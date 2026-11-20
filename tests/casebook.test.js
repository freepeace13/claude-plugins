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
    CASEBOOK_BIN_DIR: path.join(root, 'bin'),
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
if (input.includes('casebook duplicate checker')) {
  fs.writeFileSync(${JSON.stringify(path.join(root, 'last-dedupe.txt'))}, input);
  fs.appendFileSync(${JSON.stringify(path.join(root, 'dedupe-calls.log'))}, 'x\\n');
  if (process.env.STUB_DEDUPE_FAIL) process.exit(1);
  console.log(process.env.STUB_DEDUPE || '{"duplicates":[]}'); process.exit(0);
}
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
    scan: { command: stub, minTurns: 2 },
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

// ---------- topics and discovery ----------

// A session on a feature branch: the branch is set by a trailing entry, as Claude Code records it.
const onBranch = (sid, branch) => [{ type: 'system', sessionId: sid, gitBranch: branch }];
const topic = (o) => ({ score: 4, angle: 'debugging', title: 'T', summary: 's', problem: 'p', approach: 'a', outcome: 'o', tags: ['redis'], ...o });
const reply = (...topics) => ({ STUB_TOPICS: JSON.stringify({ topics }) });
const logsJson = (s) => JSON.parse(s.run(['list', '--json']).out);
const didOf = (out) => (/Discovery (d-[a-z0-9]{6})/.exec(out) || [])[1];

/** Run a discovery with this model reply and pick topic n. Returns the log it created or updated. */
function discoverPick(s, env, { args = [], n = 1 } = {}) {
  const r = s.run(['discover', ...args], { env });
  const did = didOf(r.out);
  assert.ok(did, `no discovery: ${r.out}${r.stderr}`);
  const p = s.run(['discover', 'pick', did, String(n)]);
  assert.strictEqual(p.status, 0, p.stderr);
  return idsOf(p.out)[0];
}

/** Write a log straight into the store, as an earlier discovery would have left it. */
let seeded = 0;
function seedLog(s, o = {}) {
  const { renderDoc } = require('../plugins/casebook/lib/util');
  const id = o.id || `cb-seed${String(seeded++).padStart(2, '0')}`;
  const sessions = o.sessions || ['seed'];
  const now = new Date().toISOString();
  const { body, ...rest } = o;
  const meta = {
    id, title: 'Fixed websocket reconnect storms', angle: 'debugging', project: 'acme-api', repo: 'github.com/someone/acme-api',
    policy: 'public', profile: 'default', score: 4, marked: false, marks: [], tags: ['redis'],
    session_id: sessions[0], sessions, session_turns: Object.fromEntries(sessions.map((x) => [x, 3])), branch: 'main',
    started_at: new Date(Date.now() - 90 * 60000).toISOString(), ended_at: now, user_turns: 3 * sessions.length,
    created_at: now, updated_at: now, ...rest,
  };
  const dir = path.join(s.env.CASEBOOK_HOME, 'logs', meta.project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), renderDoc(meta, body || `# ${meta.title}\n\ns\n\n## Problem\np\n`));
  return id;
}

test('discovery logs a public topic with the session\'s pending mark; list and show', () => {
  const s = sandbox();
  s.transcript('sess-1', 3);
  assert.match(s.run(['mark', '--session', 'sess-1', 'the', 'reconnect', 'fix']).out, /Marked this session: the reconnect fix \(1 mark\)\. It goes to the topic it points to when \/casebook:discovery/);
  const id = discoverPick(s, reply(topic({ title: 'Fixed websocket reconnect storms', marks: true, tags: ['Laravel', 'reverb'] })));

  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /policy for this project: public/);
  assert.match(prompt, /"the reconnect fix"/);
  assert.doesNotMatch(prompt, /noise/, 'system reminders stripped');
  assert.match(prompt, /app\/Ws\.php/);

  const list = s.run(['list']).out;
  assert.match(list, /acme-api {2}\(github\.com\/someone\/acme-api\)/);
  assert.match(list, /^ID +DATE +SCORE MRK TITLE$/m, 'no WRT column');
  assert.match(list, new RegExp(`${id}.*📌.*Fixed websocket reconnect storms`));
  assert.ok(s.run(['list', '--marked']).out.includes(id));

  const doc = s.run(['show', id]).out;
  assert.match(doc, /^---\nid: "cb-/);
  assert.match(doc, /tags: \["laravel","reverb"\]/);
  assert.match(doc, /"note":"the reconnect fix"/);
  assert.match(doc, /scanned_at: "/);
  assert.doesNotMatch(doc, /partial|scout_mode|written_to/);
  assert.match(doc, /## Problem\np/);
  assert.ok(!fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'sess-1.json')), 'pending mark consumed');
});

test('discovery follows project policies: anonymize hides the project, skip leaves the session out', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'anonymize', project: 'client-x' }));
  s.transcript('anon', 3);
  const id = discoverPick(s, reply(topic({ title: 'Login flow' })), { args: ['--project', 'client-x'] });
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /policy for this project: anonymize/);
  assert.match(prompt, /Project: \[anonymized\]/);
  assert.ok(s.run(['list', '--project', 'client-x']).out.includes(id));

  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'skip' }));
  assert.match(s.run(['discover', '--all']).out, /Nothing to discover/);
});

