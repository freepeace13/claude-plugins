'use strict';
// Topics: a log is one topic, not one session. A session can feed several logs (different angles), and a log
// can draw on several sessions. Every scan sees the logs already near its sessions, so it updates a topic
// that is already logged instead of logging it twice.

const fs = require('fs');
const path = require('path');
const { paths, ID_RE, logSummary } = require('./util');
const store = require('./store');

const NEAR_DAYS = 14;     // logs of the same project this close in time are shown to the model
const MAX_CONTEXT = 8;    // nearby logs of other sessions shown to the model (logs of the scanned sessions always are)

const t0 = (iso) => (iso ? new Date(iso).getTime() : 0);
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The sessions a log draws on. Logs written before topics only have session_id. */
function sessionsOf(log) {
  const m = log.meta;
  if (Array.isArray(m.sessions) && m.sessions.length) return m.sessions;
  return m.session_id ? [m.session_id] : [];
}

function logsForSessions(sids, logs = store.allLogs()) {
  const want = new Set(sids);
  return logs.filter((l) => sessionsOf(l).some((s) => want.has(s)));
}

/**
 * The logs a scan of these sessions must know about: every log drawing on them (all of them, so duplicates
 * can be merged), then the project's logs from around the same time (a continued session may carry on a
 * topic logged from another one), up to MAX_CONTEXT in all but at least 2 of them.
 */
function contextLogs(project, sids, startedAt, endedAt) {
  const all = store.allLogs();
  const overlap = logsForSessions(sids, all);
  const seen = new Set(overlap.map((l) => l.meta.id));
  const from = t0(startedAt) - NEAR_DAYS * 86400000;
  const to = t0(endedAt || startedAt) + NEAR_DAYS * 86400000;
  const near = all
    .filter((l) => !seen.has(l.meta.id) && l.meta.project === project)
    .filter((l) => t0(l.meta.ended_at || l.meta.started_at) >= from && t0(l.meta.started_at) <= to)
    .sort((a, b) => Math.abs(t0(a.meta.ended_at) - t0(startedAt)) - Math.abs(t0(b.meta.ended_at) - t0(startedAt)));
  return [...overlap, ...near.slice(0, Math.max(2, MAX_CONTEXT - overlap.length))];
}

/** Topics the developer deleted from these sessions; a scan must not log them again. */
function tombstones(sids) {
  const out = [];
  for (const sid of sids) for (const d of (store.getLedger(sid) || {}).deletedTopics || []) out.push(d);
  return out;
}

function renderExisting(logs, sids, deleted) {
  const parts = [];
  if (!logs.length) parts.push('None yet.');
  for (const l of logs) {
    const m = l.meta;
    const mine = sessionsOf(l).filter((s) => sids.includes(s)).length;
    const others = sessionsOf(l).length - mine;
    const where = mine ? `draws on ${mine === sids.length && sids.length === 1 ? 'this session' : `${mine} of these sessions`}${others ? ` and ${others} other(s)` : ''}` : `from other sessions of this project`;
    // In full: a topic that matches this log rewrites all of its notes, so the model must see all of them.
    const about = describe(l);
    parts.push(`### ${m.id} · ${m.angle || 'general'} · score ${m.score ?? '-'} · ${where}\n${about ? `Description: ${about}\n\n` : ''}${l.body.trim()}`);
  }
  if (deleted.length) {
    parts.push('### Deleted by the developer (never return these topics, however they are titled)');
    for (const d of deleted) parts.push(`- "${d.title}"${d.angle ? ` (${d.angle})` : ''}${d.description ? `: ${d.description}` : ''}`);
  }
  return parts.join('\n\n');
}

const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

