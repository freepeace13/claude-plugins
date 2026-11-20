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
if (process.env.STUB_TOPICS) { console.log(process.env.STUB_TOPICS); process.exit(0); }
console.log('Here you go:\\n' + JSON.stringify({score:Number(process.env.STUB_SCORE||4),fit:Number(process.env.STUB_FIT||2),belongs:process.env.STUB_BELONGS?JSON.parse(process.env.STUB_BELONGS):[],title:'Fixed websocket reconnect storms',summary:'s',problem:'p',constraints:['c'],approach:'a',alternatives:['x'],outcome:'o',evidence:['e'],tags:['Laravel','reverb'],quote:'q',open_threads:[]}));
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
  const local = new Date();
  const today = [local.getFullYear(), local.getMonth() + 1, local.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  assert.ok(path.basename(file).startsWith(today + '-'), 'out-path names files with the local date');
  assert.match(file, /case-studies\/acme-api\/\d{4}-\d{2}-\d{2}-reconnect-storms\.md$/);
  fs.writeFileSync(file, '# x');
  assert.match(s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!']).out, /-2\.md$/);
  const handoff = s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!', '--handoff']).out;
  assert.match(handoff, /handoffs\/acme-api\/\d{4}-\d{2}-\d{2}-reconnect-storms$/, 'a handoff is a folder under handoffs/');
  assert.ok(!fs.existsSync(handoff), 'the folder itself is left for the skill to create');
  fs.mkdirSync(handoff);
  assert.match(s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!', '--handoff']).out, /reconnect-storms-2$/);
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

test('manual scout: skip policy writes nothing; a deleted topic stays deleted unless --force', () => {
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
  // Hooks leave a session whose logs were all deleted alone; a manual scan may look again but not bring the topic back.
  assert.match(s.run(['scout', '--session', 'del', '--auto']).out, /^Skipped: this session's logs were deleted$/);
  const blocked = s.run(['scout', '--session', 'del']);
  assert.match(blocked.out, /^Skipped: the only topics found were ones you deleted \(use --force to log them again\)$/);
  assert.match(fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8'), /Deleted by the developer[\s\S]*"Fixed websocket reconnect storms"/);
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
  assert.ok(results.some((r) => ['skipped', 'running', 'updated'].includes(r.status)), 'the other one waits, then skips, finishes the partial log, or reports running');
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
if (process.env.STUB_TOPICS) { console.log(process.env.STUB_TOPICS); process.exit(0); }
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
  assert.strictEqual(p.seen()[2], '(unset)', 'default profile with no CLAUDE_CONFIG_DIR keeps it unset for the child');
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

test('marketplace is named kinbasco-plugins', () => {
  const m = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.claude-plugin/marketplace.json'), 'utf8'));
  assert.strictEqual(m.name, 'kinbasco-plugins');
});

test('handoff skill: same arguments as write, reads handoff.md, thin writes nothing, stays inside casebook', () => {
  const root = path.resolve(__dirname, '../plugins/casebook');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const hint = (doc) => doc.match(/^argument-hint: (.+)$/m)[1];
  const skill = read('skills/handoff/SKILL.md');

  assert.strictEqual(hint(skill), hint(read('skills/write/SKILL.md')));
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/handoff\.md/);
  assert.ok(fs.existsSync(path.join(root, 'handoff.md')), 'the checks it reads ship with the plugin');
  for (const id of ['E-1', 'E-2', 'E-3', 'E-4', 'A-1', 'A-2', 'A-3']) assert.match(read('handoff.md'), new RegExp(`\\| ${id} \\|`));
  assert.match(skill, /Nothing was written/);
  assert.match(skill, /casebook out-path --handoff/);
  assert.match(skill, /Do not run `casebook written`/);
  assert.doesNotMatch(skill, /\/porch:|mcp__plugin_porch/, 'a plugin never points at another plugin');
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
  assert.match(p.run(['--profile', '.hidden', 'list']).stderr, /invalid profile name/);
  p.seedStore('_odd');
  fs.writeFileSync(path.join(p.cb, '_odd', 'profile.json'), JSON.stringify({ name: '_odd', claudeConfigDir: path.join(p.home, '.odd') }));
  assert.strictEqual(p.run(['--profile', '_odd', 'list']).status, 0, 'any store name the code can produce is reachable');
  fs.mkdirSync(path.join(p.cb, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(p.cb, 'broken', 'profile.json'), '{}');
  assert.match(p.run(['--profile', 'broken', 'list']).stderr, /no claudeConfigDir/);
  const home = p.run(['--profile', 'default', 'list'], { env: { CASEBOOK_HOME: path.join(p.root, 'h') } });
  assert.strictEqual(home.status, 1, 'never silently acts on the wrong store');
  assert.match(home.stderr, /cannot be used while CASEBOOK_HOME is set/);
  assert.match(p.run(['list', '--profile']).stderr, /--profile needs a profile name/);
  assert.strictEqual(p.run(['help', '--profile', 'nope']).status, 0, 'help never needs a profile');
});

test('a background scout that finds the session already being scouted is logged', async () => {
  const s = sandbox();
  const tp = s.transcript('bgrun', 3);
  const first = spawn(process.execPath, [BIN, 'scout', '--session', 'bgrun', '--transcript', tp], { cwd: s.repo, env: { ...s.env, STUB_DELAY: '2500' }, stdio: 'ignore' });
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'locks', 'bgrun.lock');
  for (let i = 0; i < 50 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
  s.run(['scout', '--session', 'bgrun', '--transcript', tp, '--background']);
  const logFile = path.join(s.env.CASEBOOK_HOME, 'casebook.log');
  const read = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  for (let i = 0; i < 50 && !/not run/.test(read()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(read(), /scout for bgrun not run: A scout for this session is already running/);
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

test('a fresh empty lock is respected; a stale one is reclaimed exactly once under contention', async () => {
  const s = sandbox();
  const locks = path.join(s.env.CASEBOOK_HOME, 'state', 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, 'race.lock');
  fs.writeFileSync(lock, '');
  const tp = s.transcript('race', 3);
  assert.match(s.run(['scout', '--session', 'race', '--transcript', tp]).out, /already running/, 'just-created lock gets its grace period');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const go = () => new Promise((res) => {
    let out = '';
    const p = spawn(process.execPath, [BIN, 'scout', '--session', 'race', '--transcript', tp, '--json'], { cwd: s.repo, env: { ...s.env, STUB_DELAY: '800' } });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => res(JSON.parse(out)));
  });
  const results = await Promise.all([go(), go(), go()]);
  assert.strictEqual(results.filter((r) => r.status === 'created').length, 1);
  assert.strictEqual(s.calls().length, 1);
  assert.deepStrictEqual(fs.readdirSync(locks), [], 'no leftover lock or aside files');
});

test('--limit must be a positive whole number', () => {
  const s = sandbox();
  for (const bad of ['abc', '0', '-2', '1.5']) {
    const r = s.run(['scout', '--pending', '--dry-run', '--limit', bad]);
    assert.strictEqual(r.status, 1, bad);
    assert.match(r.stderr, /--limit must be a positive whole number/);
  }
  assert.match(s.run(['backfill', '--limit', 'x', '--yes']).stderr, /--limit must be/);
});

test('--pending marks a recently active session partial, so SessionEnd can finish it', () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  s.transcript('live-elsewhere', 3);
  const r = JSON.parse(s.run(['scout', '--pending', '--json']).out);
  assert.strictEqual(r[0].partial, true);
  assert.match(s.run(['show', r[0].logId]).out, /partial: true/);
  // The session carries on by one turn and ends: the auto scout finishes the same log despite regrowTurns.
  const fin = JSON.parse(s.run(['scout', '--session', 'live-elsewhere', '--transcript', s.transcript('live-elsewhere', 4), '--auto', '--json']).out);
  assert.strictEqual(fin.status, 'updated');
  assert.match(s.run(['show', r[0].logId]).out, /partial: false/);
});

test('a partial log with nothing new is finished by the auto scout without a model call', () => {
  const s = sandbox();
  const tp = s.transcript('end', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'end', '--transcript', tp, '--live', '--json']).out);
  assert.strictEqual(r.partial, true);
  assert.strictEqual(s.calls().length, 1);
  const fin = JSON.parse(s.run(['scout', '--session', 'end', '--transcript', tp, '--auto', '--json']).out);
  assert.strictEqual(fin.status, 'updated');
  assert.strictEqual(fin.logId, r.logId);
  assert.strictEqual(fin.partial, false);
  assert.strictEqual(s.calls().length, 1, 'no second model call');
  assert.match(s.run(['show', r.logId]).out, /partial: false/);
  assert.doesNotMatch(s.run(['list']).out, /…/);
});

test('session ids that sanitise to the same name get separate locks', () => {
  const s = sandbox();
  const locks = path.join(s.env.CASEBOOK_HOME, 'state', 'locks');
  fs.mkdirSync(locks, { recursive: true });
  // A live lock held for "x" must not block "../x".
  fs.writeFileSync(path.join(locks, 'x.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const tp = s.transcript('../x', 3);
  const r = JSON.parse(s.run(['scout', '--session', '../x', '--transcript', tp, '--json']).out);
  assert.strictEqual(r.status, 'created');
});

test('CASEBOOK_PROFILE is validated like --profile', () => {
  const p = profileSandbox();
  const r = p.run(['list'], { env: { CASEBOOK_PROFILE: '../../escape' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid profile name/);
  assert.ok(!fs.existsSync(path.join(p.root, 'escape')));
});

test('a hash-suffixed store stays stable when the store that claimed the plain name is gone', () => {
  const p = profileSandbox();
  const storeOf = (dir) => path.basename(path.dirname(p.run(['config'], { configDir: dir }).out.split('\n')[0]));
  assert.strictEqual(storeOf('/srv/a/work-cfg'), 'work-cfg');
  const second = storeOf('/srv/b/work-cfg');
  assert.match(second, /^work-cfg-[0-9a-f]{4}$/);
  fs.rmSync(path.join(p.cb, 'work-cfg'), { recursive: true });
  assert.strictEqual(storeOf('/srv/b/work-cfg'), second);
});

test('profiles lists the current store even before it has been used', () => {
  const p = profileSandbox();
  const list = JSON.parse(p.run(['profiles', '--json'], { configDir: p.dirs.personal }).out);
  assert.deepStrictEqual(list.map((x) => [x.name, x.current]), [['personal', true]]);
});

test('the default profile leaves CLAUDE_CONFIG_DIR unset for the scout; other profiles set it', () => {
  const p = profileSandbox();
  p.seedStore('default'); p.seedStore('personal');
  p.run(['list']);
  p.run(['list'], { configDir: p.dirs.personal });
  p.transcript(p.dirs.default, 'dd', 3);
  p.transcript(p.dirs.personal, 'pp', 3);
  p.run(['scout', '--session', 'dd']);
  p.run(['scout', '--session', 'pp', '--profile', 'personal']);
  assert.deepStrictEqual(p.seen(), ['(unset)', p.dirs.personal]);
});

test('a live scout does not finish a partial log; a mark added meanwhile is kept when it is finished', () => {
  const s = sandbox();
  const tp = s.transcript('lv', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'lv', '--transcript', tp, '--live', '--json']).out);
  const again = JSON.parse(s.run(['scout', '--session', 'lv', '--transcript', tp, '--auto', '--live', '--json']).out);
  assert.strictEqual(again.status, 'skipped', 'still running: leave it partial');
  assert.match(s.run(['show', r.logId]).out, /partial: true/);
  s.run(['mark', '--session', 'lv', 'late', 'note']);
  const fin = JSON.parse(s.run(['scout', '--session', 'lv', '--transcript', tp, '--auto', '--json']).out);
  assert.strictEqual(fin.status, 'updated');
  const doc = s.run(['show', r.logId]).out;
  assert.match(doc, /"note":"late note"/, 'marks on an existing log are applied directly and survive');
  assert.match(doc, /partial: false/);
  assert.strictEqual(s.calls().length, 1, 'nothing new in the transcript, so no second model call');
});

test('a catch-up pass skips a session another scout holds instead of waiting', async () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  const tp = s.transcript('busy', 3);
  const first = spawn(process.execPath, [BIN, 'scout', '--session', 'busy', '--transcript', tp], { cwd: s.repo, env: { ...s.env, STUB_DELAY: '2000' }, stdio: 'ignore' });
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'locks', 'busy.lock');
  for (let i = 0; i < 50 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const r = JSON.parse(s.run(['scout', '--pending', '--json']).out);
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the busy session');
  assert.strictEqual(r[0].status, 'running');
  await new Promise((res) => first.on('close', res));
});

test('an invalid CASEBOOK_PROFILE does not block an explicit --profile', () => {
  const p = profileSandbox();
  p.seedStore('default');
  p.run(['list']);
  const r = p.run(['list', '--profile', 'default'], { env: { CASEBOOK_PROFILE: '.x' } });
  assert.strictEqual(r.status, 0);
});

test('a symlinked ~/.claude is still the default profile', () => {
  const p = profileSandbox();
  fs.mkdirSync(p.dirs.default, { recursive: true });
  const real = path.join(p.root, 'real-claude');
  fs.mkdirSync(real);
  fs.rmSync(p.dirs.default, { recursive: true });
  fs.symlinkSync(real, p.dirs.default);
  const store = path.basename(path.dirname(p.run(['config'], { configDir: real }).out.split('\n')[0]));
  assert.strictEqual(store, 'default');
});

test('doctor probes claude the way the scout runs it', () => {
  const p = profileSandbox();
  p.seedStore('default'); p.seedStore('personal');
  assert.match(p.run(['doctor']).out, /CLAUDE_CONFIG_DIR left unset/);
  assert.match(p.run(['doctor'], { configDir: p.dirs.personal }).out, /CLAUDE_CONFIG_DIR set\)/);
});

test('the catch-up lock is atomic, owner-checked, and not stolen from a live holder', () => {
  const s = sandbox();
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'sweep.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  // Held by a live process for over 30 minutes: no longer stolen (it used to be).
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now() - 2 * 3600000 }));
  assert.match(s.run(['backfill', '--yes']).out, /already running/);
  assert.ok(fs.existsSync(lock), 'a live holder keeps its lock');
  // A dead holder is reclaimed and the lock is released afterwards.
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, t: Date.now() }));
  s.transcript('lk', 3);
  assert.doesNotMatch(s.run(['backfill', '--yes']).out, /already running/);
  assert.ok(!fs.existsSync(lock), 'released');
});

test('catch-up sessions skipped as busy do not use up the limit', async () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  const old = (id, ago) => { const f = s.transcript(id, 3); const t = new Date(Date.now() - ago); fs.utimesSync(f, t, t); return f; };
  const busyTp = old('busy1', 5000000);
  old('newer', 1000000);
  const first = spawn(process.execPath, [BIN, 'scout', '--session', 'busy1', '--transcript', busyTp], { cwd: s.repo, env: { ...s.env, STUB_DELAY: '2500' }, stdio: 'ignore' });
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'locks', 'busy1.lock');
  for (let i = 0; i < 50 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
  const r = JSON.parse(s.run(['scout', '--pending', '--limit', '1', '--json']).out);
  assert.deepStrictEqual(r.map((x) => [x.sessionId, x.status]), [['busy1', 'running'], ['newer', 'created']]);
  await new Promise((res) => first.on('close', res));
});