test('a short single session is not a candidate; a failed scan is reported and logged', () => {
  const s = sandbox();
  s.transcript('short', 1);
  assert.match(s.run(['discover']).out, /Nothing to discover .*none long enough/);
  s.transcript('long', 3);
  const r = s.run(['discover'], { env: { STUB_TOPICS: 'not json at all' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.out, /No topic matched[\s\S]*1 scan\(s\) failed: the scan returned no JSON/);
  for (const bad of ['{"topics":null}', '{}', '{"error":"overloaded"}']) {
    assert.match(s.run(['discover'], { env: { STUB_TOPICS: bad } }).out, /No topic matched/, bad);
  }
  assert.strictEqual(logsJson(s).length, 0);
});

test('mark/unmark by ID, out-path, delete and batch delete', () => {
  const s = sandbox();
  const a = seedLog(s, { sessions: ['a'] });
  const b = seedLog(s, { sessions: ['b'], score: 2, title: 'Small fix' });

  assert.match(s.run(['mark', a, 'good one']).out, /Marked/);
  assert.deepStrictEqual(idsOf(s.run(['list', '--marked']).out), [a]);
  s.run(['unmark', a]);
  assert.deepStrictEqual(idsOf(s.run(['list', '--marked']).out), []);

  const folder = s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!']).out;
  const local = new Date();
  const today = [local.getFullYear(), local.getMonth() + 1, local.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  assert.ok(path.basename(folder).startsWith(today + '-'), 'out-path names folders with the local date');
  assert.match(folder, /handoffs\/acme-api\/\d{4}-\d{2}-\d{2}-reconnect-storms$/, 'a handoff is a folder under handoffs/');
  assert.ok(!fs.existsSync(folder), 'the folder itself is left for the skill to create');
  fs.mkdirSync(folder);
  assert.match(s.run(['out-path', '--project', 'acme-api', '--title', 'Reconnect Storms!', '--handoff']).out, /reconnect-storms-2$/, '--handoff is still accepted');

  assert.match(s.run(['delete']).stderr, /needs at least one filter: --project, --below-score, --older-than or --unmarked$/m);
  const dry = s.run(['delete', '--below-score', '3']);
  assert.match(dry.out, /Would delete 1/);
  assert.ok(s.run(['show', b]).status === 0, 'dry run keeps it');
  assert.match(s.run(['delete', '--below-score', '3', '--yes']).out, new RegExp(`Deleted 1 log\\(s\\): ${b}`));
  assert.notStrictEqual(s.run(['show', b]).status, 0);
  assert.match(s.run(['delete', a]).out, /Deleted 1/);
  assert.match(s.run(['list']).out, /No casebook logs/);
});

test('the scout, backfill and written-up tracking are gone', () => {
  const s = sandbox();
  for (const cmd of ['scout', 'backfill', 'written', 'maintenance', 'profiles']) {
    const r = s.run([cmd, '--yes']);
    assert.strictEqual(r.status, 0);
    assert.match(r.out, /^casebook — find potential case studies/, `${cmd} just prints the help`);
    assert.doesNotMatch(r.out, new RegExp(`^ {2}${cmd}\\b`, 'm'));
  }
  const root = path.resolve(__dirname, '../plugins/casebook');
  for (const gone of ['skills/scout', 'skills/write', 'agents', 'lib/scout.js', 'prompts/scout.md']) assert.ok(!fs.existsSync(path.join(root, gone)), gone);
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepStrictEqual(Object.keys(hooks), ['SessionStart']);
  // A stale SessionEnd hook from an older install does nothing.
  const r = s.run(['hook', 'session-end'], { input: JSON.stringify({ session_id: 'x', cwd: s.repo }) });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.out, '');
  assert.strictEqual(s.calls().length, 0);
});

test('a config from before 0.3 keeps its model settings under "scout"', () => {
  const s = sandbox();
  const cfg = path.join(s.env.CASEBOOK_HOME, 'config.json');
  const old = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  fs.writeFileSync(cfg, JSON.stringify({ ...old, scan: undefined, scout: old.scan }));
  s.transcript('oc', 3);
  assert.ok(discoverPick(s, reply(topic({ title: 'Old config' }))));
  assert.match(s.run(['doctor']).out, /^scan +.*fake-claude → stub 1\.0 \(model haiku/m);
});

test('discovery links a feature branch, sees its logs and merges the duplicates on pick', () => {
  const s = sandbox();
  s.transcript('chain-a', 3, onBranch('chain-a', 'feat/ws'));
  s.transcript('chain-b', 3, onBranch('chain-b', 'feat/ws'));
  s.transcript('lone-c', 3); // on main, unlogged: its own candidate
  const la = seedLog(s, { sessions: ['chain-a'], title: 'Redis streams half' });
  const lb = seedLog(s, { sessions: ['chain-b'], title: 'Websocket half', written_to: ['/old/cs.md'] });
  s.run(['mark', la, 'redis streams part']);

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
  assert.match(r.out, /\n1\. \[5\] Websocket reconnects backed by Redis Streams\n {3}acme-api · debugging · 2 sessions/);
  assert.match(r.out, new RegExp(`merges: ${la}, ${lb} \\(duplicates of this topic\\)`));
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  assert.match(prompt, /Note: websocket redis/);
  assert.ok(prompt.includes(`### ${la} ·`), 'the chain scan sees existing logs');

  const did = didOf(r.out);
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 0, p.stderr);
  assert.match(p.out, new RegExp(`^Updated ${la} \\(score 5, 2 sessions\\): Websocket reconnects`), 'the first log named survives');
  assert.match(p.out, new RegExp(`Merged into it: ${lb} \\(duplicates of this topic; marks carried over\\)`));
  const doc = s.run(['show', la]).out;
  assert.match(doc, /sessions: \["chain-a","chain-b"\]/);
  assert.match(doc, /"note":"redis streams part"/, 'marks carry over');
  assert.match(doc, new RegExp(`merged_from: \\["${lb}"\\]`));
  assert.ok(!logsJson(s).some((l) => l.id === lb));
  assert.match(s.run(['discover', 'pick', did, '1']).out, new RegExp(`Already logged as ${la}`));
});

test('discovery: new angles, nothing-new topics, deleted topics, and the score, fit and tag filters', () => {
  const s = sandbox();
  s.transcript('fa', 3, onBranch('fa', 'feat/y'));
  s.transcript('fb', 3, onBranch('fb', 'feat/y'));
  const la = seedLog(s, { sessions: ['fa'] });

  assert.match(s.run(['discover', '--min-score', '5']).out, /No topic matched\. Scored 1 candidate\(s\) .*best scored 4/);
  assert.match(s.run(['discover', '--note', 'kafka'], { env: { STUB_FIT: '0' } }).out, /No topic matched/);
  assert.match(s.run(['discover', '--tags', 'kafka,graphql']).out, /Nothing to discover/);
  assert.strictEqual(s.run(['discover', '--min-score', '9']).status, 1);

  // Already logged with exactly these sessions: not a discovery.
  assert.match(s.run(['discover'], { env: reply(topic({ title: 'x', same_as: [la], belongs: [1] })) }).out, /No topic matched/);

  // A new angle on the chain becomes its own log; the old one stays.
  const r = s.run(['discover', '--tags', 'user turn'], { env: reply(topic({ title: 'Testing reconnects across deploys', angle: 'testing', belongs: [2], fit: 2 })) });
  assert.match(r.out, /testing · 1 session ·[\s\S]*new log/);
  const id = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', didOf(r.out), '1']).out)[1];
  const logs = logsJson(s);
  assert.deepStrictEqual(logs.map((l) => l.id).sort(), [la, id].sort());
  assert.deepStrictEqual(logs.find((l) => l.id === id).sessions, ['fb']);

  // A deleted topic is not offered again, even reworded, unless --force.
  s.run(['delete', id]);
  assert.match(s.run(['discover'], { env: reply(topic({ title: 'Testing reconnect across deploy', angle: 'testing', belongs: [2] })) }).out, /No topic matched/);
  assert.match(s.run(['discover', '--force'], { env: reply(topic({ title: 'Testing reconnects across deploys', angle: 'testing', belongs: [2] })) }).out, /Testing reconnects across deploys/);
});

test('the same new topic is offered once per discovery, and a pick never logs it twice', () => {
  const s = sandbox();
  s.transcript('dup', 3);
  const r = s.run(['discover'], { env: reply(topic({ title: 'Fix Redis retry storm', score: 5 }), topic({ title: 'Fixing Redis retry storms' }), topic({ title: 'Fixing Redis retry storms', angle: 'testing', score: 3 })) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.out, /1\. \[5\] Fix Redis retry storm\n/);
  assert.doesNotMatch(r.out, /\] Fixing Redis retry storms\n {3}acme-api · debugging/, 'the retold story is dropped');
  assert.match(r.out, /2\. \[3\] Fixing Redis retry storms\n {3}acme-api · testing/, 'another angle is another topic');

  // A discovery saved before this check can still list the twin: the pick finds the log the first pick made.
  const did = didOf(r.out);
  const file = path.join(s.env.CASEBOOK_HOME, 'state', 'discoveries', `${did}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.topics.push({ ...d.topics[0], rank: 3, topic: { ...d.topics[0].topic, title: 'Fixing the Redis retry storms' } });
  fs.writeFileSync(file, JSON.stringify(d));
  const first = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did, '1']).out)[1];
  assert.strictEqual(s.run(['discover', 'pick', did, '3']).out, `Already logged as ${first}: Fix Redis retry storm`);
  assert.match(s.run(['discover', 'pick', did, '2']).out, /^Created cb-/);
  assert.deepStrictEqual(logsJson(s).map((l) => l.title).sort(), ['Fix Redis retry storm', 'Fixing Redis retry storms']);
  assert.match(s.run(['discover', 'pick', did, '3']).out, new RegExp(`^Already logged as ${first}`), 'and stays so');
});

test('topics with other titles but the same description are the same story', () => {
  const s = sandbox();
  s.transcript('ds', 3);
  const desc = 'Websocket gateway reconnect handling: clients retried in lockstep after deploys and overloaded Redis; added jittered exponential backoff to the reconnect loop.';
  const r = s.run(['discover'], { env: reply(
    topic({ title: 'Taming the thundering herd', description: desc, score: 5 }),
    topic({ title: 'Jittered backoff for websocket clients', description: `${desc} Also capped retries.` }),
    topic({ title: 'Load-testing the gateway reconnects', angle: 'testing', description: desc, score: 3 }),
  ) });
  assert.match(r.out, /1\. \[5\] Taming the thundering herd/);
  assert.doesNotMatch(r.out, /Jittered backoff for websocket clients/, 'same angle, same description: dropped');
  assert.match(r.out, /2\. \[3\] Load-testing the gateway reconnects/, 'another angle stays');

  // The description is kept on the log, shown to later scans, and remembered when the log is deleted.
  const id = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', didOf(r.out), '1']).out)[1];
  assert.ok(s.run(['show', id]).out.includes(`description: ${JSON.stringify(desc)}`));
  s.transcript('ds2', 3);
  s.run(['discover'], { env: reply(topic({ title: 'Other work', angle: 'data', belongs: [2] })) });
  assert.ok(fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8').includes(`Description: ${desc}`));
  s.run(['delete', id]);
  const ledger = JSON.parse(fs.readFileSync(path.join(s.env.CASEBOOK_HOME, 'state', 'sessions', 'ds.json'), 'utf8'));
  assert.strictEqual(ledger.deletedTopics[0].description, desc);
  const again = s.run(['discover', '--exclude', 'ds2'], { env: reply(topic({ title: 'Reconnect storms after deploys', description: desc, belongs: [1] })) });
  assert.match(again.out, /No topic matched/, 'a deleted topic stays deleted under a new title');
  assert.ok(fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8').includes(`: ${desc}`), 'the model sees the deleted description');

  // A log from before descriptions is compared by its summary.
  const old = seedLog(s, { sessions: ['x1'], title: 'Something else', body: `# Something else\n\n${desc}\n\n## Problem\np\n` });
  const { sameTopic, describe } = require('../plugins/casebook/lib/topics');
  const { readLog } = require('../plugins/casebook/lib/store');
  const log = readLog(path.join(s.env.CASEBOOK_HOME, 'logs', 'acme-api', `${old}.md`));
  assert.strictEqual(describe(log), desc);
  assert.ok(sameTopic(log, { title: 'Unrelated words', angle: 'debugging', description: desc }));
  assert.ok(!sameTopic(log, { title: 'Unrelated words', angle: 'debugging', description: 'Short one.' }), 'too short to compare');
});

test('one model call checks the remaining topics for retellings in other words', () => {
  const s = sandbox();
  s.transcript('u1', 3, onBranch('u1', 'feat/u'));
  s.transcript('u2', 3, onBranch('u2', 'feat/u'));
  const x = seedLog(s, { sessions: ['u1'], title: 'Queue retry budget' });
  const env = reply(
    topic({ title: 'Stopping retry storms', description: 'Retry storms in the queue worker.', score: 5, belongs: [1, 2] }),
    topic({ title: 'Queue retry budget, end to end', same_as: [x], belongs: [1, 2] }),
    topic({ title: 'Schema for job audit', angle: 'data', description: 'Audit table for jobs.', score: 3, belongs: [2] }),
  );
  const r = s.run(['discover'], { env: { ...env, STUB_DEDUPE: '{"duplicates":[[1,2]]}' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const asked = fs.readFileSync(path.join(s.root, 'last-dedupe.txt'), 'utf8');
  assert.match(asked, /### 1\. Stopping retry storms\nAngle: debugging · 2 sessions\nDescription: Retry storms in the queue worker\./);
  assert.match(asked, /### 2\. Queue retry budget, end to end\nAngle: debugging · 2 sessions · updates an existing log/);
  assert.doesNotMatch(r.out, /Stopping retry storms/, 'the new retelling goes; the topic that names the log stays');
  assert.match(r.out, new RegExp(`1\\. \\[4\\] Queue retry budget, end to end[\\s\\S]*updates: ${x}`));
  assert.match(r.out, /2\. \[3\] Schema for job audit/);

  // A failed check offers the topics unchecked and says so in the log.
  const f = s.run(['discover'], { env: { ...env, STUB_DEDUPE_FAIL: '1' } });
  assert.match(f.out, /Stopping retry storms/);
  assert.match(fs.readFileSync(path.join(s.env.CASEBOOK_HOME, 'casebook.log'), 'utf8'), /the duplicate check failed; topics are offered unchecked/);

  // One topic left: nothing to compare, no call.
  const calls = fs.readFileSync(path.join(s.root, 'dedupe-calls.log'), 'utf8').trim().split('\n').length;
  s.run(['discover'], { env: reply(topic({ title: 'Only one', angle: 'testing', belongs: [2] })) });
  assert.strictEqual(fs.readFileSync(path.join(s.root, 'dedupe-calls.log'), 'utf8').trim().split('\n').length, calls);
});

test('a session mark on a session with several logs goes to the topic it points to', () => {
  const s = sandbox();
  s.transcript('pm', 3, onBranch('pm', 'feat/pm'));
  s.transcript('pm-next', 3, onBranch('pm-next', 'feat/pm'));
  const dbg = seedLog(s, { sessions: ['pm'], title: 'Debugging the reconnect storm' });
  const arch = seedLog(s, { sessions: ['pm'], title: 'Choosing Redis Streams', angle: 'architecture' });
  assert.match(s.run(['mark', '--session', 'pm', 'the', 'root', 'cause']).out, /Marked this session: the root cause/);
  const id = discoverPick(s, reply(topic({ title: 'Debugging the reconnect storm', same_as: [dbg], belongs: [1, 2], marks: true })));
  assert.strictEqual(id, dbg);
  assert.match(s.run(['show', dbg]).out, /"note":"the root cause"/);
  assert.doesNotMatch(s.run(['show', arch]).out, /the root cause/);
  assert.ok(!fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'pm.json')));

  // With exactly one log, the mark goes straight to it.
  const solo = seedLog(s, { sessions: ['solo'], title: 'Solo work' });
  assert.match(s.run(['mark', '--session', 'solo', 'nice']).out, new RegExp(`Marked ${solo} \\(this session's existing log\\): nice`));
});

test('an empty reply keeps pending marks for the next discovery', () => {
  const s = sandbox();
  s.transcript('empty', 3);
  s.run(['mark', '--session', 'empty', 'keep', 'me']);
  assert.match(s.run(['discover'], { env: { STUB_TOPICS: '{"topics":[]}' } }).out, /No topic matched/);
  assert.ok(fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'empty.json')), 'the mark is kept');
  // A topic that does not point at the mark leaves it waiting too.
  discoverPick(s, reply(topic({ title: 'Unrelated' })));
  assert.ok(fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'marks', 'empty.json')));
});

test('a scan of some of a log\'s sessions never lowers its score, and sees the whole log', () => {
  const s = sandbox();
  s.transcript('w3', 3);
  const long = 'x'.repeat(5000);
  const id = seedLog(s, { sessions: ['w1', 'w2'], score: 5, title: 'Reconnects over two days', body: `# Reconnects over two days\n\n## Problem\n${long}END-OF-LONG\n` });
  assert.strictEqual(discoverPick(s, reply(topic({ title: 'Reconnects over two days, revisited', same_as: [id], score: 3 }))), id);
  assert.match(s.run(['show', id]).out, /score: 5/);
  assert.match(fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8'), /END-OF-LONG/, 'the model sees the whole log it may rewrite');
});

test('a discovery rewrites a log of the same sessions only when they have new marks or turns', () => {
  const s = sandbox();
  s.transcript('ra', 3);
  const la = seedLog(s, { sessions: ['ra'], scanned_at: new Date(Date.now() - 1000).toISOString() });
  const same = reply(topic({ title: 'Fixed websocket reconnect storms', same_as: [la], belongs: [1] }));
  assert.match(s.run(['discover'], { env: same }).out, /No topic matched/, 'nothing new');

  s.run(['mark', la, 'add the before and after numbers']);
  const r = s.run(['discover'], { env: same });
  assert.match(r.out, new RegExp(`updates: ${la}`), 'a mark since the last scan is news');
  assert.match(s.run(['discover', 'pick', didOf(r.out), '1']).out, new RegExp(`Updated ${la}`));
  assert.match(s.run(['discover'], { env: same }).out, /No topic matched/, 'scanned with that mark now');

  s.transcript('ra', 5);
  assert.match(s.run(['discover'], { env: same }).out, new RegExp(`updates: ${la}`), 'new turns are news');
});

test('a --force pick reopens a session closed by an older casebook', () => {
  const s = sandbox();
  s.transcript('old', 3);
  const ledger = path.join(s.env.CASEBOOK_HOME, 'state', 'sessions', 'old.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ sessionId: 'old', deleted: true, logId: 'cb-aaaaaa' }));
  discoverPick(s, reply(topic({ title: 'Back again' })), { args: ['--force'] });
  assert.ok(JSON.parse(s.run(['discover', '--dry-run', '--json']).out).some((g) => g.sessions.includes('old')), 'no --force needed any more');
  assert.ok(!JSON.parse(fs.readFileSync(ledger, 'utf8')).deleted);
});

test('flags removed in 0.3 fail instead of widening a batch delete', () => {
  const s = sandbox();
  const id = seedLog(s, { score: 2 });
  for (const flag of ['--unwritten', '--written', '--pending', '--generated']) {
    const r = s.run(['delete', '--below-score', '3', '--yes', flag]);
    assert.strictEqual(r.status, 1, flag);
    assert.match(r.stderr, new RegExp(`${flag} was removed in 0\\.3`));
  }
  assert.strictEqual(s.run(['list', '--unwritten']).status, 1);
  assert.ok(logsJson(s).some((l) => l.id === id), 'nothing deleted');
});

test('show and the startup hook merge old stores first; a CASEBOOK_ROOT store is merged into itself', () => {
  const s = sandbox();
  const oldStore = (home, name, id) => {
    const dir = path.join(home, name);
    seedLog({ env: { CASEBOOK_HOME: dir } }, { id });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ name }));
    return dir;
  };
  oldStore(s.env.CASEBOOK_HOME, 'default', 'cb-old001');
  const shown = s.run(['show', 'cb-old001', '--path']);
  assert.strictEqual(shown.status, 0, shown.stderr);
  assert.strictEqual(shown.out, path.join(s.env.CASEBOOK_HOME, 'logs', 'acme-api', 'cb-old001.md'));

  oldStore(s.env.CASEBOOK_HOME, 'work', 'cb-old002');
  assert.strictEqual(s.run(['hook', 'session-start']).status, 0);
  assert.ok(fs.existsSync(path.join(s.env.CASEBOOK_HOME, 'logs', 'acme-api', 'cb-old002.md')));

  const root = path.join(s.root, 'cbroot');
  oldStore(root, 'default', 'cb-old003');
  fs.copyFileSync(path.join(s.env.CASEBOOK_HOME, 'config.json'), path.join(root, 'default', 'config.json'));
  const env = { CASEBOOK_HOME: '', CASEBOOK_ROOT: root };
  assert.deepStrictEqual(JSON.parse(s.run(['list', '--json'], { env }).out).map((l) => l.id), ['cb-old003']);
  assert.ok(fs.existsSync(path.join(root, 'config.json')));
});

test('a log deleted before topics existed keeps its session out of discovery unless --force', () => {
  const s = sandbox();
  s.transcript('old', 3);
  const ledger = path.join(s.env.CASEBOOK_HOME, 'state', 'sessions', 'old.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, JSON.stringify({ sessionId: 'old', deleted: true, logId: 'cb-aaaaaa' }));
  assert.ok(!JSON.parse(s.run(['discover', '--dry-run', '--json']).out).some((g) => g.sessions.includes('old')));
  assert.ok(JSON.parse(s.run(['discover', '--dry-run', '--json', '--force']).out).some((g) => g.sessions.includes('old')));
  assert.match(s.run(['mark', '--session', 'old', 'x']).out, /discovery leaves it out: run \/casebook:discovery --force/);
});

test('discover pick checks again: a deleted target or topic is refused, not logged anew', () => {
  const s = sandbox();
  s.transcript('pa', 3, onBranch('pa', 'feat/p'));
  s.transcript('pb', 3, onBranch('pb', 'feat/p'));
  const la = seedLog(s, { sessions: ['pa'] });
  const did = didOf(s.run(['discover'], { env: reply(topic({ title: 'Something else entirely', same_as: [la], belongs: [1, 2] })) }).out);
  s.run(['delete', la]);
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`the log this topic updates is gone \\(${la}\\)`));
  assert.strictEqual(logsJson(s).length, 0);

  const did2 = didOf(s.run(['discover'], { env: reply(topic({ title: 'Load-testing the gateway', belongs: [2] })) }).out);
  const id = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did2, '1']).out)[1];
  s.run(['delete', id]);
  const fresh = didOf(s.run(['discover', '--force'], { env: reply(topic({ title: 'Load-testing the gateway', belongs: [2] })) }).out);
  assert.match(s.run(['discover', 'pick', fresh, '1']).out, /Created/, '--force carries over to the pick');
});

