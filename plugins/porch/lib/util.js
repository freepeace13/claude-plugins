'use strict';
// Shared helpers: paths, time, frontmatter. No dependencies.

const os = require('os');
const fs = require('fs');
const path = require('path');

const has = (obj, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
const now = () => new Date().toISOString();
const warn = (msg) => process.stderr.write(`porch: ${msg}\n`);

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** True when `child` is `parent` or anywhere under it. */
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** Minimal frontmatter reader: top-level `key: value` lines only. Null when the file can't be read. */
function frontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):[ \t]*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = scalar(kv[2]);
  }
  return fm;
}

/** A YAML scalar: a quoted string (with '' or \" escapes), or plain text up to a " #" comment. */
function scalar(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (m) return m[1].replace(/\\(["\\])/g, '$1');
  } else if (v.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(v);
    if (m) return m[1].replace(/''/g, "'");
  }
  return v.replace(/(^|\s)#.*$/, '').trim();
}

module.exports = { has, now, warn, expandHome, inside, frontmatter, scalar };
