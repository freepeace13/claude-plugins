'use strict';
// End-to-end tests for the casebook CLI with a stub in place of `claude -p`.
// Run: node --test tests/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const BIN = path.resolve(__dirname, '../plugins/casebook/bin/casebook');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casebook-test-'));
  const env = {
    ...process.env,
    CASEBOOK_HOME: path.join(root, 'casebook'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CASEBOOK_SCOUT: '',
  };
  delete env.CASEBOOK_SCOUT;

  // A git repo standing in for a real project.
  const repo = path.join(root, 'acme-api');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:someone/acme-api.git');

  // Stub scout: prints a fixed JSON verdict, score from env, and records the prompt it saw.
  const stub = path.join(root, 'fake-claude');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs');const input=fs.readFileSync(0,'utf8');
if (!process.argv.includes('--version')) {
  fs.writeFileSync(${JSON.stringify(path.join(root, 'last-prompt.txt'))}, input);
  fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.log'))}, (process.env.CLAUDE_CONFIG_DIR||'') + '\\n');
}
if (process.env.STUB_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.STUB_DELAY));
if (process.argv.includes('--version')) { console.log('stub 1.0'); process.exit(0); }
console.log('Here you go:\\n' + JSON.stringify({score:Number(process.env.STUB_SCORE||4),title:'Fixed websocket reconnect storms',summary:'s',problem:'p',constraints:['c'],approach:'a',alternatives:['x'],outcome:'o',evidence:['e'],tags:['Laravel','reverb'],quote:'q',open_threads:[]}));
`);
  fs.chmodSync(stub, 0o755);
  fs.mkdirSync(env.CASEBOOK_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.CASEBOOK_HOME, 'config.json'), JSON.stringify({
    defaultPolicy: 'anonymize',
    projects: [{ match: 'github.com/someone/*', policy: 'public' }],
    scout: { command: stub, minTurns: 2 },
  }));

  const calls = () => {
    try { return fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  };

  const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: opts.cwd || repo, env: { ...env, ...(opts.env || {}) }, input: opts.input });
    return { ...r, out: r.stdout.trim() };
  };

  const transcript = (sid, turns = 3, extra = []) => {
    const dir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^\w]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    const ts = (i) => new Date(Date.now() - (100 - i) * 60000).toISOString();
    for (let i = 0; i < turns; i++) {
      lines.push({ type: 'user', sessionId: sid, cwd: repo, gitBranch: 'main', timestamp: ts(i), message: { role: 'user', content: `user turn ${i} <system-reminder>noise</system-reminder>` } });
      lines.push({ type: 'assistant', sessionId: sid, cwd: repo, timestamp: ts(i), message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }, { type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'app/Ws.php') } }] } });
    }
    lines.push(...extra);
    const f = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return f;
  };

  return { root, env, repo, run, transcript, calls };
}

const idsOf = (s) => [...s.matchAll(/cb-[a-z0-9]{6}/g)].map((m) => m[0]);

test('scout creates a public log with marks, list filters, show', () => {
  const s = sandbox();
  const tp = s.transcript('sess-1', 3);
  assert.match(s.run(['mark', '--session', 'sess-1', 'the', 'reconnect', 'fix']).out, /Marked this session: the reconnect fix/);

  const r = JSON.parse(s.run(['scout', '--session', 'sess-1', '--transcript', tp, '--json']).out);
  assert.strictEqual(r.status, 'created');
  const id = r.logId;

  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /policy for this project: public/);
  assert.match(prompt, /"the reconnect fix"/);
  assert.doesNotMatch(prompt, /noise/, 'system reminders stripped');
  assert.match(prompt, /app\/Ws\.php/);

  const list = s.run(['list']).out;
  assert.match(list, /acme-api {2}\(github\.com\/someone\/acme-api\)/);
  assert.match(list, new RegExp(`${id}.*📌.*Fixed websocket reconnect storms`));
  assert.ok(s.run(['list', '--marked']).out.includes(id));

  const doc = s.run(['show', id]).out;
  assert.match(doc, /^---\nid: "cb-/);
  assert.match(doc, /"tags": \["laravel","reverb"\]|tags: \["laravel","reverb"\]/);
  assert.match(doc, /## Problem\np/);
  assert.ok(!fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'sess-1.json')), 'pending mark consumed');
});

test('unmarked short or low-score sessions are skipped; anonymize policy applied', () => {
  const s = sandbox();
  const short = s.transcript('short', 1);
  assert.match(s.run(['scout', '--session', 'short', '--transcript', short, '--auto']).out, /only 1 turns/);

  const low = s.transcript('low', 3);
  assert.match(s.run(['scout', '--session', 'low', '--transcript', low, '--auto'], { env: { STUB_SCORE: '1' } }).out, /score 1/);

  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'anonymize', project: 'client-x' }));
  const anon = s.transcript('anon', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'anon', '--transcript', anon, '--json']).out);
  assert.strictEqual(r.status, 'created');
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /policy for this project: anonymize/);
  assert.match(prompt, /Project: \[anonymized\]/);
  assert.ok(s.run(['list', '--project', 'client-x']).out.includes(r.logId));

  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'skip' }));
  const sk = s.transcript('sk', 5);
  assert.match(s.run(['scout', '--session', 'sk', '--transcript', sk]).out, /policy is skip/);
});

test('/casebook:mark inside the transcript is honoured even without a pending mark', () => {
  const s = sandbox();
  const tp = s.transcript('cmd', 1, [{ type: 'user', sessionId: 'cmd', cwd: s.repo, timestamp: new Date().toISOString(), message: { role: 'user', content: '<command-message>casebook:mark</command-message>\n<command-name>/casebook:mark</command-name>\n<command-args>queue design</command-args>' } }]);
  const r = JSON.parse(s.run(['scout', '--session', 'cmd', '--transcript', tp, '--json'], { env: { STUB_SCORE: '1' } }).out);
  assert.strictEqual(r.status, 'created', 'marked sessions are kept even when short and low-score');
  assert.match(s.run(['show', r.logId]).out, /"note":"queue design"/);
});

test('mark/unmark by ID, written, out-path, delete and batch delete', () => {
  const s = sandbox();
  const a = JSON.parse(s.run(['scout', '--session', 'a', '--transcript', s.transcript('a', 3), '--json']).out).logId;
  const b = JSON.parse(s.run(['scout', '--session', 'b', '--transcript', s.transcript('b', 3), '--json'], { env: { STUB_SCORE: '2' } }).out).logId;

  assert.match(s.run(['mark', a, 'good one']).out, /Marked/);
  assert.deepStrictEqual(idsOf(s.run(['list', '--marked']).out), [a]);
  s.run(['unmark', a]);
  assert.deepStrictEqual(idsOf(s.run(['list', '--marked']).out), []);

  const file = s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!']).out;
  assert.match(file, /case-studies\/acme-api\/\d{4}-\d{2}-\d{2}-reconnect-storms\.md$/);
  fs.writeFileSync(file, '# x');
  assert.match(s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!']).out, /-2\.md$/);
  s.run(['written', a, '--file', file]);
  assert.deepStrictEqual(idsOf(s.run(['list', '--written']).out), [a]);
  assert.deepStrictEqual(idsOf(s.run(['list', '--unwritten']).out), [b]);

  assert.match(s.run(['delete']).stderr, /needs at least one filter/);
  const dry = s.run(['delete', '--below-score', '3']);
  assert.match(dry.out, /Would delete 1/);
  assert.ok(s.run(['show', b]).status === 0, 'dry run keeps it');
  assert.match(s.run(['delete', '--below-score', '3', '--yes']).out, new RegExp(`Deleted 1 log\\(s\\): ${b}`));
  assert.notStrictEqual(s.run(['show', b]).status, 0);

  // A deleted session is not scouted again.
  assert.match(s.run(['scout', '--session', 'b']).out, /deleted/);

  assert.match(s.run(['delete', a]).out, /Deleted 1/);
  assert.match(s.run(['list']).out, /No casebook logs/);
});

test('hooks: session-end detaches a scout; never prints; guard stops recursion', async () => {
  const s = sandbox();
  const tp = s.transcript('hooked', 3);
  const input = JSON.stringify({ session_id: 'hooked', transcript_path: tp, cwd: s.repo, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });

  const guarded = s.run(['hook', 'session-end'], { input, env: { CASEBOOK_SCOUT: '1' } });
  assert.strictEqual(guarded.out, '');
  await new Promise((r) => setTimeout(r, 800));
  assert.match(s.run(['list']).out, /No casebook logs/, 'guard prevented scouting');

  const r = s.run(['hook', 'session-end'], { input });
  assert.strictEqual(r.out, '', 'hooks print nothing');
  assert.strictEqual(r.status, 0);
  for (let i = 0; i < 40 && !/cb-/.test(s.run(['list']).out); i++) await new Promise((res) => setTimeout(res, 150));
  assert.match(s.run(['list']).out, /cb-/);

  const start = s.run(['hook', 'session-start'], { input: JSON.stringify({ session_id: 'new', source: 'startup' }) });
  assert.strictEqual(start.out, '', 'SessionStart must not inject context');
});

test('sweep (maintenance) picks up sessions whose SessionEnd never fired', async () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  const cfg = path.join(s.env.CASEBOOK_HOME, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), sweep: { settleMinutes: 0 } }));

  s.transcript('orphan', 3);
  s.transcript('current', 3);
  s.run(['maintenance', '--exclude', 'current']);
  const list = s.run(['list', '--json']).out;
  const sessions = JSON.parse(list).map((l) => l.session_id);
  assert.deepStrictEqual(sessions, ['orphan']);

  // Unchanged transcript is not re-scouted.
  s.run(['maintenance', '--exclude', 'current']);
  assert.strictEqual(JSON.parse(s.run(['list', '--json']).out).length, 1);
});

// ---------------------------------------------------------------- manual scouting (spec B)

test('manual scout bypasses gates and writes a partial log; SessionEnd finishes the same log', () => {
  const s = sandbox();
  const tp = s.transcript('m1', 1);
  const r = JSON.parse(s.run(['scout', '--session', 'm1', '--transcript', tp, '--live', '--json'], { env: { STUB_SCORE: '1' } }).out);
  assert.strictEqual(r.status, 'created', 'one turn and score 1 still get a log in manual mode');
  assert.strictEqual(r.partial, true);
  const doc = s.run(['show', r.logId]).out;
  assert.match(doc, /partial: true/);
  assert.match(doc, /scout_mode: "manual"/);
  assert.match(doc, /scouted_at: "/);
  assert.match(doc, /profile: "/);
  assert.match(s.run(['list']).out, new RegExp(`${r.logId} .* 1…`));
  s.run(['mark', r.logId, 'keep me']);

  // The session carries on and ends: the auto scout finishes the same log.
  const tp2 = s.transcript('m1', 2);
  const r2 = JSON.parse(s.run(['scout', '--session', 'm1', '--transcript', tp2, '--auto', '--json']).out);
  assert.strictEqual(r2.status, 'updated');
  assert.strictEqual(r2.logId, r.logId);
  const doc2 = s.run(['show', r.logId]).out;
  assert.match(doc2, /partial: false/);
  assert.match(doc2, /"note":"keep me"/, 'marks survive');
  assert.strictEqual(idsOf(s.run(['list', '--all']).out).length, 1);
});

test('auto scout of a finished (non-partial) log still needs regrowTurns of new activity', () => {
  const s = sandbox();
  const r = JSON.parse(s.run(['scout', '--session', 'f1', '--transcript', s.transcript('f1', 3), '--auto', '--json']).out);
  assert.strictEqual(r.status, 'created');
  assert.match(s.run(['show', r.logId]).out, /partial: false/);
  const again = JSON.parse(s.run(['scout', '--session', 'f1', '--transcript', s.transcript('f1', 4), '--auto', '--json']).out);
  assert.strictEqual(again.status, 'skipped');
  assert.match(again.reason, /not enough new activity/);
});

test('manual scout: skip policy writes nothing; deleted sessions need --force', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'skip' }));
  const sk = s.run(['scout', '--session', 'sk', '--transcript', s.transcript('sk', 3)]);
  assert.strictEqual(sk.status, 0);
  assert.strictEqual(sk.out, 'Skipped: project policy is skip');
  assert.strictEqual(s.calls().length, 0);
  assert.strictEqual(s.run(['scout', '--session', 'sk', '--force', '--transcript', s.transcript('sk', 3)]).out, 'Skipped: project policy is skip', '--force never overrides skip');
  fs.rmSync(path.join(s.repo, '.casebook.json'));

  const first = JSON.parse(s.run(['scout', '--session', 'del', '--transcript', s.transcript('del', 3), '--json']).out);
  s.run(['delete', first.logId]);
  const blocked = s.run(['scout', '--session', 'del']);
  assert.match(blocked.out, /^Skipped: this session's log was deleted \(use --force to scout it again\)$/);
  const forced = JSON.parse(s.run(['scout', '--session', 'del', '--force', '--json']).out);
  assert.strictEqual(forced.status, 'created');
  assert.notStrictEqual(forced.logId, first.logId);
});

test('human output', () => {
  const s = sandbox();
  const out = s.run(['scout', '--session', 'h', '--transcript', s.transcript('h', 3), '--live']).out;
  assert.match(out, /^Created cb-[a-z0-9]{6} \(score 4, partial\): Fixed websocket reconnect storms$/);
  const up = s.run(['scout', '--session', 'h', '--live']).out;
  assert.match(up, /^Updated cb-[a-z0-9]{6} \(score 4, partial\): /);
});

test('a manual and a hook scout of one session make exactly one model call', async () => {
  const s = sandbox();
  const tp = s.transcript('dup', 3);
  const env = { ...s.env, STUB_DELAY: '1200' };
  const go = (extra) => new Promise((res) => {
    let out = '';
    const p = spawn(process.execPath, [BIN, 'scout', '--session', 'dup', '--transcript', tp, '--json', ...extra], { cwd: s.repo, env });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, ...JSON.parse(out) }));
  });
  const results = await Promise.all([go([]), go(['--auto'])]);
  assert.ok(results.every((r) => r.code === 0));
  assert.strictEqual(results.filter((r) => r.status === 'created').length, 1);
  assert.ok(results.some((r) => r.status === 'skipped' || r.status === 'running'));
  assert.strictEqual(s.calls().length, 1);
  assert.strictEqual(idsOf(s.run(['list', '--all']).out).length, 1);
});

test('a second manual scout reports the running one and exits 0', async () => {
  const s = sandbox();
  const tp = s.transcript('twice', 3);
  const env = { ...s.env, STUB_DELAY: '1500' };
  const first = spawn(process.execPath, [BIN, 'scout', '--session', 'twice', '--transcript', tp], { cwd: s.repo, env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const second = s.run(['scout', '--session', 'twice', '--transcript', tp]);
  assert.strictEqual(second.status, 0);
  assert.match(second.out, /^A scout for this session is already running\. Check \/casebook:list in a minute\.$/);
  await new Promise((r) => first.on('close', r));
  assert.strictEqual(s.calls().length, 1);
});

test('--pending --dry-run makes no model calls; --pending excludes the current session and honours --limit', () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  for (const id of ['p1', 'p2', 'p3', 'cur']) s.transcript(id, 3);

  const dry = JSON.parse(s.run(['scout', '--pending', '--dry-run', '--json', '--exclude', 'cur', '--limit', '2']).out);
  assert.strictEqual(dry.length, 2);
  assert.ok(dry.every((d) => d.sessionId !== 'cur' && d.userTurns === 3 && d.project === 'acme-api'));
  assert.strictEqual(s.calls().length, 0);
  assert.match(s.run(['scout', '--pending', '--dry-run', '--exclude', 'cur']).out, /^p1 +acme-api .* 3 turns$/m);

  const real = JSON.parse(s.run(['scout', '--pending', '--json', '--exclude', 'cur', '--limit', '2']).out);
  assert.strictEqual(real.length, 2);
  assert.strictEqual(s.calls().length, 2);
  const sessions = JSON.parse(s.run(['list', '--json']).out).map((l) => l.session_id);
  assert.ok(!sessions.includes('cur'));
  assert.strictEqual(sessions.length, 2);
});

test('--background returns at once and the log appears later', async () => {
  const s = sandbox();
  const tp = s.transcript('bg', 3);
  const t0 = Date.now();
  const r = s.run(['scout', '--session', 'bg', '--transcript', tp, '--background'], { env: { STUB_DELAY: '600' } });
  const took = Date.now() - t0;
  assert.strictEqual(r.out, 'Scouting in the background. Run /casebook:list in a minute.');
  assert.ok(took < 500, `returned in ${took}ms`);
  for (let i = 0; i < 40 && !/cb-/.test(s.run(['list']).out); i++) await new Promise((res) => setTimeout(res, 150));
  assert.match(s.run(['list']).out, /cb-/);
});

test('scout failures exit 1 with a reason and are logged', () => {
  const s = sandbox();
  const cfg = path.join(s.env.CASEBOOK_HOME, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), scout: { command: '/nonexistent/claude', minTurns: 2 } }));
  const r = s.run(['scout', '--session', 'x', '--transcript', s.transcript('x', 3)]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^casebook: scout failed: /);
  assert.match(fs.readFileSync(path.join(s.env.CASEBOOK_HOME, 'casebook.log'), 'utf8'), /scout failed for x/);
});

// ---------------------------------------------------------------- profiles (spec A)

function profileSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'casebook-prof-'));
  const home = path.join(root, 'home');
  const cb = path.join(root, 'cb');
  const dirs = { default: path.join(home, '.claude'), personal: path.join(home, '.claude_personal') };
  const repo = path.join(root, 'acme-api');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['-C', repo, 'init', '-q']);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:someone/acme-api.git']);

  const stub = path.join(root, 'fake-claude');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs=require('fs');fs.readFileSync(0,'utf8');
if (process.argv.includes('--version')) { console.log('stub 1.0'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(root, 'seen-config-dir.log'))}, (process.env.CLAUDE_CONFIG_DIR||'(unset)') + '\\n');
console.log(JSON.stringify({score:4,title:'T',summary:'s',problem:'p',constraints:[],approach:'a',alternatives:[],outcome:'o',evidence:[],tags:[],quote:'',open_threads:[]}));
`);
  fs.chmodSync(stub, 0o755);

  const baseEnv = { ...process.env, HOME: home, CASEBOOK_ROOT: cb };
  delete baseEnv.CASEBOOK_HOME; delete baseEnv.CASEBOOK_PROFILE; delete baseEnv.CASEBOOK_SCOUT; delete baseEnv.CLAUDE_CONFIG_DIR;
  const config = JSON.stringify({ defaultPolicy: 'public', scout: { command: stub, minTurns: 2 }, sweep: { settleMinutes: 0 } });
  const seedStore = (name) => { fs.mkdirSync(path.join(cb, name), { recursive: true }); fs.writeFileSync(path.join(cb, name, 'config.json'), config); };

  const run = (args, { configDir, env = {}, input } = {}) => {
    const e = { ...baseEnv, ...env };
    if (configDir) e.CLAUDE_CONFIG_DIR = configDir;
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: repo, env: e, input });
    return { ...r, out: r.stdout.trim() };
  };
  const transcript = (configDir, sid, turns = 3, mtime) => {
    const dir = path.join(configDir, 'projects', repo.replace(/[^\w]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < turns; i++) {
      lines.push({ type: 'user', sessionId: sid, cwd: repo, timestamp: new Date().toISOString(), message: { role: 'user', content: `turn ${i}` } });
      lines.push({ type: 'assistant', sessionId: sid, cwd: repo, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
    }
    const f = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (mtime) fs.utimesSync(f, mtime, mtime);
    return f;
  };
  const seen = () => { try { return fs.readFileSync(path.join(root, 'seen-config-dir.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { root, home, cb, dirs, repo, run, transcript, seen, seedStore };
}

test('profile naming and store location', () => {
  const p = profileSandbox();
  const storeOf = (configDir, env) => path.relative(p.cb, path.dirname(p.run(['config'], { configDir, env }).out.split('\n')[0]));
  assert.strictEqual(storeOf(undefined), 'default');
  assert.strictEqual(storeOf('~/.claude'), 'default', 'explicit ~/.claude is the same profile as unset');
  assert.strictEqual(storeOf(p.dirs.default + '/'), 'default', 'trailing slash stripped');
  assert.strictEqual(storeOf(p.dirs.personal), 'personal');
  assert.strictEqual(storeOf(path.join(p.home, '.claude-work')), 'work');
  assert.strictEqual(storeOf('/opt/cc/work-cfg'), 'work-cfg');
  assert.strictEqual(storeOf('/opt/cc/.dotted'), 'dotted');
  assert.strictEqual(storeOf(p.dirs.personal, { CASEBOOK_PROFILE: 'mine' }), 'mine');

  const rec = JSON.parse(fs.readFileSync(path.join(p.cb, 'personal', 'profile.json'), 'utf8'));
  assert.strictEqual(rec.name, 'personal');
  assert.strictEqual(rec.claudeConfigDir, p.dirs.personal);
  assert.ok(rec.createdAt);
});

test('CASEBOOK_HOME still forces a single store', () => {
  const p = profileSandbox();
  const forced = path.join(p.root, 'forced');
  const r = p.run(['config'], { configDir: p.dirs.personal, env: { CASEBOOK_HOME: forced } });
  assert.strictEqual(r.out.split('\n')[0], path.join(forced, 'config.json'));
});

test('stores are isolated, and the scout runs as the session\'s own profile', async () => {
  const p = profileSandbox();
  p.seedStore('default'); p.seedStore('personal');
  const tp = p.transcript(p.dirs.personal, 'sp', 3);
  const input = JSON.stringify({ session_id: 'sp', transcript_path: tp, cwd: p.repo });

  // Hook inside the personal profile.
  const hook = p.run(['hook', 'session-end'], { configDir: p.dirs.personal, input });
  assert.strictEqual(hook.out, '');
  for (let i = 0; i < 40 && !/cb-/.test(p.run(['list'], { configDir: p.dirs.personal }).out); i++) await new Promise((r) => setTimeout(r, 150));
  const personal = p.run(['list'], { configDir: p.dirs.personal });
  assert.match(personal.out, /^\[profile: personal\]/);
  assert.match(personal.out, /cb-/);
  assert.match(p.run(['list', '--all']).out, /No casebook logs/, 'default profile sees nothing');
  assert.ok(!fs.existsSync(path.join(p.cb, 'default', 'logs')));
  assert.deepStrictEqual(p.seen(), [p.dirs.personal]);
  assert.match(fs.readFileSync(p.run(['show', personal.out.match(/cb-[a-z0-9]{6}/)[0], '--path'], { configDir: p.dirs.personal }).out, 'utf8'), /profile: "personal"/);

  // Terminal: no inherited CLAUDE_CONFIG_DIR, --profile picks the store and the config dir.
  p.transcript(p.dirs.personal, 'sp2', 3);
  const term = p.run(['scout', '--session', 'sp2', '--profile', 'personal', '--json']);
  assert.strictEqual(JSON.parse(term.out).status, 'created');
  assert.deepStrictEqual(p.seen(), [p.dirs.personal, p.dirs.personal]);

  // And the reverse: a default-profile session never lands in personal.
  const dtp = p.transcript(p.dirs.default, 'sd', 3);
  assert.strictEqual(JSON.parse(p.run(['scout', '--session', 'sd', '--transcript', dtp, '--json']).out).status, 'created');
  assert.strictEqual(JSON.parse(p.run(['list', '--json'], { configDir: p.dirs.personal }).out).length, 2);
  assert.strictEqual(JSON.parse(p.run(['list', '--json']).out).length, 1);
  assert.strictEqual(p.seen()[2], p.dirs.default);
});

test('transcript discovery and catch-up stay inside the profile; installedAt is per store', () => {
  const p = profileSandbox();
  p.seedStore('default'); p.seedStore('personal');
  p.run(['list']); // installs the default store now
  const yesterday = new Date(Date.now() - 86400000);
  p.transcript(p.dirs.personal, 'before-install', 3, yesterday);
  p.run(['list'], { configDir: p.dirs.personal }); // personal installs later
  p.transcript(p.dirs.personal, 'after-install', 3);
  p.transcript(p.dirs.default, 'other-profile', 3);

  p.run(['maintenance'], { configDir: p.dirs.personal });
  const logs = JSON.parse(p.run(['list', '--json'], { configDir: p.dirs.personal }).out).map((l) => l.session_id);
  assert.deepStrictEqual(logs, ['after-install'], 'no backfill before installedAt, nothing from the default profile');

  // scout --session only looks in its own profile's projects
  assert.match(p.run(['scout', '--session', 'other-profile'], { configDir: p.dirs.personal }).out, /Skipped: transcript not found/);
});

test('two config dirs with the same profile name get separate stores', () => {
  const p = profileSandbox();
  const a = '/srv/a/work-cfg';
  const b = '/srv/b/work-cfg';
  const storeOf = (dir) => path.basename(path.dirname(p.run(['config'], { configDir: dir }).out.split('\n')[0]));
  assert.strictEqual(storeOf(a), 'work-cfg');
  const second = storeOf(b);
  assert.match(second, /^work-cfg-[0-9a-f]{4}$/);
  assert.strictEqual(storeOf(b), second, 'stable');
  assert.strictEqual(storeOf(a), 'work-cfg');
  assert.match(fs.readFileSync(path.join(p.cb, second, 'casebook.log'), 'utf8'), /collision/);
});

test('--profile: unknown profile fails with the known list; profiles lists stores', () => {
  const p = profileSandbox();
  p.seedStore('default'); p.seedStore('personal');
  p.run(['list']);
  p.run(['list'], { configDir: p.dirs.personal });
  const bad = p.run(['--profile', 'nope', 'list']);
  assert.strictEqual(bad.status, 1);
  assert.strictEqual(bad.stderr.trim(), 'casebook: no profile "nope". Known: default, personal');

  const table = p.run(['profiles']).stdout;
  assert.match(table, /^ {2}PROFILE +CONFIG DIR +LOGS +LAST LOG$/m);
  assert.match(table, /^\* default /m);
  assert.match(table, /^ {2}personal /m);
  const json = JSON.parse(p.run(['profiles', '--json'], { configDir: p.dirs.personal }).out);
  assert.deepStrictEqual(json.map((x) => [x.name, x.current]), [['default', false], ['personal', true]]);
  assert.strictEqual(json[1].claudeConfigDir, p.dirs.personal);

  const doc = p.run(['doctor'], { configDir: p.dirs.personal }).out;
  assert.match(doc, /^profile +personal$/m);
  assert.match(doc, new RegExp(`^config dir +${p.dirs.personal}$`, 'm'));
});

test('marketplace is named freepeace13', () => {
  const m = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.claude-plugin/marketplace.json'), 'utf8'));
  assert.strictEqual(m.name, 'freepeace13');
});

// ---------------------------------------------------------------- review follow-ups

test('an empty lock file left by a dead scout is recovered', () => {
  const s = sandbox();
  const locks = path.join(s.env.CASEBOOK_HOME, 'state', 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, 'dead.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const r = JSON.parse(s.run(['scout', '--session', 'dead', '--transcript', s.transcript('dead', 3), '--json']).out);
  assert.strictEqual(r.status, 'created');
});

test('backfill says so when a catch-up already holds the lock', () => {
  const s = sandbox();
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'sweep.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now() }));
  assert.match(s.run(['backfill', '--yes']).out, /A catch-up is already running/);
});

test('--profile rejects path-like names and cannot be combined with CASEBOOK_HOME', () => {
  const p = profileSandbox();
  p.seedStore('default');
  p.run(['list']);
  const bad = p.run(['--profile', '../x', 'list']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /invalid profile name/);
  const home = p.run(['--profile', 'default', 'list'], { env: { CASEBOOK_HOME: path.join(p.root, 'h') } });
  assert.strictEqual(home.status, 1);
  assert.match(home.stderr, /CASEBOOK_HOME/);
});

test('a background scout that finds the session already being scouted is logged', async () => {
  const s = sandbox();
  const tp = s.transcript('bgrun', 3);
  const first = spawn(process.execPath, [BIN, 'scout', '--session', 'bgrun', '--transcript', tp], { cwd: s.repo, env: { ...s.env, STUB_DELAY: '1500' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  s.run(['scout', '--session', 'bgrun', '--transcript', tp, '--background']);
  const logFile = path.join(s.env.CASEBOOK_HOME, 'casebook.log');
  for (let i = 0; i < 30 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(fs.readFileSync(logFile, 'utf8'), /scout for bgrun not run: A scout for this session is already running/);
  await new Promise((r) => first.on('close', r));
});

test('a child pinned with CASEBOOK_PROFILE stays in the store when its config dir is spelled via a symlink', () => {
  const p = profileSandbox();
  const real = path.join(p.root, 'real-cfg');
  const link = path.join(p.root, 'link-cfg');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const storeOf = (dir) => path.basename(path.dirname(p.run(['config'], { configDir: dir, env: { CASEBOOK_PROFILE: 'shared' } }).out.split('\n')[0]));
  assert.strictEqual(storeOf(real), 'shared');
  assert.strictEqual(storeOf(link), 'shared');
});
