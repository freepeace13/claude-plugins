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

// ---------- profiles: one fully separate store per Claude Code config dir ----------

const DEFAULT_CLAUDE_DIR = '~/.claude';

/** Expand ~, resolve to an absolute path, drop any trailing slash. */
function normalizeDir(p) {
  const d = path.resolve(expandHome(p || DEFAULT_CLAUDE_DIR));
  return d.length > 1 ? d.replace(/\/+$/, '') : d;
}

function profileNameFor(configDir) {
  if (sameDir(configDir, normalizeDir(DEFAULT_CLAUDE_DIR))) return 'default';
  const base = path.basename(configDir);
  if (path.dirname(configDir) === os.homedir()) {
    const m = /^\.claude[_-](.+)$/.exec(base);
    if (m) return slugify(m[1]);
  }
  return slugify(base.replace(/^\.+/, ''));
}

const storeRoot = () => path.resolve(expandHome(process.env.CASEBOOK_ROOT || '~/.casebook'));
const realDir = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
const sameDir = (a, b) => a === b || realDir(a) === realDir(b);
const profileFile = (dir) => path.join(dir, 'profile.json');
const shortHash = (configDir) => crypto.createHash('sha1').update(configDir).digest('hex').slice(0, 4);

let cached = null;
let override = null;

function knownProfiles() {
  try {
    return fs.readdirSync(storeRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(profileFile(path.join(storeRoot(), d.name))))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Pure: works out { name, configDir, home, collided } without touching the disk. */
function computeProfile() {
  const envDir = process.env.CLAUDE_CONFIG_DIR ? normalizeDir(process.env.CLAUDE_CONFIG_DIR) : null;
  const root = storeRoot();

  if (process.env.CASEBOOK_HOME) {
    const configDir = envDir || normalizeDir(DEFAULT_CLAUDE_DIR);
    return { name: process.env.CASEBOOK_PROFILE || profileNameFor(configDir), configDir, home: path.resolve(expandHome(process.env.CASEBOOK_HOME)), collided: false };
  }

  if (process.env.CASEBOOK_PROFILE && !override) validateProfileName(process.env.CASEBOOK_PROFILE, 'CASEBOOK_PROFILE');
  const wanted = override || process.env.CASEBOOK_PROFILE || null;
  if (override) {
    const rec = readJson(profileFile(path.join(root, override)), null);
    if (!rec) throw new Error(`no profile "${override}". Known: ${knownProfiles().join(', ') || '(none)'}`);
    if (!rec.claudeConfigDir) throw new Error(`profile "${override}" has no claudeConfigDir in its profile.json`);
    return { name: override, configDir: normalizeDir(rec.claudeConfigDir), home: path.join(root, override), collided: false };
  }
  if (wanted) {
    const rec = readJson(profileFile(path.join(root, wanted)), null);
    if (rec && rec.claudeConfigDir && (!envDir || sameDir(normalizeDir(rec.claudeConfigDir), envDir))) {
      return { name: wanted, configDir: normalizeDir(rec.claudeConfigDir), home: path.join(root, wanted), collided: false };
    }
  }

  const configDir = envDir || normalizeDir(DEFAULT_CLAUDE_DIR);
  if (!wanted) {
    // A store that already records this config dir wins, so a hash-suffixed store stays stable
    // even if the store that first claimed the plain name goes away.
    for (const n of knownProfiles()) {
      const rec = readJson(profileFile(path.join(root, n)), null);
      if (rec && rec.claudeConfigDir && sameDir(normalizeDir(rec.claudeConfigDir), configDir)) {
        return { name: n, configDir, home: path.join(root, n), collided: false };
      }
    }
  }
  let name = wanted || profileNameFor(configDir);
  let collided = false;
  const rec = readJson(profileFile(path.join(root, name)), null);
  if (rec && rec.claudeConfigDir && !sameDir(normalizeDir(rec.claudeConfigDir), configDir)) {
    name = `${name}-${shortHash(configDir)}`;
    collided = true;
  }
  return { name, configDir, home: path.join(root, name), collided };
}

const profile = () => (cached = cached || computeProfile());

/** Point this process at a named store (the CLI's global --profile flag). Throws if unknown. */
function validateProfileName(name, what = '--profile') {
  if (typeof name !== 'string' || !name) throw new Error(`${what} needs a profile name`);
  if (/[\\/]/.test(name) || name.startsWith('.')) throw new Error(`invalid profile name "${name}"`);
}

function useProfile(name) {
  validateProfileName(name);
  if (process.env.CASEBOOK_HOME) throw new Error('--profile cannot be used while CASEBOOK_HOME is set (it points straight at one store)');
  override = name;
  cached = null;
  return profile();
}

/** Write profile.json the first time a store is used. */
function ensureProfileFile() {
  const p = profile();
  if (fs.existsSync(profileFile(p.home))) return;
  writeJsonAtomic(profileFile(p.home), { name: p.name, claudeConfigDir: p.configDir, createdAt: new Date().toISOString() });
  if (p.collided) logError(`profile name collision: "${p.name}" is a second config dir whose name matches another store; using a hash suffix for ${p.configDir}`);
}

function countLogs(dir) {
  let count = 0;
  let last = '';
  let projects = [];
  try { projects = fs.readdirSync(path.join(dir, 'logs'), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return { count, last }; }
  for (const d of projects) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'logs', d.name)); } catch { continue; }
    for (const n of names) {
      if (!/^cb-[a-z0-9]{6}\.md$/.test(n)) continue;
      count++;
      try {
        const t = fs.statSync(path.join(dir, 'logs', d.name, n)).mtime.toISOString().slice(0, 10);
        if (t > last) last = t;
      } catch { /* ignore */ }
    }
  }
  return { count, last };
}

