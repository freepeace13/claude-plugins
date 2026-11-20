'use strict';
// `porch init`: copy a file or folder that passed the intake check into a new work folder.

const fs = require('fs');
const path = require('path');
const { has, now, expandHome, inside } = require('./util');
const store = require('./store');

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.porch']);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2000;

/**
 * List what the copy takes: real files and folders only, leaving out SKIP names, symlinks (the intake
 * is a snapshot) and the store itself. Unreadable entries are skipped and listed in `unreadable`.
 * Unless `force`, the walk stops as soon as a limit is passed and sets `over`.
 */
function measure(root, force) {
  const r = { files: 0, bytes: 0, links: 0, list: [], dirs: [], unreadable: [], over: false };
  const home = store.realHome();
  const STOP = Symbol('stop');
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { r.unreadable.push(`${p} (${e.code || e.message})`); return; }
    if (st.isSymbolicLink()) { r.links++; return; }
    if (st.isDirectory()) {
      let names;
      try { names = fs.readdirSync(p); } catch (e) { r.unreadable.push(`${p} (${e.code || e.message})`); return; }
      r.dirs.push(p);
      for (const n of names) {
        const c = path.join(p, n);
        if (!SKIP.has(n) && !inside(c, home)) walk(c);
      }
    } else if (st.isFile()) {
      try { fs.accessSync(p, fs.constants.R_OK); } catch (e) { r.unreadable.push(`${p} (${e.code || e.message})`); return; }
      r.files++;
      r.bytes += st.size;
      r.list.push(p);
      if (!force && (r.files > MAX_FILES || r.bytes > MAX_BYTES)) { r.over = true; throw STOP; }
    }
  };
  try { walk(root); } catch (e) { if (e !== STOP) throw e; }
  return r;
}

/**
 * Create a work folder whose intake is a copy of `src`.
 * Returns { work, size }: the new state (with `dir`) and what `measure` found, including what it skipped.
 */
function init(src, { type, topic, note, force } = {}) {
  if (!src) throw new Error('usage: porch init <path> --type article|case-study --topic text [--note text] [--force] [--json]');
  if (!has(store.TYPES, type)) throw new Error(`--type must be article or case-study, got "${type ?? ''}"`);
  if (!topic || !String(topic).trim()) {
    throw new Error('--topic is required: run the intake check (references/intake.md) first and pass the topic it found');
  }
  const given = path.resolve(expandHome(src));
  let abs;
  try { abs = fs.realpathSync(given); } catch { throw new Error(`no such file or folder: ${given}`); }
  const st = fs.statSync(abs);
  if (!st.isFile() && !st.isDirectory()) throw new Error(`not a file or folder: ${abs}`);
  if (inside(abs, store.realHome())) throw new Error(`the intake is inside the store (${store.home()})`);

  const size = measure(abs, force);
  if (size.over) {
    throw new Error(`${abs} has more than ${MAX_FILES} files or ${MAX_BYTES / 1048576} MB; ` +
      'point at a smaller folder or pass --force.');
  }
  if (size.files === 0) throw new Error(`nothing readable to copy in ${abs}`);

  const name = path.basename(given);
  const work = store.createWork(type, (staging, id) => {
    fs.mkdirSync(path.join(staging, 'intake'));
    // Copy file by file from the measured list. fs.cpSync refuses any destination inside the source,
    // even one its filter would skip, and the store may sit inside the intake.
    const dest = path.join(staging, 'intake', name);
    const to = (p) => (p === abs ? dest : path.join(dest, path.relative(abs, p)));
    for (const d of size.dirs) fs.mkdirSync(to(d), { recursive: true });
    for (const file of size.list) {
      fs.mkdirSync(path.dirname(to(file)), { recursive: true });
      fs.copyFileSync(file, to(file));
    }
    const t = now();
    return {
      id,
      type,
      status: 'new',
      title: (st.isDirectory() ? name : name.replace(/(.)\.[^.]+$/, '$1')) || name,
      topic: String(topic).trim(),
      slug: '',
      tags: [],
      kind: null,
      note: note || '',
      source: given,
      intake: `intake/${name}`,
      porch_id: null,
      created_at: t,
      updated_at: t,
    };
  });
  return { work, size };
}

module.exports = { init, measure, MAX_BYTES, MAX_FILES };
