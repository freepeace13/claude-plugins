'use strict';
// Discovery: link sessions that carry one piece of work across several sessions, scan each chain (again, if
// it was scanned before) for topics, and turn the one the developer picks into a log. A topic that is already
// logged updates that log, so every topic stays unique.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLUGIN_ROOT, paths, readJson, writeJsonAtomic, parseAge } = require('./util');
const store = require('./store');
const { condense } = require('./transcript');
const T = require('./topics');
const { resolveProject, commitsBetween } = require('./project');
const { runClaudeAsync, POLICY_RULES } = require('./model');
const { logError } = require('./util');

const MAX_CHAIN = 6;          // sessions in one linked topic
const LINK_DAYS = 14;         // how far apart linked sessions may be
const TRUNKS = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'head', 'staging', 'production']);
// Phrases, not word stems: "continuous integration" or "resume.pdf" is not a continued session.
const CONTINUE_RE = /\b(continue (?:where|from|with (?:the|our|my)|on (?:the|our|my)|working)|let'?s continue|pick(?:ing)? up (?:where|from)|resume (?:where|from|the|our|my|work)|left off|previous session|last session|earlier session|other session|hand-?off|carry on|where we were)\b/i;
const DOC_RE = /\.(md|mdx|txt|rst)$/i;
// Documents every project has, and manifests that happen to be text: editing one is not a handoff.
const COMMON_DOCS = /^((readme|changelog|changes|history|claude|agents|license|licence|copying|contributing|authors|notice|security|code_of_conduct|skill)(\.[a-z]+)?|requirements[\w.-]*\.txt|constraints[\w.-]*\.txt|cmakelists\.txt|robots\.txt|llms\.txt|humans\.txt)$/i;
const STOP = new Set(('a an and any are as at be by can could find for from get has have how i in into is it its look looking me my '
  + 'need of on one or out over scores score some that the their them then there these this to topic topics was were what when '
  + 'where which with worked work works together about across between show give only just like want than more less above below '
  + 'session sessions should would also anything something everything all good great best interesting worth '
  + 'least greater higher lower case study studies write writing').split(' '));

const HOUR = 3600000;
const DAY = 24 * HOUR;
const t0 = (iso) => (iso ? new Date(iso).getTime() : 0);

// ---------- collect ----------

/**
 * Read every transcript of this profile modified since `since` and describe it. Sessions of other projects
 * (unless all), with a skip policy, or no user turns are left out. Sessions already scanned stay in: a new
 * scan can find another angle.
 */
function collectSessions(config, { project, since, exclude, force }) {
  const root = paths.claudeProjects();
  const allLogs = store.allLogs();
  const byCwd = new Map();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sessionId = n.slice(0, -6);
      if (exclude && exclude.includes(sessionId)) continue;
      const file = path.join(root, d, n);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (since && st.mtimeMs < since.getTime()) continue;
      // Deleted before topics existed: the whole session stays closed unless --force.
      if (!force && T.legacyDeleted(store.getLedger(sessionId))) continue;
      // The project first, from the head of the file: a session of another project is never read in full.
      const cwd = peekCwd(file);
      if (cwd && !byCwd.has(cwd)) byCwd.set(cwd, resolveProject(cwd, config));
      const early = cwd && byCwd.get(cwd);
      if (early && (early.policy === 'skip' || (project && early.project !== project))) continue;
      let t;
      try { t = condense(file, config.scan.maxChars); } catch { continue; }
      // No recorded directory: nothing says which project or policy it has, so it is left out.
      if (!t.userTurns || !t.cwd) continue;
      const key = t.cwd || '';
      if (!byCwd.has(key)) byCwd.set(key, resolveProject(t.cwd, config));
      const info = byCwd.get(key);
      if (info.policy === 'skip') continue;
      if (project && info.project !== project) continue;
      const logs = T.logsForSessions([sessionId], allLogs);
      out.push({
        sessionId, transcriptPath: file, mtimeMs: st.mtimeMs, size: st.size,
        project: info.project, repo: info.repo || null, root: info.root, policy: info.policy,
        branch: t.branch, startedAt: t.startedAt, endedAt: t.endedAt, userTurns: t.userTurns,
        files: t.files, readFiles: t.readFiles, prUrls: t.prUrls, aiTitle: t.aiTitle, opening: t.opening,
        text: t.text,
        logs: logs.map((l) => ({ id: l.meta.id, score: l.meta.score, title: l.meta.title, tags: l.meta.tags || [] })),
        // Pending marks wait for a scan of this session to place them. A mark of a log by ID is in the log already.
        pending: store.getMarks(sessionId),
      });
    }
  }
  // One session can sit in two project folders (resumed from another directory): keep its newest transcript.
  const newest = new Map();
  for (const s of out) if (!newest.has(s.sessionId) || newest.get(s.sessionId).mtimeMs < s.mtimeMs) newest.set(s.sessionId, s);
  return [...newest.values()].sort((a, b) => t0(a.startedAt) - t0(b.startedAt));
}

