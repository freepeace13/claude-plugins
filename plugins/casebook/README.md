# Casebook

Casebook finds the case studies hiding in your Claude Code sessions and hands them off to whoever writes them up. Install it once and it works in every project.

- **Finds topics on demand.** `/casebook:discovery` reads your recent sessions, links the ones that carry one piece of work (a resumed branch, a handoff file, one pull request), and has a cheap headless model (Haiku by default) pull out their potential case studies. It ranks the best 3 and logs the one you pick as a structured log, scored from 1 to 5.
- **Lets you flag the good ones.** Run `/casebook:mark "the queue redesign"` at the moment it matters. The next discovery that covers that session focuses on what you marked.
- **Logs topics, not sessions.** A session can feed several logs, and a log can draw on several sessions. Every scan sees the logs already near it, so a topic is updated rather than logged twice: each log is unique.
- **Lists them per project** with IDs, scores and marks. `--marked` shows only what you flagged.
- **Hands off, doesn't write.** `/casebook:handoff cb-7k2m9q cb-p3x8aa` checks the logs against `handoff.md` and writes a handoff folder with the facts, their sources and the open questions. Writing the piece is up to you or your own tools.
- **Cleans up.** You can delete one log, or delete a filtered batch.
- **Privacy first.** Each project is `public`, `anonymize` (the default) or `skip`. Under `anonymize`, client and company names never reach the notes or the handoff.

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
| `/casebook:discovery [note] [--score N] [--tags a,b] [--all \| --project P] [--since 90d] [--force]` | Find topics in your sessions, rank the best 3 and log the one you pick. See Discovery. |
| `/casebook:mark [note]` | Mark the current session. With no note, Claude writes a one-line note itself. |
| `/casebook:mark <id> [note]` | Mark an existing log. |
| `/casebook:list [--marked] [--all \| --project P] [--min-score N] [--since 30d]` | List logs. Defaults to the current repository's project. |
| `/casebook:show <id>` | Read one log. |
| `/casebook:handoff <id…> [--out dir] [instructions]` | Gather and check what a writer needs from the logs against `handoff.md`, asking at most 3 questions. Writes a handoff folder: `handoff.md` (checks, facts with sources, unknowns) and `logs/`. Writes nothing when the logs are too thin. |
| `/casebook:delete <id…>` | Delete specific logs. |
| `/casebook:delete --below-score 3 --older-than 30d --unmarked` | Delete a batch. It runs as a dry run first and asks before deleting. |

The same commands work from any shell through the `casebook` CLI. Inside Claude Code the plugin's `bin/` is on PATH. For your terminal, the plugin symlinks `~/.local/bin/casebook` to itself at every Claude Code startup, so the link follows updates; make sure `~/.local/bin` is on your PATH. An existing link to an older casebook (or a broken one) is replaced; a regular file, a link to anything else, or a link to an equal or newer casebook is left alone. Run `casebook link` to do it now. Set `CASEBOOK_BIN_DIR` to link into another folder, or to `off` to stop linking. Uninstalling the plugin does not remove the link. Run `casebook help` for the full list, including `doctor`.

```text
$ casebook list --marked
porch  (github.com/freepeace13/porch)  ·  14 logs, 3 marked
ID         DATE        SCORE MRK TITLE
cb-7k2m9q  2026-11-16  4     📌  Fixed websocket reconnect storms with jittered backoff
cb-p3x8aa  2026-11-12  5     📌  Magic-link chat resume without visitor accounts
```

## How it works

```text
/casebook:discovery ─► read and link sessions ─► claude -p --model haiku --tools "" --no-session-persistence
                         (no model call)            one call per candidate chain, side by side
                                                    │  condensed transcripts + commits + marks + existing logs + policy
                                                    ▼
                                      ranked topics ─► you pick one ─► ~/.casebook/logs/<project>/<id>.md
```

