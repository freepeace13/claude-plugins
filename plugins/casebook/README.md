# Casebook

Casebook keeps a running record of the case studies hiding in your Claude Code sessions. Install it once and it works in every project.

- **Captures automatically.** When a session ends, a cheap headless scout (Haiku by default) reads the transcript and the git commits made during it. It pulls out the session's potential case studies (up to 3 topics, each from its own angle), scores each from 1 to 5 and writes one structured log per topic. Routine sessions are dropped.
- **Lets you flag the good ones.** Run `/casebook:mark "the queue redesign"` at the moment it matters. A marked session is always logged, and the scout focuses on what you marked.
- **Logs topics, not sessions.** A session can feed several logs, and a log can draw on several sessions. Every scan sees the logs already near it, so a topic is updated rather than logged twice: each log is unique in its profile.
- **Finds topics across sessions.** Work carried over several sessions (a resumed branch, a handoff file, one pull request) belongs in one log. `/casebook:discovery` links those sessions, scans them again for topics, ranks the best 3 and logs the one you pick.
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
| `/casebook:discovery [note] [--score N] [--tags a,b] [--all \| --project P] [--since 90d]` | Find topics across linked sessions, rank the best 3 and log the one you pick. See Discovery. |
| `/casebook:show <id>` | Read one log. |
| `/casebook:write <id…> [--out dir] [instructions]` | Write a case study `.md` with the `case-study-writer` agent. |
| `/casebook:handoff <id…> [--out dir] [instructions]` | Gather and check what a writer needs from the logs against `handoff.md`, asking at most 3 questions. Writes a handoff folder: `handoff.md` (checks, facts with sources, unknowns) and `logs/`. Writes nothing when the logs are too thin. |
| `/casebook:delete <id…>` | Delete specific logs. |
| `/casebook:delete --below-score 3 --older-than 30d --unmarked` | Delete a batch. It runs as a dry run first and asks before deleting. |

The same commands work from any shell through the `casebook` CLI. Inside Claude Code the plugin's `bin/` is on PATH. For your terminal, the plugin symlinks `~/.local/bin/casebook` to itself at every Claude Code startup, so the link follows updates; make sure `~/.local/bin` is on your PATH. An existing link to an older casebook (or a broken one) is replaced; a regular file, a link to anything else, or a link to an equal or newer casebook is left alone. Run `casebook link` to do it now. Set `CASEBOOK_BIN_DIR` to link into another folder, or to `off` to stop linking. Uninstalling the plugin does not remove the link. Run `casebook help` for the full list, including `profiles`, `backfill` and `doctor`.

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
- **Resumed sessions** are scanned again once they've grown by `sweep.regrowTurns` turns. Topics already logged are updated and keep their IDs and marks; a new angle becomes a new log.
- **Deleted topics stay deleted.** No later scan logs them again. A session whose logs were all deleted is not scanned automatically any more; `/casebook:scout <id>` can still look in it for other topics.
- **Cost.** Sessions with fewer than `scout.minTurns` user turns are skipped unless marked. Transcripts are condensed (tool output dropped, the middle elided past `scout.maxChars`) before the single Haiku call.

## Storage

