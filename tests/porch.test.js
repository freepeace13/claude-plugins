'use strict';
// Tests for the porch publish guard. Run: node --test tests/

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.resolve(__dirname, '../plugins/porch/bin/porch-guard');

function run(input) {
  return spawnSync('node', [GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('allows a draft article', () => {
  const r = run({ tool_input: { title: 'x', body: 'y', status: 'draft' } });
  assert.strictEqual(r.status, 0);
});

test('allows a call with no status', () => {
  assert.strictEqual(run({ tool_input: { title: 'x' } }).status, 0);
});

test('blocks status published', () => {
  const r = run({ tool_input: { status: 'published' } });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /Porch admin/);
});

test('blocks is_published true', () => {
  assert.strictEqual(run({ tool_input: { is_published: true } }).status, 2);
});

test('allows is_published false', () => {
  assert.strictEqual(run({ tool_input: { is_published: false } }).status, 0);
});

test('blocks on unreadable input', () => {
  assert.strictEqual(run('not json').status, 2);
});

test('hook matcher covers plugin and standalone tool names', () => {
  const hooks = require('../plugins/porch/hooks/hooks.json');
  const re = new RegExp('^(?:' + hooks.hooks.PreToolUse[0].matcher + ')$');
  for (const n of [
    'mcp__plugin_porch_porch__create-article',
    'mcp__porch__update-case-study',
  ]) assert.ok(re.test(n), n);
  assert.ok(!re.test('mcp__porch__read-article'));
});

// Plugin structure: manifest, frontmatter, and every file the prompts point at.
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../plugins/porch');

function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${file} has frontmatter`);
  return m[1];
}

test('manifest and marketplace agree', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../.claude-plugin/marketplace.json'), 'utf8')
  );
  const entry = market.plugins.find((p) => p.name === 'porch');
  assert.ok(entry);
  assert.strictEqual(entry.source, './plugins/porch');
  assert.strictEqual(plugin.name, 'porch');
});

test('skills and agent have name, description and valid tools', () => {
  for (const f of ['skills/brief/SKILL.md', 'skills/draft/SKILL.md', 'skills/push/SKILL.md', 'skills/voice/SKILL.md', 'agents/writer.md']) {
    const fm = frontmatter(path.join(ROOT, f));
    assert.match(fm, /^name: \w+/m, f);
    assert.match(fm, /^description:/m, f);
  }
  const writer = frontmatter(path.join(ROOT, 'agents/writer.md'));
  assert.match(writer, /^tools: Read, Write, Glob, Grep$/m);
  assert.doesNotMatch(writer, /Bash|mcp__/);
});

test('brief and draft skills never get a create or update tool; push is user-only', () => {
  for (const f of ['skills/brief/SKILL.md', 'skills/draft/SKILL.md']) {
    const fm = frontmatter(path.join(ROOT, f));
    assert.doesNotMatch(fm, /create-|update-/, f);
    assert.match(fm, /Bash\(porch:\*\)/, f);
    assert.doesNotMatch(fm, /Bash(?!\(porch:\*\))/, f);
  }
  const push = frontmatter(path.join(ROOT, 'skills/push/SKILL.md'));
  assert.match(push, /disable-model-invocation: true/);
});

test('every references/ file named in the prompts exists', () => {
  const files = ['skills/brief/SKILL.md', 'skills/draft/SKILL.md', 'skills/push/SKILL.md', 'skills/voice/SKILL.md', 'agents/writer.md'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/references\/([\w-]+\.md)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'references', m[1])), `${f} -> ${m[1]}`);
    }
  }
});

test('.mcp.json is valid and the guard is executable', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.porch.url.startsWith('https://'));
  fs.accessSync(path.join(ROOT, 'bin/porch-guard'), fs.constants.X_OK);
  fs.accessSync(path.join(ROOT, 'bin/porch'), fs.constants.X_OK);
});

test('point-of-view rule is in the brief, voice, intake, review and writer', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['references/brief.md', 'references/voice.md', 'agents/writer.md']) {
    assert.match(read(f), /first person/i, f);
    assert.match(read(f), /the owner/, f);
  }
  assert.match(read('skills/brief/SKILL.md'), /point of view/);
  assert.match(read('skills/draft/SKILL.md'), /"the owner", "the user", "operator" and "Claude"/);
});

// Voice: base voice with Fixed and Defaults, the question bank, and voice_user wiring.
test('base voice has Fixed rules before Defaults, and the POV rule is fixed', () => {
  const v = fs.readFileSync(path.join(ROOT, 'references/voice.md'), 'utf8');
  const fixed = v.indexOf('\n## Fixed\n');
  const defaults = v.indexOf('\n## Defaults\n');
  assert.ok(fixed > 0 && defaults > fixed);
  assert.match(v.slice(fixed, defaults), /first person/);
  assert.match(v.slice(fixed, defaults), /Numbers only when they are facts/);
});

function questionBank() {
  const text = fs.readFileSync(path.join(ROOT, 'references/voice-questions.md'), 'utf8');
  return text.split(/\n### Q/).slice(1).map((block) => {
    const head = block.match(/^(\d+) `(\w+)`/);
    const options = block.split(/\n#### /).slice(1).map((o) => ({
      id: o.match(/^`(\w+)`/)[1],
      label: o.match(/^`\w+` (.+)/)[1],
      description: /\n- description: \S/.test(o),
      preview: /\n- preview:\n  > \S/.test(o),
      rule: (o.match(/\n- rule: (.+)/) || [])[1],
    }));
    return {
      n: Number(head[1]),
      id: head[2],
      header: (block.match(/\n- header: `([^`]+)`/) || [])[1],
      question: (block.match(/\n- question: (.+\?)\n/) || [])[1],
      options,
    };
  });
}