- **Nothing runs in the background.** Casebook spends model calls only when you run a discovery. Its one hook, at startup, links the `casebook` CLI (and, once after upgrading from 0.2, merges the old per-profile stores; see Profiles) and never prints anything.
- **No recursion.** A scan runs with `CASEBOOK_SCAN=1`, `--restricted` (no user settings, so no plugins) and `--no-session-persistence` (no transcript of its own).
- **Deleted topics stay deleted.** No later discovery logs them again, unless you pass `--force`.
- **Cost.** At most 5 candidates are scanned per discovery (`--candidates`), plus one call to check the topics found for duplicates when there are two or more. A single session with fewer than `scan.minTurns` user turns is not a candidate, unless it has a pending mark (one no scan has seen yet also ranks it higher). Casebook's own commands, and what they print, are not read as a session's work. Transcripts are condensed (tool output dropped, the middle elided past `scan.maxChars`) before each Haiku call.

## Storage

```text
~/.casebook/                    (override with CASEBOOK_HOME; a pre-0.3 CASEBOOK_ROOT is used too); one store for every profile
  config.json
  logs/<project>/cb-xxxxxx.md   one log per topic (frontmatter + notes)
  handoffs/<project>/YYYY-MM-DD-<slug>/         /casebook:handoff output (handoff.md + logs/)
  marks/                        pending marks, waiting for a discovery of their session
  state/                        per-session ledger (deleted topics), discoveries (kept 7 days)
  casebook.log                  errors (see `casebook doctor`)
```

Projects are named after the git remote's repository name. Without a remote, the folder name is used. A repository can override the name and policy with a committed or ignored `.casebook.json`:

```json
{ "project": "client-portal", "policy": "anonymize" }
```

Casebook keeps its data in `~/.casebook/` rather than the plugin directory, on purpose: logs are shared by every Claude config directory and must survive plugin updates and reinstalls. Uninstalling the plugin does **not** delete them. Remove `~/.casebook/` yourself if you want them gone.

## Profiles

If you run Claude Code under more than one config directory (for example `CLAUDE_CONFIG_DIR=~/.claude_personal` next to the default `~/.claude`), every one of them uses the same store: one config, one set of logs, one list. Each log records the profile it came from in its `profile` frontmatter.

| Config dir | Profile |
|---|---|
| `~/.claude` (or `CLAUDE_CONFIG_DIR` unset) | `default` |
| `~/.claude_<x>` or `~/.claude-<x>` | `<x>` |
| anything else | its folder name without leading dots |

- **A scan runs as the profile `claude` ran under**, so it is billed to that account. Skills use the `CLAUDE_CONFIG_DIR` that Claude Code passes them; the terminal uses yours (`default` when it is unset). There is no setting to change this.
- Discovery reads only that profile's `projects/` folder. To discover in another profile's sessions from a terminal, run with its config dir: `CLAUDE_CONFIG_DIR=~/.claude_personal casebook discover`.
- **Upgrading from per-profile stores.** Casebook used to keep one store per profile (`~/.casebook/<profile>/`). The first run after upgrading moves their logs, marks, session ledgers and discoveries into `~/.casebook/`. The `default` profile's config is the base (or the first other one if there is none), and every other profile's privacy settings are folded in: the strictest `defaultPolicy` wins, and their project rules are added. Each pattern keeps the strictest policy any profile gave it, and the rules are ordered `skip`, `anonymize`, `public`, so no merged rule can loosen another (a `public` exception under a broader stricter rule stops applying; move it back up by hand if you want it). Other profiles' scan settings are not used; `casebook.log` says when one differed. A session found in two stores keeps the pending marks and deleted topics of both. Case studies and handoffs stay where they were. A merged store keeps its leftovers with `profile.migrated.json` in place of `profile.json` (and `config.migrated.json`), and each merge is noted in `casebook.log`. Nothing already in the shared store is overwritten.

## Topics

A log is one topic, not one session.

