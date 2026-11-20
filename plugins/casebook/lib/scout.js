'use strict';
// Scout: condense a session, ask a cheap headless Claude for case-study notes, write/update the log.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PLUGIN_ROOT, paths, sessionKey, readJson, writeJsonAtomic, logError } = require('./util');
const store = require('./store');
const T = require('./topics');
const { condense, findTranscript } = require('./transcript');
const { resolveProject, commitsBetween } = require('./project');

const POLICY_RULES = {
  public:
    'Public: you may name the project, repository, libraries and the developer\'s own product. Still do not name third-party clients or people.',
  anonymize:
    'Anonymize: this may be client or employer work. Do NOT name the client, company, product, repository, domain, people, or internal URLs. Describe them generically ("a logistics SaaS", "a fintech client"). Keep the technical story, stack and numbers.',
};

function buildPrompt(t, info, marks, commits, existing = 'None yet.', maxTopics = 3) {
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'prompts', 'scout.md'), 'utf8');
  const notes = marks.map((m) => m.note).filter(Boolean);
  const vars = {
    MARKED_HINT: marks.length ? `(${marks.length} mark${marks.length > 1 ? 's' : ''})` : 'NOT (no marks)',
    POLICY: info.policy,
    POLICY_RULES: POLICY_RULES[info.policy] || POLICY_RULES.anonymize,
    PROJECT: info.policy === 'public' ? `${info.project}${info.repo ? ` (${info.repo})` : ''}` : '[anonymized]',
    BRANCH: info.policy === 'public' ? t.branch || 'unknown' : '[anonymized]',
    MARKS: notes.length ? notes.map((n) => `"${n}"`).join('; ') : marks.length ? '(marked, no note)' : 'none',
    COMMITS: commits.length ? commits.map((c) => `- ${c}`).join('\n') : '- none',
    FILES: t.files.length ? t.files.slice(0, 40).map((f) => `- ${info.root ? path.relative(info.root, f) || f : f}`).join('\n') : '- none',
    TRANSCRIPT: t.text,
    EXISTING: existing,
    MAX_TOPICS: String(maxTopics),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
}

function childEnv() {
  const env = { ...process.env, CASEBOOK_SCOUT: '1' };
  if (paths.claudeConfigDirExplicit()) env.CLAUDE_CONFIG_DIR = paths.claudeConfigDir();
  return env;
}

function claudeInvocation(config) {
  const cmd = config.scout.command || 'claude';
  const hardened = ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
  const base = ['-p', '--model', config.scout.model || 'haiku', '--tools', '', '--output-format', 'text'];
  return { cmd, full: [...base, ...hardened], fallback: [...base, '--no-session-persistence'] };
}

// Older Claude Code versions may not know every hardening flag: retry with the essentials.
const unknownFlag = (r) => r.status !== 0 && /unknown option|unrecognized/i.test(`${r.stderr}${r.stdout}`);