test('a topic updating a live log is not dropped because a deleted log had a similar title', () => {
  const s = sandbox();
  s.transcript('live', 3, onBranch('live', 'feat/lv'));
  s.transcript('live2', 3, onBranch('live2', 'feat/lv'));
  const lag = seedLog(s, { sessions: ['live'], title: 'Debugging Redis stream consumer lag' });
  const restarts = seedLog(s, { sessions: ['live'], title: 'Debugging Redis stream consumer restarts', angle: 'reliability' });
  s.run(['delete', restarts]);
  assert.strictEqual(discoverPick(s, reply(topic({ title: 'Debugging Redis stream consumer lag', same_as: [lag], belongs: [1, 2], score: 5 }))), lag);
  assert.match(s.run(['show', lag]).out, /score: 5/);
});

test('re-picking a topic whose log was merged away reports it; a merged ID still opens its log', () => {
  const s = sandbox();
  s.transcript('ma', 3, onBranch('ma', 'feat/m'));
  s.transcript('mb', 3, onBranch('mb', 'feat/m'));
  const did = didOf(s.run(['discover'], { env: reply(topic({ title: 'Gateway rewrite', belongs: [1, 2] })) }).out);
  const x = /Created (cb-[a-z0-9]{6})/.exec(s.run(['discover', 'pick', did, '1']).out)[1];
  const y = seedLog(s, { sessions: ['ma', 'other'], title: 'Unrelated', angle: 'data' });
  assert.strictEqual(discoverPick(s, reply(topic({ title: 'Gateway rewrite, all of it', same_as: [y, x], belongs: [1, 2] }))), y);
  assert.ok(!logsJson(s).some((l) => l.id === x), 'x was merged away');
  assert.match(s.run(['discover', 'pick', did, '1']).out, new RegExp(`^Already logged as ${y}`));
  assert.strictEqual(logsJson(s).length, 1);

  const show = s.run(['show', x, '--path']);
  assert.strictEqual(show.status, 0, show.stderr);
  assert.match(show.stderr, new RegExp(`${x} was merged into ${y}`));
  assert.ok(show.out.endsWith(`${y}.md`));
  assert.strictEqual(s.run(['mark', x, 'note']).status, 0);
  const del = s.run(['delete', x]);
  assert.strictEqual(del.status, 1);
  assert.match(del.stderr, /was merged into/);
  assert.strictEqual(logsJson(s).length, 1);
});

