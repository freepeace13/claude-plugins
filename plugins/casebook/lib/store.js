'use strict';
// Log storage: ~/.casebook/logs/<project>/<id>.md, per-session ledger, pending marks.

const fs = require('fs');
const path = require('path');
const { paths, sessionKey, mkdirp, readJson, writeJsonAtomic, writeFileAtomic, parseDoc, renderDoc, newId, ID_RE } = require('./util');

function listProjects() {
  try {
    return fs.readdirSync(paths.logs(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function logFiles(project) {
  const projects = project ? [project] : listProjects();
  const out = [];
  for (const p of projects) {
    const dir = path.join(paths.logs(), p);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (/^cb-[a-z0-9]{6}\.md$/.test(n)) out.push(path.join(dir, n));
  }
  return out;
}

function readLog(file) {
  const { meta, body } = parseDoc(fs.readFileSync(file, 'utf8'));
  return { file, meta, body };
}

function allLogs(project) {
  const out = [];
  for (const f of logFiles(project)) {
    try { out.push(readLog(f)); } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => String(b.meta.started_at || '').localeCompare(String(a.meta.started_at || '')));
}

function findLog(id) {
  if (!ID_RE.test(id)) return null;
  for (const p of listProjects()) {
    const f = path.join(paths.logs(), p, `${id}.md`);
    if (fs.existsSync(f)) return readLog(f);
  }
  return null;
}

function saveLog(log) {
  log.meta.updated_at = new Date().toISOString();
  writeFileAtomic(log.file, renderDoc(log.meta, log.body));
  return log;
}

function createLogFile(project, meta, body) {
  const id = newId((candidate) => Boolean(findLog(candidate)));
  const file = path.join(mkdirp(path.join(paths.logs(), project)), `${id}.md`);
  const now = new Date().toISOString();
  return saveLog({ file, meta: { id, ...meta, created_at: now }, body });
}

function deleteLog(log) {
  fs.rmSync(log.file, { force: true });
  try { fs.rmdirSync(path.dirname(log.file)); } catch { /* not empty */ }
  // The topic is remembered per session so no later scan logs it again. A session left with no logs at all
  // is not scouted again automatically; a manual scout can still look for other topics in it.
  const m = log.meta;
  const sessions = Array.isArray(m.sessions) && m.sessions.length ? m.sessions : [m.session_id].filter(Boolean);
  const left = allLogs();
  for (const sid of sessions) {
    const prev = getLedger(sid) || {};
    const deletedTopics = [...(prev.deletedTopics || []), { id: m.id, title: m.title, angle: m.angle || '', at: new Date().toISOString() }];
    const stillLogged = left.some((l) => (Array.isArray(l.meta.sessions) && l.meta.sessions.length ? l.meta.sessions : [l.meta.session_id]).includes(sid));
    setLedger(sid, { deletedTopics, ...(stillLogged ? {} : { deleted: true, deletedAt: new Date().toISOString() }) });
  }
}

/**
 * Run fn while holding the store's write lock. Logs are shared between sessions now, so two scans must not
 * update or create logs at the same moment. Held only for the writes, never during a model call.
 */
function withWriteLock(fn) {
  const file = path.join(paths.home(), 'state', 'write.lock');
  mkdirp(path.dirname(file));
  const deadline = Date.now() + 60000;
  for (;;) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // A holder that crashed leaves the file behind; writes take milliseconds, so 30s means it is stale.
    try { if (Date.now() - fs.statSync(file).mtimeMs > 30000) fs.rmSync(file, { force: true }); } catch { /* gone */ }
    if (Date.now() > deadline) throw new Error('timed out waiting for the casebook write lock');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { return fn(); } finally { fs.rmSync(file, { force: true }); }
}

// ---------- ledger: one small file per session, so concurrent scouts never race ----------

const ledgerFile = (sid) => path.join(paths.sessions(), `${sessionKey(sid)}.json`);
const getLedger = (sid) => readJson(ledgerFile(sid), null);
function setLedger(sid, patch) {
  const next = { ...(getLedger(sid) || {}), ...patch, sessionId: sid, at: new Date().toISOString() };
  writeJsonAtomic(ledgerFile(sid), next);
  return next;
}

// ---------- pending marks for sessions that have no log yet ----------

const marksFile = (sid) => path.join(paths.marks(), `${sessionKey(sid)}.json`);
const getMarks = (sid) => readJson(marksFile(sid), []);
function addPendingMark(sid, note) {
  const marks = getMarks(sid);
  marks.push({ at: new Date().toISOString(), note: note || '' });
  writeJsonAtomic(marksFile(sid), marks);
  return marks;
}
const clearMarks = (sid) => fs.rmSync(marksFile(sid), { force: true });

function applyMark(log, note) {
  log.meta.marked = true;
  log.meta.marks = [...(log.meta.marks || []), { at: new Date().toISOString(), note: note || '' }];
  return saveLog(log);
}

module.exports = {
  listProjects, allLogs, findLog, readLog, saveLog, createLogFile, deleteLog, withWriteLock,
  getLedger, setLedger, getMarks, addPendingMark, clearMarks, applyMark,
};
