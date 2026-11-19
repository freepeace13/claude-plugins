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
/plugin install casebook@kinbasco-plugins
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
| `/casebook:scout [<session-id> \| --pending] [--background] [--force]` | Scout the current session now (or another one, or all missed sessions). See Manual scouting. |
| `/casebook:show <id>` | Read one log. |
| `/casebook:write <id…> [--out dir] [instructions]` | Write a case study `.md` with the `case-study-writer` agent. |
| `/casebook:handoff <id…> [--out dir] [instructions]` | Gather and check what a writer needs from the logs against `handoff.md`, asking at most 3 questions. Writes a handoff folder: `handoff.md` (checks, facts with sources, unknowns) and `logs/`. Writes nothing when the logs are too thin. |
| `/casebook:delete <id…>` | Delete specific logs. |
| `/casebook:delete --below-score 3 --older-than 30d --unmarked` | Delete a batch. It runs as a dry run first and asks before deleting. |

The same commands work from any shell through the `casebook` CLI. Inside Claude Code the plugin's `bin/` is on PATH. Elsewhere, run `node <plugin dir>/bin/casebook`, or add an alias. Run `casebook help` for the full list, including `profiles`, `backfill` and `doctor`.

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
~/.casebook/                    (override the root with CASEBOOK_ROOT)
  default/                      one store per Claude config dir, see Profiles
    profile.json                { name, claudeConfigDir, createdAt }
    config.json
    logs/<project>/cb-xxxxxx.md   one log per session (frontmatter + notes)
    case-studies/<project>/YYYY-MM-DD-<slug>.md   writer output (or output.dir)
    handoffs/<project>/YYYY-MM-DD-<slug>/         /casebook:handoff output (handoff.md + logs/)
    marks/                      pending marks for sessions still running
    state/                      per-session ledger and locks, install timestamp
    casebook.log                errors from background runs (see `casebook doctor`)
  personal/
    …
```

`CASEBOOK_HOME` points straight at one store directory and bypasses profiles. The tests use it.

Projects are named after the git remote's repository name. Without a remote, the folder name is used. A repository can override the name and policy with a committed or ignored `.casebook.json`:

```json
{ "project": "client-portal", "policy": "anonymize" }
```

Casebook keeps its data in `~/.casebook/` rather than the plugin directory, on purpose: logs are shared by every Claude config directory's own store and must survive plugin updates and reinstalls. Uninstalling the plugin does **not** delete them. Remove `~/.casebook/` yourself if you want them gone.

The `case-study-writer` agent has `Bash`, `Read`, `Write`, `Glob` and `Grep`. It runs `casebook` commands and `git remote get-url origin`, and writes the case study file.

## Profiles

If you run Claude Code under more than one config directory (for example `CLAUDE_CONFIG_DIR=~/.claude_personal` next to the default `~/.claude`), each one gets its own fully separate store. Nothing is shared: not logs, not config, not the install date. A work profile can stay `anonymize` while a personal one is `public`.

| Config dir | Profile |
|---|---|
| `~/.claude` (or `CLAUDE_CONFIG_DIR` unset) | `default` |
| `~/.claude_<x>` or `~/.claude-<x>` | `<x>` |
| anything else | its folder name without leading dots |

`CASEBOOK_PROFILE=<name>` overrides the name. If two different config dirs would get the same name, the second store gets a short hash suffix (`work-cfg-3fa9`) and a warning is written to its `casebook.log`.

- **Hooks and skills** use the `CLAUDE_CONFIG_DIR` that Claude Code passes them.
- **The terminal** uses `--profile <name>`, else `CASEBOOK_PROFILE`, else `CLAUDE_CONFIG_DIR`, else `default`. `casebook profiles` lists every store, with `*` on the current one. `casebook list` prints `[profile: <name>]` on its first line and never shows other profiles' logs.
- **The scout runs as the session's profile**, so it is billed to that account. There is no setting to change this.
- Transcripts, the catch-up pass and `backfill` only read the current profile's `projects/` folder. A profile installed later does not backfill its history.

## Manual scouting

Don't want to wait for the session to end? `/casebook:scout` scouts the current session now, in the foreground (20 to 90 seconds).

| Invocation | Effect |
|---|---|
| `/casebook:scout` | Scout the current session. |
| `/casebook:scout <session-id>` | Scout another session in this profile. |
| `/casebook:scout --pending` | Catch up on missed sessions. It lists them first and asks before spending model calls. |
| `… --background` | Return immediately; the log appears in a minute. |
| `… --force` | Also re-scout a session whose log you deleted. Never overrides a `skip` policy. |

A manual scout skips the `minTurns`, `keepMinScore` and `regrowTurns` gates: you asked, so you get a log. A log written while its session may still be running is **partial** (`partial: true`, shown as `4…` in `casebook list`). When the session ends, the normal scout finishes the same log and sets `partial: false`. The case study writer lists partial logs as things to verify.

Scouts of one session never overlap. If one is already running, a manual scout says so and exits, and a hook scout waits for it and then skips if nothing changed.

## Configuration

`~/.casebook/<profile>/config.json`. Any key you leave out keeps its default:

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