test('a recently active session is not finished early by a catch-up pass', () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  const tp = s.transcript('act', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'act', '--transcript', tp, '--live', '--json']).out);
  // Same transcript, still recent: the logic reached through a catch-up must leave it partial.
  const again = JSON.parse(s.run(['scout', '--pending', '--json']).out);
  assert.ok(again.every((x) => x.status !== 'updated'), 'unchanged and recent: nothing to do');
  assert.match(s.run(['show', r.logId]).out, /partial: true/);
});

test('session ids that sanitise alike get separate ledgers as well as separate locks', () => {
  const s = sandbox();
  const a = JSON.parse(s.run(['scout', '--session', 'x', '--transcript', s.transcript('x', 3), '--json']).out);
  const b = JSON.parse(s.run(['scout', '--session', '../x', '--transcript', s.transcript('../x', 3), '--json']).out);
  assert.strictEqual(a.status, 'created');
  assert.strictEqual(b.status, 'created', 'the second id is not mistaken for the first one');
  assert.notStrictEqual(a.logId, b.logId);
  const files = fs.readdirSync(path.join(s.env.CASEBOOK_HOME, 'state', 'sessions')).sort();
  assert.strictEqual(files.length, 2);
  assert.ok(files.includes('x.json'), 'ordinary ids keep their plain file name');
});

test('a relative CASEBOOK_HOME resolves to one absolute store', () => {
  const s = sandbox();
  const r = s.run(['config'], { env: { CASEBOOK_HOME: 'rel-store' }, cwd: s.root });
  assert.strictEqual(r.out.split('\n')[0], path.join(fs.realpathSync(s.root), 'rel-store', 'config.json'));
});

