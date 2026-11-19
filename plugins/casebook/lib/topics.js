'use strict';
// Topics: a log is one topic, not one session. A session can feed several logs (different angles), and a log
// can draw on several sessions. Every scan sees the logs already near its sessions, so it updates a topic
// that is already logged instead of logging it twice.

const fs = require('fs');
const path = require('path');
const { paths, ID_RE } = require('./util');
const store = require('./store');

const NEAR_DAYS = 14;     // logs of the same project this close in time are shown to the model
const MAX_CONTEXT = 8;    // existing logs shown to the model
const BODY_CHARS = 3000;  // of each existing log's notes

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
 * The logs a scan of these sessions must know about: every log drawing on them first, then the project's
 * logs from around the same time (a continued session may carry on a topic logged from another one).
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
  return [...overlap, ...near].slice(0, MAX_CONTEXT);
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
    const body = l.body.length > BODY_CHARS ? `${l.body.slice(0, BODY_CHARS)} …` : l.body;
    parts.push(`### ${m.id} · ${m.angle || 'general'} · score ${m.score ?? '-'} · ${where}\n${body.trim()}`);
  }
  if (deleted.length) {
    parts.push('### Deleted by the developer (never return these topics)');
    for (const d of deleted) parts.push(`- "${d.title}"${d.angle ? ` (${d.angle})` : ''}`);
  }
  return parts.join('\n\n');
}

const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

function normalizeTopic(n) {
  return {
    score: Math.max(1, Math.min(5, Math.round(Number(n.score) || 1))),
    title: String(n.title || 'Untitled session').slice(0, 120),
    angle: String(n.angle || '').toLowerCase().trim().slice(0, 40),
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
  if (start < 0 || end <= start) throw new Error(`scout returned no JSON: ${s.slice(0, 200)}`);
  const raw = JSON.parse(s.slice(start, end + 1));
  const list = Array.isArray(raw.topics) ? raw.topics : [raw];
  return list.filter((x) => x && typeof x === 'object').map(normalizeTopic)
    .sort((a, b) => b.score - a.score).slice(0, max || 3);
}

const isTombstoned = (topic, deleted) => deleted.some((d) => normTitle(d.title) === normTitle(topic.title));

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
 * logs, they were duplicates: they merge into one (a written-up log survives, so its ID stays valid).
 *
 * ctx: { members: [{ sessionId, startedAt, endedAt, userTurns, branch, files }], info: { project, repo, policy, root },
 *        marks, partial, mode, note?, commits }
 * Call with the store lock held.
 */
function applyTopic(topic, ctx) {
  const sids = ctx.members.map((m) => m.sessionId);
  let targets = topic.same_as.map((id) => store.findLog(id)).filter(Boolean);
  if (!targets.length) {
    // Never log the same title twice for the same sessions, even if the model did not say so.
    const twin = logsForSessions(sids).find((l) => normTitle(l.meta.title) === normTitle(topic.title));
    if (twin) targets = [twin];
  }
  const relFiles = (m) => (ctx.info.root ? m.files.map((f) => path.relative(ctx.info.root, f) || f) : m.files);
  const ordered = [...ctx.members].sort((a, b) => t0(a.startedAt) - t0(b.startedAt));
  const turns = {};
  for (const l of targets) Object.assign(turns, l.meta.session_turns || (l.meta.session_id ? { [l.meta.session_id]: l.meta.user_turns || 0 } : {}));
  for (const m of ctx.members) turns[m.sessionId] = m.userTurns || 0;

  const survivor = targets.find((l) => (l.meta.written_to || []).length) || targets[0] || null;
  const merged = targets.filter((l) => l !== survivor);
  const prior = survivor ? [survivor, ...merged] : [];
  const sessions = uniq([...prior.flatMap(sessionsOf), ...sids]);
  const starts = [...prior.map((l) => l.meta.started_at), ...ordered.map((m) => m.startedAt)].filter(Boolean).sort();
  const ends = [...prior.map((l) => l.meta.ended_at), ...ordered.map((m) => m.endedAt)].filter(Boolean).sort();

  const meta = {
    title: topic.title,
    angle: topic.angle || (survivor && survivor.meta.angle) || '',
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
    partial: ctx.partial,
    scouted_at: new Date().toISOString(),
    scout_mode: ctx.mode,
    commits: uniq([...prior.flatMap((l) => l.meta.commits || []), ...(ctx.commits || [])]).slice(0, 60),
    files: uniq([...prior.flatMap((l) => l.meta.files || []), ...ordered.flatMap(relFiles)]),
  };
  meta.marked = meta.marks.length > 0;
  const note = ctx.note || (survivor && survivor.meta.discovery_note);
  if (note) meta.discovery_note = note;
  const body = renderBody(topic);

  if (!survivor) {
    const log = store.createLogFile(ctx.info.project, { ...meta, written_to: [] }, body);
    return { status: 'created', logId: log.meta.id, score: topic.score, title: topic.title, angle: meta.angle, merged: [] };
  }
  survivor.meta = {
    ...survivor.meta, ...meta,
    written_to: uniq(prior.flatMap((l) => l.meta.written_to || [])),
    merged_from: uniq([...(survivor.meta.merged_from || []), ...merged.map((l) => l.meta.id), ...merged.flatMap((l) => l.meta.merged_from || [])]),
  };
  if (!survivor.meta.merged_from.length) delete survivor.meta.merged_from;
  survivor.body = body;
  store.saveLog(survivor);
  for (const l of merged) {
    fs.rmSync(l.file, { force: true });
    try { fs.rmdirSync(path.dirname(l.file)); } catch { /* not empty */ }
  }
  return { status: 'updated', logId: survivor.meta.id, score: topic.score, title: topic.title, angle: meta.angle, merged: merged.map((l) => l.meta.id) };
}

module.exports = {
  sessionsOf, logsForSessions, contextLogs, tombstones, renderExisting, parseTopics, normalizeTopic,
  isTombstoned, renderBody, applyTopic, normTitle,
};
