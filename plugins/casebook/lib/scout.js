'use strict';
// Scout: condense a session, ask a cheap headless Claude for case-study notes, write/update the log.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PLUGIN_ROOT, paths, readJson, writeJsonAtomic, logError } = require('./util');
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
    env: { ...process.env, CASEBOOK_SCOUT: '1' },
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
 * Scout one session. Returns { status, logId?, reason? }.
 * status: created | updated | skipped
 */
function scoutSession(args, config) {
  const release = acquireSessionLock(args.sessionId, (config.scout.timeoutSec || 240) * 1000 + 30000);
  try { return scoutSessionLocked(args, config); } finally { release(); }
}

/**
 * Serialize scouts of the same session. A resumed session can end while an earlier scout is still
 * running; without this both would see no log yet and each create one. The ledger is read only after
 * the lock is held, so the later scout updates the first scout's log.
 */
function acquireSessionLock(sessionId, waitMs) {
  const file = path.join(paths.sessions(), `${sessionId}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = NaN;
      try { holder = Number(fs.readFileSync(file, 'utf8')); } catch { /* released meanwhile */ }
      let alive = false;
      if (holder) { try { process.kill(holder, 0); alive = true; } catch { /* dead holder */ } }
      if (!alive && !Number.isNaN(holder)) { fs.rmSync(file, { force: true }); continue; }
      if (Date.now() > deadline) { fs.rmSync(file, { force: true }); continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  return () => fs.rmSync(file, { force: true });
}

function scoutSessionLocked({ sessionId, transcriptPath, cwd, force = false }, config) {
  const tp = transcriptPath && fs.existsSync(transcriptPath) ? transcriptPath : findTranscript(sessionId);
  if (!tp) return { status: 'skipped', reason: 'transcript not found' };
  const size = fs.statSync(tp).size;
  const ledger = store.getLedger(sessionId) || {};
  if (ledger.deleted && !force) return { status: 'skipped', reason: 'log was deleted' };

  const t = condense(tp, config.scout.maxChars);
  const info = resolveProject(cwd || t.cwd, config);
  if (info.policy === 'skip') {
    store.setLedger(sessionId, { skipped: 'policy', size });
    return { status: 'skipped', reason: 'project policy is skip' };
  }

  const existing = ledger.logId ? store.findLog(ledger.logId) : null;
  if (existing && !force && t.userTurns - (ledger.userTurns || 0) < (config.sweep.regrowTurns || 8)) {
    store.setLedger(sessionId, { size });
    return { status: 'skipped', reason: 'already logged, not enough new activity' };
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

  if (!force && !marks.length && t.userTurns < config.scout.minTurns) {
    store.setLedger(sessionId, { skipped: 'short', userTurns: t.userTurns, size });
    return { status: 'skipped', reason: `only ${t.userTurns} turns` };
  }

  const commits = commitsBetween(info.root, t.startedAt, t.endedAt);
  const notes = parseNotes(runClaude(buildPrompt(t, info, marks, commits), config));

  if (!force && !marks.length && notes.score < config.scout.keepMinScore) {
    store.setLedger(sessionId, { skipped: 'low-score', score: notes.score, userTurns: t.userTurns, size });
    return { status: 'skipped', reason: `score ${notes.score}` };
  }

  const meta = {
    title: notes.title,
    project: info.project,
    repo: info.repo || null,
    policy: info.policy,
    score: notes.score,
    marked: marks.length > 0,
    marks,
    tags: notes.tags,
    session_id: sessionId,
    branch: t.branch,
    started_at: t.startedAt,
    ended_at: t.endedAt,
    user_turns: t.userTurns,
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
  store.setLedger(sessionId, { logId: log.meta.id, project: info.project, userTurns: t.userTurns, size, skipped: undefined });
  return { status: existing ? 'updated' : 'created', logId: log.meta.id, score: notes.score, title: notes.title };
}

// ---------- sweep: catch sessions whose SessionEnd hook never ran ----------

function acquireLock() {
  const file = paths.lock();
  const cur = readJson(file, null);
  if (cur && Date.now() - cur.t < 30 * 60000) {
    try { process.kill(cur.pid, 0); return false; } catch { /* stale */ }
  }
  writeJsonAtomic(file, { pid: process.pid, t: Date.now() });
  return true;
}
const releaseLock = () => fs.rmSync(paths.lock(), { force: true });

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

function sweep(config, { since, exclude, limit, settleMinutes, onResult } = {}) {
  if (!acquireLock()) return [];
  const results = [];
  try {
    const list = candidateTranscripts({ since, exclude, settleMinutes });
    for (const c of list.slice(0, limit || list.length)) {
      try {
        const r = scoutSession(c, config);
        results.push({ ...c, ...r });
        if (onResult) onResult(c, r);
      } catch (err) {
        logError(`scout failed for ${c.sessionId}`, err);
        results.push({ ...c, status: 'error', reason: err.message });
        if (onResult) onResult(c, { status: 'error', reason: err.message });
      }
    }
  } finally {
    releaseLock();
  }
  return results;
}

module.exports = { scoutSession, sweep, parseNotes, renderBody, buildPrompt };