// ---------- topics and discovery ----------

// A session on a feature branch: the branch is set by a trailing entry, as Claude Code records it.
const onBranch = (sid, branch) => [{ type: 'system', sessionId: sid, gitBranch: branch }];
const topic = (o) => ({ score: 4, angle: 'debugging', title: 'T', summary: 's', problem: 'p', approach: 'a', outcome: 'o', tags: ['redis'], ...o });
const reply = (...topics) => ({ STUB_TOPICS: JSON.stringify({ topics }) });
const logsJson = (s) => JSON.parse(s.run(['list', '--json']).out);

test('one session can give several topics; a rescan updates them instead of logging them twice', () => {
  const s = sandbox();
  const tp = s.transcript('multi', 3);
  const two = reply(topic({ title: 'Debugging the reconnect storm' }), topic({ title: 'Choosing Redis Streams over pub/sub', angle: 'architecture', score: 3 }));
  const r = s.run(['scout', '--session', 'multi', '--transcript', tp], { env: two });
  assert.match(r.out, /^Created cb-\w{6} \(score 4, partial, debugging\): Debugging the reconnect storm\nCreated cb-\w{6} \(score 3, partial, architecture\): Choosing Redis Streams/);
  const logs = logsJson(s);
  assert.strictEqual(logs.length, 2);
  assert.ok(logs.every((l) => l.sessions.join() === 'multi'));

  // The rescan sees both logs and says so; nothing is duplicated, and a new angle becomes a third log.
  const [dbg, arch] = ['Debugging the reconnect storm', 'Choosing Redis Streams over pub/sub'].map((t) => logs.find((l) => l.title === t).id);
  const again = s.run(['scout', '--session', 'multi'], {
    env: reply(topic({ title: 'Debugging the reconnect storm, with the root cause', same_as: [dbg], score: 5 }), topic({ title: 'Choosing Redis Streams over pub/sub', angle: 'architecture' }), topic({ title: 'Load-testing reconnects', angle: 'testing', score: 3 })),
  });
  assert.strictEqual(again.status, 0, again.stderr);
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.ok(prompt.includes(`### ${dbg} · debugging`) && prompt.includes(`### ${arch} · architecture`), 'the scan sees the existing logs');
  assert.match(again.out, new RegExp(`Updated ${dbg} \\(score 5, partial, debugging\\): Debugging the reconnect storm, with the root cause`));
  assert.match(again.out, new RegExp(`Updated ${arch} .*Choosing Redis Streams`), 'same title for the same session is never logged twice');
  assert.match(again.out, /Created cb-\w{6} \(score 3, partial, testing\): Load-testing reconnects/);
  assert.strictEqual(logsJson(s).length, 3);

  // With several logs, a session mark waits for the next scan, which gives it to the topic it points to.
  assert.match(s.run(['mark', '--session', 'multi', 'the', 'root', 'cause']).out, /Marked this session: the root cause/);
  s.run(['scout', '--session', 'multi'], { env: reply(topic({ title: 'Debugging the reconnect storm, with the root cause', same_as: [dbg], marks: true }), topic({ title: 'Choosing Redis Streams over pub/sub', same_as: [arch] })) });
  assert.match(s.run(['show', dbg]).out, /"note":"the root cause"/);
  assert.doesNotMatch(s.run(['show', arch]).out, /the root cause/);

  // Deleting one topic keeps the session scannable for others; the deleted one never comes back.
  s.run(['delete', arch]);
  const after = s.run(['scout', '--session', 'multi', '--json'], { env: reply(topic({ title: 'Choosing Redis Streams over pub/sub' }), topic({ title: 'Debugging the reconnect storm, with the root cause', same_as: [dbg] })) });
  const res = JSON.parse(after.out);
  assert.deepStrictEqual(res.logs.map((l) => l.logId), [dbg]);
  assert.ok(!logsJson(s).some((l) => l.title.startsWith('Choosing Redis')));
});

test('a continued session can extend a log from an earlier session', () => {
  const s = sandbox();
  const first = JSON.parse(s.run(['scout', '--session', 'day1', '--transcript', s.transcript('day1', 3), '--json']).out).logId;
  const r = JSON.parse(s.run(['scout', '--session', 'day2', '--transcript', s.transcript('day2', 3), '--json'], { env: reply(topic({ title: 'Reconnect storms, fixed over two days', same_as: [first] })) }).out);
  assert.strictEqual(r.status, 'updated');
  assert.strictEqual(r.logId, first);
  const doc = s.run(['show', first]).out;
  assert.match(doc, /sessions: \["day1","day2"\]/);
  assert.match(doc, /user_turns: 6/);
  assert.strictEqual(logsJson(s).length, 1);
});

test('discovery links a feature branch, sees its logs and merges the duplicates on pick', () => {
  const s = sandbox();
  const a = s.transcript('chain-a', 3, onBranch('chain-a', 'feat/ws'));
  const b = s.transcript('chain-b', 3, onBranch('chain-b', 'feat/ws'));
  s.transcript('lone-c', 3); // on main, unlogged: its own candidate
  const la = JSON.parse(s.run(['scout', '--session', 'chain-a', '--transcript', a, '--json']).out).logId;
  const lb = JSON.parse(s.run(['scout', '--session', 'chain-b', '--transcript', b, '--json']).out).logId;
  assert.notStrictEqual(la, lb, 'one-session scouts log the halves separately');
  s.run(['mark', la, 'redis streams part']);
  s.run(['written', lb, '--file', path.join(s.root, 'cs.md')]);

  const before = s.calls().length;
  const shortlist = JSON.parse(s.run(['discover', '--dry-run', '--json']).out);
  assert.strictEqual(s.calls().length, before, 'dry run makes no model calls');
  const chain = shortlist.find((g) => g.sessions.length === 2);
  assert.deepStrictEqual(chain.sessions.sort(), ['chain-a', 'chain-b']);
  assert.match(chain.reasons.join(), /same branch feat\/ws/);
  assert.deepStrictEqual(chain.logs.sort(), [la, lb].sort(), 'logged sessions are scanned again');
  assert.ok(shortlist.some((g) => g.sessions.join() === 'lone-c'));

  const env = reply(topic({ title: 'Websocket reconnects backed by Redis Streams', same_as: [la, lb], belongs: [1, 2], fit: 2, score: 5 }));
  const r = s.run(['discover', '--note', 'websocket redis', '--min-score', '3'], { env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(s.calls().length, before + 2, 'one model call per candidate');
  assert.match(r.out, /\n1\. \[5…?\] Websocket reconnects backed by Redis Streams\n {3}acme-api · debugging · 2 sessions/);
  assert.match(r.out, new RegExp(`merges: ${la}, ${lb} \\(duplicates of this topic\\)`));
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /Note: websocket redis/);
  assert.ok(prompt.includes(`### ${la} ·`), 'the chain scan sees existing logs');

  const did = /Discovery (d-[a-z0-9]{6})/.exec(r.out)[1];
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 0, p.stderr);
  assert.match(p.out, new RegExp(`^Updated ${lb} \\(score 5.*2 sessions\\): Websocket reconnects`), 'the written-up log survives');
  assert.match(p.out, new RegExp(`Merged into it: ${la}`));
  const doc = s.run(['show', lb]).out;
  assert.match(doc, /sessions: \["chain-b","chain-a"\]|sessions: \["chain-a","chain-b"\]/);
  assert.match(doc, /"note":"redis streams part"/, 'marks carry over');
  assert.match(doc, /written_to: \[".*cs\.md"\]/);
  assert.match(doc, new RegExp(`merged_from: \\["${la}"\\]`));
  assert.ok(!logsJson(s).some((l) => l.id === la));
  assert.match(s.run(['discover', 'pick', did, '1']).out, new RegExp(`Already logged as ${lb}`));
});

