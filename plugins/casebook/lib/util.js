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

// ---------- one store; the profile is the Claude Code config dir `claude` runs under ----------

const DEFAULT_CLAUDE_DIR = '~/.claude';

/** Expand ~, resolve to an absolute path, drop any trailing slash. */
function normalizeDir(p) {
  const d = path.resolve(expandHome(p || DEFAULT_CLAUDE_DIR));
  return d.length > 1 ? d.replace(/\/+$/, '') : d;
}

const realDir = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
const sameDir = (a, b) => a === b || realDir(a) === realDir(b);

/** A short name for a config dir, recorded on each log: ~/.claude → default, ~/.claude_personal → personal. */
function profileNameFor(configDir) {
  if (sameDir(configDir, normalizeDir(DEFAULT_CLAUDE_DIR))) return 'default';
  const base = path.basename(configDir);
  if (path.dirname(configDir) === os.homedir()) {
    const m = /^\.claude[_-](.+)$/.exec(base);
    if (m) return slugify(m[1]);
  }
  return slugify(base.replace(/^\.+/, ''));
}

const home = () => path.resolve(expandHome(process.env.CASEBOOK_HOME || '~/.casebook'));
const configDir = () => normalizeDir(process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_DIR);

const paths = {
  home,
  config: () => path.join(home(), 'config.json'),
  logs: () => path.join(home(), 'logs'),
  marks: () => path.join(home(), 'marks'),
  sessions: () => path.join(home(), 'state', 'sessions'),
  errorLog: () => path.join(home(), 'casebook.log'),
  profileName: () => profileNameFor(configDir()),
  claudeConfigDir: configDir,
  // Children inherit CLAUDE_CONFIG_DIR exactly as we got it, so a scan runs (and is billed) as the
  // account `claude` ran under. Never set it when it was unset: that could change how `claude` finds its credentials.
  claudeConfigDirExplicit: () => Boolean(process.env.CLAUDE_CONFIG_DIR),
  claudeProjects: () => path.join(configDir(), 'projects'),
};

// ---------- migration from per-profile stores (~/.casebook/<profile>/) ----------

// What moves from an old profile store into the shared one. Everything is one file per log, session or
// discovery, so moving files merges the stores. Case studies and handoffs stay where they are, so the
// `written_to` paths in logs keep working.
const MOVED = ['logs', 'marks', path.join('state', 'sessions'), path.join('state', 'discoveries')];

/** Move every file under `from` into `to` that `to` does not have yet. Returns the files left behind. */
function mergeTree(from, to) {
  let left = 0;
  let entries = [];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { left += mergeTree(src, dst); continue; }
    if (fs.existsSync(dst)) { left++; continue; }
    try { mkdirp(to); fs.renameSync(src, dst); } catch (err) { if (err.code !== 'ENOENT') left++; }
  }
  try { fs.rmdirSync(from); } catch { /* not empty */ }
  return left;
}

/** Old stores are folders of the store holding a profile.json. Merged ones keep it as profile.migrated.json. */
function oldStores() {
  try {
    return fs.readdirSync(home(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !['logs', 'marks', 'state'].includes(d.name) && fs.existsSync(path.join(home(), d.name, 'profile.json')))
      .map((d) => d.name)
      .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  } catch {
    return [];
  }
}

/** Merge old per-profile stores into the one store. Safe to run from several processes at once, and again after a crash. */
function migrateProfiles() {
  for (const name of oldStores()) {
    const dir = path.join(home(), name);
    let left = 0;
    for (const sub of MOVED) left += mergeTree(path.join(dir, sub), path.join(home(), sub));
    let config = 'kept';
    if (!fs.existsSync(paths.config())) {
      try { fs.renameSync(path.join(dir, 'config.json'), paths.config()); config = 'moved'; } catch { /* none, or another process won */ }
    }
    try { fs.renameSync(path.join(dir, 'profile.json'), path.join(dir, 'profile.migrated.json')); } catch { continue; }
    logError(`merged profile store "${name}" into ${home()}${config === 'kept' && fs.existsSync(path.join(dir, 'config.json')) ? `; its config.json was not used (see ${dir})` : ''}${left ? `; ${left} file(s) already present were left in ${dir}` : ''}`);
  }
}

const DEFAULT_CONFIG = {
  defaultPolicy: 'anonymize',
  projects: [{ match: 'github.com/YOUR-GITHUB-HANDLE/*', policy: 'public' }],
  scan: {
    command: 'claude',
    model: 'haiku',
    minTurns: 4,
    maxTopics: 3,
    maxChars: 60000,
    timeoutSec: 240,
  },
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

/** Load config, creating the default file on first use. */
function loadConfig() {
  migrateProfiles();
  const file = paths.config();
  if (!fs.existsSync(file)) writeJsonAtomic(file, DEFAULT_CONFIG);
  const raw = readJson(file, {});
  // Before 0.3 the model settings were under "scout".
  if (raw.scout && !raw.scan) raw.scan = raw.scout;
  return deepMerge(DEFAULT_CONFIG, raw);
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

/** A log's summary: the paragraph between its title and its first section. */
function logSummary(body) {
  return String(body || '').replace(/^\s*# .*\n+/, '').split(/\n## /)[0].trim();
}

// ---------- misc ----------

function newId(exists) {
  for (;;) {
    const id = 'cb-' + crypto.randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
    if (id.length === 9 && !exists(id)) return id;
  }
}

const ID_RE = /^cb-[a-z0-9]{6}$/;

/**
 * A filesystem-safe key for a session id, shared by its ledger, pending marks and lock. Ids made only of
 * safe characters are used as they are; if sanitising changed one, a hash of the raw id keeps distinct ids apart.
 */
function sessionKey(sessionId) {
  const id = String(sessionId);
  const safe = id.replace(/[^\w-]/g, '');
  return safe === id && safe ? safe : `${safe}-${crypto.createHash('sha1').update(id).digest('hex').slice(0, 8)}`;
}

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

/** A mark note as it is compared and stored: outer quotes dropped, whitespace collapsed. */
function normNote(s) {
  return String(s || '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ').trim();
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
  normNote, logError, normalizeDir, profileNameFor, parseDoc, renderDoc, logSummary, newId, ID_RE, sessionKey, slugify, parseAge, daysSince, globMatch, expandHome,
};