test('the write lock: a stale lock is reclaimed once; mark and unmark take it', () => {
  const s = sandbox();
  const id = seedLog(s, { sessions: ['wl'] });
  const lock = path.join(s.env.CASEBOOK_HOME, 'state', 'write.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, 'crashed');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.match(s.run(['mark', id, 'after', 'a', 'crash']).out, /Marked/);
  assert.ok(!fs.existsSync(lock) && !fs.existsSync(`${lock}.reclaim`), 'reclaimed and released');
  assert.match(s.run(['unmark', id]).out, /Unmarked/);
  assert.strictEqual(s.run(['discover', '--candidates', '0']).stderr.trim(), 'casebook: --candidates must be a positive whole number, got "0"');
});

test('deleting logs remembers their topics per session, also for ids that sanitise alike', () => {
  const s = sandbox();
  const a = seedLog(s, { sessions: ['x'], title: 'First' });
  const b = seedLog(s, { sessions: ['../x'], title: 'Second' });
  s.run(['delete', a, b]);
  const dir = path.join(s.env.CASEBOOK_HOME, 'state', 'sessions');
  const files = fs.readdirSync(dir).sort();
  assert.strictEqual(files.length, 2, 'the second id is not mistaken for the first one');
  assert.ok(files.includes('x.json'), 'ordinary ids keep their plain file name');
  const titles = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).deletedTopics.map((d) => d.title)).flat().sort();
  assert.deepStrictEqual(titles, ['First', 'Second']);
});