test('discovery: new angles, nothing-new topics, deleted topics, and the score, fit and tag filters', () => {
  const s = sandbox();
  const a = s.transcript('fa', 3, onBranch('fa', 'feat/y'));
  s.transcript('fb', 3, onBranch('fb', 'feat/y'));
  const la = JSON.parse(s.run(['scout', '--session', 'fa', '--transcript', a, '--json']).out).logId;

  assert.match(s.run(['discover', '--min-score', '5']).out, /No topic matched\. Scored 1 candidate\(s\) .*best scored 4/);
  assert.match(s.run(['discover', '--note', 'kafka'], { env: { STUB_FIT: '0' } }).out, /No topic matched/);
  assert.match(s.run(['discover', '--tags', 'kafka,graphql']).out, /Nothing to discover/);
  assert.strictEqual(s.run(['discover', '--min-score', '9']).status, 1);

  // Already logged with exactly these sessions: not a discovery.
  assert.match(s.run(['discover'], { env: reply(topic({ title: 'x', same_as: [la], belongs: [1] })) }).out, /No topic matched/);

  // A new angle on the chain becomes its own log; the old one stays.
  const r = s.run(['discover', '--tags', 'user turn'], { env: reply(topic({ title: 'Testing reconnects across deploys', angle: 'testing', belongs: [2], fit: 2 })) });
  assert.match(r.out, /testing · 1 session ·[\s\S]*new log/);
  const did = /Discovery (d-[a-z0-9]{6})/.exec(r.out)[1];
  const id = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did, '1']).out)[1];
  const logs = logsJson(s);
  assert.deepStrictEqual(logs.map((l) => l.id).sort(), [la, id].sort());
  assert.deepStrictEqual(logs.find((l) => l.id === id).sessions, ['fb']);

  // A deleted topic is not offered again, unless --force.
  s.run(['delete', id]);
  const env = reply(topic({ title: 'Testing reconnects across deploys', angle: 'testing', belongs: [2] }));
  assert.match(s.run(['discover'], { env }).out, /No topic matched/);
  assert.match(s.run(['discover', '--force'], { env }).out, /Testing reconnects across deploys/);
});

// ---------------------------------------------------------------- topics review follow-ups

test('a session mark on a session with several logs is placed by the next auto scan, even with little new activity', () => {
  const s = sandbox();
  const tp = s.transcript('pm', 3);
  const two = reply(topic({ title: 'Debugging the reconnect storm' }), topic({ title: 'Choosing Redis Streams', angle: 'architecture' }));
  s.run(['scout', '--session', 'pm', '--transcript', tp, '--auto'], { env: two });
  const dbg = logsJson(s).find((l) => l.title === 'Debugging the reconnect storm').id;
  s.run(['mark', '--session', 'pm', 'the', 'root', 'cause']);
  const tp2 = s.transcript('pm', 4); // one more turn: far below regrowTurns
  const r = JSON.parse(s.run(['scout', '--session', 'pm', '--transcript', tp2, '--auto', '--json'], {
    env: reply(topic({ title: 'Debugging the reconnect storm', same_as: [dbg], marks: true }), topic({ title: 'Choosing Redis Streams', angle: 'architecture' })),
  }).out);
  assert.strictEqual(r.status, 'updated');
  assert.match(s.run(['show', dbg]).out, /"note":"the root cause"/);
});

test('a one-session rescan never lowers the score of a log that spans more sessions, and keeps it partial', () => {
  const s = sandbox();
  const id = JSON.parse(s.run(['scout', '--session', 'w1', '--transcript', s.transcript('w1', 3), '--json'], { env: { STUB_SCORE: '5' } }).out).logId;
  s.run(['scout', '--session', 'w2', '--transcript', s.transcript('w2', 3)], { env: reply(topic({ title: 'Reconnects over two days', same_as: [id], score: 5 })) });
  const long = 'x'.repeat(5000);
  const file = s.run(['show', id, '--path']).out;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Problem', `## Problem\n${long}END-OF-LONG`));
  const r = JSON.parse(s.run(['scout', '--session', 'w2', '--json'], { env: reply(topic({ title: 'Reconnects over two days', same_as: [id], score: 3 })) }).out);
  assert.strictEqual(r.score, 5);
  assert.match(s.run(['show', id]).out, /score: 5/);
  assert.match(fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8'), /END-OF-LONG/, 'the model sees the whole log it may rewrite');
});

test('an unknown same_as id does not let a low-score topic past the gate', () => {
  const s = sandbox();
  const r = s.run(['scout', '--session', 'ghost', '--transcript', s.transcript('ghost', 3), '--auto'], { env: reply(topic({ title: 'Renamed a variable', score: 1, same_as: ['cb-zzzzzz'] })) });
  assert.strictEqual(r.out, 'Skipped: score 1', 'the made-up id is ignored, so the score gate applies');
  assert.strictEqual(logsJson(s).length, 0);
});

test('a deleted topic stays deleted when reworded; a session that gets a log again is scanned automatically again', () => {
  const s = sandbox();
  const tp = s.transcript('tomb', 3);
  const id = JSON.parse(s.run(['scout', '--session', 'tomb', '--transcript', tp, '--json'], { env: reply(topic({ title: 'Fixing websocket reconnect storms' })) }).out).logId;
  s.run(['delete', id]);
  assert.match(s.run(['scout', '--session', 'tomb'], { env: reply(topic({ title: 'Fixing WebSocket reconnect storm on deploy' })) }).out, /ones you deleted/);
  assert.match(s.run(['scout', '--session', 'tomb', '--auto']).out, /logs were deleted/);

  // Discovery logs a new angle for it: the session is no longer treated as deleted.
  const did = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Load-testing the gateway', angle: 'testing' })) }).out)[1];
  s.run(['discover', 'pick', did, '1']);
  assert.doesNotMatch(s.run(['scout', '--session', 'tomb', '--auto']).out, /logs were deleted/);
});

test('tags with regex characters are matched literally and never crash discovery', () => {
  const s = sandbox();
  s.transcript('rx', 3);
  const r = s.run(['discover', '--dry-run', '--tags', 'c(,[slug]']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.out, /0 eligible/);
});

test('a marked session always gets a log, even when its only topic scores low', () => {
  const s = sandbox();
  s.run(['mark', '--session', 'lowm', 'queue', 'idea']);
  const r = JSON.parse(s.run(['scout', '--session', 'lowm', '--transcript', s.transcript('lowm', 3), '--auto', '--json'], { env: reply(topic({ title: 'Tiny tweak', score: 1 })) }).out);
  assert.strictEqual(r.status, 'created');
  assert.match(s.run(['show', r.logId]).out, /"note":"queue idea"/);
});

test('a log deleted before topics existed keeps its session closed unless --force', () => {
  const s = sandbox();
  const tp = s.transcript('old', 3);
  const ledger = path.join(s.env.CASEBOOK_HOME, 'state', 'sessions', 'old.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ sessionId: 'old', deleted: true, logId: 'cb-aaaaaa' }));
  assert.match(s.run(['scout', '--session', 'old', '--transcript', tp]).out, /log was deleted \(use --force/);
  assert.ok(!JSON.parse(s.run(['discover', '--dry-run', '--json']).out).some((g) => g.sessions.includes('old')));
  assert.strictEqual(JSON.parse(s.run(['scout', '--session', 'old', '--force', '--json']).out).status, 'created');
});

test('two topics of one scan never write into the same log; reworded rescans update, merged ids resolve', () => {
  const s = sandbox();
  const tp = s.transcript('claim', 3);
  const id = JSON.parse(s.run(['scout', '--session', 'claim', '--transcript', tp, '--json'], { env: reply(topic({ title: 'Fixed websocket reconnect storms' })) }).out).logId;

  // Both name the same log: the better one updates it, the other becomes its own log.
  const r = JSON.parse(s.run(['scout', '--session', 'claim', '--json'], {
    env: reply(topic({ title: 'Fixed websocket reconnect storms', same_as: [id], score: 5 }), topic({ title: 'Picking Redis Streams for fan-out', angle: 'architecture', same_as: [id], score: 3 })),
  }).out);
  assert.deepStrictEqual(r.logs.map((l) => l.status), ['updated', 'created']);
  assert.strictEqual(r.logs[0].logId, id);
  assert.strictEqual(r.score, 5);
  assert.strictEqual(logsJson(s).length, 2);

  // A reworded title without same_as is still the same story.
  const again = JSON.parse(s.run(['scout', '--session', 'claim', '--json'], { env: reply(topic({ title: 'Fixing websocket reconnect storms on deploy' })) }).out);
  assert.strictEqual(again.logId, id);
  assert.strictEqual(logsJson(s).length, 2);
});

test('discover pick checks again: a deleted target or topic is refused, not logged anew', () => {
  const s = sandbox();
  const a = s.transcript('pa', 3, onBranch('pa', 'feat/p'));
  s.transcript('pb', 3, onBranch('pb', 'feat/p'));
  const la = JSON.parse(s.run(['scout', '--session', 'pa', '--transcript', a, '--json']).out).logId;
  const did = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Something else entirely', same_as: [la], belongs: [1, 2] })) }).out)[1];
  s.run(['delete', la]);
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`the log this topic updates is gone \\(${la}\\)`));
  assert.strictEqual(logsJson(s).length, 0);

  const did2 = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Load-testing the gateway', belongs: [2] })) }).out)[1];
  const id = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did2, '1']).out)[1];
  s.run(['delete', id]);
  const fresh = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover', '--force'], { env: reply(topic({ title: 'Load-testing the gateway', belongs: [2] })) }).out)[1];
  assert.match(s.run(['discover', 'pick', fresh, '1']).out, /Created/, '--force carries over to the pick');
});

