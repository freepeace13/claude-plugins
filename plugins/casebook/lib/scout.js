'use strict';
// Scout: condense a session, ask a cheap headless Claude for case-study notes, write/update the log.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PLUGIN_ROOT, paths, sessionKey, readJson, writeJsonAtomic, logError } = require('./util');
const store = require('./store');
const { condense, findTranscript } = require('./transcript');
const { resolveProject, commitsBetween } = require('./project');

const POLICY_RULES = {
  public:
    'Public: you may name the project, repository, libraries and the developer\'s own product. Still do not name third-party clients or people.',
  anonymize:
    'Anonymize: this may be client or employer work. Do NOT name the client, company, product, repository, domain, people, or internal URLs. Describe them generically ("a logistics SaaS", "a fintech client"). Keep the technical story, stack and numbers.',
};

function buildPrompt(t, info, marks, commits) {
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'prompts', 'scout.md'), 'utf8');
  const notes = marks.map((m) => m.note).filter(Boolean);
  const vars = {
    MARKED_HINT: marks.length ? `(${marks.length} mark${marks.length > 1 ? 's' : ''})` : 'NOT (no marks)',
    POLICY: info.policy,
    POLICY_RULES: POLICY_RULES[info.policy] || POLICY_RULES.anonymize,
    PROJECT: info.policy === 'public' ? `${info.project}${info.repo ? ` (${info.repo})` : ''}` : '[anonymized]',
    BRANCH: t.branch || 'unknown',
    MARKS: notes.length ? notes.map((n) => `"${n}"`).join('; ') : marks.length ? '(marked, no note)' : 'none',
    COMMITS: commits.length ? commits.map((c) => `- ${c}`).join('\n') : '- none',
    FILES: t.files.length ? t.files.slice(0, 40).map((f) => `- ${info.root ? path.relative(info.root, f) || f : f}`).join('\n') : '- none',
    TRANSCRIPT: t.text,
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

function childEnv() {
  const env = { ...process.env, CASEBOOK_SCOUT: '1' };
  if (paths.claudeConfigDirExplicit()) env.CLAUDE_CONFIG_DIR = paths.claudeConfigDir();
  return env;
}

function runClaude(prompt, config) {
  const cmd = config.scout.command || 'claude';
  const hardened = ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
  const base = ['-p', '--model', config.scout.model || 'haiku', '--tools', '', '--output-format', 'text'];
  const opts = {
    input: prompt,
    encoding: 'utf8',
    timeout: (config.scout.timeoutSec || 240) * 1000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: os.tmpdir(),
    // Run as the session's profile, even from a terminal with no inherited value.
    env: childEnv(),
  };
  let r = spawnSync(cmd, [...base, ...hardened], opts);
  // Older Claude Code versions may not know every hardening flag: retry with the essentials.
  if (r.status !== 0 && /unknown option|unrecognized/i.test(`${r.stderr}${r.stdout}`)) {
    r = spawnSync(cmd, [...base, '--no-session-persistence'], opts);
  }
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`scout exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return r.stdout;
}

function parseNotes(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`scout returned no JSON: ${s.slice(0, 200)}`);
  const n = JSON.parse(s.slice(start, end + 1));
  const arr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);
  return {
    score: Math.max(1, Math.min(5, Math.round(Number(n.score) || 1))),
    title: String(n.title || 'Untitled session').slice(0, 120),
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
  };
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

/**
 * Scout one session. Returns { status, logId?, reason?, partial? }.
 * status: created | updated | skipped | running
 *
 * args: { sessionId, transcriptPath?, cwd?, mode: 'auto'|'manual', live?, force? }
 *  - auto (hooks, catch-up) applies every gate; waits for a scout already running on the session.
 *  - manual (user-run) bypasses the turn / score / regrow gates; returns { status: 'running' } instead of waiting.
 */
function scoutSession(args, config) {
  const mode = args.mode === 'auto' ? 'auto' : 'manual';
  const timeoutMs = (config.scout.timeoutSec || 240) * 1000;
  // Hook scouts wait for a running scout of the session; catch-up passes (noWait) move on to the next one.
  const release = acquireSessionLock(args.sessionId, { wait: mode === 'auto' && !args.noWait, timeoutMs });
  if (!release) {
    return { status: 'running', reason: mode === 'manual' ? 'A scout for this session is already running. Check /casebook:list in a minute.' : args.noWait ? 'another scout of this session is running' : 'timed out waiting for another scout of this session' };
  }
  try { return scoutSessionLocked({ ...args, mode }, config); } finally { release(); }
}

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

/** Dead holder, expired lock, or a lock file a crashed scout left empty/garbled (given 10s of grace). */
function lockIsStale(file, staleMs) {
  let holder = null;
  let ageMs = 0;
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (h && typeof h === 'object' && Number.isInteger(h.pid) && Number.isFinite(h.startedAt)) holder = h;
    ageMs = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { return false; } // released
  }
  return holder ? !pidAlive(holder.pid) || Date.now() - holder.startedAt > staleMs : ageMs > 10000;
}

/**
 * Serialize scouts of the same session (state/locks/<id>.lock = {pid, startedAt}). A resumed session
 * can end while an earlier scout is still running; without this both would see no log yet and each
 * create one. The ledger is read only after the lock is held, so the later scout sees the first one's
 * result. Returns a release function, or null when the lock is held and we were told not to wait
 * (or the wait ran out).
 */
function acquireSessionLock(sessionId, { wait, timeoutMs }) {
  const file = path.join(paths.locks(), `${sessionKey(sessionId)}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A scout can take up to two model runs (the flag-fallback retry), so a live holder is not stale before that.
  const staleMs = 2 * timeoutMs + 60000;
  const deadline = Date.now() + staleMs;
  const mine = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  for (;;) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      // Only remove the lock if it is still ours (a reclaimed lock now belongs to someone else).
      return () => { try { if (fs.readFileSync(file, 'utf8') === mine) fs.rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (lockIsStale(file, staleMs)) {
      // Reclaim under a gate so the check and the removal can't interleave with another waiter's:
      // only the gate holder ever removes an existing lock, and it re-checks first.
      const gate = `${file}.reclaim`;
      try {
        fs.writeFileSync(gate, String(process.pid), { flag: 'wx' });
        try { if (lockIsStale(file, staleMs)) fs.rmSync(file, { force: true }); } finally { fs.rmSync(gate, { force: true }); }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Someone else is reclaiming; a gate left by a crashed process expires.
        try { if (Date.now() - fs.statSync(gate).mtimeMs > 10000) fs.rmSync(gate, { force: true }); } catch { /* gone */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      continue;
    }
    if (!wait || Date.now() > deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}

function scoutSessionLocked({ sessionId, transcriptPath, cwd, mode, live = false, force = false, partialIfRecent = false }, config) {
  const manual = mode === 'manual';
  const tp = transcriptPath && fs.existsSync(transcriptPath) ? transcriptPath : findTranscript(sessionId);
  if (!tp) return { status: 'skipped', reason: 'transcript not found' };
  const st = fs.statSync(tp);
  const size = st.size;
  const ledger = store.getLedger(sessionId) || {};
  if (ledger.deleted && !(manual && force)) {
    return { status: 'skipped', reason: "this session's log was deleted (use --force to scout it again)" };
  }

  const t = condense(tp, config.scout.maxChars);
  const info = resolveProject(cwd || t.cwd, config);
  if (info.policy === 'skip') {
    store.setLedger(sessionId, { skipped: 'policy', size });
    return { status: 'skipped', reason: 'project policy is skip' };
  }

  // A log is partial when scouted while its session may still be running.
  const settleMs = (config.sweep.settleMinutes || 0) * 60000;
  // Manual scouts, and catch-up passes that skip the settle delay, may be looking at a session that is still running.
  const recent = Date.now() - st.mtimeMs < settleMs;
  const partial = live || ((manual || partialIfRecent) && recent);

  const existing = !ledger.deleted && ledger.logId ? store.findLog(ledger.logId) : null;
  if (!manual && existing) {
    // An auto scout finishes a partial log if the transcript grew at all; otherwise the regrow threshold applies.
    const wasPartial = existing.meta.partial === true || ledger.partial === true;
    // New marks count as new content: the log has to be re-scouted to pick them up.
    const grew = t.userTurns > (ledger.userTurns || 0) || size !== ledger.size || store.getMarks(sessionId).length > 0;
    if (wasPartial && !grew && !live && !(partialIfRecent && recent)) {
      // The session is over (hook) or settled and nothing was added since the partial scout:
      // the notes are already complete, so finish the log without another model call.
      existing.meta.partial = false;
      store.saveLog(existing);
      store.setLedger(sessionId, { partial: false, size });
      return { status: 'updated', logId: existing.meta.id, score: existing.meta.score, title: existing.meta.title, partial: false };
    }
    if (!(wasPartial && grew) && t.userTurns - (ledger.userTurns || 0) < (config.sweep.regrowTurns || 8)) {
      store.setLedger(sessionId, { size });
      return { status: 'skipped', reason: 'already logged, not enough new activity' };
    }
  }

  // Marks: ones already on the log, pending ones from /casebook:mark, and any /casebook:mark
  // invocations found in the transcript (a fallback in case the mark command itself failed).
  const prior = existing ? existing.meta.marks || [] : [];
  const pending = store.getMarks(sessionId);
  const seen = new Set([...prior, ...pending].map((m) => m.note));
  for (const note of t.commandMarks) {
    if (!seen.has(note)) { pending.push({ at: t.endedAt, note }); seen.add(note); }
  }
  const marks = [...prior, ...pending];

  // The turn and score gates decide whether a session earns a log at all; a session that already has one is just updated.
  const gated = !manual && !existing && !marks.length;
  if (gated && t.userTurns < config.scout.minTurns) {
    store.setLedger(sessionId, { skipped: 'short', userTurns: t.userTurns, size });
    return { status: 'skipped', reason: `only ${t.userTurns} turns` };
  }

  const commits = commitsBetween(info.root, t.startedAt, t.endedAt);
  const notes = parseNotes(runClaude(buildPrompt(t, info, marks, commits), config));

  if (gated && notes.score < config.scout.keepMinScore) {
    store.setLedger(sessionId, { skipped: 'low-score', score: notes.score, userTurns: t.userTurns, size });
    return { status: 'skipped', reason: `score ${notes.score}` };
  }

  const meta = {
    title: notes.title,
    project: info.project,
    repo: info.repo || null,
    policy: info.policy,
    profile: paths.profileName(),
    score: notes.score,
    marked: marks.length > 0,
    marks,
    tags: notes.tags,
    session_id: sessionId,
    branch: t.branch,
    started_at: t.startedAt,
    ended_at: t.endedAt,
    user_turns: t.userTurns,
    partial,
    scouted_at: new Date().toISOString(),
    scout_mode: mode,
    commits,
    files: info.root ? t.files.map((f) => path.relative(info.root, f) || f) : t.files,
  };
  const body = renderBody(notes);

  let log;
  if (existing) {
    log = existing;
    log.meta = { ...existing.meta, ...meta, written_to: existing.meta.written_to };
    log.body = body;
    store.saveLog(log);
  } else {
    log = store.createLogFile(info.project, { ...meta, written_to: [] }, body);
  }
  store.clearMarks(sessionId);
  store.setLedger(sessionId, {
    logId: log.meta.id, project: info.project, userTurns: t.userTurns, size, partial,
    skipped: undefined, deleted: undefined, deletedAt: undefined,
  });
  return { status: existing ? 'updated' : 'created', logId: log.meta.id, score: notes.score, title: notes.title, partial };
}

// ---------- sweep: catch sessions whose SessionEnd hook never ran ----------

// One catch-up pass at a time per store. Created atomically; a holder is stale when its process is gone
// (or after 6 hours, in case the pid was reused). Only the process that wrote the lock removes it.
let sweepToken = null;

function acquireLock() {
  const file = paths.lock();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, t: Date.now() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      sweepToken = mine;
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const cur = readJson(file, null);
    if (cur && Number.isInteger(cur.pid)) {
      if (pidAlive(cur.pid) && Date.now() - cur.t < 6 * 3600000) return false;
    } else {
      // Empty or garbled: a holder that is still writing it gets a few seconds.
      try { if (Date.now() - fs.statSync(file).mtimeMs < 10000) return false; } catch { continue; }
    }
    fs.rmSync(file, { force: true });
  }
  return false;
}
const releaseLock = () => {
  try { if (fs.readFileSync(paths.lock(), 'utf8') === sweepToken) fs.rmSync(paths.lock(), { force: true }); } catch { /* gone */ }
};

function candidateTranscripts({ since, exclude, settleMinutes = 0 }) {
  const root = paths.claudeProjects();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  const settled = Date.now() - settleMinutes * 60000;
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sessionId = n.slice(0, -6);
      if (sessionId === exclude) continue;
      const file = path.join(root, d, n);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (since && st.mtimeMs < since.getTime()) continue;
      if (st.mtimeMs > settled) continue;
      const ledger = store.getLedger(sessionId);
      if (ledger && (ledger.deleted || ledger.skipped === 'policy' || ledger.size === st.size)) continue;
      out.push({ sessionId, transcriptPath: file, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Catch up on sessions whose SessionEnd hook never ran. Each is scouted in auto mode, so every gate applies.
 * With dryRun, nothing is scouted: returns the candidates with their project and user turns.
 * Returns { results, locked }; locked means another catch-up is already running.
 */
function sweep(config, { since, exclude, limit, settleMinutes, dryRun, partialIfRecent, onResult } = {}) {
  if (dryRun) {
    const list = candidateTranscripts({ since, exclude, settleMinutes }).slice(0, limit || undefined);
    const results = list.map((c) => {
      let userTurns = null;
      let project = null;
      try {
        const t = condense(c.transcriptPath, config.scout.maxChars);
        userTurns = t.userTurns;
        project = resolveProject(t.cwd, config).project;
      } catch { /* unreadable: list it anyway */ }
      return { ...c, status: 'candidate', project, userTurns };
    });
    return { results, locked: false };
  }
  if (!acquireLock()) return { results: [], locked: true };
  const results = [];
  try {
    const list = candidateTranscripts({ since, exclude, settleMinutes });
    let spent = 0; // sessions skipped because another scout holds them don't use up the limit
    for (const c of list) {
      if (limit && spent >= limit) break;
      try {
        const r = scoutSession({ ...c, mode: 'auto', partialIfRecent, noWait: true }, config);
        if (r.status !== 'running') spent++;
        results.push({ ...c, ...r });
        if (onResult) onResult(c, r);
      } catch (err) {
        spent++;
        logError(`scout failed for ${c.sessionId}`, err);
        results.push({ ...c, status: 'error', reason: err.message });
        if (onResult) onResult(c, { status: 'error', reason: err.message });
      }
    }
  } finally {
    releaseLock();
  }
  return { results, locked: false };
}

module.exports = { scoutSession, sweep, parseNotes, renderBody, buildPrompt };
