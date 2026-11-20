'use strict';
// Condense a Claude Code session transcript (JSONL) into a compact, model-friendly text.

const fs = require('fs');
const path = require('path');
const { paths } = require('./util');

const MAX_MSG = 2000;

function stripNoise(s) {
  return String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-(stdout|stderr)>[\s\S]*?<\/local-command-\1>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .trim();
}

function clip(s, n = MAX_MSG) {
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s;
}

/** Turn "<command-name>/x</command-name><command-args>y</command-args>" into "/x y". */
function parseCommand(s) {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(s);
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
  return { name: name[1].trim(), args: args ? args[1].trim() : '' };
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function isCasebookTool(b) {
  if (!b || b.type !== 'tool_use') return false;
  const i = b.input || {};
  if (b.name === 'Skill') return /^casebook:/.test(String(i.skill || i.name || ''));
  // `casebook` as a command word anywhere in the line: after `cd x &&`, a pipe or VAR=value prefixes.
  if (b.name === 'Bash') return /(^|[;&|(]\s*)(\w+=\S*\s+)*casebook(\s|$)/.test(String(i.command || '').split('\n')[0]);
  const fp = i.file_path || i.path || '';
  return Boolean(fp) && path.resolve(String(fp)).startsWith(paths.home() + path.sep);
}

function describeTool(b) {
  const i = b.input || {};
  const target = i.file_path || i.notebook_path || i.path || i.pattern || i.url || i.description || '';
  if (b.name === 'Bash' && i.command) return `[Bash] ${clip(String(i.command).split('\n')[0], 160)}`;
  return `[${b.name}]${target ? ' ' + clip(String(target), 160) : ''}`;
}

function findTranscript(sessionId) {
  const root = paths.claudeProjects();
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function condense(file, maxChars = 60000) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  const files = new Set();
  const readFiles = new Set();
  const prUrls = new Set();
  const opening = [];
  let aiTitle = null;
  let userTurns = 0;
  // The reply to a casebook slash command, up to the next turn of the user: its output (topic listings, other
  // logs shown) is about other work, so it is never read as part of this session.
  let inCasebook = false;
  let startedAt = null;
  let endedAt = null;
  let cwd = null;
  let branch = null;
  let sessionId = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) {
      startedAt = startedAt || e.timestamp;
      endedAt = e.timestamp;
    }
    cwd = cwd || e.cwd || null;
    branch = e.gitBranch || branch;
    sessionId = sessionId || e.sessionId || null;
    if (e.type === 'pr-link' && e.prUrl) prUrls.add(String(e.prUrl));
    if (e.type === 'ai-title' && e.aiTitle) aiTitle = String(e.aiTitle);
    if (e.isSidechain || e.isMeta || !e.message) continue;

    if (e.type === 'user') {
      for (const b of blocksOf(e.message.content)) {
        if (b.type !== 'text' || !b.text) continue;
        const cmd = parseCommand(b.text);
        if (cmd) {
          // Casebook's own commands are not work: a discovery must not count itself as news for the session.
          // Those that print other work (listings, logs, a handoff) keep their reply out too; a mark prints none.
          const ours = /^\/?casebook:/.test(cmd.name);
          inCasebook = ours && !/^\/?casebook:mark$/.test(cmd.name);
          if (ours) continue;
          out.push(`USER: ${cmd.name} ${clip(cmd.args, 400)}`.trim());
          userTurns++;
          continue;
        }
        const t = stripNoise(b.text);
        if (!t || t.startsWith('Caveat:')) continue;
        // A short reply inside a casebook command answers it (a topic number, a yes): not work, and still casebook's.
        if (inCasebook && t.length <= 20) continue;
        inCasebook = false;
        out.push(`USER: ${clip(t)}`);
        if (opening.length < 2) opening.push(clip(t, 1000));
        userTurns++;
      }
    } else if (e.type === 'assistant') {
      if (inCasebook) continue;
      for (const b of blocksOf(e.message.content)) {
        // A casebook skill the model invoked, a casebook CLI call, a file in the store: casebook's own calls are
        // not work, though the work around them is.
        if (isCasebookTool(b)) continue;
        if (b.type === 'text' && b.text && b.text.trim()) out.push(`CLAUDE: ${clip(stripNoise(b.text))}`);
        else if (b.type === 'tool_use') {
          out.push(`  ${describeTool(b)}`);
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) files.add(fp);
          if (fp && b.name === 'Read') readFiles.add(fp);
        }
      }
    }
  }

  let text = out.join('\n');
  if (text.length > maxChars) {
    const head = Math.floor(maxChars * 0.4);
    const tail = maxChars - head;
    text = `${text.slice(0, head)}\n\n[… ${text.length - maxChars} chars omitted from the middle …]\n\n${text.slice(-tail)}`;
  }
  return {
    text, userTurns, startedAt, endedAt, cwd, branch, sessionId, files: [...files],
    readFiles: [...readFiles], prUrls: [...prUrls], aiTitle, opening: opening.join('\n'),
  };
}

module.exports = { condense, findTranscript, parseCommand };