test('a topic updating a live log is not dropped because a deleted log had a similar title', () => {
  const s = sandbox();
  const tp = s.transcript('live', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'live', '--transcript', tp, '--json'], {
    env: reply(topic({ title: 'Debugging Redis stream consumer lag' }), topic({ title: 'Debugging Redis stream consumer restarts', angle: 'reliability' })),
  }).out);
  const [lag, restarts] = r.logs.map((l) => l.logId);
  s.run(['delete', restarts]);
  const up = JSON.parse(s.run(['scout', '--session', 'live', '--json'], { env: reply(topic({ title: 'Debugging Redis stream consumer lag', same_as: [lag], score: 5 })) }).out);
  assert.strictEqual(up.logId, lag);
  assert.match(s.run(['show', lag]).out, /score: 5/);
});

// ---------------------------------------------------------------- topics review, round 3

test('re-picking a topic whose log was merged away reports it, instead of logging it again', () => {
  const s = sandbox();
  s.transcript('ma', 3, onBranch('ma', 'feat/m'));
  s.transcript('mb', 3, onBranch('mb', 'feat/m'));
  const did = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Gateway rewrite', belongs: [1, 2] })) }).out)[1];
  const x = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did, '1']).out)[1];
  const y = JSON.parse(s.run(['scout', '--session', 'other', '--transcript', s.transcript('other', 3), '--json'], { env: reply(topic({ title: 'Unrelated', angle: 'data' })) }).out).logId;
  s.run(['scout', '--session', 'other', '--json'], { env: reply(topic({ title: 'Gateway rewrite, all of it', same_as: [y, x] })) });
  assert.ok(!logsJson(s).some((l) => l.id === x), 'x was merged away');
  const again = s.run(['discover', 'pick', did, '1']);
  assert.match(again.out, /^Already logged as cb-/);
  assert.strictEqual(logsJson(s).length, 1);
});

test('a pick works out partial from the sessions as they are now', () => {
  const s = sandbox();
  s.transcript('pp', 3);
  const did = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Settled work' })) }).out)[1];
  const file = path.join(s.env.CASEBOOK_HOME, 'state', 'discoveries', `${did}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(d.topics[0].partial, true, 'recent when discovered');
  const old = new Date(Date.now() - 3600000);
  for (const dir of fs.readdirSync(path.join(s.env.CLAUDE_CONFIG_DIR, 'projects'))) fs.utimesSync(path.join(s.env.CLAUDE_CONFIG_DIR, 'projects', dir, 'pp.jsonl'), old, old);
  const id = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did, '1']).out)[1];
  assert.match(s.run(['show', id]).out, /partial: false/);
});

test('an empty reply keeps pending marks and says no topic was found', () => {
  const s = sandbox();
  s.run(['mark', '--session', 'empty', 'keep', 'me']);
  const r = s.run(['scout', '--session', 'empty', '--transcript', s.transcript('empty', 3)], { env: { STUB_TOPICS: '{"topics":[]}' } });
  assert.strictEqual(r.out, 'Skipped: the scout found no topic');
  assert.ok(fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'empty.json')), 'the mark is kept');
});

test('an unmarked note found in the transcript is not re-added and does not force a rescan', () => {
  const s = sandbox();
  const cmd = { type: 'user', sessionId: 'um', cwd: s.repo, message: { role: 'user', content: '<command-name>/casebook:mark</command-name><command-args>queue idea</command-args>' } };
  const tp = s.transcript('um', 3, [cmd]);
  const id = JSON.parse(s.run(['scout', '--session', 'um', '--transcript', tp, '--auto', '--json']).out).logId;
  assert.match(s.run(['show', id]).out, /"note":"queue idea"/);
  s.run(['unmark', id]);
  const calls = s.calls().length;
  const tp2 = s.transcript('um', 4, [cmd]);
  assert.match(s.run(['scout', '--session', 'um', '--transcript', tp2, '--auto']).out, /not enough new activity/);
  assert.strictEqual(s.calls().length, calls);
  s.run(['scout', '--session', 'um', '--transcript', tp2]);
  assert.doesNotMatch(s.run(['show', id]).out, /queue idea/);
});

test('a log claimed by a title match is not overwritten by a later topic naming it', () => {
  const s = sandbox();
  const tp = s.transcript('tw', 3);
  const id = JSON.parse(s.run(['scout', '--session', 'tw', '--transcript', tp, '--json'], { env: reply(topic({ title: 'Fixing reconnect storms' })) }).out).logId;
  const r = JSON.parse(s.run(['scout', '--session', 'tw', '--json'], {
    env: reply(topic({ title: 'Fixed reconnect storms', score: 4 }), topic({ title: 'Why we picked Redis Streams', angle: 'architecture', same_as: [id], score: 3 })),
  }).out);
  assert.deepStrictEqual(r.logs.map((l) => l.status), ['updated', 'created']);
  assert.match(s.run(['show', id]).out, /^# Fixed reconnect storms/m);
});

test('the write lock: a stale lock is reclaimed once; mark, unmark and written take it', () => {
  const s = sandbox();
  const id = JSON.parse(s.run(['scout', '--session', 'wl', '--transcript', s.transcript('wl', 3), '--json']).out).logId;
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'write.lock');
  fs.writeFileSync(lock, 'crashed');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.match(s.run(['mark', id, 'after', 'a', 'crash']).out, /Marked/);
  assert.ok(!fs.existsSync(lock) && !fs.existsSync(`${lock}.reclaim`), 'reclaimed and released');
  assert.match(s.run(['written', id, '--file', path.join(s.root, 'a.md')]).out, /Recorded 1/);
  assert.match(s.run(['unmark', id]).out, /Unmarked/);
  assert.strictEqual(s.run(['discover', '--candidates', '0']).stderr.trim(), 'casebook: --candidates must be a positive whole number, got "0"');
});

// ---------------------------------------------------------------- topics review, round 4

test('unmarking a bare mark, or deleting a marked log, does not bring the mark back', () => {
  const s = sandbox();
  const bare = { type: 'user', sessionId: 'bm', cwd: s.repo, message: { role: 'user', content: '<command-name>/casebook:mark</command-name><command-args></command-args>' } };
  const tp = s.transcript('bm', 3, [bare]);
  const id = JSON.parse(s.run(['scout', '--session', 'bm', '--transcript', tp, '--auto', '--json']).out).logId;
  assert.match(s.run(['show', id]).out, /marked: true/);
  s.run(['unmark', id]);
  const calls = s.calls().length;
  assert.match(s.run(['scout', '--session', 'bm', '--transcript', s.transcript('bm', 4, [bare]), '--auto']).out, /not enough new activity/);
  assert.strictEqual(s.calls().length, calls, 'no rescan for the unmarked bare mark');

  const perf = { type: 'user', sessionId: 'dm', cwd: s.repo, message: { role: 'user', content: '<command-name>/casebook:mark</command-name><command-args>perf win</command-args>' } };
  const tp2 = s.transcript('dm', 3, [perf]);
  const r = JSON.parse(s.run(['scout', '--session', 'dm', '--transcript', tp2, '--auto', '--json'], {
    env: reply(topic({ title: 'Halved p99 latency', angle: 'performance', marks: true }), topic({ title: 'Moved queues to Redis Streams', angle: 'architecture' })),
  }).out);
  const [marked, other] = r.logs.map((l) => l.logId);
  s.run(['delete', marked]);
  const calls2 = s.calls().length;
  assert.match(s.run(['scout', '--session', 'dm', '--transcript', s.transcript('dm', 4, [perf]), '--auto']).out, /not enough new activity/);
  assert.strictEqual(s.calls().length, calls2);
  assert.match(s.run(['show', other]).out, /marked: false/);
});

test('a merged ID still opens its log; delete refuses a merged ID', () => {
  const s = sandbox();
  const x = JSON.parse(s.run(['scout', '--session', 'mx', '--transcript', s.transcript('mx', 3), '--json'], { env: reply(topic({ title: 'Gateway rewrite' })) }).out).logId;
  const y = JSON.parse(s.run(['scout', '--session', 'my', '--transcript', s.transcript('my', 3), '--json'], { env: reply(topic({ title: 'Unrelated', angle: 'data' })) }).out).logId;
  s.run(['scout', '--session', 'my', '--json'], { env: reply(topic({ title: 'Gateway rewrite, all of it', same_as: [y, x] })) });
  const survivor = logsJson(s)[0].id;
  const merged = survivor === x ? y : x;
  const show = s.run(['show', merged, '--path']);
  assert.strictEqual(show.status, 0, show.stderr);
  assert.match(show.stderr, new RegExp(`${merged} was merged into ${survivor}`));
  assert.ok(show.out.endsWith(`${survivor}.md`));
  assert.strictEqual(s.run(['mark', merged, 'note']).status, 0);
  const del = s.run(['delete', merged]);
  assert.strictEqual(del.status, 1);
  assert.match(del.stderr, /was merged into/);
  assert.strictEqual(logsJson(s).length, 1);
});

test('discovery lists a log as updated by one topic only, and a pick refuses a log changed since', () => {
  const s = sandbox();
  const l = JSON.parse(s.run(['scout', '--session', 'base', '--transcript', s.transcript('base', 3), '--json'], { env: reply(topic({ title: 'Reconnect storms' })) }).out).logId;
  for (const [sid, br] of [['ca', 'feat/a'], ['cb', 'feat/a'], ['da', 'feat/b'], ['db', 'feat/b']]) s.transcript(sid, 3, onBranch(sid, br));
  const r = s.run(['discover', '--exclude', 'base'], { env: reply(topic({ title: 'Reconnect storms, end to end', same_as: [l], belongs: [1, 2] })) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual([...r.out.matchAll(new RegExp(`updates: ${l}`, 'g'))].length, 1, r.out);
  const did = /Discovery (d-[a-z0-9]{6})/.exec(r.out)[1];
  s.run(['mark', l, 'later note']);
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`${l} changed since the discovery ran`));
  assert.match(s.run(['show', l]).out, /^# Reconnect storms$/m);
});

test('a long chain shows the model every log of its sessions', () => {
  const s = sandbox();
  const ids = [];
  for (const sid of ['l1', 'l2', 'l3', 'l4']) {
    const tp = s.transcript(sid, 3, onBranch(sid, 'feat/long'));
    const r = JSON.parse(s.run(['scout', '--session', sid, '--transcript', tp, '--json'], {
      env: reply(topic({ title: `${sid} lag` }), topic({ title: `${sid} schema`, angle: 'data' }), topic({ title: `${sid} tests`, angle: 'testing' })),
    }).out);
    ids.push(...r.logs.map((x) => x.logId));
  }
  assert.strictEqual(ids.length, 12);
  s.run(['discover'], { env: reply(topic({ title: 'All of it', same_as: ids, belongs: [1, 2, 3, 4] })) });
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  for (const id of ids) assert.ok(prompt.includes(`### ${id} ·`), `${id} is in the prompt`);
});

test('linking: "continuous" is not a continuation; reasons name no repo or branch unless public', () => {
  const { linkSessions } = require('../plugins/casebook/lib/discover');
  const now = Date.now();
  const sess = (id, o) => ({
    sessionId: id, project: 'p', policy: 'anonymize', branch: 'main', prUrls: [], files: ['/r/package.json'], readFiles: [],
    opening: '', startedAt: new Date(now - (id === 'a' ? 5 : 1) * 3600000).toISOString(),
    endedAt: new Date(now - (id === 'a' ? 4 : 0) * 3600000).toISOString(), ...o,
  });
  assert.strictEqual(linkSessions([sess('a'), sess('b', { opening: 'set up continuous integration' })]).length, 2);
  assert.strictEqual(linkSessions([sess('a'), sess('b', { opening: "let's continue where we left off" })]).length, 1);
  const pr = ['https://github.com/acme-corp/billing/pull/12'];
  const [g] = linkSessions([sess('a', { prUrls: pr, branch: 'acme-x' }), sess('b', { prUrls: pr, branch: 'acme-x' })]);
  assert.ok(g.reasons.length && !g.reasons.join().match(/acme/), g.reasons.join());
  const [pg] = linkSessions([sess('a', { prUrls: pr, policy: 'public' }), sess('b', { prUrls: pr, policy: 'public' })]);
  assert.match(pg.reasons.join(), /acme-corp\/billing\/pull\/12/);
});

// ---------------------------------------------------------------- topics review, round 5

const slow = (s, args, env) => new Promise((res) => {
  let out = '';
  let err = '';
  const p = spawn(process.execPath, [BIN, ...args], { cwd: s.repo, env: { ...s.env, ...env } });
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => res({ code, out: out.trim(), stderr: err }));
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a mark made while a scout runs is kept; a log changed meanwhile makes the scan run again', async () => {
  const s = sandbox();
  const tp = s.transcript('rc', 3);
  const two = reply(topic({ title: 'Halved p99 latency', angle: 'performance' }), topic({ title: 'Moved queues to Redis Streams', angle: 'architecture' }));
  const [a] = JSON.parse(s.run(['scout', '--session', 'rc', '--transcript', tp, '--json'], { env: two }).out).logs.map((l) => l.logId);
  const before = s.calls().length;
  const run = slow(s, ['scout', '--session', 'rc', '--transcript', tp, '--json'], { ...two, STUB_DELAY: '1500' });
  await pause(700);
  assert.strictEqual(s.run(['mark', '--session', 'rc', 'the', 'backoff', 'decision']).status, 0);
  assert.strictEqual(s.run(['mark', a, 'direct note']).status, 0);
  const r = await run;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(s.calls().length, before + 2, 'the log changed during the first call, so the scan ran again');
  assert.match(s.run(['show', a]).out, /"note":"direct note"/, 'the change made meanwhile survives');
  const marks = JSON.parse(fs.readFileSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'rc.json'), 'utf8'));
  assert.deepStrictEqual(marks.map((m) => m.note), ['the backoff decision'], 'the mark added meanwhile waits for the next scan');
});

