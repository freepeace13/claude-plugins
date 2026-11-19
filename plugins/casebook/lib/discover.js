'use strict';
// Discovery: link sessions that carry one piece of work across several sessions, scan each chain (again, if
// it was scanned before) for topics, and turn the one the developer picks into a log. A topic that is already
// logged updates that log, so every topic stays unique.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLUGIN_ROOT, paths, readJson, writeJsonAtomic, parseAge } = require('./util');
const store = require('./store');
const { condense, findTranscript } = require('./transcript');
const T = require('./topics');
const { resolveProject, commitsBetween } = require('./project');
const { runClaudeAsync, POLICY_RULES, acquireSessionLock } = require('./scout');

const MAX_CHAIN = 6;          // sessions in one linked topic
const LINK_DAYS = 14;         // how far apart linked sessions may be
const TRUNKS = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'head', 'staging', 'production']);
const CONTINUE_RE = /\b(continu\w*|pick(?:ing)? up|resum\w*|left off|previous session|last session|hand-?off|carry on|where we were)\b/i;
const DOC_RE = /\.(md|mdx|txt|rst)$/i;
const COMMON_DOCS = /^(readme|changelog|claude|agents|license|contributing)\.md$/i;
const STOP = new Set(('a an and any are as at be by can could find for from get has have how i in into is it its look looking me my '
  + 'need of on one or out over scores score some that the their them then there these this to topic topics was were what when '
  + 'where which with worked work works together about across between show give only just like want than more less above below '
  + 'session sessions should would also').split(' '));

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
      let t;
      try { t = condense(file, config.scout.maxChars); } catch { continue; }
      if (!t.userTurns) continue;
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
      });
    }
  }
  return out.sort((a, b) => t0(a.startedAt) - t0(b.startedAt));
}

// ---------- link ----------

const base = (f) => path.basename(String(f));

