# Casebook

Casebook keeps a running record of the case studies hiding in your Claude Code sessions. Install it once and it works in every project.

- **Captures automatically.** When a session ends, a cheap headless scout (Haiku by default) reads the transcript and the git commits made during it. It scores the session from 1 to 5 as a potential case study and writes a structured log. Routine sessions are dropped.
- **Lets you flag the good ones.** Run `/casebook:mark "the queue redesign"` at the moment it matters. A marked session is always logged, and the scout focuses on what you marked.
- **Lists them per project** with IDs, scores and marks. `--marked` shows only what you flagged.
- **Writes case studies by ID.** `/casebook:write cb-7k2m9q cb-p3x8aa` merges logs into one publish-ready Markdown file, with frontmatter that a downstream tool (a CMS agent, a static site) can consume.
- **Cleans up.** You can delete one log, or delete a filtered batch.
- **Privacy first.** Each project is `public`, `anonymize` (the default) or `skip`. Under `anonymize`, client and company names never reach the notes or the case study.

## Install

```text
/plugin marketplace add freepeace13/claude-plugins
/plugin install casebook@freepeace13
```

Requirements: Claude Code with plugin support, Node.js 18 or newer on PATH, and git. Tested on macOS and Linux.

Open the config once and add your own repositories as `public`:

```bash
casebook config      # prints the path, ~/.casebook/config.json
```

## Commands

| Command | What it does |
|---|---|
| `/casebook:mark [note]` | Mark the current session. With no note, Claude writes a one-line note itself. |
| `/casebook:mark <id> [note]` | Mark an existing log. |
| `/casebook:list [--marked] [--all \| --project P] [--min-score N] [--unwritten] [--since 30d]` | List logs. Defaults to the current repository's project. |
| `/casebook:show <id>` | Read one log. |
| `/casebook:write <id…> [--out dir] [instructions]` | Write a case study `.md` with the `case-study-writer` agent. |
| `/casebook:delete <id…>` | Delete specific logs. |
| `/casebook:delete --below-score 3 --older-than 30d --unmarked` | Delete a batch. It runs as a dry run first and asks before deleting. |

The same commands work from any shell through the `casebook` CLI. Inside Claude Code the plugin's `bin/` is on PATH. Elsewhere, run `node ~/.claude/plugins/…/casebook/bin/casebook`, or add an alias. Run `casebook help` for the full list, including `backfill` and `doctor`.

```text
$ casebook list --marked
porch  (github.com/freepeace13/porch)  ·  14 logs, 3 marked
ID         DATE        SCORE MRK WRT TITLE
cb-7k2m9q  2026-11-16  4     📌      Fixed websocket reconnect storms with jittered backoff
cb-p3x8aa  2026-11-12  5     📌  ✓   Magic-link chat resume without visitor accounts
```

## How it works

```text
session ends ─► SessionEnd hook ─► (detached) scout ─► claude -p --model haiku --tools "" --no-session-persistence
                                       │  condensed transcript + commits + marks + policy
                                       ▼
                         ~/.casebook/logs/<project>/<id>.md      (score, marks, notes)

next session starts ─► SessionStart hook ─► (detached) sweep missed sessions
```

- **Never blocks you.** Both hooks hand off to a detached process and return immediately. They never print anything, so no text gets injected into your session.
- **No recursion.** The scout runs with `CASEBOOK_SCOUT=1`, `--restricted` (no user settings, so no plugins) and `--no-session-persistence` (no transcript of its own).
- **The sweep** catches sessions whose SessionEnd never fired, such as a killed terminal or a crash. It scouts at most `sweep.maxPerRun` per start, and only sessions from after installation. Use `casebook backfill --since 30d --yes` to process older ones.
- **Resumed sessions** are scouted again once they've grown by `sweep.regrowTurns` turns. The same log is updated and keeps its ID and marks.
- **Deleted logs stay deleted.** Their sessions are never scouted again.
- **Cost.** Sessions with fewer than `scout.minTurns` user turns are skipped unless marked. Transcripts are condensed (tool output dropped, the middle elided past `scout.maxChars`) before the single Haiku call.

## Storage

```text
~/.casebook/                    (override with CASEBOOK_HOME)
  config.json
  logs/<project>/cb-xxxxxx.md   one log per session (frontmatter + notes)
  case-studies/<project>/YYYY-MM-DD-<slug>.md   writer output (or output.dir)
  marks/                        pending marks for sessions still running
  state/                        per-session ledger, install timestamp
  casebook.log                  errors from background runs (see `casebook doctor`)
```

Projects are named after the git remote's repository name. Without a remote, the folder name is used. A repository can override the name and policy with a committed or ignored `.casebook.json`:

```json
{ "project": "client-portal", "policy": "anonymize" }
```

## Configuration

`~/.casebook/config.json`. Any key you leave out keeps its default:

```json
{
  "defaultPolicy": "anonymize",
  "projects": [
    { "match": "github.com/your-handle/*", "policy": "public" },
    { "match": "*/client-acme/*", "policy": "skip" }
  ],
  "scout": { "model": "haiku", "minTurns": 4, "keepMinScore": 2, "maxChars": 60000, "timeoutSec": 240, "command": "claude" },
  "sweep": { "enabled": true, "maxPerRun": 3, "settleMinutes": 15, "regrowTurns": 8 },
  "output": { "dir": null }
}
```

`match` is a glob checked against the normalized remote (`github.com/owner/repo`), the repository path and the project name. The first match wins.

## Writer output

`/casebook:write` saves a file such as `~/.casebook/case-studies/porch/2026-11-16-magic-link-chat-resume.md`:

```markdown
---
title: "Magic-link chat resume without visitor accounts"
slug: "magic-link-chat-resume"
summary: "…"
project: "porch"
repo: "github.com/freepeace13/porch"
policy: "public"
tags: ["laravel", "reverb"]
stack: ["Laravel", "Reverb", "Livewire"]
period: "2026-11-02 – 2026-11-12"
source_logs: ["cb-p3x8aa"]
status: "draft"
created_at: "2026-11-16"
word_count: 870
---
# …
```

Other tools can rely on this frontmatter: `status: "draft"`, `source_logs`, `policy` and `slug` are always present. `casebook list --written --json` lists each log together with the files written from it (`written_to`).

## License

MIT