test('marks that only point at deleted topics stop forcing rescans; a mark of another log is not this session\'s', () => {
  const s = sandbox();
  const cmd = (sid, args) => ({ type: 'user', sessionId: sid, cwd: s.repo, message: { role: 'user', content: `<command-name>/casebook:mark</command-name><command-args>${args}</command-args>` } });
  const A = topic({ title: 'Halved p99 latency', angle: 'performance' });
  const r = JSON.parse(s.run(['scout', '--session', 'dd', '--transcript', s.transcript('dd', 3), '--json'], { env: reply(A, topic({ title: 'Moved queues to Redis Streams', angle: 'architecture' })) }).out);
  s.run(['delete', r.logs[0].logId]);
  // The manual scout left the other log partial; the first auto scan that adds nothing finishes it.
  const calls = s.calls().length;
  const first = s.run(['scout', '--session', 'dd', '--transcript', s.transcript('dd', 4, [cmd('dd', 'retry storm')]), '--auto'], { env: reply(A) });
  assert.match(first.out, /ones you deleted/);
  assert.strictEqual(s.calls().length, calls + 1);
  assert.match(s.run(['show', r.logs[1].logId]).out, /partial: false/);
  const again = s.run(['scout', '--session', 'dd', '--transcript', s.transcript('dd', 5, [cmd('dd', 'retry storm')]), '--auto'], { env: reply(A) });
  assert.match(again.out + again.stderr, /not enough new activity/, JSON.stringify(again));
  assert.strictEqual(s.calls().length, calls + 1, 'no rescan for a mark already found to point at a deleted topic');

  const tp2 = s.transcript('om', 3, [cmd('om', 'cb-abc123 great example')]);
  const l = JSON.parse(s.run(['scout', '--session', 'om', '--transcript', tp2, '--auto', '--json']).out).logId;
  assert.match(s.run(['show', l]).out, /marked: false/);
});

