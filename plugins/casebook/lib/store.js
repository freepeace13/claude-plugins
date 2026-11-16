'use strict';
// Log storage: ~/.casebook/logs/<project>/<id>.md, per-session ledger, pending marks.

const fs = require('fs');
const path = require('path');
const { paths, mkdirp, readJson, writeJsonAtomic, writeFileAtomic, parseDoc, renderDoc, newId, ID_RE } = require('./util');

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
  if (log.meta.session_id) setLedger(log.meta.session_id, { deleted: true, logId: log.meta.id, deletedAt: new Date().toISOString() });
  try { fs.rmdirSync(path.dirname(log.file)); } catch { /* not empty */ }
}

// ---------- ledger: one small file per session, so concurrent scouts never race ----------

const ledgerFile = (sid) => path.join(paths.sessions(), `${String(sid).replace(/[^\w-]/g, '')}.json`);
const getLedger = (sid) => readJson(ledgerFile(sid), null);
function setLedger(sid, patch) {
  const next = { ...(getLedger(sid) || {}), ...patch, sessionId: sid, at: new Date().toISOString() };
  writeJsonAtomic(ledgerFile(sid), next);
  return next;
}

// ---------- pending marks for sessions that have no log yet ----------

const marksFile = (sid) => path.join(paths.marks(), `${String(sid).replace(/[^\w-]/g, '')}.json`);
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
  listProjects, allLogs, findLog, readLog, saveLog, createLogFile, deleteLog,
  getLedger, setLedger, getMarks, addPendingMark, clearMarks, applyMark,
};