/** The first cwd recorded in a transcript, from its first 64 KB only; null if none is found there. */
function peekCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    for (const line of head.split('\n')) {
      try { const e = JSON.parse(line); if (e && e.cwd) return e.cwd; } catch { /* a cut line */ }
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
  return null;
}

// ---------- link ----------

const base = (f) => path.basename(String(f));

/** Why session b (the later one) continues session a, or null. Strength 3 = strong, 1 = weak. */
function linkReason(a, b, latestBefore) {
  const gap = t0(b.startedAt) - t0(a.endedAt);
  if (gap > LINK_DAYS * DAY || gap < -DAY) return null;
  const pr = a.prUrls.find((u) => b.prUrls.includes(u));
  // Only a public project's reasons name the repository and branch: they go into the prompt.
  const pub = a.policy === 'public' && b.policy === 'public';
  if (pr) return { strength: 3, why: pub ? `same pull request ${pr.replace(/^https?:\/\/(www\.)?github\.com\//, '')}` : 'same pull request' };
  // A branch name is only shared within one repository: two repos that slug alike are not one piece of work.
  const sameRepo = a.repo ? a.repo === b.repo : Boolean(a.root) && a.root === b.root;
  if (sameRepo && a.branch && a.branch === b.branch && !TRUNKS.has(a.branch.toLowerCase())) return { strength: 3, why: pub ? `same branch ${a.branch}` : 'same feature branch' };
  const opening = b.opening.toLowerCase();
  const handoff = a.files.find((f) => {
    const name = base(f);
    if (COMMON_DOCS.test(name)) return false;
    // Only a document someone wrote to hand over counts (handoff.md, notes.txt), never code or a manifest:
    // a later session naming package.json is not continuing the work.
    if (!DOC_RE.test(name)) return false;
    const mentioned = name.length >= 6 && hasWord(opening, name.toLowerCase());
    return mentioned || b.readFiles.includes(f);
  });
  if (handoff) return { strength: 3, why: `${b.sessionId.slice(0, 8)} picks up ${base(handoff)} from ${a.sessionId.slice(0, 8)}` };
  const shared = a.files.filter((f) => b.files.includes(f));
  if (latestBefore === a && CONTINUE_RE.test(b.opening) && gap <= 2 * DAY && shared.length) {
    return { strength: 2, why: `${b.sessionId.slice(0, 8)} continues ${a.sessionId.slice(0, 8)}` };
  }
  const union = new Set([...a.files, ...b.files]).size;
  if (shared.length >= 3 && shared.length / union >= 0.5 && gap <= 3 * DAY) {
    return { strength: 1, why: `both edit ${shared.length} of the same files` };
  }
  return null;
}