test('discovery lists a log as updated by one topic only, and a pick refuses a log changed since', () => {
  const s = sandbox();
  const l = seedLog(s, { sessions: ['base'], title: 'Reconnect storms' });
  for (const [sid, br] of [['ca', 'feat/a'], ['cb', 'feat/a'], ['da', 'feat/b'], ['db', 'feat/b']]) s.transcript(sid, 3, onBranch(sid, br));
  const r = s.run(['discover'], { env: reply(topic({ title: 'Reconnect storms, end to end', same_as: [l], belongs: [1, 2] })) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual([...r.out.matchAll(new RegExp(`updates: ${l}`, 'g'))].length, 1, r.out);
  s.run(['mark', l, 'later note']);
  const p = s.run(['discover', 'pick', didOf(r.out), '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`${l} changed since the discovery ran`));
  assert.match(s.run(['show', l]).out, /^# Reconnect storms$/m);
});

test('a long chain shows the model every log of its sessions', () => {
  const s = sandbox();
  const ids = [];
  for (const sid of ['l1', 'l2', 'l3', 'l4']) {
    s.transcript(sid, 3, onBranch(sid, 'feat/long'));
    for (const angle of ['debugging', 'data', 'testing']) ids.push(seedLog(s, { sessions: [sid], title: `${sid} ${angle}`, angle }));
  }
  s.run(['discover'], { env: reply(topic({ title: 'All of it', same_as: ids, belongs: [1, 2, 3, 4] })) });
  const prompt = fs.readFileSync(path.join(s.root, 'last-prompt.txt'), 'utf8');
  for (const id of ids) assert.ok(prompt.includes(`### ${id} ·`), `${id} is in the prompt`);
});

test('same_as can only name a log shown to the model; one session in two folders does not crash discovery', () => {
  const s = sandbox();
  const x = seedLog(s, { sessions: ['cx'], project: 'client-x', repo: null, policy: 'anonymize', title: 'Client billing' });
  s.transcript('mine', 3);
  const id = discoverPick(s, reply(topic({ title: 'Gateway', same_as: [x] })));
  assert.notStrictEqual(id, x, 'a new log');
  assert.match(s.run(['show', x]).out, /^# Client billing$/m, 'the unseen log is untouched');

  const other = path.join(s.root, 'client-x');
  fs.mkdirSync(other);
  const moved = fs.readFileSync(s.transcript('twin', 3), 'utf8').split(s.repo).join(other);
  const dir = path.join(s.env.CLAUDE_CONFIG_DIR, 'projects', other.replace(/[^\w]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'twin.jsonl'), moved);
  const d = s.run(['discover', '--dry-run', '--all']);
  assert.strictEqual(d.status, 0, d.stderr);
});

test('a pick refuses when its sessions were logged again since; pick mistakes are not logged as errors', () => {
  const s = sandbox();
  s.transcript('g1', 3, onBranch('g1', 'feat/g'));
  s.transcript('g2', 3, onBranch('g2', 'feat/g'));
  const did = didOf(s.run(['discover'], { env: reply(topic({ title: 'Gateway retries', belongs: [1, 2] })) }).out);
  const later = seedLog(s, { sessions: ['g2'], title: 'Gateway retry budget' });
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`logged again since the discovery ran \\(${later}\\)`));

  assert.strictEqual(s.run(['discover', 'pick', 'd-000000', '1']).status, 1);
  const errLog = path.join(s.env.CASEBOOK_HOME, 'casebook.log');
  assert.ok(!fs.existsSync(errLog) || !/no discovery|changed since/.test(fs.readFileSync(errLog, 'utf8')));
});

test('a new angle with a similar title is a new log, and a deleted angle does not block another', () => {
  const s = sandbox();
  s.transcript('an8', 3);
  const lag = seedLog(s, { sessions: ['an8', 'an8-old'], title: 'Debugging Redis stream consumer lag' });
  const r = discoverPick(s, reply(topic({ title: 'Debugging Redis stream consumer restarts', angle: 'reliability' })));
  assert.notStrictEqual(r, lag);
  assert.match(s.run(['show', lag]).out, /^# Debugging Redis stream consumer lag$/m);
  s.run(['delete', r]);
  const again = discoverPick(s, reply(topic({ title: 'Debugging Redis stream consumer restart', angle: 'architecture' })));
  assert.ok(again && again !== r, 'another angle than the deleted one');
});

test('a removed worktree inside its repo stays in the repo\'s project; sessions without a folder are left out', () => {
  const s = sandbox();
  const wt = path.join(s.repo, '.claude', 'worktrees', 'feat-x');
  const tp = s.transcript('wt11', 3);
  fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').split(s.repo).join(wt));
  const id = discoverPick(s, reply(topic({ title: 'Worktree work' })));
  assert.match(s.run(['show', id]).out, /project: "acme-api"/);
  assert.match(s.run(['show', id]).out, /policy: "public"/);

  const nc = s.transcript('nocwd', 3);
  fs.writeFileSync(nc, fs.readFileSync(nc, 'utf8').split(`"cwd":${JSON.stringify(s.repo)},`).join(''));
  const dry = JSON.parse(s.run(['discover', '--dry-run', '--json']).out);
  assert.ok(!dry.some((g) => g.sessions.includes('nocwd')));
});

test('a note with only a score threshold does not filter by fit; note words lose trailing dots', () => {
  const s = sandbox();
  s.transcript('th1', 3);
  const r = s.run(['discover', '--note', 'find anything that scores > 3', '--min-score', '4'], { env: { STUB_FIT: '0' } });
  assert.match(r.out, /^Discovery d-/, r.out);
  const { keywords } = require('../plugins/casebook/lib/discover');
  assert.deepStrictEqual(keywords('webhook retries. Also redis.'), ['webhook', 'retries', 'redis']);
});

test('discovery updates a same-title log of its own sessions; a gone folder outside a worktree borrows no repo', () => {
  const s = sandbox();
  s.transcript('tt1', 3, onBranch('tt1', 'feat/t'));
  s.transcript('tt2', 3, onBranch('tt2', 'feat/t'));
  const id = seedLog(s, { sessions: ['tt1'], title: 'Fix Redis retry storm' });
  const r = s.run(['discover'], { env: reply(topic({ title: 'Fixing Redis retry storms', belongs: [1, 2] })) });
  assert.match(r.out, new RegExp(`updates: ${id}`), r.out);

  const s2 = sandbox();
  const clone = path.join(s2.repo, 'tmp', 'client-api');
  const tc = s2.transcript('cl12', 3);
  fs.writeFileSync(tc, fs.readFileSync(tc, 'utf8').split(s2.repo).join(clone));
  const l = discoverPick(s2, reply(topic({ title: 'Client work' })), { args: ['--project', 'client-api'] });
  const doc = s2.run(['show', l]).out;
  assert.match(doc, /project: "client-api"/);
  assert.match(doc, /policy: "anonymize"/);
});

test('a branch name links sessions of one repository only; an exact title of another angle is a new log', () => {
  const { linkSessions } = require('../plugins/casebook/lib/discover');
  const now = Date.now();
  const sess = (id, o) => ({
    sessionId: id, project: 'api', policy: 'anonymize', branch: 'feature/auth', prUrls: [], files: [], readFiles: [], opening: '',
    startedAt: new Date(now - (id === 'a' ? 48 : 1) * 3600000).toISOString(), endedAt: new Date(now - (id === 'a' ? 47 : 0) * 3600000).toISOString(), ...o,
  });
  assert.strictEqual(linkSessions([sess('a', { repo: 'github.com/me/api' }), sess('b', { repo: 'github.com/client/api' })]).length, 2);
  assert.strictEqual(linkSessions([sess('a', { repo: 'github.com/me/api' }), sess('b', { repo: 'github.com/me/api' })]).length, 1);

  const s = sandbox();
  s.transcript('ex13', 3);
  const arch = seedLog(s, { sessions: ['ex13', 'ex13-old'], title: 'Moving queue retries to Redis streams', angle: 'architecture' });
  const r = discoverPick(s, reply(topic({ title: 'Moving queue retries to Redis streams', angle: 'debugging' })));
  assert.notStrictEqual(r, arch);
  assert.match(s.run(['show', arch]).out, /angle: "architecture"/);
});

test('a gone folder is left out under a skip default', () => {
  const s = sandbox();
  const cfg = path.join(s.env.CASEBOOK_HOME, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), defaultPolicy: 'skip' }));
  const tc = s.transcript('gs13', 3);
  fs.writeFileSync(tc, fs.readFileSync(tc, 'utf8').split(s.repo).join(path.join(s.root, 'tmp-client')));
  assert.ok(!JSON.parse(s.run(['discover', '--dry-run', '--json', '--all']).out).some((g) => g.sessions.includes('gs13')));
});

test('a pick refuses when any log it merges was deleted', () => {
  const s = sandbox();
  s.transcript('m14a', 3, onBranch('m14a', 'feat/m'));
  s.transcript('m14b', 3, onBranch('m14b', 'feat/m'));
  const la = seedLog(s, { sessions: ['m14a'], title: 'Part one' });
  const lb = seedLog(s, { sessions: ['m14b'], title: 'Part two' });
  const did = didOf(s.run(['discover'], { env: reply(topic({ title: 'The whole story', same_as: [la, lb], belongs: [1, 2] })) }).out);
  s.run(['delete', lb]);
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, new RegExp(`gone \\(${lb}\\)`));
  assert.match(s.run(['show', la]).out, /^# Part one$/m);
});

test('an update drops the fields older casebooks kept; a bad --since is not logged as a failure', () => {
  const s = sandbox();
  s.transcript('up1', 3, onBranch('up1', 'feat/u'));
  s.transcript('up2', 3, onBranch('up2', 'feat/u'));
  const id = seedLog(s, { sessions: ['up1'], partial: true, partial_sessions: ['up1'], scout_mode: 'auto', scouted_at: '2026-01-01T00:00:00.000Z', written_to: ['/x.md'] });
  assert.strictEqual(discoverPick(s, reply(topic({ title: 'Both halves', same_as: [id], belongs: [1, 2] }))), id);
  const doc = s.run(['show', id]).out;
  assert.doesNotMatch(doc, /partial|scout_mode|scouted_at/);
  assert.match(doc, /written_to: \["\/x\.md"\]/, 'old data is kept as it was');

  const bad = s.run(['discover', '--since', '3 months']);
  assert.strictEqual(bad.status, 1);
  const log = path.join(s.env.CASEBOOK_HOME, 'casebook.log');
  assert.ok(!fs.existsSync(log) || !/command discover failed/.test(fs.readFileSync(log, 'utf8')));
});

test('a pick checks the project policy again', () => {
  const s = sandbox();
  s.transcript('pk16', 3, onBranch('pk16', 'feat/k'));
  s.transcript('pk16b', 3, onBranch('pk16b', 'feat/k'));
  const did = didOf(s.run(['discover'], { env: reply(topic({ title: 'Schema change', angle: 'data', belongs: [1, 2] })) }).out);
  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'anonymize' }));
  const p = s.run(['discover', 'pick', did, '1']);
  assert.strictEqual(p.status, 1);
  assert.match(p.stderr, /no longer public/);
  fs.writeFileSync(path.join(s.repo, '.casebook.json'), JSON.stringify({ policy: 'skip' }));
  assert.match(s.run(['discover', 'pick', did, '1']).stderr, /now set to skip; nothing was logged/);
});

