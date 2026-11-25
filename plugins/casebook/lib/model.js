'use strict';
// One headless `claude -p` call, as the account `claude` ran under. Used by discovery to scan sessions.

const os = require('os');
const { spawn } = require('child_process');
const { paths } = require('./util');

const POLICY_RULES = {
  public:
    'Public: the repository is public. You may name the project, repository, libraries and the developer\'s own product, and cite commit hashes, pull request numbers and file paths. Still do not name third-party clients or people.',
  anonymize:
    'Anonymize: this may be client or employer work. Do NOT name the client, company, product, repository, domain, people, or internal URLs. Describe them generically ("a logistics SaaS", "a fintech client"), and still say what the system is and does. No commit hashes, pull request numbers or file paths. Keep the technical story, stack and numbers.',
};

function childEnv() {
  const env = { ...process.env, CASEBOOK_SCAN: '1' };
  if (paths.claudeConfigDirExplicit()) env.CLAUDE_CONFIG_DIR = paths.claudeConfigDir();
  return env;
}

function claudeInvocation(config) {
  const cmd = config.scan.command || 'claude';
  const hardened = ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
  const base = ['-p', '--model', config.scan.model || 'haiku', '--tools', '', '--output-format', 'text'];
  return { cmd, full: [...base, ...hardened], fallback: [...base, '--no-session-persistence'] };
}

// Older Claude Code versions may not know every hardening flag: retry with the essentials.
const unknownFlag = (r) => r.status !== 0 && /unknown option|unrecognized/i.test(`${r.stderr}${r.stdout}`);

function checkRun(r) {
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`scan exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return r.stdout;
}

/** Run the model on a prompt without blocking, so several scans can run side by side. Resolves to stdout. */
async function runClaudeAsync(prompt, config, opts = {}) {
  const { cmd, full, fallback } = claudeInvocation(config);
  const timeoutSec = opts.timeoutSec || config.scan.timeoutSec || 240;
  const once = (args) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout, stderr, ...r }); } };
    const child = spawn(cmd, args, { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    // SIGTERM first; a child that ignores it is killed and its pipes closed, so the caller can exit.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } for (const p of [child.stdin, child.stdout, child.stderr]) try { p.destroy(); } catch { /* closed */ } }, 5000).unref();
      finish({ status: null, error: new Error(`scan timed out after ${timeoutSec}s`) }); },
      timeoutSec * 1000);
    // Decode as a stream: a character split across two chunks must not turn into U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ status: null, error }));
    child.on('close', (status) => finish({ status }));
    child.stdin.on('error', () => { /* the child may exit before reading everything */ });
    child.stdin.end(prompt);
  });
  let r = await once(full);
  if (unknownFlag(r)) r = await once(fallback);
  return checkRun(r);
}

module.exports = { runClaudeAsync, POLICY_RULES };