function normalizeTopic(n) {
  return {
    score: Math.max(1, Math.min(5, Math.round(Number(n.score) || 1))),
    title: String(n.title || 'Untitled session').slice(0, 120),
    angle: String(n.angle || '').toLowerCase().trim().slice(0, 40),
    description: String(n.description || '').trim().slice(0, 400),
    summary: String(n.summary || ''),
    problem: String(n.problem || ''),
    constraints: arr(n.constraints),
    approach: String(n.approach || ''),
    alternatives: arr(n.alternatives),
    outcome: String(n.outcome || ''),
    evidence: arr(n.evidence),
    tags: arr(n.tags).map((t) => t.toLowerCase()).slice(0, 8),
    quote: String(n.quote || ''),
    open_threads: arr(n.open_threads),
    same_as: [...new Set(arr(n.same_as).filter((id) => ID_RE.test(id)))],
    marks: n.marks === true,
    fit: Math.max(0, Math.min(3, Math.round(Number(n.fit) || 0))),
    belongs: (Array.isArray(n.belongs) ? n.belongs : []).map(Number).filter(Number.isInteger),
  };
}

/** The model's reply: { topics: [...] }, or a single topic object (older prompts, tests). Best first. */
function parseTopics(text, max) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`the scan returned no JSON: ${s.slice(0, 200)}`);
  const raw = JSON.parse(s.slice(start, end + 1));
  // One bare topic is accepted too, but only if it looks like one: {} or {"topics": null} is no topic.
  const list = Array.isArray(raw.topics) ? raw.topics : raw && (raw.title || raw.score) ? [raw] : [];
  return list.filter((x) => x && typeof x === 'object').map(normalizeTopic)
    .sort((a, b) => b.score - a.score).slice(0, max || 3);
}

// A deleted topic stays deleted even when the model words its title a little differently: titles that share
// most of their words (word endings folded, filler dropped) count as the same topic.
const TITLE_FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'from', 'at', 'after', 'via']);
// Crude stemming, enough for titles: fixing / fixed / fixes → fix, storms → storm.
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
const titleWords = (s) => new Set(normTitle(s).split(' ').filter((w) => w && !TITLE_FILLER.has(w)).map(stem));
function sameTitle(a, b) {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.size || !y.size) return normTitle(a) === normTitle(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= 0.6;
}
// Descriptions name the work itself (component, problem, change), so two descriptions of the same work share
// most of their content words even when the titles share few. Short ones say too little to compare.
const DESC_FILLER = new Set([...TITLE_FILLER, 'is', 'was', 'were', 'are', 'be', 'been', 'it', 'its', 'this', 'that', 'which', 'so',
  'into', 'when', 'then', 'than', 'as', 'but', 'not', 'no', 'we', 'they', 'their', 'our', 'new', 'now', 'also', 'using', 'use', 'used']);
const descWords = (s) => new Set(normTitle(s).split(' ').filter((w) => w.length > 2 && !DESC_FILLER.has(w)).map(stem));
function sameDescription(a, b) {
  const x = descWords(a);
  const y = descWords(b);
  if (x.size < 5 || y.size < 5) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= 0.6;
}
// Another angle on the same work is another topic, however alike the titles are.
const sameAngle = (a, b) => !a || !b || String(a).toLowerCase() === String(b).toLowerCase();
/** What a log is about: its description, or for a log from before descriptions, its summary. */
const describe = (l) => l.meta.description || logSummary(l.body);
const aboutOf = (x) => (x && x.meta ? { title: x.meta.title, angle: x.meta.angle, description: describe(x) } : x);
/** The same story: the same angle, and a similar title or a similar description. Takes topics, logs or log metas. */
function sameTopic(a, b) {
  const x = aboutOf(a);
  const y = aboutOf(b);
  return sameAngle(x.angle, y.angle) && (sameTitle(x.title, y.title) || sameDescription(x.description, y.description));
}
const isTombstoned = (topic, deleted) => deleted.some((d) => sameTopic(d, topic));

/** A log by id, following merges: an id merged into another log resolves to the log that absorbed it. */
function resolveLog(id) {
  return store.findLog(id) || store.allLogs().find((l) => (l.meta.merged_from || []).includes(id)) || null;
}

/** A ledger from before topics: the session's one log was deleted, and no topic was remembered. */
const legacyDeleted = (ledger) => Boolean(ledger && ledger.deleted && !(ledger.deletedTopics || []).length);

/**
 * Drop deleted topics (unless the topic updates a log that still exists), keep only same_as ids that resolve,
 * and let each existing log be claimed by one topic only: the best-scored one. Topics come best first.
 * With `shown` (the logs in the prompt), same_as may only name those: never a log the model did not see.
 */
