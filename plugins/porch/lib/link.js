'use strict';
// Puts the porch CLI on the user's PATH by symlinking ~/.local/bin/porch to this plugin's bin.
// Runs from the SessionStart hook (`porch link --hook`, silently) and from `porch link`.

const fs = require('fs');
const path = require('path');
const { expandHome } = require('./util');

const NAME = 'porch';
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(PLUGIN_ROOT, 'bin', NAME);

/** Where the link goes: $PORCH_BIN_DIR (absolute or ~/…), else ~/.local/bin. "off" turns linking off. */
function binDir() {
  const raw = process.env.PORCH_BIN_DIR;
  if (raw === 'off') return null;
  const p = expandHome(raw || '~/.local/bin');
  if (!path.isAbsolute(p)) throw new Error(`PORCH_BIN_DIR must be an absolute path, ~/… or "off", got "${raw}"`);
  return path.resolve(p);
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

function compareVersions(a, b) {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Make <binDir>/porch point at this plugin's bin.
 * Creates the link when missing, and replaces a link that is broken or points at an older porch plugin.
 * Leaves alone: a link to an equal or newer porch, a link to anything else, and a regular file.
 * Returns { status, path, target?, reason? }; status is linked | updated | current | skipped.
 */
function linkBin() {
  if (process.platform === 'win32') return { status: 'skipped', reason: 'symlinks are not set up on Windows' };
  const dir = binDir();
  if (!dir) return { status: 'skipped', reason: 'PORCH_BIN_DIR is "off"' };
  const dest = path.join(dir, NAME);
  const target = fs.realpathSync(BIN);

  let existing = null;
  try {
    const st = fs.lstatSync(dest);
    if (!st.isSymbolicLink()) return { status: 'skipped', path: dest, reason: `${dest} exists and is not a symlink` };
    existing = path.resolve(dir, fs.readlinkSync(dest));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (existing) {
    let real = null;
    try { real = fs.realpathSync(existing); } catch { /* broken link: replace it */ }
    if (real === target) return { status: 'current', path: dest, target };
    if (real) {
      const theirs = pluginVersion(real);
      if (theirs === null) return { status: 'skipped', path: dest, reason: `${dest} points at ${existing}, which is not a porch plugin` };
      const ours = pluginVersion(target) || '0';
      if (compareVersions(ours, theirs) <= 0) return { status: 'skipped', path: dest, target: real, reason: `${dest} already points at porch ${theirs}` };
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  // Swap the link in one rename so a terminal never sees it missing.
  const tmp = path.join(dir, `.${NAME}.${process.pid}.tmp`);
  try { fs.unlinkSync(tmp); } catch { /* not there */ }
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, dest);
  return { status: existing ? 'updated' : 'linked', path: dest, target };
}

/** True when `dir` is on $PATH. */
function onPath(dir) {
  return (process.env.PATH || '').split(path.delimiter).some((p) => p && path.resolve(expandHome(p)) === dir);
}

module.exports = { linkBin, binDir, onPath, compareVersions };