test('same_as can only name a log shown to the model; one session in two folders does not crash discovery', () => {
  const s = sandbox();
  const other = path.join(s.root, 'client-x');
  fs.mkdirSync(other);
  const tpx = s.transcript('cx', 3);
  const moved = fs.readFileSync(tpx, 'utf8').split(s.repo).join(other);
  const dir = path.join(s.env.CLAUDE_CONFIG_DIR, 'projects', other.replace(/[^\w]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cx.jsonl'), moved);
  fs.rmSync(tpx);
  const x = JSON.parse(s.run(['scout', '--session', 'cx', '--transcript', path.join(dir, 'cx.jsonl'), '--json'], { env: reply(topic({ title: 'Client billing' })) }).out).logId;
  const r = JSON.parse(s.run(['scout', '--session', 'mine', '--transcript', s.transcript('mine', 3), '--json'], { env: reply(topic({ title: 'Gateway', same_as: [x] })) }).out);
  assert.strictEqual(r.status, 'created');
  assert.match(s.run(['show', x]).out, /^# Client billing$/m, 'the unseen log is untouched');

  const dup = path.join(dir, 'twin.jsonl');
  fs.writeFileSync(dup, moved.split('"cx"').join('"twin"'));
  fs.copyFileSync(dup, path.join(path.dirname(s.transcript('twin', 3)), 'twin.jsonl'));
  const d = s.run(['discover', '--dry-run', '--all']);
  assert.strictEqual(d.status, 0, d.stderr);
});

test('a later session naming package.json is not a handoff', () => {
  const { linkSessions } = require('../plugins/casebook/lib/discover');
  const now = Date.now();
  const sess = (id, o) => ({
    sessionId: id, project: 'p', policy: 'public', branch: 'main', prUrls: [], files: [], readFiles: [], opening: '',
    startedAt: new Date(now - (id === 'a' ? 200 : 1) * 3600000).toISOString(),
    endedAt: new Date(now - (id === 'a' ? 199 : 0) * 3600000).toISOString(), ...o,
  });
  assert.strictEqual(linkSessions([sess('a', { files: ['/r/package.json'] }), sess('b', { opening: 'why does package.json pin node 18?' })]).length, 2);
  assert.strictEqual(linkSessions([sess('a', { files: ['/r/docs/handoff.md'] }), sess('b', { opening: 'read handoff.md and carry on' })]).length, 1);
});

// ---------------------------------------------------------------- topics review, round 6

test('one session\'s auto scout does not finish a log another running session feeds', () => {
  const s = sandbox();
  const a = s.transcript('pa6', 3, onBranch('pa6', 'feat/six'));
  s.transcript('pb6', 3, onBranch('pb6', 'feat/six'));
  const la = JSON.parse(s.run(['scout', '--session', 'pa6', '--transcript', a, '--json']).out).logId;
  const did = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Both halves', same_as: [la], belongs: [1, 2] })) }).out)[1];
  assert.match(s.run(['discover', 'pick', did, '1']).out, new RegExp(`^Updated ${la}`));
  s.run(['scout', '--session', 'pa6', '--transcript', a, '--auto']);
  assert.match(s.run(['show', la]).out, /partial: true/, 'pb6 may still be running');
});

test('picking a topic never overwrites a title match the discovery did not list', () => {
  const s = sandbox();
  s.transcript('ta6', 3, onBranch('ta6', 'feat/tw'));
  s.transcript('tb6', 3, onBranch('tb6', 'feat/tw'));
  const r = s.run(['discover'], { env: reply(topic({ title: 'Redis stream backpressure fix', belongs: [1, 2] }), topic({ title: 'Redis stream backpressure fix load testing', angle: 'testing', belongs: [1, 2], score: 3 })) });
  const did = /Discovery (d-[a-z0-9]{6})/.exec(r.out)[1];
  const one = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did, '1']).out)[1];
  const two = s.run(['discover', 'pick', did, '2']);
  assert.match(two.out, /^Created cb-/, two.out);
  assert.match(s.run(['show', one]).out, /^# Redis stream backpressure fix$/m);
});

test('a pending mark reopens a session whose logs were deleted; note words lose trailing dots', () => {
  const s = sandbox();
  const tp = s.transcript('dl6', 3);
  const id = JSON.parse(s.run(['scout', '--session', 'dl6', '--transcript', tp, '--auto', '--json']).out).logId;
  s.run(['delete', id]);
  const calls = s.calls().length;
  s.run(['scout', '--session', 'dl6', '--transcript', tp, '--auto']);
  assert.strictEqual(s.calls().length, calls, 'closed after the delete');
  s.run(['mark', '--session', 'dl6', 'the real story is the cache fix']);
  s.run(['scout', '--session', 'dl6', '--transcript', tp, '--auto'], { env: reply(topic({ title: 'Cache fix', angle: 'performance' })) });
  assert.strictEqual(s.calls().length, calls + 1, 'the mark is placed by the next auto scan');
  assert.ok(logsJson(s).some((l) => l.marked));

  const { keywords } = require('../plugins/casebook/lib/discover');
  assert.deepStrictEqual(keywords('webhook retries. Also redis.'), ['webhook', 'retries', 'redis']);
});

// ---------------------------------------------------------------- topics review, round 7

test('the catch-up sweep passes over sessions whose logs were deleted, without crashing', () => {
  const s = sandbox();
  const meta = path.join(s.env.CASEBOOK_HOME, 'state', 'meta.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ installedAt: new Date(Date.now() - 86400000).toISOString() }));
  const id = JSON.parse(s.run(['scout', '--session', 'sw7', '--transcript', s.transcript('sw7', 3), '--auto', '--json']).out).logId;
  s.run(['delete', id]);
  s.transcript('sw7', 4);
  s.transcript('other7', 3);
  const dry = s.run(['scout', '--pending', '--dry-run', '--json']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.deepStrictEqual(JSON.parse(dry.out).map((d) => d.sessionId), ['other7']);
  s.run(['mark', '--session', 'sw7', 'cache fix']);
  assert.deepStrictEqual(JSON.parse(s.run(['scout', '--pending', '--dry-run', '--json']).out).map((d) => d.sessionId).sort(), ['other7', 'sw7']);
});

test('a log is partial per session: the final scan of the session that made it partial finishes it', () => {
  const s = sandbox();
  const l = JSON.parse(s.run(['scout', '--session', 'f1', '--transcript', s.transcript('f1', 3), '--auto', '--json']).out).logId;
  const tp2 = s.transcript('f2', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'f2', '--transcript', tp2, '--json'], { env: reply(topic({ title: 'Fixed websocket reconnect storms', same_as: [l] })) }).out);
  assert.strictEqual(r.logId, l);
  assert.match(s.run(['show', l]).out, /partial: true/);
  s.run(['scout', '--session', 'f2', '--transcript', tp2, '--auto']);
  assert.match(s.run(['show', l]).out, /partial: false/, 'f1 was finished already, f2 is now');
});

test('a pick refuses when its sessions were logged again since; a reply with no topics logs nothing', () => {
  const s = sandbox();
  s.transcript('g1', 3, onBranch('g1', 'feat/g'));
  const tp = s.transcript('g2', 3, onBranch('g2', 'feat/g'));
  const did = /Discovery (d-[a-z0-9]{6})/.exec(s.run(['discover'], { env: reply(topic({ title: 'Gateway retries', belongs: [1, 2] })) }).out)[1];
  const later = JSON.parse(s.run(['scout', '--session', 'g2', '--transcript', tp, '--json'], { env: reply(topic({ title: 'Gateway retry budget' })) }).out).logId;
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`logged again since the discovery ran \\(${later}\\)`));

  for (const bad of ['{"topics":null}', '{}', '{"error":"overloaded"}']) {
    const r = s.run(['scout', '--session', 'nt', '--transcript', s.transcript('nt', 3)], { env: { STUB_TOPICS: bad } });
    assert.strictEqual(r.out, 'Skipped: the scout found no topic', bad);
  }
  assert.strictEqual(logsJson(s).length, 1);
});

// ---------------------------------------------------------------- topics review, round 8

