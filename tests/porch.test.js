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
  for (const f of ['skills/draft/SKILL.md', 'skills/push/SKILL.md', 'agents/writer.md']) {
    const fm = frontmatter(path.join(ROOT, f));
    assert.match(fm, /^name: \w+/m, f);
    assert.match(fm, /^description:/m, f);
  }
  const writer = frontmatter(path.join(ROOT, 'agents/writer.md'));
  assert.match(writer, /^tools: Read, Write, Glob, Grep$/m);
  assert.doesNotMatch(writer, /Bash|mcp__/);
});

test('draft skill never gets a create or update tool; push is user-only', () => {
  const draft = frontmatter(path.join(ROOT, 'skills/draft/SKILL.md'));
  assert.doesNotMatch(draft, /create-|update-/);
  const push = frontmatter(path.join(ROOT, 'skills/push/SKILL.md'));
  assert.match(push, /disable-model-invocation: true/);
});

test('every references/ file named in the prompts exists', () => {
  const files = ['skills/draft/SKILL.md', 'skills/push/SKILL.md', 'agents/writer.md'];
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
});