test('voice bank has 16 questions with 2 to 4 options, each with a preview and a rule', () => {
  const qs = questionBank();
  assert.strictEqual(qs.length, 16);
  qs.forEach((q, i) => {
    assert.strictEqual(q.n, i + 1);
    assert.ok(q.header && q.header.length <= 12, `${q.id} header`);
    assert.ok(q.header.startsWith(`${i + 1}/16 `), `${q.id} header count`);
    assert.ok(q.question, `${q.id} question`);
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.id} options`);
    assert.strictEqual(new Set(q.options.map((o) => o.id)).size, q.options.length, `${q.id} ids`);
    for (const o of q.options) {
      // At most 4 words, so ' (Recommended)' still fits the 5-word label limit.
      assert.ok(o.label.split(/\s+/).length <= 4, `${q.id}.${o.id} label`);
      assert.ok(o.description && o.preview && o.rule, `${q.id}.${o.id}`);
    }
  });
  assert.strictEqual(new Set(qs.map((q) => q.id)).size, 16);
});

test('voice skill lists every question id in its format, and each area table row exists', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills/voice/SKILL.md'), 'utf8');
  const bank = fs.readFileSync(path.join(ROOT, 'references/voice-questions.md'), 'utf8');
  for (const q of questionBank()) {
    assert.match(skill, new RegExp(`\\n  ${q.id}: <option id or other>\\n`), q.id);
    assert.match(skill, new RegExp(`<${q.id} rule>`), q.id);
  }
  // Each area's table row lists exactly its questions, in bank order.
  const rows = bank.split('\n## ')[0].split('\n').filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith('| Area'));
  const listed = rows.flatMap((r) => r.split('|')[3].split(',').map((s) => s.trim()));
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(listed, questionBank().map((q) => q.id));
  for (const h of ['Rhythm', 'Presence', 'Delivery', 'Audience']) assert.match(skill, new RegExp(`\\n## ${h}\\n`));
});

test('voice skill writes only the voice file and never calls Porch', () => {
  const fm = frontmatter(path.join(ROOT, 'skills/voice/SKILL.md'));
  assert.match(fm, /^allowed-tools: Read, Write, Glob, AskUserQuestion, Bash\(porch:\*\)$/m);
  assert.doesNotMatch(fm, /mcp__/);
});

test('brief, writer and review read the base voice and voice_user', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['references/brief.md', 'skills/brief/SKILL.md', 'agents/writer.md', 'skills/draft/SKILL.md']) {
    assert.match(read(f), /voice_user/, f);
  }
  for (const f of ['agents/writer.md', 'skills/draft/SKILL.md']) assert.match(read(f), /references\/voice\.md/, f);
  assert.match(read('agents/writer.md'), /Fixed rules always apply/);
  const draft = read('skills/draft/SKILL.md');
  assert.match(draft, /`plugin_root` should be `\$\{CLAUDE_PLUGIN_ROOT\}`/);
  assert.match(draft, /When all three already match, skip the Edit/);
  assert.match(draft, /`voice_user` should be that path; otherwise there should be no `voice_user` line/);
  assert.match(draft, /For `kind=draft`.*AC-5 fails only on what the writer added/);
  assert.match(fs.readFileSync(path.join(ROOT, "skills/voice/SKILL.md"), "utf8"), /\n## My additions\n/);
  assert.match(draft, /with Edit, which you use for nothing else, changing only these frontmatter lines in `dir\/brief\.md`/);
  const voice = read('skills/voice/SKILL.md');
  assert.match(voice, /voice\.md\.bak`; if that already exists, read it before writing/);
  assert.match(voice, /voice\.handwritten-2\.md/);
  assert.match(voice, /both `generated_by: \/porch:voice` and `answers`/);
  assert.match(voice, /The `updated` date and the Sample section are always new/);
});

// porch CLI: work folders in $PORCH_HOME.
const os = require('os');
const crypto = require('crypto');
const CLI = path.join(ROOT, 'bin/porch');

function sandbox() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'porch-test-'));
  const home = path.join(base, 'store');
  const cli = (...args) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PORCH_HOME: home },
  });
  return { base, home, cli };
}

test('init copies a file into <home>/articles/<uuid>/intake with state', () => {
  const { base, home, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'notes.md'), '# Queue backoff\n');
  const r = cli('init', path.join(base, 'notes.md'), '--type', 'article', '--topic', 'Retry storms after deploys', '--note', 'keep it short', '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(s.dir, path.join(home, 'articles', s.id));
  assert.strictEqual(fs.readFileSync(path.join(s.dir, 'intake/notes.md'), 'utf8'), '# Queue backoff\n');
  const state = JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'));
  assert.strictEqual(state.status, 'new');
  assert.strictEqual(state.title, 'notes');
  assert.strictEqual(state.note, 'keep it short');
  assert.strictEqual(state.topic, 'Retry storms after deploys');
  assert.ok(state.created_at && state.updated_at);
});

test('init copies a folder into case-studies, skipping .git and node_modules', () => {
  const { base, cli } = sandbox();
  const src = path.join(base, 'proj');
  for (const d of ['docs', '.git', 'node_modules/x']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'docs/a.md'), 'a');
  fs.writeFileSync(path.join(src, '.git/HEAD'), 'x');
  fs.writeFileSync(path.join(src, 'node_modules/x/i.js'), 'x');
  const s = JSON.parse(cli('init', src, '--type', 'case-study', '--topic', 'T', '--json').stdout);
  assert.ok(s.dir.includes(`${path.sep}case-studies${path.sep}`));
  assert.ok(fs.existsSync(path.join(s.dir, 'intake/proj/docs/a.md')));
  assert.ok(!fs.existsSync(path.join(s.dir, 'intake/proj/.git')));
  assert.ok(!fs.existsSync(path.join(s.dir, 'intake/proj/node_modules')));
});

test('init rejects a bad type and a missing path', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  assert.strictEqual(cli('init', path.join(base, 'n.md'), '--type', 'blog').status, 1);
  assert.strictEqual(cli('init', path.join(base, 'nope.md'), '--type', 'article', '--topic', 'T').status, 1);
});

test('set, list and read work by id prefix', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const { id } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
  const short = id.slice(0, 8);
  const set = cli('set', short, 'status=briefed', 'title=Backoff after deploys', 'tags=queues, laravel', 'slug=backoff-after-deploys');
  assert.strictEqual(set.status, 0, set.stderr);

  const list = cli('list');
  assert.match(list.stdout, new RegExp(`${short}\\s+article\\s+briefed .*queues,laravel\\s+Backoff after deploys`));
  assert.strictEqual(JSON.parse(cli('list', '--status', 'approved', '--json').stdout).length, 0);
  assert.strictEqual(JSON.parse(cli('list', '--tag', 'queues', '--json').stdout).length, 1);

  const read = JSON.parse(cli('read', short, '--json').stdout);
  assert.deepStrictEqual(read.tags, ['queues', 'laravel']);
  assert.strictEqual(read.slug, 'backoff-after-deploys');
  assert.strictEqual(cli('read', short, '--path').stdout.trim(), read.dir);
  fs.writeFileSync(path.join(read.dir, 'brief.md'), 'BRIEF');
  assert.strictEqual(cli('read', short, 'brief').stdout, 'BRIEF');
  assert.strictEqual(cli('read', short, 'draft').status, 1);
});

test('set rejects unknown keys and bad values', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const { id } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
  assert.strictEqual(cli('set', id, 'type=case-study').status, 1);
  assert.strictEqual(cli('set', id, 'status=published').status, 1);
  assert.strictEqual(cli('set', id, 'slug=Not A Slug').status, 1);
  assert.strictEqual(cli('set', id, 'id=x').status, 1);
});

test('delete is a dry run without --yes', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const { id, dir } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
  const dry = cli('delete', id);
  assert.match(dry.stdout, /would delete/);
  assert.ok(fs.existsSync(dir));
  assert.strictEqual(cli('delete', id, '--yes').status, 0);
  assert.ok(!fs.existsSync(dir));
  assert.strictEqual(cli('read', id).status, 1);
});

test('short or unknown ids fail', () => {
  const { cli } = sandbox();
  assert.strictEqual(cli('read', 'ab').status, 1);
  assert.strictEqual(cli('read', 'abcdef').status, 1);
  assert.match(cli('list').stdout, /no work folders yet/);
});

test('init refuses without a topic from the intake check, and creates nothing', () => {
  const { base, home, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  for (const extra of [[], ['--topic', '  ']]) {
    const r = cli('init', path.join(base, 'n.md'), '--type', 'article', ...extra);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /intake check/);
  }
  assert.ok(!fs.existsSync(home));
  const { id } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
  assert.strictEqual(cli('set', id, 'topic=').status, 1);
});

test('brief skill checks the intake before porch init; draft gates on the check', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const brief = read('skills/brief/SKILL.md');
  const check = brief.indexOf('**Check the intake**');
  const init = brief.indexOf("porch init '");
  assert.ok(check > 0 && init > check, 'intake check comes before porch init');
  assert.match(brief, /references\/intake\.md/);
  assert.doesNotMatch(brief.slice(0, init), /porch delete/);
  assert.match(read('skills/draft/SKILL.md'), /intake_check: pass/);
  assert.match(read('references/brief.md'), /^intake_check: /m);
  const intake = read('references/intake.md');
  for (const e of ['E-1', 'E-2', 'E-3', 'E-4', 'A-1', 'A-2', 'A-3', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5']) assert.match(intake, new RegExp(`\\| ${e} \\|`), e);
  for (const h of ['## Common elements (article and case study)', '## Article elements', '## Case study elements']) assert.ok(intake.includes(h), h);
  for (const v of ['`pass`', '`pass-with-answers`', '`thin`']) assert.ok(intake.includes(v), v);
});

// Review fixes on PR #4.
const ids = (home) => ['articles', 'case-studies'].flatMap((t) => {
  try { return fs.readdirSync(path.join(home, t)); } catch { return []; }
});
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a failed create leaves nothing in the store', { skip: isRoot && 'root ignores folder modes' }, () => {
  const { base, home, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  assert.strictEqual(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T').status, 0);
  fs.chmodSync(path.join(home, 'articles'), 0o500);
  const r = cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T');
  fs.chmodSync(path.join(home, 'articles'), 0o700);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^porch: could not create the work folder/);
  assert.strictEqual(ids(home).length, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, '.staging')), []);
});

test('unreadable files and folders are skipped with a warning', { skip: isRoot && 'root can read them' }, () => {
  const { base, cli } = sandbox();
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'a');
  fs.writeFileSync(path.join(src, 'b.md'), 'b');
  fs.chmodSync(path.join(src, 'b.md'), 0o000);
  fs.chmodSync(path.join(src, 'sub'), 0o000);
  const r = cli('init', src, '--type', 'article', '--topic', 'T', '--json');
  fs.chmodSync(path.join(src, 'b.md'), 0o644);
  fs.chmodSync(path.join(src, 'sub'), 0o755);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipped 2 unreadable path/);
  assert.doesNotMatch(r.stderr, /at .*node:/);
  const w = JSON.parse(r.stdout);
  assert.strictEqual(w.skipped_unreadable.length, 2);
  assert.ok(fs.existsSync(path.join(w.dir, 'intake/src/a.md')));
  assert.ok(!fs.existsSync(path.join(w.dir, 'intake/src/b.md')));
});

test('a store inside the intake folder is left out of the copy', () => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'porch-test-'));
  const proj = path.join(base, 'proj');
  const home = path.join(proj, 'st');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'notes.md'), 'n');
  const env = { ...process.env, PORCH_HOME: home };
  const run = () => spawnSync('node', [CLI, 'init', proj, '--type', 'article', '--topic', 'T', '--json'], { encoding: 'utf8', env });
  const first = run();
  assert.strictEqual(first.status, 0, first.stderr);
  const second = run();
  assert.strictEqual(second.status, 0, second.stderr);
  const { dir } = JSON.parse(second.stdout);
  assert.ok(fs.existsSync(path.join(dir, 'intake/proj/notes.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'intake/proj/st')));
});

test('symlinks are not copied, so the intake is a snapshot', () => {
  const { base, cli } = sandbox();
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(base, 'outside.md'), 'o');
  fs.writeFileSync(path.join(src, 'a.md'), 'a');
  fs.symlinkSync(path.join(base, 'outside.md'), path.join(src, 'link.md'));
  const r = cli('init', src, '--type', 'article', '--topic', 'T', '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.strictEqual(s.skipped_links, 1);
  assert.match(r.stderr, /skipped 1 symlink/);
  assert.ok(fs.existsSync(path.join(s.dir, 'intake/src/a.md')));
  assert.throws(() => fs.lstatSync(path.join(s.dir, 'intake/src/link.md')));
});

test('PORCH_HOME must be absolute', () => {
  const r = spawnSync('node', [CLI, 'home'], { encoding: 'utf8', env: { ...process.env, PORCH_HOME: 'rel/store' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /PORCH_HOME must be an absolute path/);
  const ok = spawnSync('node', [CLI, 'home'], { encoding: 'utf8', env: { ...process.env, PORCH_HOME: '~/x-porch' } });
  assert.strictEqual(ok.stdout.trim(), path.join(os.homedir(), 'x-porch'));
});

test('Object property names are not valid types, files or commands', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const r = cli('init', path.join(base, 'n.md'), '--type', 'constructor', '--topic', 'T');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^porch: --type must be article or case-study/);
  const { id } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
  for (const args of [['read', id, 'toString'], ['read', id, 'toString', '--path'], ['list', '--type', '__proto__'], ['toString']]) {
    const x = cli(...args);
    assert.strictEqual(x.status, 1, args.join(' '));
    assert.match(x.stderr, /^porch: /, args.join(' '));
  }
});

test('list takes several statuses', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const mk = (st) => {
    const { id } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
    cli('set', id, `status=${st}`);
  };
  ['briefed', 'drafting', 'escalated', 'pushed'].forEach(mk);
  assert.strictEqual(JSON.parse(cli('list', '--status', 'briefed,drafting,escalated', '--json').stdout).length, 3);
  assert.strictEqual(cli('list', '--status', 'briefed,nope').status, 1);
});

test('import brings 0.1.0 .porch/<slug> folders into the store', () => {
  const { base, home, cli } = sandbox();
  const old = path.join(base, 'proj/.porch');
  const ok = path.join(old, 'backoff-after-deploys');
  const wip = path.join(old, 'half-done');
  fs.mkdirSync(ok, { recursive: true });
  fs.mkdirSync(wip, { recursive: true });
  fs.writeFileSync(path.join(old, 'voice.md'), 'my voice');
  fs.writeFileSync(path.join(ok, 'brief.md'), '---\ntype: article\nslug: backoff-after-deploys\nthesis: Back off after deploys\n---\n');
  fs.writeFileSync(path.join(ok, 'draft.md'), '---\ntype: article\ntitle: "Backoff after deploys"\n---\nBody\n');
  fs.writeFileSync(path.join(ok, 'review.md'), 'AC-1 pass\napproved\n');
  fs.writeFileSync(path.join(wip, 'brief.md'), '---\ntype: case-study   # comment\nslug: half-done\n---\n');

  const r = cli('import', ok, wip);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /voice\.md is not used any more; copy it to/);
  const items = JSON.parse(cli('list', '--json').stdout);
  const a = items.find((w) => w.slug === 'backoff-after-deploys');
  const c = items.find((w) => w.slug === 'half-done');
  assert.strictEqual(a.status, 'approved');
  assert.strictEqual(a.type, 'article');
  assert.strictEqual(a.title, 'Backoff after deploys');
  assert.strictEqual(a.topic, 'Back off after deploys');
  assert.strictEqual(fs.readFileSync(path.join(a.dir, 'draft.md'), 'utf8'), '---\ntype: article\ntitle: "Backoff after deploys"\n---\nBody\n');
  assert.ok(a.dir.startsWith(path.join(home, 'articles')));
  assert.strictEqual(c.status, 'new');
  assert.strictEqual(c.type, 'case-study');
  assert.match(cli('read', a.id).stdout, /files: {4}brief\.md, draft\.md, review\.md/);

  assert.match(cli('import', ok).stdout, /already imported/);
  assert.strictEqual(JSON.parse(cli('list', '--json').stdout).length, 2);
  assert.strictEqual(cli('import', base).status, 1);
});

test('draft and push point 0.1.0 users at porch import; brief counts the publish question in the 3', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const f of ['skills/draft/SKILL.md', 'skills/push/SKILL.md']) assert.match(read(f), /porch import \.porch\/<id>/, f);
  assert.match(read('skills/draft/SKILL.md'), /porch list --status briefed,drafting,escalated/);
  assert.match(read('skills/brief/SKILL.md'), /only when there is room left in the 3/);
  assert.match(read('references/intake.md'), /counts toward the 3/);
});

// Second review round on PR #4.
test('a broken state.json is skipped with a warning, not a crash', () => {
  const { base, home, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const { id } = JSON.parse(cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T', '--json').stdout);
  const bad = [
    ['articles', '{}'],
    ['articles', '[]'],
    ['articles', 'not json'],
    ['case-studies', null], // id matches, but the folder is the wrong type
  ];
  for (const [t, body] of bad) {
    const u = crypto.randomUUID();
    fs.mkdirSync(path.join(home, t, u), { recursive: true });
    fs.writeFileSync(path.join(home, t, u, 'state.json'),
      body ?? JSON.stringify({ id: u, type: 'article', tags: 'oops' }));
  }
  const tagsBad = crypto.randomUUID();
  fs.mkdirSync(path.join(home, 'articles', tagsBad));
  fs.writeFileSync(path.join(home, 'articles', tagsBad, 'state.json'), JSON.stringify({ id: tagsBad, type: 'article', tags: 'x' }));

  const list = cli('list');
  assert.strictEqual(list.status, 0, list.stderr);
  assert.strictEqual((list.stderr.match(/^porch: skipping /gm) || []).length, 4);
  assert.strictEqual(JSON.parse(cli('list', '--json').stdout).length, 2);
  for (const args of [['read', id], ['set', id, 'title=x'], ['delete', id]]) {
    assert.strictEqual(cli(...args).status, 0, args.join(' '));
  }
});

test('import keeps # and quotes in frontmatter values', () => {
  const { base, cli } = sandbox();
  const dir = path.join(base, '.porch/c-sharp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.md'),
    "---\ntype: article   # kind of piece\nslug: c-sharp # the slug\nthesis: 'It''s C# all the way'\n---\n");
  fs.writeFileSync(path.join(dir, 'draft.md'), '---\ntype: article\ntitle: "C# in 2026: \\"why\\" # not a comment"\n---\n');
  fs.writeFileSync(path.join(dir, 'review.md'), 'approved\n');
  assert.strictEqual(cli('import', dir).status, 0);
  const [w] = JSON.parse(cli('list', '--json').stdout);
  assert.strictEqual(w.title, 'C# in 2026: "why" # not a comment');
  assert.strictEqual(w.topic, "It's C# all the way");
  assert.strictEqual(w.slug, 'c-sharp');
});

test('init stops at the size limit and tells you to pass --force', () => {
  const { base, home, cli } = sandbox();
  const src = path.join(base, 'big');
  fs.mkdirSync(src);
  for (let i = 0; i <= 2000; i++) fs.writeFileSync(path.join(src, `f${i}.md`), '');
  const r = cli('init', src, '--type', 'article', '--topic', 'T');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /more than 2000 files .* pass --force/);
  assert.deepStrictEqual(ids(home), []);
  const forced = cli('init', src, '--type', 'article', '--topic', 'T', '--force', '--json');
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.strictEqual(fs.readdirSync(path.join(JSON.parse(forced.stdout).dir, 'intake/big')).length, 2001);
});

test('init only sets the mode of a store it creates', () => {
  const { base, home, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T');
  assert.strictEqual(fs.statSync(home).mode & 0o777, 0o700);
  fs.chmodSync(home, 0o755);
  cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', 'T');
  assert.strictEqual(fs.statSync(home).mode & 0o777, 0o755);
});

test('init keeps empty folders', () => {
  const { base, cli } = sandbox();
  const src = path.join(base, 'src');
  fs.mkdirSync(path.join(src, 'empty/deeper'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'a');
  const { dir } = JSON.parse(cli('init', src, '--type', 'article', '--topic', 'T', '--json').stdout);
  assert.ok(fs.statSync(path.join(dir, 'intake/src/empty/deeper')).isDirectory());
});

test('unapproved imports become the intake of a work folder that /porch:brief <id> picks up', () => {
  const { base, cli } = sandbox();
  const dir = path.join(base, '.porch/wip');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.md'), '---\ntype: article\nslug: wip\n---\n');
  fs.writeFileSync(path.join(dir, 'draft.md'), '---\ntitle: WIP\n---\nBody\n');
  const r = cli('import', dir);
  assert.match(r.stdout, /brief it again with \/porch:brief [0-9a-f]{8}/);
  const [w] = JSON.parse(cli('list', '--json').stdout);
  assert.strictEqual(w.status, 'new');
  assert.strictEqual(w.intake, 'intake/wip');
  assert.ok(fs.existsSync(path.join(w.dir, 'intake/wip/draft.md')));
  assert.ok(!fs.existsSync(path.join(w.dir, 'brief.md')));
  const brief = fs.readFileSync(path.join(ROOT, 'skills/brief/SKILL.md'), 'utf8');
  assert.match(brief, /\*\*Imported folder\.\*\*/);
  assert.match(brief, /status `new` and an `intake`/);
});

test('draft_source must be a file inside intake/, and draft copies it', () => {
  const { base, cli } = sandbox();
  const src = path.join(base, 'proj');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'post.md'), 'p');
  const { id } = JSON.parse(cli('init', src, '--type', 'article', '--topic', 'T', '--json').stdout);
  assert.strictEqual(cli('set', id, 'draft_source=intake/proj/post.md').status, 0);
  assert.strictEqual(JSON.parse(cli('read', id, '--json').stdout).draft_source, 'intake/proj/post.md');
  for (const bad of ['intake/proj/nope.md', 'intake/proj', 'state.json', 'intake/../state.json', '../x']) {
    assert.strictEqual(cli('set', id, `draft_source=${bad}`).status, 1, bad);
  }
  const draft = fs.readFileSync(path.join(ROOT, 'skills/draft/SKILL.md'), 'utf8');
  assert.match(draft, /copy `dir\/<draft_source>` to `dir\/draft\.md`/);
  assert.match(fs.readFileSync(path.join(ROOT, 'skills/brief/SKILL.md'), 'utf8'), /draft_source=intake\//);
});

test('import --json stays valid JSON when a folder was already imported', () => {
  const { base, cli } = sandbox();
  const dir = path.join(base, 'p/.porch/a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brief.md'), '---\ntype: article\nslug: a\n---\n');
  assert.strictEqual(cli('import', dir, '--json').status, 0);
  const r = cli('import', dir, '--json');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /already imported/);
});

test('import checks every folder before creating any', () => {
  const { base, cli } = sandbox();
  const a = path.join(base, 'p/.porch/a');
  const b = path.join(base, 'p/.porch/b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'brief.md'), '---\ntype: article\nslug: a\n---\n');
  fs.writeFileSync(path.join(b, 'brief.md'), '---\ntype: post\nslug: b\n---\n');
  assert.strictEqual(cli('import', a, b, '--json').status, 1);
  assert.deepStrictEqual(JSON.parse(cli('list', '--json').stdout), []);
});

test('a value flag refuses another flag as its value, and a boolean flag refuses a value', () => {
  const { base, cli } = sandbox();
  fs.writeFileSync(path.join(base, 'n.md'), 'x');
  const r = cli('init', path.join(base, 'n.md'), '--type', 'article', '--topic', '--json');
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--topic needs a value/);
  assert.strictEqual(cli('list', '--json=false').status, 1);
  assert.deepStrictEqual(JSON.parse(cli('list', '--json').stdout), []);
});

test('default title keeps dots in folder names and names dotfiles', () => {
  const { base, cli } = sandbox();
  const dir = path.join(base, 'api.v2');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.md'), 'a');
  fs.writeFileSync(path.join(base, '.notes'), 'n');
  const title = (p) => JSON.parse(cli('init', p, '--type', 'article', '--topic', 'T', '--json').stdout).title;
  assert.strictEqual(title(dir), 'api.v2');
  assert.strictEqual(title(path.join(base, '.notes')), '.notes');
});

test('skills pass values in single quotes, allow spaced paths, and keep drafts pushable', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const brief = read('skills/brief/SKILL.md');
  const draft = read('skills/draft/SKILL.md');
  for (const [f, s] of [['brief', brief], ['draft', draft]]) {
    assert.doesNotMatch(s, /(--topic|--note|title=|topic=|note=) ?"/, f);
  }
  assert.match(brief, /--topic '<topic>'/);
  assert.match(brief, /first word that is exactly `article` or `case-study`/);
  assert.match(brief, /note='<note>'/);
  // draft_source is checked before the status changes, and finished statuses are not re-drafted silently.
  assert.ok(draft.indexOf('draft_source` is not set') < draft.indexOf('status=drafting'));
  assert.match(draft, /`approved` or `pushed`/);
  assert.match(draft, /no frontmatter with `type`, `title` and `slug`/);
  assert.match(read('agents/writer.md'), /finished draft, copied in unchanged/);
});

// ---------- link: ~/.local/bin/porch ----------

function linkSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'porch-link-')));
  const dir = path.join(root, 'bin');
  const env = { ...process.env, PORCH_BIN_DIR: dir, PORCH_HOME: path.join(root, 'store') };
  const run = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input });
  // A fake install of this plugin at some version, to point the link at.
  const fakePlugin = (name, version) => {
    const p = path.join(root, `${name}-${version}`);
    fs.mkdirSync(path.join(p, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(p, 'bin'));
    fs.writeFileSync(path.join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(p, 'bin', 'porch'), '#!/bin/sh\n');
    return path.join(p, 'bin', 'porch');
  };
  return { root, dir, dest: path.join(dir, 'porch'), env, run, fakePlugin, target: fs.realpathSync(CLI) };
}