test('a new angle with a similar title is a new log, and a deleted angle does not block it', () => {
  const s = sandbox();
  const tp = s.transcript('an8', 3);
  const lag = JSON.parse(s.run(['scout', '--session', 'an8', '--transcript', tp, '--json'], { env: reply(topic({ title: 'Debugging Redis stream consumer lag' })) }).out).logId;
  const r = JSON.parse(s.run(['scout', '--session', 'an8', '--json'], { env: reply(topic({ title: 'Debugging Redis stream consumer restarts', angle: 'reliability' })) }).out);
  assert.strictEqual(r.status, 'created');
  assert.notStrictEqual(r.logId, lag);
  assert.match(s.run(['show', lag]).out, /^# Debugging Redis stream consumer lag$/m);
  s.run(['delete', r.logId]);
  const again = JSON.parse(s.run(['scout', '--session', 'an8', '--json'], { env: reply(topic({ title: 'Debugging Redis stream consumer restart', angle: 'architecture' })) }).out);
  assert.strictEqual(again.status, 'created', 'another angle than the deleted one');
});

test('a nearby log changing during the model call does not rerun the scan', async () => {
  const s = sandbox();
  const near = JSON.parse(s.run(['scout', '--session', 'nb8', '--transcript', s.transcript('nb8', 3), '--auto', '--json'], { env: reply(topic({ title: 'Nearby work', angle: 'data' })) }).out).logId;
  const tp = s.transcript('mn8', 3);
  const before = s.calls().length;
  const run = slow(s, ['scout', '--session', 'mn8', '--transcript', tp, '--json'], { ...reply(topic({ title: 'Own work' })), STUB_DELAY: '1200' });
  await pause(600);
  s.run(['mark', near, 'meanwhile']);
  const r = await run;
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(s.calls().length, before + 1);
  assert.match(s.run(['show', near]).out, /"note":"meanwhile"/);
});

test('scout output labels each log by its own partial state; pick mistakes are not logged as errors', () => {
  const s = sandbox();
  const l = JSON.parse(s.run(['scout', '--session', 'q1', '--transcript', s.transcript('q1', 3), '--json']).out).logId;
  const tp2 = s.transcript('q2', 3);
  s.run(['scout', '--session', 'q2', '--transcript', tp2, '--auto']);
  const out = s.run(['scout', '--session', 'q2', '--transcript', s.transcript('q2', 12)], { env: reply(topic({ title: 'Fixed websocket reconnect storms', same_as: [l] })) }).out;
  assert.match(out, new RegExp(`Updated ${l} \\(score \\d, partial\\)`), 'q1 is still partial');
  const p = s.run(['discover', 'pick', 'd-000000', '1']);
  assert.strictEqual(p.status, 1);
  const errLog = path.join(s.env.CASEBOOK_HOME, 'casebook.log');
  assert.ok(!fs.existsSync(errLog) || !/no discovery/.test(fs.readFileSync(errLog, 'utf8')));
});

// ---------------------------------------------------------------- topics review, round 9

test('a losing topic that retells the same story is dropped; a same-angle claim beats a title match', () => {
  const s = sandbox();
  const tp = s.transcript('dp9', 3);
  const id = JSON.parse(s.run(['scout', '--session', 'dp9', '--transcript', tp, '--json'], { env: reply(topic({ title: 'Fix Redis retry storms' })) }).out).logId;
  const r = JSON.parse(s.run(['scout', '--session', 'dp9', '--json'], {
    env: reply(topic({ title: 'Fix Redis retry storms', same_as: [id], score: 5 }), topic({ title: 'Fixing the Redis retry storms', same_as: [id], score: 3 })),
  }).out);
  assert.deepStrictEqual(r.logs.map((l) => l.status), ['updated']);
  assert.strictEqual(logsJson(s).length, 1);

  const r2 = JSON.parse(s.run(['scout', '--session', 'dp9', '--json'], {
    env: reply(topic({ title: 'Fixed Redis retry storm', score: 5 }), topic({ title: 'Redis retry storms after deploys', same_as: [id], score: 4 })),
  }).out);
  const upd = r2.logs.find((l) => l.status === 'updated');
  assert.strictEqual(upd.logId, id);
  assert.strictEqual(upd.title, 'Redis retry storms after deploys', 'the topic that named the log updates it');
});

test('a "continue" opening links to the session that ended last, not the one that started last', () => {
  const { linkSessions } = require('../plugins/casebook/lib/discover');
  const day = new Date('2026-11-10T00:00:00Z').getTime();
  const at = (h, m = 0) => new Date(day + (h * 60 + m) * 60000).toISOString();
  const sess = (id, s, e, o) => ({ sessionId: id, project: 'p', policy: 'public', branch: 'main', prUrls: [], files: [], readFiles: [], opening: '', startedAt: s, endedAt: e, ...o });
  const groups = linkSessions([
    sess('A', at(9), at(17), { files: ['/r/app/queue.js'] }),
    sess('C', at(10), at(10, 30), { files: ['/r/other.js'] }),
    sess('B', at(17, 5), at(18), { files: ['/r/app/queue.js'], opening: "let's continue where we left off" }),
  ]);
  const ab = groups.find((g) => g.members.some((m) => m.sessionId === 'B'));
  assert.deepStrictEqual(ab.members.map((m) => m.sessionId).sort(), ['A', 'B']);
});

// ---------------------------------------------------------------- topics review, round 10

test('a session whose folder is gone keeps its own project; a chain with one anonymized session is anonymized', () => {
  const s = sandbox();
  const gone = path.join(s.root, 'acme-wt-removed');
  const tp = s.transcript('gw', 3);
  fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').split(s.repo).join(gone));
  const dry = JSON.parse(s.run(['discover', '--dry-run', '--json', '--project', 'acme-api']).out);
  assert.ok(!dry.some((g) => g.sessions.includes('gw')), 'not counted as acme-api');

  // Same slug, different place: the copy is not a git repo with the public remote, so it is anonymized.
  const twin = path.join(s.root, 'elsewhere', 'acme-api');
  fs.mkdirSync(twin, { recursive: true });
  s.transcript('pub', 3, onBranch('pub', 'feat/z'));
  const tp2 = s.transcript('priv', 3, onBranch('priv', 'feat/z'));
  const moved = fs.readFileSync(tp2, 'utf8').split(s.repo).join(twin);
  fs.rmSync(tp2);
  const dir = path.join(s.env.CLAUDE_CONFIG_DIR, 'projects', twin.replace(/[^\w]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'priv.jsonl'), moved);
  s.run(['discover', '--project', 'acme-api'], { env: reply(topic({ title: 'Login flow', belongs: [1, 2] })) });
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /2 sessions|Session 2 of 2/);
  assert.match(prompt, /Privacy policy for this project: anonymize/);
  assert.match(prompt, /Project: \[anonymized\]/);
});

test('a bare mark the skill wrote a note for does not come back after unmark', () => {
  const s = sandbox();
  const bare = { type: 'user', sessionId: 'bk', cwd: s.repo, message: { role: 'user', content: '<command-name>/casebook:mark</command-name><command-args></command-args>' } };
  const id = JSON.parse(s.run(['scout', '--session', 'bk', '--transcript', s.transcript('bk', 3), '--auto', '--json']).out).logId;
  s.run(['mark', '--session', 'bk', '--', 'Fixed redis retry storm']);
  assert.match(s.run(['show', id]).out, /"note":"Fixed redis retry storm"/);
  s.run(['unmark', id]);
  const calls = s.calls().length;
  assert.match(s.run(['scout', '--session', 'bk', '--transcript', s.transcript('bk', 4, [bare]), '--auto']).out, /not enough new activity/);
  assert.strictEqual(s.calls().length, calls);
  assert.match(s.run(['show', id]).out, /marked: false/);
});

test('a scan runs again when another scan of the project created a log meanwhile', async () => {
  const s = sandbox();
  const t1 = s.transcript('cc1', 3);
  const t2 = s.transcript('cc2', 3);
  const env = { ...reply(topic({ title: 'Fix Redis retry storm' })) };
  const [a, b] = await Promise.all([
    slow(s, ['scout', '--session', 'cc1', '--transcript', t1, '--json'], { ...env, STUB_DELAY: '400' }),
    slow(s, ['scout', '--session', 'cc2', '--transcript', t2, '--json'], { ...env, STUB_DELAY: '1400' }),
  ]);
  assert.strictEqual(a.code, 0, a.stderr);
  assert.strictEqual(b.code, 0, b.stderr);
  assert.strictEqual(s.calls().length, 3, 'the slower scan looked again with the new log shown');
});

test('editing requirements.txt or a README in any format is not a handoff', () => {
  const { linkSessions } = require('../plugins/casebook/lib/discover');
  const now = Date.now();
  const sess = (id, o) => ({
    sessionId: id, project: 'p', policy: 'public', branch: 'main', prUrls: [], files: [], readFiles: [], opening: '',
    startedAt: new Date(now - (id === 'a' ? 240 : 1) * 3600000).toISOString(),
    endedAt: new Date(now - (id === 'a' ? 239 : 0) * 3600000).toISOString(), ...o,
  });
  for (const f of ['/r/requirements.txt', '/r/README.rst', '/r/LICENSE.txt', '/r/CMakeLists.txt']) {
    assert.strictEqual(linkSessions([sess('a', { files: [f] }), sess('b', { readFiles: [f] })]).length, 2, f);
  }
  assert.strictEqual(linkSessions([sess('a', { files: ['/r/notes/handoff.txt'] }), sess('b', { readFiles: ['/r/notes/handoff.txt'] })]).length, 1);
});
