'use strict';
// Whether a repository is public. Only github.com repositories are looked up: one anonymous request to
// the GitHub API, which answers 200 for a public repository and 404 for a private or missing one. Nothing
// else is sent. Answers are kept for a day in state/visibility.json, so a discovery asks at most once per repo.

const path = require('path');
const { spawnSync } = require('child_process');
const { paths, readJson, writeJsonAtomic, mkdirp } = require('./util');

const TTL_MS = 24 * 60 * 60 * 1000;
const GITHUB = /^github\.com\/([\w.-]+)\/([\w.-]+)$/;

const cacheFile = () => path.join(paths.home(), 'state', 'visibility.json');

/** 'public', 'private' (404) or '' (no answer: offline, rate limited, curl missing). */
function lookup(owner, name) {
  const base = (process.env.CASEBOOK_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5',
      '-H', 'Accept: application/vnd.github+json', '-A', 'casebook', `${base}/repos/${owner}/${name}`], { encoding: 'utf8', timeout: 8000 });
    const code = String(r.stdout || '').trim();
    return code === '200' ? 'public' : code === '404' ? 'private' : '';
  } catch {
    return '';
  }
}

/** True only when the repository is known to be public. Unknown counts as private. */
function isPublicRepo(repo) {
  if (process.env.CASEBOOK_VISIBILITY === 'off') return false;
  const m = GITHUB.exec(String(repo || '').toLowerCase());
  if (!m) return false;
  const cache = readJson(cacheFile(), {});
  const hit = cache[m[0]];
  if (hit && Date.now() - new Date(hit.checked_at).getTime() < TTL_MS) return hit.visibility === 'public';
  const visibility = lookup(m[1], m[2]);
  if (!visibility) return false;
  try {
    mkdirp(path.dirname(cacheFile()));
    writeJsonAtomic(cacheFile(), { ...readJson(cacheFile(), {}), [m[0]]: { visibility, checked_at: new Date().toISOString() } });
  } catch { /* asked again next time: harmless */ }
  return visibility === 'public';
}

module.exports = { isPublicRepo };
