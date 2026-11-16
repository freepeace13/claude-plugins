'use strict';
// Shared helpers: paths, config, frontmatter, small fs utilities. No dependencies.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function expandHome(p) {
  if (!p) return p;
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

const home = () => expandHome(process.env.CASEBOOK_HOME || '~/.casebook');
const claudeDir = () => expandHome(process.env.CLAUDE_CONFIG_DIR || '~/.claude');

const paths = {
  home,
  config: () => path.join(home(), 'config.json'),
  logs: () => path.join(home(), 'logs'),
  marks: () => path.join(home(), 'marks'),
  sessions: () => path.join(home(), 'state', 'sessions'),
  meta: () => path.join(home(), 'state', 'meta.json'),
  lock: () => path.join(home(), 'state', 'sweep.lock'),
  errorLog: () => path.join(home(), 'casebook.log'),
  claudeProjects: () => path.join(claudeDir(), 'projects'),
};

const DEFAULT_CONFIG = {
  defaultPolicy: 'anonymize',
  projects: [{ match: 'github.com/YOUR-GITHUB-HANDLE/*', policy: 'public' }],
  scout: {
    command: 'claude',
    model: 'haiku',
    minTurns: 4,
    keepMinScore: 2,
    maxChars: 60000,
    timeoutSec: 240,
  },
  sweep: { enabled: true, maxPerRun: 3, settleMinutes: 15, regrowTurns: 8 },
  output: { dir: null },
};

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function writeFileAtomic(file, text) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/** Load config, creating the default file (and install timestamp) on first use. */
function loadConfig() {
  const file = paths.config();
  if (!fs.existsSync(file)) writeJsonAtomic(file, DEFAULT_CONFIG);
  const meta = readJson(paths.meta(), {});
  if (!meta.installedAt) writeJsonAtomic(paths.meta(), { ...meta, installedAt: new Date().toISOString() });
  return deepMerge(DEFAULT_CONFIG, readJson(file, {}));
}

function logError(msg, err) {
  try {
    mkdirp(home());
    const line = `[${new Date().toISOString()}] ${msg}${err ? ': ' + (err.stack || err.message || err) : ''}\n`;
    fs.appendFileSync(paths.errorLog(), line);
  } catch { /* never throw from logging */ }
}

// ---------- frontmatter (values are JSON-encoded, which is also valid YAML) ----------

function parseDoc(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    try { meta[key] = JSON.parse(raw); } catch { meta[key] = raw; }
  }
  return { meta, body: text.slice(m[0].length) };
}

function renderDoc(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

// ---------- misc ----------

function newId(exists) {
  for (;;) {
    const id = 'cb-' + crypto.randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
    if (id.length === 9 && !exists(id)) return id;
  }
}

const ID_RE = /^cb-[a-z0-9]{6}$/;

function slugify(s, max = 60) {
  return String(s || 'untitled')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, max)
    .replace(/-$/, '') || 'untitled';
}

/** "30d", "12w", "6m", "1y" or an ISO date → Date threshold. */
function parseAge(spec) {
  if (!spec) return null;
  const m = /^(\d+)\s*([dwmy])$/i.exec(String(spec).trim());
  if (m) {
    const n = Number(m[1]);
    const days = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase()] * n;
    return new Date(Date.now() - days * 86400000);
  }
  const d = new Date(spec);
  if (Number.isNaN(d.getTime())) throw new Error(`Can't read "${spec}" as an age (use 30d, 12w, 6m, 1y) or a date`);
  return d;
}

const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);

/** Minimal glob: * matches anything (including /), ? one char. Case-insensitive. */
function globMatch(pattern, value) {
  if (!pattern || !value) return false;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(value);
}

module.exports = {
  PLUGIN_ROOT, paths, DEFAULT_CONFIG, loadConfig, mkdirp, readJson, writeJsonAtomic, writeFileAtomic,
  logError, parseDoc, renderDoc, newId, ID_RE, slugify, parseAge, daysSince, globMatch, expandHome,
};