```text
~/.casebook/                    (override the root with CASEBOOK_ROOT)
  default/                      one store per Claude config dir, see Profiles
    profile.json                { name, claudeConfigDir, createdAt }
    config.json
    logs/<project>/cb-xxxxxx.md   one log per topic (frontmatter + notes)
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
| `… --force` | Let a scan log a topic you deleted again. Never overrides a `skip` policy. |

A manual scout skips the `minTurns` and `regrowTurns` gates and always keeps at least its best topic: you asked, so you get a log. You can scout a session as often as you like; topics already logged are updated, never duplicated. A log written while its session may still be running is **partial** (`partial: true`, shown as `4…` in `casebook list`). When the session ends, the normal scout finishes the same logs and sets `partial: false`. The case study writer lists partial logs as things to verify.

Scouts of one session never overlap. If one is already running, a manual scout says so and exits, and a hook scout waits for it and then skips if nothing changed.

## Topics

A log is one topic, not one session.

- **A session can feed several logs.** One scan returns up to `scout.maxTopics` topics, each a story that stands on its own: the debugging hunt, and the architecture decision it led to, are two logs with different `angle`s. A new topic must score `keepMinScore` or more unless it carries a mark.
- **A log can draw on several sessions.** Its frontmatter lists them in `sessions`, with `session_turns` per session. `session_id` is the first of them.
- **Every log is unique in its profile.** A scan is shown the logs that already draw on its sessions, plus the project's logs from the 14 days around it, and the topics you deleted. For each topic it finds, the model either names the existing log it is the same as (`same_as`), which is then updated with the notes rewritten to cover both, or calls it new. A topic with the same title as a log of the same sessions is never created twice. When a topic matches several logs, they were duplicates: they merge into one. A log already written up survives the merge, so its ID stays valid; the others are listed in `merged_from`.
- **Re-scanning is always allowed.** `/casebook:scout` and `/casebook:discovery` can scan a session again to pull out another angle.
- **Marks.** `/casebook:mark` on a session with one log marks that log. With several, the mark waits for the next scan, which gives it to the topic it points to.
- **Deleting** a log remembers its topic for each of its sessions, so no scan brings it back (`--force` lifts that).

## Discovery

The scout reads one session at a time, so work carried over several sessions tends to end up as one log per session, each telling part of the story. `/casebook:discovery` looks across sessions:

1. **Collect.** It reads every transcript of this profile from the last 90 days (`--since`), in the current project (`--all` or `--project P` to widen it). Skipped projects stay out. Sessions that are already logged stay in: a new scan can find another angle.
2. **Link.** Sessions of one project are linked when the later one continues the earlier one, within 14 days:
   - the same pull request,
   - the same feature branch (not `main`, `master`, `develop` and the like),
   - a handoff: the later session opens by naming a file the earlier one wrote, or reads a Markdown file it wrote,
   - a "continue where we left off" opening right after a session that edited the same files,
   - or most of the same files edited within 3 days.

   A chain holds at most 6 sessions.
3. **Shortlist.** With `--tags`, a chain must mention at least one tag. Chains are ranked without a model call (existing log scores, linked chains first, how well they match the note and tags) and the top 5 go on.
4. **Scan.** Each candidate is one headless model call, side by side, with the merged transcripts as chapters of one story and the existing logs (see Topics). It returns up to `scout.maxTopics` topics, each with a score, how well it fits the note and tags, which of the sessions it draws on, and which existing logs it is the same as.
5. **Rank.** Topics already logged with exactly those sessions are dropped, and so are deleted topics, topics below `--score`, and, with a note or tags, topics that don't fit. The best 3 across all candidates are shown, highest score first, each marked `new log`, `updates <id>` or `merges <ids>`, and you pick one.
6. **Log.** The chosen topic becomes a new log, or updates (and merges) the logs it matches. `scout_mode` is `discovery` and your note is kept as `discovery_note`.

The note can name a topic or give rules: `/casebook:discovery look for websocket + redis stream worked together --score 4`. A threshold in words works too ("scores > 3").

The CLI equivalent is `casebook discover` (add `--dry-run` to see the chains without any model call), then `casebook discover pick <discovery-id> <n>`.

## Configuration

`~/.casebook/<profile>/config.json`. Any key you leave out keeps its default:

```json
{
  "defaultPolicy": "anonymize",
  "projects": [
    { "match": "github.com/your-handle/*", "policy": "public" },
    { "match": "*/client-acme/*", "policy": "skip" }
  ],
  "scout": { "model": "haiku", "minTurns": 4, "keepMinScore": 2, "maxTopics": 3, "maxChars": 60000, "timeoutSec": 240, "command": "claude" },
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
