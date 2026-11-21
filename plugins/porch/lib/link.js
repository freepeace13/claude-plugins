'use strict';
// Puts the porch CLI on the user's PATH: writes ~/.local/bin/porch, a small launcher that runs the newest
// porch installed in any Claude Code profile each time it starts. Claude Code has no install or update hook,
// so the launcher finds the install itself: an install or update needs no relink.
// Written from the SessionStart hook (silently, on every session) and by `porch link`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'porch';
const ENV = 'PORCH_BIN_DIR';
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(PLUGIN_ROOT, 'bin', NAME);
// Bump when the launcher's text changes, so an older launcher is replaced and a newer one is kept.
const LAUNCHER_VERSION = 1;
const MARK = new RegExp(`^// ${NAME}-launcher (\\d+)\\b`, 'm');

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Where the launcher goes: $PORCH_BIN_DIR (absolute or ~/…), else ~/.local/bin. "off" turns linking off. */
function binDir() {
  const raw = process.env[ENV];
  if (raw === 'off') return null;
  const p = expandHome(raw || '~/.local/bin');
  if (!path.isAbsolute(p)) throw new Error(`${ENV} must be an absolute path, ~/… or "off", got "${raw}"`);
  return path.resolve(p);
}

/**
 * The newest installed copy of plugin `name`: { bin, version } or null. Looks in $CLAUDE_CONFIG_DIR and every
 * ~/.claude* folder: the installs that profile's plugins/installed_plugins.json lists, or, when it has no such
 * file, every cached copy. Self-contained, because the launcher embeds its source.
 */
function newestInstall(name) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const versionOf = (root) => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
      return m.name === name && fs.statSync(path.join(root, 'bin', name)).isFile() ? String(m.version || '0') : null;
    } catch { return null; }
  };
  const newer = (a, b) => {
    const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
    const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  const profiles = [];
  if (process.env.CLAUDE_CONFIG_DIR) profiles.push(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  try { for (const e of fs.readdirSync(os.homedir()).sort()) if (e.startsWith('.claude')) profiles.push(path.join(os.homedir(), e)); } catch { /* no home */ }
  let best = null;
  for (const dir of new Set(profiles)) {
    let roots;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
      const all = (record && record.plugins) || record || {};
      roots = Object.keys(all).filter((k) => k.split('@')[0] === name).flatMap((k) => [].concat(all[k]).map((x) => x && x.installPath));
    } catch {
      roots = [];
      const cache = path.join(dir, 'plugins', 'cache');
      try { for (const m of fs.readdirSync(cache)) try { for (const v of fs.readdirSync(path.join(cache, m, name))) roots.push(path.join(cache, m, name, v)); } catch { /* not in this marketplace */ } } catch { /* no cache */ }
    }
    for (const root of roots.filter(Boolean)) {
      const version = versionOf(root);
      if (version !== null && (!best || newer(version, best.version))) best = { bin: path.join(root, 'bin', name), version };
    }
  }
  return best;
}

function launcherSource() {
  return `#!/usr/bin/env node
// ${NAME}-launcher ${LAUNCHER_VERSION}: written by the ${NAME} Claude Code plugin (${NAME} link). Runs the newest ${NAME}
// installed in any Claude Code profile, so installing or updating the plugin needs no relink. Safe to delete.
'use strict';
${newestInstall.toString()}
const found = newestInstall(${JSON.stringify(NAME)});
if (!found) {
  process.stderr.write(${JSON.stringify(`${NAME}: no installed ${NAME} plugin found in ~/.claude*. Install it in Claude Code, or delete `)} + __filename + '.\\n');
  process.exit(127);
}
process.argv[1] = found.bin;
require(found.bin);
`;
}

/** The version of the porch plugin whose bin is at `bin`, or null when `bin` is not a porch plugin bin. */
function pluginVersion(bin) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return m.name === NAME ? String(m.version || '0') : null;
  } catch {
    return null;
  }
}

/**
 * Make <binDir>/porch the launcher.
 * Writes it when missing, and replaces an older launcher, a broken link, or a link to any porch plugin
 * (the way porch 0.3.1 and earlier linked it). Leaves alone: a newer launcher, a link to anything else,
 * and any other file. Returns { status, path, target?, reason? }; status is linked | updated | current | skipped.
 * `target` is the bin the launcher runs now.
 */
function linkBin() {
  if (process.platform === 'win32') return { status: 'skipped', reason: 'the launcher is not set up on Windows' };
  const dir = binDir();
  if (!dir) return { status: 'skipped', reason: `${ENV} is "off"` };
  const dest = path.join(dir, NAME);
  const source = launcherSource();
  const runs = () => { const f = newestInstall(NAME); return f ? f.bin : fs.realpathSync(BIN); };

  let replacing = false;
  let st = null;
  try { st = fs.lstatSync(dest); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (st && st.isSymbolicLink()) {
    let real = null;
    try { real = fs.realpathSync(dest); } catch { /* broken link: replace it */ }
    if (real && pluginVersion(real) === null) return { status: 'skipped', path: dest, reason: `${dest} points at ${fs.readlinkSync(dest)}, which is not a ${NAME} plugin` };
    replacing = true;
  } else if (st) {
    let text = '';
    try { text = fs.readFileSync(dest, 'utf8'); } catch { /* unreadable: not ours */ }
    const m = text.match(MARK);
    if (!m) return { status: 'skipped', path: dest, reason: `${dest} exists and is not the ${NAME} launcher` };
    if (Number(m[1]) > LAUNCHER_VERSION) return { status: 'skipped', path: dest, target: runs(), reason: `${dest} is a newer ${NAME} launcher` };
    if (text === source) return { status: 'current', path: dest, target: runs() };
    replacing = true;
  }

  fs.mkdirSync(dir, { recursive: true });
  // Swap it in with one rename so a terminal never sees it missing.
  const tmp = path.join(dir, `.${NAME}.${process.pid}.tmp`);
  try { fs.unlinkSync(tmp); } catch { /* not there */ }
  fs.writeFileSync(tmp, source, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  return { status: replacing ? 'updated' : 'linked', path: dest, target: runs() };
}

/** True when `dir` is on $PATH. */
function onPath(dir) {
  return (process.env.PATH || '').split(path.delimiter).some((p) => p && path.resolve(expandHome(p)) === dir);
}

module.exports = { linkBin, binDir, onPath, newestInstall, launcherSource, LAUNCHER_VERSION };