/** Every store under CASEBOOK_ROOT (or just the current one under CASEBOOK_HOME). */
function listProfiles() {
  const cur = profile();
  const dirs = process.env.CASEBOOK_HOME ? [cur.home] : knownProfiles().map((n) => path.join(storeRoot(), n));
  // The current store may not have been used yet (no profile.json): still show it.
  if (!dirs.some((d) => path.resolve(d) === path.resolve(cur.home))) dirs.push(cur.home);
  return dirs.map((dir) => {
    const isCurrent = path.resolve(dir) === path.resolve(cur.home);
    const rec = readJson(profileFile(dir), isCurrent ? { name: cur.name, claudeConfigDir: cur.configDir } : {});
    const { count, last } = countLogs(dir);
    return { name: rec.name || path.basename(dir), claudeConfigDir: rec.claudeConfigDir || null, logs: count, lastLog: last || null, current: isCurrent };
  });
}

const home = () => profile().home;

const paths = {
  home,
  root: storeRoot,
  config: () => path.join(home(), 'config.json'),
  logs: () => path.join(home(), 'logs'),
  marks: () => path.join(home(), 'marks'),
  sessions: () => path.join(home(), 'state', 'sessions'),
  locks: () => path.join(home(), 'state', 'locks'),
  meta: () => path.join(home(), 'state', 'meta.json'),
  lock: () => path.join(home(), 'state', 'sweep.lock'),
  errorLog: () => path.join(home(), 'casebook.log'),
  profileName: () => profile().name,
  claudeConfigDir: () => profile().configDir,
  // Pass CLAUDE_CONFIG_DIR to children only when it matters: it was already set, or the profile is not the
  // default ~/.claude. Setting it for a default-profile user could change how `claude` finds its credentials.
  claudeConfigDirExplicit: () => Boolean(process.env.CLAUDE_CONFIG_DIR) || !sameDir(profile().configDir, normalizeDir(DEFAULT_CLAUDE_DIR)),
  claudeProjects: () => path.join(profile().configDir, 'projects'),
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
  ensureProfileFile();
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
  logError, profile, useProfile, listProfiles, normalizeDir, profileNameFor, parseDoc, renderDoc, newId, ID_RE, sessionKey, slugify, parseAge, daysSince, globMatch, expandHome,
};