test('porch link creates the bin folder and the link, then reports it current', () => {
  const s = linkSandbox();
  const r = JSON.parse(s.run(['link', '--json']).stdout);
  assert.strictEqual(r.status, 'linked');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'current');
  const help = spawnSync(s.dest, ['help'], { encoding: 'utf8', env: s.env });
  assert.strictEqual(help.status, 0, 'the CLI runs through the link');
  assert.match(help.stdout, /porch/);
});

test('porch link replaces a broken link and a link to an older porch, and keeps a newer one', () => {
  const s = linkSandbox();
  fs.mkdirSync(s.dir);
  fs.symlinkSync(path.join(s.root, 'gone', 'bin', 'porch'), s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'updated');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);

  fs.unlinkSync(s.dest);
  fs.symlinkSync(s.fakePlugin('porch', '0.0.1'), s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'updated');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);

  const newer = s.fakePlugin('porch', '99.0.0');
  fs.unlinkSync(s.dest);
  fs.symlinkSync(newer, s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'skipped');
  assert.strictEqual(fs.readlinkSync(s.dest), newer);
});

test('porch link leaves a regular file, a link to something else, and "off" alone', () => {
  const s = linkSandbox();
  fs.mkdirSync(s.dir);
  const other = s.fakePlugin('not-porch', '9.0.0');
  fs.symlinkSync(other, s.dest);
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'skipped');
  assert.strictEqual(fs.readlinkSync(s.dest), other);

  fs.unlinkSync(s.dest);
  fs.writeFileSync(s.dest, 'mine');
  assert.strictEqual(JSON.parse(s.run(['link', '--json']).stdout).status, 'skipped');
  assert.strictEqual(fs.readFileSync(s.dest, 'utf8'), 'mine');

  const off = spawnSync(process.execPath, [CLI, 'link', '--json'], { encoding: 'utf8', env: { ...s.env, PORCH_BIN_DIR: 'off' } });
  assert.strictEqual(JSON.parse(off.stdout).status, 'skipped');
});

test('porch SessionStart hook links silently and never fails', () => {
  const s = linkSandbox();
  const r = s.run(['link', '--hook'], '{}');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '', 'SessionStart must not inject context');
  assert.strictEqual(fs.realpathSync(s.dest), s.target);

  const bad = spawnSync(process.execPath, [CLI, ...['link', '--hook']], { encoding: 'utf8', env: { ...s.env, PORCH_BIN_DIR: 'relative/bin' }, input: '{}' });
  assert.strictEqual(bad.status, 0);
  assert.strictEqual(bad.stdout, '');
});