function screenTopics(found, deleted, shown) {
  const known = shown && new Set(shown.flatMap((l) => [l.meta.id, ...(l.meta.merged_from || [])]));
  const claimed = new Set();
  const out = [];
  for (const x of found) {
    const named = known ? x.same_as.filter((id) => known.has(id)) : x.same_as;
    const live = [...new Set(named.map(resolveLog).filter(Boolean).map((l) => l.meta.id))];
    if (!live.length && isTombstoned(x, deleted)) continue;
    // Every log it names went to a better topic. Another angle on that work is still a new topic; the same
    // story told again (same angle, a similar title), or a deleted one, is dropped.
    if (live.length && live.every((id) => claimed.has(id))) {
      const twins = [...live.map(resolveLog).filter(Boolean), ...out];
      if (isTombstoned(x, deleted) || twins.some((t) => sameTopic(t, x))) continue;
    }
    x.same_as = live.filter((id) => !claimed.has(id));
    for (const id of x.same_as) claimed.add(id);
    out.push(x);
  }
  return out;
}

function renderBody(n) {
  const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '_none noted_');
  const para = (s) => s || '_none noted_';
  return [
    `# ${n.title}`,
    '',
    n.summary,
    '',
    '## Problem', para(n.problem), '',
    '## Constraints', list(n.constraints), '',
    '## Approach', para(n.approach), '',
    '## Alternatives considered', list(n.alternatives), '',
    '## Outcome', para(n.outcome), '',
    '## Evidence', list(n.evidence), '',
    '## Key decision', n.quote ? `> ${n.quote}` : '_none noted_', '',
    '## Open threads', list(n.open_threads), '',
  ].join('\n');
}

