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
  for (const f of ['skills/brief/SKILL.md', 'skills/draft/SKILL.md', 'skills/push/SKILL.md', 'agents/writer.md']) {
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
  const files = ['skills/brief/SKILL.md', 'skills/draft/SKILL.md', 'skills/push/SKILL.md', 'agents/writer.md'];
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

// porch CLI: work folders in $PORCH_HOME.
const os = require('os');
const CLI = path.join(ROOT, 'bin/porch');

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-test-'));
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
  const init = brief.indexOf('porch init "');
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