- **A session can feed several logs.** A scan returns up to `scan.maxTopics` topics, each a story that stands on its own: the debugging hunt, and the architecture decision it led to, are two logs with different `angle`s.
- **A log can draw on several sessions.** Its frontmatter lists them in `sessions`, with `session_turns` per session. `session_id` is the first of them.
- **Every topic has a `description`**: 1–2 plain sentences naming the work itself (the part of the system, the problem, the change), worded so the same work gets nearly the same description whatever its title. Duplicates are found by what the work is, not only by how it is titled. Logs from before descriptions are compared by their summary.
- **Every log is unique.** A scan is shown the logs that already draw on its sessions, plus the project's logs from the 14 days around it (each with its description), and the topics you deleted (with theirs). For each topic it finds, the model either names the existing log it is the same as (`same_as`), which is then updated with the notes rewritten to cover both, or calls it new. A topic with the same angle and a similar title or description as a log of its own sessions updates that log. When a topic matches several logs, they were duplicates: they merge into the first one, and the others are listed in `merged_from`, so their IDs keep working.
- **Re-scanning is always allowed.** A discovery reads sessions that are already logged, to pull out another angle. It rewrites a log from exactly the same sessions only when they have news for it: turns added since its last scan, or pending session marks the scan places on it. (A mark of a log by ID is part of the log already; a handoff reads it.)
- **Marks.** `/casebook:mark` on a session with one log marks that log. Otherwise the mark waits, and the discovery pick that covers its session gives it to the topic it points to.
- **Deleting** a log remembers its topic (title, angle and description) for each of its sessions, so no discovery brings it back under another title (`--force` lifts that).

## Discovery

`/casebook:discovery` is how logs are made. It looks across sessions, so work carried over several of them becomes one log:

1. **Collect.** It reads every transcript of this profile from the last 90 days (`--since`), this session's too as far as it has gone, in the current project (`--all` or `--project P` to widen it). Skipped projects stay out. Sessions that are already logged stay in: a new scan can find another angle.
2. **Link.** Sessions of one project are linked when the later one continues the earlier one, within 14 days:
   - the same pull request,
   - the same feature branch (not `main`, `master`, `develop` and the like),
   - a handoff: the later session opens by naming a file the earlier one wrote, or reads a Markdown file it wrote,
   - a "continue where we left off" opening right after a session that edited the same files,
   - or most of the same files edited within 3 days.

   A chain holds at most 6 sessions.
3. **Shortlist.** With `--tags`, a chain must mention at least one tag. Chains are ranked without a model call (existing log scores, linked chains first, how well they match the note and tags) and the top 5 go on.
4. **Scan.** Each candidate is one headless model call, side by side, with the merged transcripts as chapters of one story and the existing logs (see Topics). It returns up to `scan.maxTopics` topics, each with a score, how well it fits the note and tags, which of the sessions it draws on, and which existing logs it is the same as.
5. **Rank.** Topics already logged with exactly those sessions are dropped (unless the sessions have new turns or pending marks for it), and so are deleted topics, topics below `--score`, and, with a note or tags, topics that don't fit. A log is updated by one topic only, and a new topic with the same angle and a similar title or description as a better one is dropped.
6. **Check for retellings.** Each chain was scanned on its own, so when two or more topics are left, one more model call compares their titles, angles, descriptions and summaries and groups the ones that tell the same story. In each group, the best topic that updates a log stays (else the best one), and the other new topics go. A topic that updates a log is never dropped. If the call fails, the topics are offered unchecked and `casebook.log` says so.
7. **Pick.** The best 3 are shown, highest score first, each marked `new log`, `updates <id>` or `merges <ids>`, and you pick one. A new topic that retells what an earlier pick of the same discovery logged reports that log instead of logging it again.
8. **Log.** The chosen topic becomes a new log, or updates (and merges) the logs it matches. Your note is kept as `discovery_note`.

The note can name a topic or give rules: `/casebook:discovery look for websocket + redis stream worked together --score 4`. A threshold in words works too ("scores > 3").

The CLI equivalent is `casebook discover` (add `--dry-run` to see the chains without any model call), then `casebook discover pick <discovery-id> <n>`.

## Configuration

`~/.casebook/config.json`. Any key you leave out keeps its default:

```json
{
  "defaultPolicy": "anonymize",
  "projects": [
    { "match": "github.com/your-handle/*", "policy": "public" },
    { "match": "*/client-acme/*", "policy": "skip" }
  ],
  "scan": { "model": "haiku", "minTurns": 4, "maxTopics": 3, "maxChars": 60000, "timeoutSec": 240, "command": "claude" }
}
```

A config from before 0.3 keeps working: its `scout` settings are read as `scan`. `sweep`, `output` and `scout.keepMinScore` are ignored.

`match` is a glob checked against the normalized remote (`github.com/owner/repo`), the repository path and the project name. The first match wins.

## License

MIT