/** Why session b (the later one) continues session a, or null. Strength 3 = strong, 1 = weak. */
function linkReason(a, b, latestBefore) {
  const gap = t0(b.startedAt) - t0(a.endedAt);
  if (gap > LINK_DAYS * DAY || gap < -DAY) return null;
  const pr = a.prUrls.find((u) => b.prUrls.includes(u));
  if (pr) return { strength: 3, why: `same pull request ${pr.replace(/^https?:\/\/(www\.)?github\.com\//, '')}` };
  if (a.branch && a.branch === b.branch && !TRUNKS.has(a.branch.toLowerCase())) return { strength: 3, why: `same branch ${a.branch}` };
  const opening = b.opening.toLowerCase();
  const handoff = a.files.find((f) => {
    const name = base(f);
    if (COMMON_DOCS.test(name)) return false;
    // Only a real file name counts as a mention (handoff.md, not the word "casebook").
    const mentioned = /^[^.].*\.\w+$/.test(name) && name.length >= 6 && hasWord(opening, name.toLowerCase());
    return mentioned || (DOC_RE.test(f) && b.readFiles.includes(f));
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
      for (let i = 0; i < j; i++) if (t0(list[i].endedAt) <= t0(b.startedAt) + HOUR) latestBefore = list[i];
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
    if (ra === rb) { reasons.get(ra).add(e.why); continue; }
    if (size.get(ra) + size.get(rb) > MAX_CHAIN) continue;
    parent.set(rb, ra);
    size.set(ra, size.get(ra) + size.get(rb));
    reasons.set(ra, new Set([...(reasons.get(ra) || []), ...(reasons.get(rb) || []), e.why]));
  }
  const groups = new Map();
  for (const s of sessions) {
    const r = find(s.sessionId);
    if (!groups.has(r)) groups.set(r, { members: [], reasons: [...(reasons.get(r) || [])] });
    groups.get(r).members.push(s);
  }
  return [...groups.values()];
}

// ---------- shortlist ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[-_/]+/g, ' ');
const keywords = (note) => [...new Set(norm(note).split(/[^a-z0-9.+#]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
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
    if (g.members.length === 1 && g.members[0].userTurns < config.scout.minTurns) continue;
    const text = groupText(g);
    const tagHits = tags.filter((t) => hasWord(text, norm(t)));
    if (tags.length && !tagHits.length) continue;
    const noteFit = words.length ? words.filter((w) => hasWord(text, w)).length / words.length : 0;
    const logs = g.members.flatMap((m) => m.logs);
    const logScore = Math.max(0, ...logs.map((l) => l.score || 0));
    const turns = g.members.reduce((n, m) => n + m.userTurns, 0);
    // Chains are what a one-session scout cannot see; a session that is already logged on its own matters less.
    const solo = g.members.length === 1 && logs.length ? -1 : 0;
    const prelim = (logScore || 2) + (g.members.length > 1 ? 1 : 0) + solo + 3 * noteFit + tagHits.length + Math.min(1, turns / 40);
    out.push({ ...g, noteFit, tagHits, prelim, latest: Math.max(...g.members.map((m) => t0(m.endedAt))) });
  }
  return out.sort((a, b) => b.prelim - a.prelim || b.latest - a.latest);
}

// ---------- score ----------

function sessionsBlock(members, maxChars) {
  const each = Math.max(4000, Math.floor(maxChars / members.length));
  return members.map((m, i) => {
    const t = condense(m.transcriptPath, each);
    return `### Session ${i + 1} of ${members.length} · ${String(m.startedAt || '').slice(0, 16).replace('T', ' ')} · branch ${t.branch || 'unknown'} · ${t.userTurns} turns\n${t.text}`;
  }).join('\n\n');
}

function chainCommits(members, root) {
  const seen = new Set();
  for (const m of members) for (const c of commitsBetween(root, m.startedAt, m.endedAt)) seen.add(c);
  return [...seen].slice(0, 40);
}

function renderPrompt(members, { note, tags, reasons, marks, existing, maxTopics, commits }, maxChars) {
  const first = members[0];
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'prompts', 'discovery.md'), 'utf8');
  const notes = marks.map((m) => m.note).filter(Boolean);
  const files = [...new Set(members.flatMap((m) => m.files))].map((f) => (first.root ? path.relative(first.root, f) || f : f)).slice(0, 60);
  const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');
  const vars = {
    NOTE: note || 'none',
    TAGS: tags.length ? tags.join(', ') : 'none',
    MAX_TOPICS: String(maxTopics),
    MARKED_HINT: marks.length ? `(${marks.length} mark${marks.length > 1 ? 's' : ''})` : 'NOT (no marks)',
    POLICY: first.policy,
    POLICY_RULES: POLICY_RULES[first.policy] || POLICY_RULES.anonymize,
    PROJECT: first.policy === 'public' ? `${first.project}${first.repo ? ` (${first.repo})` : ''}` : '[anonymized]',
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
    mtimeMs: m.mtimeMs, branch: m.branch, files: m.files,
  };
}

/** One model call over a chain. Returns its topics, each cut down to the sessions it belongs to. */
async function scanChain(g, config, opts) {
  const sids = g.members.map((m) => m.sessionId);
  const first = g.members[0];
  const context = T.contextLogs(first.project, sids, first.startedAt, g.members[g.members.length - 1].endedAt);
  const deleted = opts.force ? [] : T.tombstones(sids);
  const marks = [...context.filter((l) => T.sessionsOf(l).some((s) => sids.includes(s))).flatMap((l) => l.meta.marks || []),
    ...sids.flatMap((sid) => store.getMarks(sid))];
  const maxTopics = config.scout.maxTopics || 3;
  const commits = chainCommits(g.members, first.root);
  const prompt = renderPrompt(g.members, {
    ...opts, reasons: g.reasons, marks, existing: T.renderExisting(context, sids, deleted), maxTopics, commits,
  }, config.scout.maxChars);
  const found = T.parseTopics(await runClaudeAsync(prompt, config), maxTopics);
  const byId = new Map(context.map((l) => [l.meta.id, l]));
  const out = [];
  for (const topic of T.screenTopics(found, deleted)) {
    const idx = [...new Set(topic.belongs.filter((i) => i >= 1 && i <= g.members.length))].sort((a, b) => a - b);
    const members = idx.length ? idx.map((i) => g.members[i - 1]) : g.members;
    const same = topic.same_as.map((id) => byId.get(id) || T.resolveLog(id)).filter(Boolean);
    // Already logged with these very sessions and nothing to merge: not a discovery.
    if (same.length === 1 && members.every((m) => T.sessionsOf(same[0]).includes(m.sessionId))) continue;
    out.push({
      topic, members, commits,
      reasons: members.length > 1 ? g.reasons : [],
      updates: same.map((l) => l.meta.id),
    });
  }
  return out;
}

// ---------- discover ----------

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
  const since = o.since ? parseAge(o.since) : parseAge('90d');
  const tags = (o.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const sessions = collectSessions(config, { project: o.project, since, exclude: o.exclude, force: o.force });
  const groups = linkSessions(sessions);
  const ranked = shortlist(groups, config, { note: o.note, tags });
  const picked = ranked.slice(0, o.candidates);
  const summary = { sessions: sessions.length, chains: groups.filter((g) => g.members.length > 1).length, eligible: ranked.length };
  if (o.dryRun || !picked.length) return { ...summary, shortlist: picked, topics: [] };

  const settled = Date.now() - (config.sweep.settleMinutes || 0) * 60000;
  const scanned = await Promise.all(picked.map(async (g) => {
    try {
      return { ok: true, found: await scanChain(g, config, { note: o.note, tags, force: o.force }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }));
  const failed = scanned.filter((s) => !s.ok).map((s) => s.error);
  const found = scanned.filter((s) => s.ok).flatMap((s) => s.found);
  const narrowed = Boolean(o.note || tags.length);
  const topics = found
    .filter((f) => f.topic.score >= (o.minScore || 1) && (!narrowed || f.topic.fit >= 1))
    .sort((a, b) => b.topic.score - a.topic.score || b.topic.fit - a.topic.fit || b.members.length - a.members.length
      || Math.max(...b.members.map((m) => t0(m.endedAt))) - Math.max(...a.members.map((m) => t0(m.endedAt))))
    .slice(0, o.top || 3)
    .map((f, i) => {
      const first = f.members[0];
      return {
        rank: i + 1, score: f.topic.score, fit: f.topic.fit, topic: f.topic, reasons: f.reasons, updates: f.updates,
        commits: f.commits,
        info: { project: first.project, repo: first.repo, policy: first.policy, root: first.root },
        members: f.members.map(memberRecord),
        partial: f.members.some((m) => m.mtimeMs > settled),
      };
    });

  const best = found.reduce((n, f) => Math.max(n, f.topic.score), 0);
  let id = null;
  if (topics.length) {
    pruneDiscoveries();
    id = newDiscoveryId();
    writeJsonAtomic(path.join(discoveriesDir(), `${id}.json`), {
      id, created_at: new Date().toISOString(), note: o.note || '', tags, minScore: o.minScore || null, force: Boolean(o.force), topics, picked: {},
    });
  }
  return { ...summary, id, scored: picked.length, failed, best, topics };
}

// ---------- pick ----------

/** Log topic `n` of discovery `id`: a new log, or an update of the log(s) it is the same as. */
function pick(config, id, n) {
  const file = path.join(discoveriesDir(), `${id}.json`);
  const d = readJson(file, null);
  if (!d) throw new Error(`no discovery "${id}" (discoveries are kept for 7 days)`);
  const t = d.topics.find((x) => x.rank === Number(n));
  if (!t) throw new Error(`discovery ${id} has no topic ${n}; pick 1 to ${d.topics.length}`);
  const done = d.picked && d.picked[t.rank] && T.resolveLog(d.picked[t.rank]);
  if (done) return { status: 'exists', logId: done.meta.id, title: done.meta.title };

  // A discovery can be days old: check again that nothing it relied on changed since.
  const sids = t.members.map((m) => m.sessionId);
  const releases = [];
  try {
    for (const sid of sids) {
      const release = acquireSessionLock(sid, { wait: false, timeoutMs: (config.scout.timeoutSec || 240) * 1000 });
      if (!release) throw new Error(`a scout of session ${sid.slice(0, 8)} is running; try again in a minute`);
      releases.push(release);
    }
    const gone = t.updates.filter((uid) => !T.resolveLog(uid));
    if (gone.length && gone.length === t.updates.length) {
      throw new Error(`the log this topic updates is gone (${gone.join(', ')}); run discovery again`);
    }
    const deleted = d.force ? [] : T.tombstones(sids);
    const [topic] = T.screenTopics([{ ...t.topic, same_as: t.updates }], deleted);
    if (!topic) throw new Error('this topic was deleted since the discovery ran; run discovery again, or with --force');

    // Partial as of now, not as of the discovery: a session that has since settled is finished.
    const settled = Date.now() - (config.sweep.settleMinutes || 0) * 60000;
    const partial = sids.some((sid) => { const f = findTranscript(sid); try { return f && fs.statSync(f).mtimeMs > settled; } catch { return false; } });
    const pending = topic.marks ? sids.flatMap((sid) => store.getMarks(sid)) : [];
    const r = store.withWriteLock(() => T.applyTopic(topic, {
      members: t.members, info: t.info, marks: pending, partial, mode: 'discovery', note: d.note, commits: t.commits,
    }));
    if (pending.length) for (const sid of sids) store.clearMarks(sid);
    writeJsonAtomic(file, { ...d, picked: { ...(d.picked || {}), [t.rank]: r.logId } });
    return { ...r, sessions: sids, partial };
  } finally {
    for (const release of releases) release();
  }
}

module.exports = { discover, pick, collectSessions, linkSessions, shortlist, keywords };