test('a relative CASEBOOK_HOME resolves to one absolute store', () => {
  const s = sandbox();
  const r = s.run(['config'], { env: { CASEBOOK_HOME: 'rel-store' }, cwd: s.root });
  assert.strictEqual(r.out.split('\n')[0], path.join(fs.realpathSync(s.root), 'rel-store', 'config.json'));
});

test('tags with regex characters are matched literally and never crash discovery', () => {
  const s = sandbox();
  s.transcript('rx', 3);
  const r = s.run(['discover', '--dry-run', '--tags', 'c(,[slug]']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.out, /0 eligible/);
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
  // Linked by a shared pull request: a branch name alone does not link two different checkouts.
  const pr = (sid) => ({ type: 'pr-link', sessionId: sid, prUrl: 'https://github.com/someone/acme-api/pull/7' });
  s.transcript('pub', 3, [pr('pub')]);
  const tp2 = s.transcript('priv', 3, [pr('priv')]);
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

// ---------------------------------------------------------------- profiles: one store, scout runs where claude ran

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
const fs=require('fs');const input=fs.readFileSync(0,'utf8');
if (input.includes('casebook duplicate checker')) { console.log('{"duplicates":[]}'); process.exit(0); }
if (process.argv.includes('--version')) { console.log('stub 1.0'); process.exit(0); }
if (process.env.STUB_TOPICS) { console.log(process.env.STUB_TOPICS); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(root, 'seen-config-dir.log'))}, (process.env.CLAUDE_CONFIG_DIR||'(unset)') + '\\n');
console.log(JSON.stringify({score:4,title:'T',summary:'s',problem:'p',constraints:[],approach:'a',alternatives:[],outcome:'o',evidence:[],tags:[],quote:'',open_threads:[]}));
`);
  fs.chmodSync(stub, 0o755);

  const baseEnv = { ...process.env, HOME: home, CASEBOOK_HOME: cb, CASEBOOK_BIN_DIR: path.join(root, 'bin') };
  delete baseEnv.CASEBOOK_PROFILE; delete baseEnv.CASEBOOK_SCOUT; delete baseEnv.CLAUDE_CONFIG_DIR;
  const config = JSON.stringify({ defaultPolicy: 'public', scan: { command: stub, minTurns: 2 } });
  const seedStore = (dir = cb) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'config.json'), config); };

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

test('every profile shares one store; each log records its profile; a scan runs as the account claude ran under', () => {
  const p = profileSandbox();
  p.seedStore();
  p.transcript(p.dirs.personal, 'sp', 3);
  const r = p.run(['discover', '--json'], { configDir: p.dirs.personal });
  assert.strictEqual(r.status, 0, r.stderr);
  const pick = p.run(['discover', 'pick', JSON.parse(r.out).id, '1'], { configDir: p.dirs.personal });
  const id = pick.out.match(/cb-[a-z0-9]{6}/)[0];
  assert.ok(p.run(['list']).out.includes(id), 'a log made in personal is listed from the default profile');
  assert.deepStrictEqual(p.seen(), [p.dirs.personal], 'billed to the profile the session ran under');
  assert.match(fs.readFileSync(p.run(['show', id, '--path']).out, 'utf8'), /profile: "personal"/);
  assert.ok(fs.existsSync(path.join(p.cb, 'logs', 'acme-api', `${id}.md`)));

  p.transcript(p.dirs.default, 'sd', 3);
  const d = JSON.parse(p.run(['discover', '--json']).out);
  assert.strictEqual(p.run(['discover', 'pick', d.id, '1']).status, 0);
  assert.strictEqual(p.seen()[1], '(unset)', 'default profile with no CLAUDE_CONFIG_DIR keeps it unset for the child');
  assert.strictEqual(JSON.parse(p.run(['list', '--json'], { configDir: p.dirs.personal }).out).length, 2);
  assert.strictEqual(JSON.parse(p.run(['list', '--json']).out).length, 2);
  assert.deepStrictEqual(fs.readdirSync(p.cb).filter((n) => !['logs', 'state', 'config.json', 'casebook.log'].includes(n)), [], 'no per-profile folders');
});

test('transcripts are read from the config dir claude ran under', () => {
  const p = profileSandbox();
  p.seedStore();
  p.transcript(p.dirs.personal, 'mine', 3);
  p.transcript(p.dirs.default, 'other-profile', 3);
  const sids = (configDir) => JSON.parse(p.run(['discover', '--dry-run', '--json'], { configDir }).out).flatMap((g) => g.sessions);
  assert.deepStrictEqual(sids(p.dirs.personal), ['mine']);
  assert.deepStrictEqual(sids(undefined), ['other-profile']);
  assert.deepStrictEqual(p.seen(), [], 'a dry run makes no model call');
});

test('profile names come from the config dir', () => {
  const p = profileSandbox();
  const nameOf = (configDir) => p.run(['doctor'], { configDir }).out.match(/^profile +(\S+)$/m)[1];
  assert.strictEqual(nameOf(undefined), 'default');
  assert.strictEqual(nameOf('~/.claude'), 'default');
  assert.strictEqual(nameOf(p.dirs.default + '/'), 'default');
  assert.strictEqual(nameOf(p.dirs.personal), 'personal');
  assert.strictEqual(nameOf(path.join(p.home, '.claude-work')), 'work');
  assert.strictEqual(nameOf('/opt/cc/work-cfg'), 'work-cfg');
  assert.strictEqual(nameOf('/opt/cc/.dotted'), 'dotted');
  const real = path.join(p.root, 'real-claude');
  fs.mkdirSync(real);
  fs.mkdirSync(p.home, { recursive: true });
  fs.symlinkSync(real, p.dirs.default);
  assert.strictEqual(nameOf(real), 'default', 'a symlinked ~/.claude is still default');
  const doc = p.run(['doctor'], { configDir: p.dirs.personal }).out;
  assert.match(doc, new RegExp(`^config dir +${p.dirs.personal}$`, 'm'));
  assert.match(doc, new RegExp(`^store +${p.cb}$`, 'm'));
});

test('doctor probes claude the way a scan runs it', () => {
  const p = profileSandbox();
  p.seedStore();
  assert.match(p.run(['doctor']).out, /CLAUDE_CONFIG_DIR left unset/);
  assert.match(p.run(['doctor'], { configDir: p.dirs.personal }).out, /CLAUDE_CONFIG_DIR set\)/);
});

test('--profile is gone and says what to do instead', () => {
  const p = profileSandbox();
  const r = p.run(['list', '--profile', 'personal']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /every profile shares one store.*CLAUDE_CONFIG_DIR/);
  assert.strictEqual(p.run(['help', '--profile', 'x']).status, 0);
});

test('old per-profile stores are merged into the one store', () => {
  const p = profileSandbox();
  // Build two stores the old way: ~/.casebook/<profile>/ with a profile.json.
  const old = {};
  for (const [name, dir] of [['default', p.dirs.default], ['personal', p.dirs.personal]]) {
    const store = path.join(p.cb, name);
    p.seedStore(store);
    p.transcript(dir, `s-${name}`, 3);
    const opts = { configDir: dir, env: { CASEBOOK_HOME: store } };
    const d = JSON.parse(p.run(['discover', '--json'], opts).out);
    const r = { logId: p.run(['discover', 'pick', d.id, '1'], opts).out.match(/cb-[a-z0-9]{6}/)[0] };
    p.run(['mark', r.logId, `note ${name}`], opts);
    p.run(['mark', '--session', `pending-${name}`, 'waiting'], opts);
    fs.writeFileSync(path.join(store, 'profile.json'), JSON.stringify({ name, claudeConfigDir: dir }));
    fs.mkdirSync(path.join(store, 'case-studies'), { recursive: true });
    fs.writeFileSync(path.join(store, 'case-studies', 'x.md'), name);
    old[name] = r.logId;
  }
  fs.writeFileSync(path.join(p.cb, 'personal', 'config.json'), JSON.stringify({ defaultPolicy: 'skip' }));

  const logs = JSON.parse(p.run(['list', '--json']).out);
  assert.deepStrictEqual(logs.map((l) => l.id).sort(), [old.default, old.personal].sort());
  assert.ok(logs.every((l) => l.marked));
  for (const id of Object.values(old)) assert.ok(fs.existsSync(path.join(p.cb, 'logs', 'acme-api', `${id}.md`)));
  assert.notStrictEqual(JSON.parse(fs.readFileSync(path.join(p.cb, 'config.json'), 'utf8')).defaultPolicy, 'skip', 'the default profile\'s config is used');
  for (const name of ['default', 'personal']) {
    assert.ok(fs.existsSync(path.join(p.cb, name, 'profile.migrated.json')));
    assert.ok(!fs.existsSync(path.join(p.cb, name, 'profile.json')));
    assert.strictEqual(fs.readFileSync(path.join(p.cb, name, 'case-studies', 'x.md'), 'utf8'), name, 'case studies stay put');
    assert.ok(!fs.existsSync(path.join(p.cb, name, 'logs')));
  }
  assert.match(fs.readFileSync(path.join(p.cb, 'casebook.log'), 'utf8'), /merged profile store "personal".*config\.json was not used/);
  // Pending marks and discoveries come along.
  for (const name of ['default', 'personal']) assert.ok(fs.existsSync(path.join(p.cb, 'marks', `pending-${name}.json`)));
  assert.strictEqual(fs.readdirSync(path.join(p.cb, 'state', 'discoveries')).length, 2);
});

test('a file already in the shared store is left in the old store, and the merge finishes on a rerun', () => {
  const p = profileSandbox();
  p.seedStore();
  const store = path.join(p.cb, 'work');
  fs.mkdirSync(path.join(store, 'marks'), { recursive: true });
  fs.mkdirSync(path.join(p.cb, 'marks'), { recursive: true });
  fs.writeFileSync(path.join(store, 'marks', 'dup.json'), '{"old":true}');
  fs.writeFileSync(path.join(p.cb, 'marks', 'dup.json'), '{"new":true}');
  fs.writeFileSync(path.join(store, 'profile.json'), '{}');
  assert.strictEqual(p.run(['list']).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(p.cb, 'marks', 'dup.json'), 'utf8'), '{"new":true}', 'never overwritten');
  assert.strictEqual(fs.readFileSync(path.join(store, 'marks', 'dup.json'), 'utf8'), '{"old":true}');
  assert.match(fs.readFileSync(path.join(p.cb, 'casebook.log'), 'utf8'), /1 file\(s\) already present were left in/);
  assert.ok(fs.existsSync(path.join(store, 'profile.migrated.json')));
});

test('marketplace is named kinbasco-plugins', () => {
  const m = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.claude-plugin/marketplace.json'), 'utf8'));
  assert.strictEqual(m.name, 'kinbasco-plugins');
});

test('handoff skill: reads handoff.md, thin writes nothing, stays inside casebook', () => {
  const root = path.resolve(__dirname, '../plugins/casebook');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const hint = (doc) => doc.match(/^argument-hint: (.+)$/m)[1];
  const skill = read('skills/handoff/SKILL.md');

  assert.match(hint(skill), /^"<log-id> \[<log-id>…\] \[--out <dir>\]/);
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/handoff\.md/);
  assert.ok(fs.existsSync(path.join(root, 'handoff.md')), 'the checks it reads ship with the plugin');
  for (const id of ['E-1', 'E-2', 'E-3', 'E-4', 'A-1', 'A-2', 'A-3']) assert.match(read('handoff.md'), new RegExp(`\\| ${id} \\|`));
  assert.match(skill, /Nothing was written/);
  assert.match(skill, /casebook out-path --project/);
  assert.doesNotMatch(skill, /casebook written|\/casebook:write|\/casebook:scout/);
  assert.doesNotMatch(skill, /\/porch:|mcp__plugin_porch/, 'a plugin never points at another plugin');
});

// ---------- link: ~/.local/bin/casebook ----------

function linkSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'casebook-link-')));
  const dir = path.join(root, 'bin');
  const env = { ...process.env, CASEBOOK_BIN_DIR: dir, CASEBOOK_HOME: path.join(root, 'store'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const run = (args, input = '') => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, input });
  // A fake install of this plugin at some version, to point the link at.
  const fakePlugin = (name, version) => {
    const p = path.join(root, `${name}-${version}`);
    fs.mkdirSync(path.join(p, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(p, 'bin'));
    fs.writeFileSync(path.join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(p, 'bin', 'casebook'), '#!/bin/sh\n');
    return path.join(p, 'bin', 'casebook');
  };
  return { root, dir, dest: path.join(dir, 'casebook'), env, run, fakePlugin, target: fs.realpathSync(BIN) };
}

test('casebook link creates the bin folder and the link, then reports it current', () => {
  const s = linkSandbox();
  const r = JSON.parse(s.run(['link', '--json']).stdout);
  assert.strictEqual(r.status, 'linked');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'current');
  const help = spawnSync(s.dest, ['help'], { encoding: 'utf8', env: s.env });
  assert.strictEqual(help.status, 0, 'the CLI runs through the link');
  assert.match(help.stdout, /casebook/);
});

test('casebook link replaces a broken link and a link to an older casebook, and keeps a newer one', () => {
  const s = linkSandbox();
  fs.mkdirSync(s.dir);
  fs.symlinkSync(path.join(s.root, 'gone', 'bin', 'casebook'), s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'updated');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);

  fs.unlinkSync(s.dest);
  fs.symlinkSync(s.fakePlugin('casebook', '0.0.1'), s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'updated');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);

  const newer = s.fakePlugin('casebook', '99.0.0');
  fs.unlinkSync(s.dest);
  fs.symlinkSync(newer, s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'skipped');
  assert.strictEqual(fs.readlinkSync(s.dest), newer);
});

test('casebook link leaves a regular file, a link to something else, and "off" alone', () => {
  const s = linkSandbox();
  fs.mkdirSync(s.dir);
  const other = s.fakePlugin('not-casebook', '9.0.0');
  fs.symlinkSync(other, s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'skipped');
  assert.strictEqual(fs.readlinkSync(s.dest), other);

  fs.unlinkSync(s.dest);
  fs.writeFileSync(s.dest, 'mine');
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'skipped');
  assert.strictEqual(fs.readFileSync(s.dest, 'utf8'), 'mine');

  const off = spawnSync(process.execPath, [BIN, 'link', '--json'], { encoding: 'utf8', env: { ...s.env, CASEBOOK_BIN_DIR: 'off' } });
  assert.strictEqual(JSON.parse(off.stdout).status, 'skipped');
});

test('casebook SessionStart hook links silently and never fails', () => {
  const s = linkSandbox();
  const r = s.run(['hook', 'session-start'], JSON.stringify({ session_id: 's', source: 'startup' }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '', 'SessionStart must not inject context');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);

  const bad = spawnSync(process.execPath, [BIN, ...['hook', 'session-start']], { encoding: 'utf8', env: { ...s.env, CASEBOOK_BIN_DIR: 'relative/bin' }, input: JSON.stringify({ session_id: 's', source: 'startup' }) });
  assert.strictEqual(bad.status, 0);
  assert.strictEqual(bad.stdout, '');
});