/** Group one project's sessions into chains. Strong links are applied first; a chain never exceeds MAX_CHAIN. */
function linkSessions(sessions) {
  const parent = new Map(sessions.map((s) => [s.sessionId, s.sessionId]));
  const size = new Map(sessions.map((s) => [s.sessionId, 1]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const edges = [];
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  for (const list of byProject.values()) {
    for (let j = 0; j < list.length; j++) {
      const b = list[j];
      let latestBefore = null;
      // The session that ended last before b began, not the last one to start.
      for (let i = 0; i < j; i++) {
        if (t0(list[i].endedAt) <= t0(b.startedAt) + HOUR && (!latestBefore || t0(list[i].endedAt) > t0(latestBefore.endedAt))) latestBefore = list[i];
      }
      for (let i = 0; i < j; i++) {
        const r = linkReason(list[i], b, latestBefore);
        if (r) edges.push({ a: list[i], b, ...r, gap: t0(b.startedAt) - t0(list[i].endedAt) });
      }
    }
  }
  edges.sort((x, y) => y.strength - x.strength || x.gap - y.gap);
  const reasons = new Map();
  for (const e of edges) {
    const ra = find(e.a.sessionId);
    const rb = find(e.b.sessionId);
    const link = { a: e.a.sessionId, b: e.b.sessionId, why: e.why };
    if (ra === rb) { if (!reasons.has(ra)) reasons.set(ra, []); reasons.get(ra).push(link); continue; }
    if (size.get(ra) + size.get(rb) > MAX_CHAIN) continue;
    parent.set(rb, ra);
    size.set(ra, size.get(ra) + size.get(rb));
    reasons.set(ra, [...(reasons.get(ra) || []), ...(reasons.get(rb) || []), link]);
  }
  const groups = new Map();
  for (const s of sessions) {
    const r = find(s.sessionId);
    if (!groups.has(r)) {
      const links = reasons.get(r) || [];
      groups.set(r, { members: [], links, reasons: whys(links) });
    }
    groups.get(r).members.push(s);
  }
  return [...groups.values()];
}

const whys = (links) => [...new Set(links.map((l) => l.why))];

// ---------- shortlist ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[-_/]+/g, ' ');
const keywords = (note) => [...new Set(norm(note).split(/[^a-z0-9.+#]+/).map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
// Whole words only, and any character in a tag or file name is taken literally.
const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\#/-]/g, '\\$&')}(?![a-z0-9])`, 'i').test(text);

function groupText(g) {
  return norm(g.members.map((m) => [m.aiTitle, m.text, ...m.logs.flatMap((l) => [l.title, ...l.tags]), ...m.files.map(base)].join('\n')).join('\n'));
}

/** Rank chains without any model call. Nothing is left out for being logged already: a rescan can find a new angle. */
function shortlist(groups, config, { note, tags }) {
  const words = keywords(note);
  const out = [];
  for (const g of groups) {
    // A session with a pending mark is a candidate however short; one no scan has seen yet also ranks higher.
    const marked = g.members.some((m) => m.pending.some((k) => !k.seen));
    if (!g.members.some((m) => m.pending.length) && g.members.length === 1 && g.members[0].userTurns < config.scan.minTurns) continue;
    const text = groupText(g);
    const tagHits = tags.filter((t) => hasWord(text, norm(t)));
    if (tags.length && !tagHits.length) continue;
    const noteFit = words.length ? words.filter((w) => hasWord(text, w)).length / words.length : 0;
    const logs = g.members.flatMap((m) => m.logs);
    const logScore = Math.max(0, ...logs.map((l) => l.score || 0));
    const turns = g.members.reduce((n, m) => n + m.userTurns, 0);
    // Linked chains first: they hold the stories no single session tells; a session already logged on its own matters less.
    const solo = g.members.length === 1 && logs.length ? -1 : 0;
    const prelim = (logScore || 2) + (g.members.length > 1 ? 1 : 0) + solo + 3 * noteFit + tagHits.length + Math.min(1, turns / 40) + (marked ? 2 : 0);
    out.push({ ...g, noteFit, tagHits, prelim, latest: Math.max(...g.members.map((m) => t0(m.endedAt))) });
  }
  return out.sort((a, b) => b.prelim - a.prelim || b.latest - a.latest);
}

// ---------- score ----------

/** A chain is as private as its most private session: one anonymized session anonymizes the whole prompt. */
const chainPolicy = (members) => (members.every((m) => m.policy === 'public') ? 'public' : 'anonymize');

function sessionsBlock(members, maxChars) {
  const each = Math.max(4000, Math.floor(maxChars / members.length));
  const policy = chainPolicy(members);
  return members.map((m, i) => {
    const t = condense(m.transcriptPath, each);
    const branch = policy === 'public' ? ` · branch ${t.branch || 'unknown'}` : '';
    return `### Session ${i + 1} of ${members.length} · ${String(m.startedAt || '').slice(0, 16).replace('T', ' ')}${branch} · ${t.userTurns} turns\n${t.text}`;
  }).join('\n\n');
}

function chainCommits(members, root) {
  const seen = new Set();
  // Each session's commits from its own checkout: linked sessions may run in different worktrees.
  for (const m of members) for (const c of commitsBetween(m.root || root, m.startedAt, m.endedAt)) seen.add(c);
  return [...seen].slice(0, 40);
}

function renderPrompt(members, { note, tags, reasons, marks, existing, maxTopics, commits }, maxChars) {
  const first = members[0];
  const policy = chainPolicy(members);
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'prompts', 'discovery.md'), 'utf8');
  const notes = marks.map((m) => m.note).filter(Boolean);
  const rel = (m, f) => { const root = m.root || first.root; return root ? path.relative(root, f) || f : f; };
  const files = [...new Set(members.flatMap((m) => m.files.map((f) => rel(m, f))))].slice(0, 60);
  const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');
  const vars = {
    NOTE: note || 'none',
    TAGS: tags.length ? tags.join(', ') : 'none',
    MAX_TOPICS: String(maxTopics),
    MARKED_HINT: marks.length ? `(${marks.length} mark${marks.length > 1 ? 's' : ''})` : 'NOT (no marks)',
    POLICY: policy,
    POLICY_RULES: POLICY_RULES[policy] || POLICY_RULES.anonymize,
    PROJECT: policy === 'public' ? `${first.project}${first.repo ? ` (${first.repo})` : ''}` : '[anonymized]',
    MARKS: notes.length ? notes.map((n) => `"${n}"`).join('; ') : marks.length ? '(marked, no note)' : 'none',
    LINKS: reasons.length ? list(reasons) : '- a single session',
    COMMITS: list(commits),
    FILES: list(files),
    EXISTING: existing,
    SESSIONS: sessionsBlock(members, maxChars),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

function memberRecord(m) {
  return {
    sessionId: m.sessionId, startedAt: m.startedAt, endedAt: m.endedAt, userTurns: m.userTurns, size: m.size,
    mtimeMs: m.mtimeMs, branch: m.branch, files: m.files, root: m.root,
  };
}

/** What a log has not been scanned with yet: pending marks of its sessions (placed on this topic, or not seen by
 *  any scan yet), or turns its sessions gained since. A mark of the log by ID is in the log already: not news. */
function hasNews(log, members, topic) {
  const m = log.meta;
  const turns = m.session_turns || (m.session_id ? { [m.session_id]: m.user_turns || 0 } : {});
  const pending = members.map((x) => store.getMarks(x.sessionId));
  // The model placed the sessions' pending marks on this topic: the pick gives them to the log.
  if (topic && topic.marks && pending.some((p) => p.length)) return true;
  // Older logs: 0.2 has scouted_at, 0.1 only created_at. A pending mark a scan saw and left unplaced is news once.
  const since = m.scanned_at || m.scouted_at || m.created_at || '';
  // A log from before 0.3 counted casebook's own commands as turns: compare when its sessions last changed instead.
  const grew = (x) => (m.scanned_at ? (x.userTurns || 0) > (turns[x.sessionId] || 0) : String(x.endedAt || '') > (m.scouted_at || m.updated_at || since));
  return members.some((x, i) => pending[i].some((k) => !k.seen && String(k.at || '') > since) || grew(x));
}

/** One model call over a chain. Returns its topics, each cut down to the sessions it belongs to. */
async function scanChain(g, config, opts) {
  const sids = g.members.map((m) => m.sessionId);
  const first = g.members[0];
  const lastEnd = g.members.map((m) => m.endedAt || '').sort().pop();
  const context = T.contextLogs(first.project, sids, first.startedAt, lastEnd);
  const deleted = opts.force ? [] : T.tombstones(sids);
  const startedScan = new Date().toISOString();
  const marks = [...context.filter((l) => T.sessionsOf(l).some((s) => sids.includes(s))).flatMap((l) => l.meta.marks || []),
    ...sids.flatMap((sid) => store.getMarks(sid))];
  const maxTopics = config.scan.maxTopics || 3;
  const commits = chainCommits(g.members, first.root);
  const prompt = renderPrompt(g.members, {
    ...opts, reasons: g.reasons, marks, existing: T.renderExisting(context, sids, deleted), maxTopics, commits,
  }, config.scan.maxChars);
  const found = T.parseTopics(await runClaudeAsync(prompt, config), maxTopics);
  const byId = new Map(context.map((l) => [l.meta.id, l]));
  const out = [];
  for (const topic of T.screenTopics(found, deleted, context)) {
    const idx = [...new Set(topic.belongs.filter((i) => i >= 1 && i <= g.members.length))].sort((a, b) => a - b);
    const members = idx.length ? idx.map((i) => g.members[i - 1]) : g.members;
    // A shown log merged into another one during the call resolves to a log the model never saw: drop the topic.
    if (topic.same_as.some((id) => !byId.has(id))) continue;
    let same = topic.same_as.map((id) => byId.get(id));
    // Same title and angle as a log of its own sessions, though the model did not say so: that log.
    if (!same.length) {
      const own = context.filter((l) => T.sessionsOf(l).some((sid) => members.some((m) => m.sessionId === sid)));
      const twin = own.find((l) => T.sameTopic(l, topic));
      if (twin) { same = [twin]; topic.same_as = [twin.meta.id]; }
    }
    // Already logged with these very sessions and nothing to merge: not a discovery, unless the sessions have
    // news for that log (new turns, or marks made since its last scan), and then it refreshes the log.
    if (same.length === 1 && members.every((m) => T.sessionsOf(same[0]).includes(m.sessionId)) && !hasNews(same[0], members, topic)) continue;
    // Only what concerns this topic's own sessions: their commits, and the links between them.
    const ids = new Set(members.map((m) => m.sessionId));
    out.push({
      topic, members,
      commits: members.length === g.members.length ? commits : chainCommits(members, first.root),
      reasons: members.length > 1 ? whys((g.links || []).filter((l) => ids.has(l.a) && ids.has(l.b))) : [],
      updates: same.map((l) => l.meta.id),
      targets: Object.fromEntries(same.map((l) => [l.meta.id, l.meta.updated_at || l.meta.created_at || ''])),
      // The logs of these sessions the model was shown: a pick refuses if the sessions gained another one.
      known: T.logsForSessions(members.map((m) => m.sessionId), context).map((l) => l.meta.id),
    });
  }
  // Pending marks this scan saw and tied to no topic stay pending, but are no longer news for these sessions' logs.
  // Bookkeeping only: a busy lock must not throw away a scan that worked.
  // Only an open scan: one narrowed by a note or tags looks for something else, and may rightly place nothing.
  if (!opts.narrowed && !found.some((t) => t.marks)) {
    try { store.withWriteLock(() => { for (const sid of sids) store.markSeen(sid, startedScan); }, { waitMs: 5000 }); } catch (err) { logError('could not record the marks a scan saw', err); }
  }
  return out;
}

// ---------- duplicates across scans ----------

/**
 * One model call that groups the topics telling the same story, for topics found by different scans (no scan
 * sees another's topics). In each group the best topic that updates a log stays, else the best one; the other
 * new topics in it are dropped. A topic that updates a log is never dropped: it names that log. On failure the
 * list is returned as it was.
 */
const projectOf = (f) => f.members[0].project;

async function dedupeTopics(list, config) {
  // Only new topics can be dropped: with none, the call could change nothing.
  if (list.length < 2 || list.every((f) => f.updates.length)) return list;
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'prompts', 'dedupe.md'), 'utf8');
  // Only to tell projects apart: a label, never the project's name (it may be anonymized).
  const labels = new Map();
  const label = (f) => { const p = projectOf(f); if (!labels.has(p)) labels.set(p, String.fromCharCode(65 + (labels.size % 26)) + (labels.size >= 26 ? labels.size : '')); return labels.get(p); };
  const lines = list.map((f, i) => [
    `### ${i + 1}. ${f.topic.title}`,
    `Project ${label(f)} · Angle: ${f.topic.angle || 'general'} · ${f.members.length} session${f.members.length > 1 ? 's' : ''}${f.updates.length ? ' · updates an existing log' : ''}`,
    `Description: ${f.topic.description || '(none)'}`,
    `Summary: ${f.topic.summary || '(none)'}`,
  ].join('\n'));
  let groups;
  try {
    const text = await runClaudeAsync(tpl.replace('{{TOPICS}}', () => lines.join('\n\n')), config, { timeoutSec: Math.min(config.scan.timeoutSec || 240, 90) });
    const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    groups = Array.isArray(raw.duplicates) ? raw.duplicates : [];
  } catch (err) {
    logError('the duplicate check failed; topics are offered unchecked', err);
    return list;
  }
  const drop = new Set();
  for (const g of groups) {
    const idx = [...new Set((Array.isArray(g) ? g : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length))].sort((a, b) => a - b);
    if (idx.length < 2) continue;
    // Work in two projects is two stories, whatever the model says: group within each project.
    for (const p of new Set(idx.map((n) => projectOf(list[n - 1])))) {
      const mine = idx.filter((n) => projectOf(list[n - 1]) === p);
      const keep = mine.find((n) => list[n - 1].updates.length) || mine[0];
      for (const n of mine) if (n !== keep && !list[n - 1].updates.length) drop.add(n);
    }
  }
  return list.filter((_, i) => !drop.has(i + 1));
}

// ---------- discover ----------

/** A mistake the user can fix (an old discovery, a changed log): reported, not logged as a failure. */
function userError(msg) { const err = new Error(msg); err.user = true; return err; }

const discoveriesDir = () => path.join(paths.home(), 'state', 'discoveries');
const newDiscoveryId = () => `d-${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;

function pruneDiscoveries() {
  let names = [];
  try { names = fs.readdirSync(discoveriesDir()); } catch { return; }
  for (const n of names) {
    const f = path.join(discoveriesDir(), n);
    try { if (Date.now() - fs.statSync(f).mtimeMs > 7 * DAY) fs.rmSync(f, { force: true }); } catch { /* gone */ }
  }
}

/**
 * Find linked sessions, scan the most promising chains (one model call each, side by side) and keep the
 * best `top` topics across them. With dryRun nothing is scanned: the shortlist is returned as it would be sent.
 */
async function discover(config, o) {
  let since;
  try { since = o.since ? parseAge(o.since) : parseAge('90d'); } catch (err) { throw userError(err.message); }
  const tags = (o.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  // Before any transcript or mark is read: what is added after it was never scanned.
  const scanStarted = new Date().toISOString();
  const sessions = collectSessions(config, { project: o.project, since, exclude: o.exclude, force: o.force });
  const groups = linkSessions(sessions);
  const ranked = shortlist(groups, config, { note: o.note, tags });
  const picked = ranked.slice(0, o.candidates);
  const summary = { sessions: sessions.length, chains: groups.filter((g) => g.members.length > 1).length, eligible: ranked.length };
  if (o.dryRun || !picked.length) return { ...summary, shortlist: picked, topics: [] };

  // A note that names nothing to look for ("anything that scores > 3") filters by score only, not by fit.
  const narrowed = Boolean(keywords(o.note).length || tags.length);
  const scanned = await Promise.all(picked.map(async (g) => {
    try {
      return { ok: true, found: await scanChain(g, config, { note: o.note, tags, force: o.force, narrowed }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }));
  const failed = scanned.filter((s) => !s.ok).map((s) => s.error);
  const found = scanned.filter((s) => s.ok).flatMap((s) => s.found);
  // A note that names nothing to look for ("anything that scores > 3") filters by score only, not by fit.
  const candidates = found
    .filter((f) => f.topic.score >= (o.minScore || 1) && (!narrowed || f.topic.fit >= 1))
    .sort((a, b) => b.topic.score - a.topic.score || b.topic.fit - a.topic.fit || b.members.length - a.members.length
      || Math.max(...b.members.map((m) => t0(m.endedAt))) - Math.max(...a.members.map((m) => t0(m.endedAt))))
    // Chains near each other see the same logs: only the best topic may update a given log.
    .filter(((taken) => (f) => {
      if (f.updates.some((id) => taken.has(id))) return false;
      for (const id of f.updates) taken.add(id);
      return true;
    })(new Set()))
    // The same new story found twice (one chain's scan, or two chains near each other): only the best one is offered.
    .filter(((kept) => (f) => {
      if (!f.updates.length && kept.some((k) => projectOf(k) === projectOf(f) && T.sameTopic(k.topic, f.topic))) return false;
      kept.push(f);
      return true;
    })([]));
  // Retellings in other words get past the title and description checks: the model compares what is left.
  const topics = (await dedupeTopics(candidates, config))
    .slice(0, o.top || 3)
    .map((f, i) => {
      const first = f.members[0];
      return {
        rank: i + 1, score: f.topic.score, fit: f.topic.fit, topic: f.topic, reasons: f.reasons, updates: f.updates, targets: f.targets,
        known: f.known,
        commits: f.commits,
        info: { project: first.project, repo: first.repo, policy: chainPolicy(f.members), root: first.root },
        members: f.members.map(memberRecord),
      };
    });

  const best = found.reduce((n, f) => Math.max(n, f.topic.score), 0);
  let id = null;
  if (topics.length) {
    pruneDiscoveries();
    id = newDiscoveryId();
    writeJsonAtomic(path.join(discoveriesDir(), `${id}.json`), {
      id, created_at: new Date().toISOString(), scan_started_at: scanStarted, note: o.note || '', tags, minScore: o.minScore || null, force: Boolean(o.force), topics, picked: {},
    });
  }
  return { ...summary, id, scored: scanned.filter((s) => s.ok).length, failed, best, topics };
}

// ---------- pick ----------

/** The pending marks of a session the discovery's scan could see: one made since stays for the next discovery. */
const scannedMarks = (sid, d) => store.getMarks(sid).filter((k) => !d.scan_started_at || String(k.at || '') <= d.scan_started_at);

/** Log topic `n` of discovery `id`: a new log, or an update of the log(s) it is the same as. */
function pick(config, id, n) {
  const file = path.join(discoveriesDir(), `${id}.json`);
  const d = readJson(file, null);
  if (!d) throw userError(`no discovery "${id}" (discoveries are kept for 7 days)`);
  const t = d.topics.find((x) => x.rank === Number(n));
  if (!t) throw userError(`discovery ${id} has no topic ${n}; pick 1 to ${d.topics.length}`);
  const done = d.picked && d.picked[t.rank] && T.resolveLog(d.picked[t.rank]);
  if (done) return { status: 'exists', logId: done.meta.id, title: done.meta.title };

  // A discovery can be days old: check again that nothing it relied on changed since.
  const sids = t.members.map((m) => m.sessionId);
  // Every check runs under the write lock, so nothing can change a target between the check and the write.
  const r = store.withWriteLock(() => {
    // Read the discovery again under the lock: another pick of it may have just recorded its log.
    const pickedNow = Object.values(readJson(file, d).picked || {}).map((x) => T.resolveLog(x)).filter(Boolean);
    const gone = t.updates.filter((uid) => !T.resolveLog(uid));
    // Any of them: a log deleted since must not come back merged into another.
    if (gone.length) {
      throw userError(`${gone.length === 1 && t.updates.length === 1 ? 'the log this topic updates is' : 'logs this topic merges are'} gone (${gone.join(', ')}); run discovery again`);
    }
    // The notes were taken from the logs as they were then: a log changed since would lose its new notes.
    const changed = t.updates.filter((uid) => {
      const l = T.resolveLog(uid);
      return l && t.targets && (l.meta.id !== uid || (l.meta.updated_at || l.meta.created_at || '') !== t.targets[uid]);
    });
    if (changed.length) throw userError(`${changed.join(', ')} changed since the discovery ran; run discovery again`);
    // A log these sessions gained since may already tell this story: the discovery never weighed it.
    if (t.known) {
      // Logs made by earlier picks of this same discovery are other topics it listed, not news.
      const mineToo = pickedNow.map((l) => l.meta.id);
      const fresh = T.logsForSessions(sids).map((l) => l.meta.id).filter((x) => !t.known.includes(x) && !t.updates.includes(x) && !mineToo.includes(x));
      if (fresh.length) throw userError(`these sessions were logged again since the discovery ran (${fresh.join(', ')}); run discovery again`);
    }
    const deleted = d.force ? [] : T.tombstones(sids);
    const [topic] = T.screenTopics([{ ...t.topic, same_as: t.updates }], deleted);
    if (!topic) throw userError('this topic was deleted since the discovery ran; run discovery again, or with --force');
    // The project's policy as it is now: it may have changed since the discovery ran.
    const now = resolveProject(t.info.root || t.info.cwd || null, config);
    if (t.info.root && now.policy === 'skip') throw userError(`${t.info.project} is now set to skip; nothing was logged`);
    if (t.info.root && t.info.policy === 'public' && now.policy !== 'public') {
      throw userError(`${t.info.project} is no longer public; run discovery again so the notes follow its policy`);
    }
    // A new topic that retells what an earlier pick of this discovery already logged is that log.
    if (!t.updates.length) {
      const twin = pickedNow.find((l) => l.meta.project === t.info.project && T.sameTopic(l, topic));
      if (twin) {
        // The marks the model tied to this topic go to the log that tells it.
        if (topic.marks) {
          for (const sid of sids) {
            const m = scannedMarks(sid, d);
            for (const k of m) store.applyMark(twin, k.note, sid);
            store.consumeMarks(sid, m);
          }
        }
        return { status: 'exists', logId: twin.meta.id, title: twin.meta.title };
      }
    }
    const bySession = topic.marks ? sids.map((sid) => [sid, scannedMarks(sid, d)]) : [];
    const res = T.applyTopic(topic, {
      members: t.members, info: t.info, marks: bySession.flatMap(([, m]) => m), note: d.note, commits: t.commits, scannedAt: d.scan_started_at || d.created_at,
    });
    for (const [sid, m] of bySession) store.consumeMarks(sid, m);
    return res;
  });
  // Read it again under the lock: another pick of this discovery may have recorded its own log meanwhile.
  store.withWriteLock(() => {
    const now = readJson(file, d);
    writeJsonAtomic(file, { ...now, picked: { ...(now.picked || {}), [t.rank]: r.logId } });
  });
  return { ...r, sessions: sids };
}

module.exports = { discover, pick, collectSessions, linkSessions, shortlist, keywords };