const uniq = (xs) => [...new Set(xs.filter((x) => x !== undefined && x !== null && x !== ''))];
function uniqMarks(marks) {
  const seen = new Set();
  return marks.filter((m) => { const k = `${m.at}|${m.note}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Write one topic: update the log(s) it is the same as, or create a new log. When it is the same as several
 * logs, they were duplicates: they merge into the first one, and the others' IDs resolve to it.
 *
 * ctx: { members: [{ sessionId, startedAt, endedAt, userTurns, branch, files, root }], info: { project, repo, policy, root },
 *        marks, note?, commits }
 * Writes exactly the logs in same_as (or a new log). Call with the store lock held.
 */
function applyTopic(topic, ctx) {
  const sids = ctx.members.map((m) => m.sessionId);
  const targets = [...new Map(topic.same_as.map(resolveLog).filter(Boolean).map((l) => [l.meta.id, l])).values()];
  // Each session's files relative to its own checkout: sessions of one log may run in different worktrees.
  const relFiles = (m) => { const root = m.root || ctx.info.root; return root ? m.files.map((f) => path.relative(root, f) || f) : m.files; };
  const ordered = [...ctx.members].sort((a, b) => t0(a.startedAt) - t0(b.startedAt));
  const turns = {};
  for (const l of targets) Object.assign(turns, l.meta.session_turns || (l.meta.session_id ? { [l.meta.session_id]: l.meta.user_turns || 0 } : {}));
  for (const m of ctx.members) turns[m.sessionId] = m.userTurns || 0;

  const survivor = targets[0] || null;
  const merged = targets.slice(1);
  const prior = targets;
  const sessions = uniq([...prior.flatMap(sessionsOf), ...sids]);
  const starts = [...prior.map((l) => l.meta.started_at), ...ordered.map((m) => m.startedAt)].filter(Boolean).sort();
  const ends = [...prior.map((l) => l.meta.ended_at), ...ordered.map((m) => m.endedAt)].filter(Boolean).sort();

  const meta = {
    title: topic.title,
    angle: topic.angle || (survivor && survivor.meta.angle) || '',
    description: topic.description || (survivor && survivor.meta.description) || '',
    project: ctx.info.project,
    repo: ctx.info.repo || null,
    policy: ctx.info.policy,
    profile: paths.profileName(),
    score: topic.score,
    marked: false,
    marks: uniqMarks([...prior.flatMap((l) => l.meta.marks || []), ...ctx.marks]),
    tags: topic.tags,
    session_id: sessions[0],
    sessions,
    session_turns: turns,
    branch: ordered[ordered.length - 1].branch || (survivor && survivor.meta.branch) || null,
    started_at: starts[0] || null,
    ended_at: ends[ends.length - 1] || null,
    user_turns: Object.values(turns).reduce((a, b) => a + b, 0),
    scanned_at: new Date().toISOString(),
    commits: uniq([...prior.flatMap((l) => l.meta.commits || []), ...(ctx.commits || [])]).slice(-60),  // the newest stay
    files: uniq([...prior.flatMap((l) => l.meta.files || []), ...ordered.flatMap(relFiles)]),
  };
  meta.marked = meta.marks.length > 0;
  const note = ctx.note || (survivor && survivor.meta.discovery_note);
  if (note) meta.discovery_note = note;
  // A scan that sees only some of a log's sessions must not lower its score.
  const unseen = prior.some((l) => sessionsOf(l).some((sid) => !sids.includes(sid)));
  if (unseen) {
    meta.score = Math.max(meta.score, ...prior.map((l) => l.meta.score || 0));
    // Nor make public what another session of the log keeps private.
    if (meta.policy === 'public' && prior.some((l) => l.meta.policy && l.meta.policy !== 'public')) meta.policy = 'anonymize';
  }
  const body = renderBody(topic);

  // A session closed by an older casebook (its log deleted before topics) has a log again: discovery may scan it.
  for (const sid of sids) {
    const l = store.getLedger(sid);
    if (l && l.deleted) store.setLedger(sid, { deleted: undefined, deletedAt: undefined });
  }

  if (!survivor) {
    const log = store.createLogFile(ctx.info.project, meta, body);
    return { status: 'created', logId: log.meta.id, score: topic.score, title: topic.title, angle: meta.angle, merged: [] };
  }
  const was = { project: survivor.meta.project, repo: survivor.meta.repo, policy: survivor.meta.policy };
  survivor.meta = {
    ...survivor.meta, ...meta,
    merged_from: uniq([...(survivor.meta.merged_from || []), ...merged.map((l) => l.meta.id), ...merged.flatMap((l) => l.meta.merged_from || [])]),
  };
  // Fields older casebooks kept that nothing reads any more.
  for (const k of ['partial', 'partial_sessions', 'scouted_at', 'scout_mode']) delete survivor.meta[k];
  if (!survivor.meta.merged_from.length) delete survivor.meta.merged_from;
  survivor.body = body;
  // A session whose folder is gone resolves to a guess (its folder's name, no repo): the log keeps the project
  // and repo it already had, and only ever gets a stricter policy.
  if (!ctx.info.root && was.project) {
    survivor.meta.project = was.project;
    survivor.meta.repo = was.repo || null;
    const policies = [was.policy, ...merged.map((l) => l.meta.policy), ctx.info.policy];
    if (policies.some((x) => x && x !== 'public')) survivor.meta.policy = 'anonymize';
  }
  // Logs live in their project's folder: a log now under another project moves with it.
  const oldFile = survivor.file;
  const want = path.join(paths.logs(), survivor.meta.project, path.basename(oldFile));
  if (path.dirname(oldFile) !== path.dirname(want)) { fs.mkdirSync(path.dirname(want), { recursive: true }); survivor.file = want; }
  store.saveLog(survivor);
  if (survivor.file !== oldFile) {
    fs.rmSync(oldFile, { force: true });
    try { fs.rmdirSync(path.dirname(oldFile)); } catch { /* not empty */ }
  }
  for (const l of merged) {
    fs.rmSync(l.file, { force: true });
    try { fs.rmdirSync(path.dirname(l.file)); } catch { /* not empty */ }
  }
  return { status: 'updated', logId: survivor.meta.id, score: meta.score, title: topic.title, angle: meta.angle, merged: merged.map((l) => l.meta.id) };
}

module.exports = {
  sessionsOf, logsForSessions, contextLogs, tombstones, renderExisting, parseTopics, normalizeTopic,
  isTombstoned, sameTitle, sameDescription, sameTopic, describe, renderBody, applyTopic, normTitle, resolveLog, legacyDeleted, screenTopics, sameAngle,
};