function checkRun(r) {
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`scout exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return r.stdout;
}

function runClaude(prompt, config) {
  const { cmd, full, fallback } = claudeInvocation(config);
  const opts = {
    input: prompt,
    encoding: 'utf8',
    timeout: (config.scout.timeoutSec || 240) * 1000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: os.tmpdir(),
    // Run as the session's profile, even from a terminal with no inherited value.
    env: childEnv(),
  };
  let r = spawnSync(cmd, full, opts);
  if (unknownFlag(r)) r = spawnSync(cmd, fallback, opts);
  return checkRun(r);
}

/** runClaude without blocking, so several scouts can run side by side. Resolves to stdout. */
async function runClaudeAsync(prompt, config) {
  const { cmd, full, fallback } = claudeInvocation(config);
  const once = (args) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout, stderr, ...r }); } };
    const child = spawn(cmd, args, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ status: null, error: new Error(`scout timed out after ${config.scout.timeoutSec || 240}s`) }); },
      (config.scout.timeoutSec || 240) * 1000);
    // Decode as a stream: a character split across two chunks must not turn into U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status) => finish({ status }));
    child.stdin.on('error', () => { /* the child may exit before reading everything */ });
    child.stdin.end(prompt);
  });
  let r = await once(full);
  if (unknownFlag(r)) r = await once(fallback);
  return checkRun(r);
}

/**
 * Scout one session for topics. Returns { status, logs?, logId?, reason?, partial? }; logId, score and title are
 * the highest-scored log's (after merging). status: created (at least one new log) | updated | skipped | running
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
  // Every log from this session was deleted: hooks and catch-ups leave it alone, unless the developer marked
  // it since. A manual scout may look again.
  if (ledger.deleted && !manual && !store.getMarks(sessionId).length) return { status: 'skipped', reason: "this session's logs were deleted" };
  // Deleted before topics existed: nothing says which topic it was, so the whole session stays closed.
  if (T.legacyDeleted(ledger) && !force) return { status: 'skipped', reason: "this session's log was deleted (use --force to scout it again)" };

  const t = condense(tp, config.scout.maxChars);
  const info = resolveProject(cwd || t.cwd, config);
  if (info.policy === 'skip') {
    store.withWriteLock(() => store.setLedger(sessionId, { skipped: 'policy', size }));
    return { status: 'skipped', reason: 'project policy is skip' };
  }

  // A log is partial when scouted while its session may still be running.
  const settleMs = (config.sweep.settleMinutes || 0) * 60000;
  // Manual scouts, and catch-up passes that skip the settle delay, may be looking at a session that is still running.
  const recent = Date.now() - st.mtimeMs < settleMs;
  const partial = live || ((manual || partialIfRecent) && recent);

  let mine = T.logsForSessions([sessionId]);
  // Notes the developer unmarked: a /casebook:mark for them in the transcript is not a mark any more.
  const unmarked = new Set(ledger.unmarked || []);
  // A bare /casebook:mark shows in the transcript with no note: the skill wrote one, so once `casebook mark`
  // recorded it, the transcript copy is not a separate mark. It is only a fallback if that command failed.
  const commandMarks = t.commandMarks.filter((n) => n || !ledger.sessionMarked);
  const scanned = Boolean(ledger.scoutedAt || ledger.logId || mine.length);
  if (!manual && scanned) {
    // An auto scout finishes partial logs if the transcript grew at all; otherwise the regrow threshold applies.
    const wasPartial = mine.some((l) => T.partialSessionsOf(l).includes(sessionId)) || ledger.partial === true;
    // New marks count as new content: the session has to be scanned again to pick them up.
    const grew = t.userTurns > (ledger.userTurns || 0) || size !== ledger.size || store.getMarks(sessionId).length > 0;
    if (wasPartial && !grew && !live && !(partialIfRecent && recent)) {
      // The session is over (hook) or settled and nothing was added since the partial scout:
      // the notes are already complete, so finish the logs without another model call.
      // Each log is read again under the lock: another session's scan may have updated it since.
      // Only for this session: a log another running session feeds stays partial for that one.
      // Ledger writes take the lock too: a delete or unmark writes the same ledger under it.
      store.withWriteLock(() => { T.finishSession(sessionId); store.setLedger(sessionId, { partial: false, size }); });
      mine = T.logsForSessions([sessionId]);
      const best = [...mine].sort((a, b) => (b.meta.score || 0) - (a.meta.score || 0))[0];
      if (!best) return { status: 'skipped', reason: 'nothing new since the last scan' };
      return { status: 'updated', logId: best.meta.id, score: best.meta.score, title: best.meta.title, partial: false,
        logs: mine.map((l) => ({ status: 'updated', logId: l.meta.id, score: l.meta.score, title: l.meta.title, angle: l.meta.angle || '' })) };
    }
    // A pending mark always earns a rescan: with several logs, the mark waits for the scan to place it.
    const hasPending = store.getMarks(sessionId).length > 0 || commandMarks.some((n) => !unmarked.has(n) && !mine.some((l) => (l.meta.marks || []).some((m) => m.note === n)));
    if (!(wasPartial && grew) && !hasPending && t.userTurns - (ledger.userTurns || 0) < (config.sweep.regrowTurns || 8)) {
      store.withWriteLock(() => store.setLedger(sessionId, { size }));
      return { status: 'skipped', reason: 'already scanned, not enough new activity' };
    }
  }

  // Marks: pending ones from /casebook:mark, and any /casebook:mark invocations found in the transcript
  // (a fallback in case the mark command itself failed) that no log of this session has yet.
  const pending = store.getMarks(sessionId);
  const seen = new Set([...mine.flatMap((l) => l.meta.marks || []), ...pending].map((m) => m.note));
  for (const note of commandMarks) {
    if (!seen.has(note) && !unmarked.has(note)) { pending.push({ at: t.endedAt, note }); seen.add(note); }
  }
  const promptMarks = [...mine.flatMap((l) => l.meta.marks || []), ...pending];

  // The turn and score gates decide whether a session earns a log at all; a session already scanned is just rescanned.
  const gated = !manual && !scanned && !pending.length;
  if (gated && t.userTurns < config.scout.minTurns) {
    store.withWriteLock(() => store.setLedger(sessionId, { skipped: 'short', userTurns: t.userTurns, size }));
    return { status: 'skipped', reason: `only ${t.userTurns} turns` };
  }

  const commits = commitsBetween(info.root, t.startedAt, t.endedAt);
  const deleted = force ? [] : T.tombstones([sessionId]);
  const maxTopics = config.scout.maxTopics || 3;
  const member = { sessionId, startedAt: t.startedAt, endedAt: t.endedAt, userTurns: t.userTurns, branch: t.branch, files: t.files };
  // The model call runs without the lock, so another scan may update a log shown to it meanwhile. The
  // notes are then written only if nothing it saw changed; otherwise the scan runs again on the new notes.
  let logs = null;
  for (let attempt = 1; !logs; attempt++) {
    if (attempt > 3) throw new Error('the logs of this session kept changing during the scan; try again');
    const context = T.contextLogs(info.project, [sessionId], t.startedAt, t.endedAt);
    const versions = T.versionsOf(context);
    const takenAt = new Date().toISOString();
    const prompt = buildPrompt(t, info, promptMarks, commits, T.renderExisting(context, [sessionId], deleted), maxTopics);
    const found = T.parseTopics(runClaude(prompt, config), maxTopics);

    // A topic the developer deleted never comes back (unless --force). A new topic must clear keepMinScore
    // unless it carries a mark; a manual scout, and a marked session, keep at least their best topic.
    const allowed = T.screenTopics(found, deleted, context);
    let keep = allowed.filter((x) => x.same_as.length || x.score >= config.scout.keepMinScore || (x.marks && pending.length));
    if ((manual || pending.length) && !keep.length && allowed.length) keep = [allowed[0]];
    if (!keep.length) {
      const best = found.reduce((n, x) => Math.max(n, x.score), 0);
      // No topic at all is not the same as only deleted ones: marks are kept for the next scan.
      const onlyDeleted = found.length > 0 && !allowed.length;
      // Marks that only pointed at deleted topics are dropped, and their notes remembered, so a
      // /casebook:mark left in the transcript does not force a rescan every time.
      const skipped = onlyDeleted ? 'deleted-topics' : found.length ? 'low-score' : 'no-topic';
      store.withWriteLock(() => {
        if (onlyDeleted) store.consumeMarks(sessionId, pending);
        // A final scan that adds nothing still finishes this session's partial logs: the model saw their notes
        // and had nothing to add, so they would otherwise be rescanned every time the transcript grows.
        if (!partial) T.finishSession(sessionId);
        const prev = store.getLedger(sessionId) || {};
        store.setLedger(sessionId, {
          skipped, score: best, userTurns: t.userTurns, size, partial, scoutedAt: new Date().toISOString(),
          ...(onlyDeleted ? { unmarked: [...new Set([...(prev.unmarked || []), ...pending.map((m) => m.note || '')])] } : {}),
        });
      });
      const reason = onlyDeleted ? 'the only topics found were ones you deleted (use --force to log them again)' : found.length ? `score ${best}` : 'the scout found no topic';
      return { status: 'skipped', reason };
    }

    // Pending marks go to the topics they point to, or to the best one.
    const markTargets = keep.some((x) => x.marks) ? keep.filter((x) => x.marks) : [keep[0]];
    const claimed = new Set();
    // A log a kept topic of the same angle names is that topic's: another topic's title match must not
    // take it first. A claim across angles is weaker than a same-angle title match, so it reserves nothing.
    const reserved = new Set(keep.flatMap((x) => x.same_as.filter((id) => { const l = T.resolveLog(id); return l && T.sameAngle(l.meta.angle, x.angle); })));
    logs = store.withWriteLock(() => {
      const watch = [...new Set([...context.filter((l) => T.sessionsOf(l).includes(sessionId)).map((l) => l.meta.id), ...keep.flatMap((x) => x.same_as)])];
      // A log of this project another scan created meanwhile may be this same topic: look again with it
      // shown. On the last attempt only the logs this scan writes count, so a busy project still gets its log.
      if (T.changedSince(versions, [sessionId], watch, attempt < 3 ? { project: info.project, takenAt } : null)) return null;
      const written = keep.map((topic) => T.applyTopic(topic, {
        members: [member], info, marks: markTargets.includes(topic) ? pending : [], partial, mode, commits, claimed, reserved,
      }));
      store.consumeMarks(sessionId, pending);
      // In the same lock as the logs: a delete right after must not be undone by this ledger write.
      // applyTopic already lifted a 'deleted' flag, since the session has a log again.
      store.setLedger(sessionId, {
        project: info.project, userTurns: t.userTurns, size, partial, scoutedAt: new Date().toISOString(),
        logId: undefined, skipped: undefined,
      });
      return written;
    });
  }
  const best = logs.reduce((a, b) => (b.score > a.score ? b : a));
  return { status: logs.some((l) => l.status === 'created') ? 'created' : 'updated', logId: best.logId, score: best.score, title: best.title, partial, logs };
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
      // A session deleted before topics stays closed whatever its marks; scouting it would only skip again.
      if (ledger && (T.legacyDeleted(ledger) || (ledger.deleted && !store.getMarks(sessionId).length) || ledger.skipped === 'policy' || ledger.size === st.size)) continue;
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

module.exports = { scoutSession, sweep, buildPrompt, runClaude, runClaudeAsync, POLICY_RULES, acquireSessionLock };
