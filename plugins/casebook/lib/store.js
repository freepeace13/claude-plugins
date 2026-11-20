'use strict';
// Log storage: ~/.casebook/logs/<project>/<id>.md, per-session ledger, pending marks.

const fs = require('fs');
const path = require('path');
const { paths, sessionKey, mkdirp, readJson, writeJsonAtomic, writeFileAtomic, parseDoc, renderDoc, newId, ID_RE, logSummary, withWriteLock } = require('./util');

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
  // Never an ID a merged log once had: old references to it resolve through merged_from.
  const merged = new Set(allLogs().flatMap((l) => l.meta.merged_from || []));
  const id = newId((candidate) => merged.has(candidate) || Boolean(findLog(candidate)));
  const file = path.join(mkdirp(path.join(paths.logs(), project)), `${id}.md`);
  const now = new Date().toISOString();
  return saveLog({ file, meta: { id, ...meta, created_at: now }, body });
}

function deleteLog(log) {
  // Read it again under the lock: a scan may have added sessions to it since it was listed.
  return withWriteLock(() => { const fresh = findLog(log.meta.id); if (fresh) deleteLogLocked(fresh); return Boolean(fresh); });
}

function deleteLogLocked(log) {
  fs.rmSync(log.file, { force: true });
  try { fs.rmdirSync(path.dirname(log.file)); } catch { /* not empty */ }
  // The topic is remembered per session so no later discovery logs it again.
  const m = log.meta;
  const sessions = Array.isArray(m.sessions) && m.sessions.length ? m.sessions : [m.session_id].filter(Boolean);
  for (const sid of sessions) {
    const prev = getLedger(sid) || {};
    const description = m.description || logSummary(log.body);
    setLedger(sid, { deletedTopics: [...(prev.deletedTopics || []), { id: m.id, title: m.title, angle: m.angle || '', description, at: new Date().toISOString() }] });
  }
}

// ---------- ledger: one small file per session (the topics deleted from it) ----------

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
  marks.push({ at: new Date().toISOString(), note: note || '', session: sid });
  writeJsonAtomic(marksFile(sid), marks);
  return marks;
}
const clearMarks = (sid) => fs.rmSync(marksFile(sid), { force: true });
/** Remove only the marks a pick placed: a mark added since the discovery ran stays for the next one. */
function consumeMarks(sid, used) {
  const key = (m) => `${m.at}|${m.note || ''}`;
  const gone = new Set(used.map(key));
  const left = getMarks(sid).filter((m) => !gone.has(key(m)));
  if (left.length) writeJsonAtomic(marksFile(sid), left); else clearMarks(sid);
}

/** Remove a log's marks. */
function clearLogMarks(log) {
  log.meta.marked = false;
  log.meta.marks = [];
  return saveLog(log);
}

/** session: the session the mark was made for; none for a mark of a log by its ID. */
function applyMark(log, note, session) {
  log.meta.marked = true;
  log.meta.marks = [...(log.meta.marks || []), { at: new Date().toISOString(), note: note || '', ...(session ? { session } : { via: 'id' }) }];
  return saveLog(log);
}

module.exports = {
  listProjects, allLogs, findLog, readLog, saveLog, createLogFile, deleteLog, withWriteLock,
  getLedger, setLedger, getMarks, addPendingMark, clearMarks, consumeMarks, applyMark, clearLogMarks,
};
