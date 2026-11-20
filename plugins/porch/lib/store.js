'use strict';
// The Porch store: work folders and their state.json.
//
// Store: $PORCH_HOME (default ~/.porch)
//   voice.md                      optional, written by /porch:voice; extends the plugin's base voice
//   articles/<uuid>/              one work folder per piece
//   case-studies/<uuid>/
//     state.json                  id, type, status, title, topic, slug, tags, timestamps, ...
//     intake/<file or folder>     copy of what /porch:brief was given
//     brief.md, draft.md, review.md

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { has, now, warn, expandHome, inside } = require('./util');

const TYPES = { article: 'articles', 'case-study': 'case-studies' };
const STATUSES = ['new', 'briefed', 'drafting', 'approved', 'escalated', 'pushed'];
const KINDS = ['notes', 'draft'];
const FILES = { brief: 'brief.md', draft: 'draft.md', review: 'review.md', state: 'state.json' };
const SETTABLE = ['title', 'topic', 'slug', 'tags', 'status', 'kind', 'draft_source', 'note', 'porch_id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function home() {
  const raw = process.env.PORCH_HOME || '~/.porch';
  const p = expandHome(raw);
  if (!path.isAbsolute(p)) throw new Error(`PORCH_HOME must be an absolute path or start with ~/, got "${raw}"`);
  return path.resolve(p);
}
/** The store path with symlinks resolved, for comparing against real intake paths. */
function realHome() {
  try { return fs.realpathSync(home()); } catch { return home(); }
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILES.state), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(dir, state) {
  const file = path.join(dir, FILES.state);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Why a state can't be used, or null. The id must match the folder name and the type its parent. */
function invalid(state, name, type) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'state.json is missing or not a JSON object';
  if (state.id !== name) return `id ${JSON.stringify(state.id)} does not match the folder name`;
  if (state.type !== type) return `type ${JSON.stringify(state.type)} does not match the folder`;
  return null;
}

let warned = false;

/** Every valid work folder in the store: [{ dir, state }]. Broken ones are skipped with a warning on stderr. */
function all() {
  const items = [];
  const broken = [];
  for (const [type, sub] of Object.entries(TYPES)) {
    const base = path.join(home(), sub);
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) {
      if (!UUID.test(name)) continue;
      const dir = path.join(base, name);
      const state = readState(dir);
      const why = invalid(state, name, type);
      if (why) { broken.push(`${dir}: ${why}`); continue; }
      if (!Array.isArray(state.tags)) state.tags = [];
      items.push({ dir, state });
    }
  }
  if (broken.length && !warned) {
    warned = true;
    for (const b of broken) warn(`skipping ${b}`);
  }
  return items;
}

/** Work folders matching the filters, most recently updated first. */
function list({ type, statuses, tag } = {}) {
  if (type && !has(TYPES, type)) throw new Error('--type must be article or case-study');
  if (statuses && !statuses.every((x) => STATUSES.includes(x))) throw new Error(`--status must be one or more of ${STATUSES.join(', ')}`);
  let items = all();
  if (type) items = items.filter((w) => w.state.type === type);
  if (statuses) items = items.filter((w) => statuses.includes(w.state.status));
  if (tag) items = items.filter((w) => (w.state.tags || []).includes(tag));
  return items.sort((a, b) => String(b.state.updated_at).localeCompare(String(a.state.updated_at)));
}

/** Resolve a full id or a unique prefix of at least 4 characters. */
function resolve(ref) {
  if (!ref) throw new Error('missing work id (see `porch list`)');
  const r = String(ref).toLowerCase();
  if (r.length < 4) throw new Error(`id "${ref}" is too short; give at least 4 characters`);
  const hits = all().filter((w) => w.state.id.startsWith(r));
  if (hits.length === 0) throw new Error(`no work folder matches "${ref}" in ${home()}`);
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} work folders: ${hits.map((w) => w.state.id).join(', ')}`);
  return hits[0];
}

/** The brief, draft and review files a work folder has. */
function filesIn(dir) {
  return Object.values(FILES).filter((f) => f !== FILES.state && fs.existsSync(path.join(dir, f)));
}

/**
 * Build a work folder in <home>/.staging/<id>, then rename it into <home>/<type dir>/<id>.
 * `build(staging, id)` fills the folder and returns its state.
 * A failure anywhere removes the staging folder, so a failed create leaves nothing in the store.
 */
function createWork(type, build) {
  const id = crypto.randomUUID();
  const staging = path.join(home(), '.staging', id);
  const dir = path.join(home(), TYPES[type], id);
  try {
    // Private by default, but only when this creates the store: never change an existing folder's mode.
    if (!fs.existsSync(home())) fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const state = build(staging, id);
    writeState(staging, state);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.renameSync(staging, dir);
    return { ...state, dir };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`could not create the work folder: ${e.message}`);
  }
}

/** Apply `key=value` pairs to a work folder's state, checking each one. Returns the new state. */
function update(w, pairs) {
  if (!pairs.length) throw new Error(`usage: porch set <id> key=value…  (keys: ${SETTABLE.join(', ')})`);
  const s = { ...w.state };
  for (const p of pairs) {
    const m = /^([a-z_]+)=(.*)$/s.exec(p);
    if (!m) throw new Error(`expected key=value, got "${p}"`);
    const [, k, v] = m;
    if (!SETTABLE.includes(k)) throw new Error(`cannot set "${k}"; settable keys: ${SETTABLE.join(', ')}`);
    if (k === 'status' && !STATUSES.includes(v)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    if (k === 'kind' && !KINDS.includes(v)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
    if (k === 'slug' && v && !SLUG.test(v)) throw new Error(`slug must be lowercase words joined by "-", got "${v}"`);
    if (k === 'topic' && !v.trim()) throw new Error('topic cannot be empty');
    if (k === 'draft_source') {
      const rel = path.normalize(v);
      const file = path.join(w.dir, rel);
      if (!rel.startsWith('intake' + path.sep) || !inside(file, path.join(w.dir, 'intake'))) {
        throw new Error(`draft_source must be a path inside intake/, got "${v}"`);
      }
      let ok = false;
      try { ok = fs.lstatSync(file).isFile(); } catch { /* missing */ }
      if (!ok) throw new Error(`draft_source ${v} is not a file in ${w.state.id.slice(0, 8)}`);
    }
    if (k === 'tags') s.tags = v.split(',').map((t) => t.trim()).filter(Boolean);
    else if (k === 'porch_id') s.porch_id = v || null;
    else s[k] = v;
  }
  s.updated_at = now();
  writeState(w.dir, s);
  return s;
}

/** Throw unless `w.dir` is exactly <home>/<type dir>/<uuid>, the only thing delete may remove. */
function assertDeletable(w) {
  const rel = path.relative(home(), w.dir).split(path.sep);
  if (rel.length !== 2 || !Object.values(TYPES).includes(rel[0]) || !UUID.test(rel[1])) {
    throw new Error(`refusing to delete ${w.dir}: not a work folder`);
  }
}

function remove(w) {
  assertDeletable(w);
  fs.rmSync(w.dir, { recursive: true, force: true });
}

module.exports = {
  TYPES, STATUSES, KINDS, FILES, SETTABLE, SLUG,
  home, realHome, all, list, resolve, filesIn, createWork, update, assertDeletable, remove,
};
