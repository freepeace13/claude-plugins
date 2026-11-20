'use strict';
// Resolve which project a directory belongs to, and which privacy policy applies.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, slugify, globMatch } = require('./util');

function git(cwd, args) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** git@github.com:o/r.git, https://x@github.com/o/r.git → github.com/o/r */
function normalizeRemote(url) {
  if (!url) return '';
  let u = url.trim().replace(/\.git$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const p = new URL(u);
    return `${p.hostname}${p.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

const POLICIES = ['public', 'anonymize', 'skip'];

function resolveProject(cwd, config) {
  // A recorded directory that is gone (a removed worktree) is still that directory: never the caller's,
  // or an old client session would take on the project and policy of wherever casebook runs.
  const dir = cwd || process.cwd();
  if (!fs.existsSync(dir)) {
    // A removed worktree at a known worktree place inside its repo (…/repo/.claude/worktrees/x) still belongs
    // to that repo. Any other folder that is gone may have been a separate clone: never borrow an ancestor's.
    const wt = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/.exec(dir);
    if (wt && fs.existsSync(wt[1]) && git(wt[1], ['rev-parse', '--show-toplevel'])) return resolveProject(wt[1], config);
    const project = slugify(path.basename(dir), 50);
    let policy = null;
    for (const rule of config.projects || []) {
      if ([dir, project].some((v) => globMatch(rule.match, v)) && POLICIES.includes(rule.policy)) { policy = rule.policy; break; }
    }
    // Nothing says which repo it was, so a repo rule cannot apply: anonymize unless a rule names this folder.
    return { project, repo: '', root: null, cwd: dir, policy: policy || 'anonymize' };
  }
  const root = git(dir, ['rev-parse', '--show-toplevel']) || '';
  const repo = root ? normalizeRemote(git(root, ['remote', 'get-url', 'origin'])) : '';
  const override = root ? readJson(path.join(root, '.casebook.json'), {}) : {};
  const base = override.project || (repo ? repo.split('/').pop() : path.basename(root || dir));
  const project = slugify(base, 50);

  let policy = POLICIES.includes(override.policy) ? override.policy : null;
  if (!policy) {
    for (const rule of config.projects || []) {
      if ([repo, root, dir, project].some((v) => globMatch(rule.match, v))) {
        if (POLICIES.includes(rule.policy)) { policy = rule.policy; break; }
      }
    }
  }
  return { project, repo, root: root || null, cwd: dir, policy: policy || config.defaultPolicy || 'anonymize' };
}

function commitsBetween(root, since, until) {
  if (!root || !since) return [];
  const end = until ? new Date(new Date(until).getTime() + 10 * 60000).toISOString() : undefined;
  const args = ['log', '--no-merges', `--since=${since}`, ...(end ? [`--until=${end}`] : []), '--pretty=%h %s', '-n', '30'];
  return git(root, args).split('\n').filter(Boolean);
}

module.exports = { resolveProject, normalizeRemote, commitsBetween, POLICIES };
