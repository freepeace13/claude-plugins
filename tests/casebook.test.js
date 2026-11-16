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
fs.writeFileSync(${JSON.stringify(path.join(root, 'last-prompt.txt'))}, input);
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

  return { root, env, repo, run, transcript };
}

const idsOf = (s) => [...s.matchAll(/cb-[a-z0-9]{6}/g)].map((m) => m[0]);

test('scout creates a public log with marks, list filters, show', () => {
  const s = sandbox();
  const tp = s.transcript('sess-1', 3);
  assert.match(s.run(['mark', '--session', 'sess-1', 'the', 'reconnect', 'fix']).out, /Marked this session: the reconnect fix/);

  const r = JSON.parse(s.run(['scout', '--session', 'sess-1', '--transcript', tp]).out);
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
  assert.match(s.run(['scout', '--session', 'short', '--transcript', short]).out, /only 1 turns/);

  const low = s.transcript('low', 3);
  assert.match(s.run(['scout', '--session', 'low', '--transcript', low], { env: { STUB_SCORE: '1' } }).out, /score 1/);

  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'anonymize', project: 'client-x' }));
  const anon = s.transcript('anon', 3);
  const r = JSON.parse(s.run(['scout', '--session', 'anon', '--transcript', anon]).out);
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
  const r = JSON.parse(s.run(['scout', '--session', 'cmd', '--transcript', tp], { env: { STUB_SCORE: '1' } }).out);
  assert.strictEqual(r.status, 'created', 'marked sessions are kept even when short and low-score');
  assert.match(s.run(['show', r.logId]).out, /"note":"queue design"/);
});

test('mark/unmark by ID, written, out-path, delete and batch delete', () => {
  const s = sandbox();
  const a = JSON.parse(s.run(['scout', '--session', 'a', '--transcript', s.transcript('a', 3)]).out).logId;
  const b = JSON.parse(s.run(['scout', '--session', 'b', '--transcript', s.transcript('b', 3)], { env: { STUB_SCORE: '2' } }).out).logId;

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

test('concurrent scouts of one session create a single log', async () => {
  const s = sandbox();
  const tp = s.transcript('dup', 3);
  const env = { ...s.env, STUB_DELAY: '1200' };
  const args = [BIN, 'scout', '--session', 'dup', '--transcript', tp];
  const go = () => new Promise((res) => {
    let out = '';
    const p = spawn(process.execPath, args, { cwd: s.repo, env });
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => res(JSON.parse(out)));
  });
  const results = await Promise.all([go(), go()]);
  assert.deepStrictEqual(results.map((r) => r.status).sort(), ['created', 'skipped']);
  assert.strictEqual(idsOf(s.run(['list', '--all']).out).length, 1);
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
