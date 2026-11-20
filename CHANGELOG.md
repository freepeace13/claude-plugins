# Changelog

## Unreleased
- casebook 0.3.0: `/casebook:discovery` is now the only way logs are made. The scout is gone: no SessionEnd hook, no startup sweep, no `/casebook:scout`, `casebook scout`, `backfill` or `maintenance`. Casebook spends model calls only when you run a discovery; the SessionStart hook only links the CLI
- casebook: the write feature is gone (`/casebook:write`, the `case-study-writer` agent, case-study paths from `out-path`). Casebook ends at `/casebook:handoff`; `out-path` always names a handoff folder
- casebook: written-up tracking is gone (`casebook written`, the WRT column, `--written`/`--unwritten` on `list` and `delete`). Old `written_to` fields stay in logs as they were, and a merge keeps the first log it names
- casebook: partial logs are gone, since nothing finishes them any more. An update drops `partial`, `partial_sessions`, `scouted_at` and `scout_mode`; logs now get `scanned_at`
- casebook: config `scout` is renamed `scan` (an old `scout` section is still read); `sweep`, `output` and `keepMinScore` are dropped. A pending `/casebook:mark` waits for the next discovery pick of its session; the transcript fallback for marks and `mark --generated` are gone
- casebook: topics get a `description` (1–2 plain sentences naming the work, kept on the log and on deleted topics). Duplicates are matched by the same angle and a similar title or description; the model sees the descriptions of existing logs and deleted topics. When two or more topics are left, one more model call groups retellings across chains and keeps one per story (a topic that updates a log is never dropped)
- casebook: one discovery never offers or logs the same new topic twice; a pick of a twin reports the log an earlier pick made. Topics of different projects are never duplicates. An update keeps the log's first `profile`
- casebook: one store for every profile at `~/.casebook/` (`CASEBOOK_HOME` overrides it) instead of `~/.casebook/<profile>/`. A scan still runs, and is billed, as the profile `claude` ran under, and transcripts are still read from that profile only. Logs keep their `profile` frontmatter
- casebook: the first run after upgrading (any command, or the next Claude Code startup) merges old per-profile stores into the shared one: logs, marks, ledgers and discoveries, and the `default` config with every other profile's privacy settings folded in (the strictest default policy; their project rules, stricter ones first). A session in two stores keeps the marks and deleted topics of both. Case studies and handoffs stay in place. Nothing is overwritten
- Breaking: `casebook profiles`, the global `--profile` flag and `CASEBOOK_PROFILE` are gone; `list` no longer prints a `[profile: …]` line. To discover in another profile's sessions from a terminal, set `CLAUDE_CONFIG_DIR`. A set `CASEBOOK_ROOT` is now the one store (its profile stores merge into it). Removed flags (`--written`, `--unwritten`, `--pending`, `--generated`) fail instead of being ignored
- casebook: a discovery rewrites a log from exactly the same sessions only when they have new turns or marks since its last scan; the duplicate check gets a 90s timeout of its own
- casebook 0.2.1: at every startup the SessionStart hook symlinks `~/.local/bin/casebook` to the installed plugin, so `casebook` runs from any terminal; `casebook link [--json]` does it on demand; `CASEBOOK_BIN_DIR` moves the link or turns it `off`
- porch 0.3.1: a new SessionStart hook symlinks `~/.local/bin/porch` the same way; `porch link [--json]`; `PORCH_BIN_DIR`
- porch: the CLI's logic moves into `lib/` (`store`, `intake`, `legacy`, `link`, `util`), the same layout as casebook; `bin/porch` only parses arguments and prints
- porch 0.3.0: `/porch:voice [--from <file>]` asks 16 multiple-choice questions (each option previews a passage in that style) on rhythm, presence, delivery and audience, approves a sample paragraph and writes `$PORCH_HOME/voice.md`; reruns can redo one area, keeping the previous file as `voice.md.bak` (a replaced hand-written file as `voice.handwritten.md`, never overwritten)
- porch: `$PORCH_HOME/voice.md` now extends the base voice instead of replacing it. `references/voice.md` splits into Fixed rules (always apply) and Defaults (your voice overrides them); briefs name the base as `voice` and your file as `voice_user`

## casebook 0.2.0 — 2026-11-20
- Logs are topics, not sessions: one scan returns up to `scout.maxTopics` (3) topics, each with an `angle`; a log lists the `sessions` it draws on (with `session_turns`)
- Every log is unique in its profile: each scan sees the logs near its sessions and either updates the one a topic matches (`same_as`) or creates a new one; duplicates merge, keeping a written-up log's ID (`merged_from`)
- Sessions can be scanned again at any time for other angles; a deleted log's topic never comes back (`--force` lifts that), and a session left with no logs is no longer scanned automatically
- `/casebook:mark` on a session with several logs waits for the next scan, which gives the mark to the topic it points to
- `/casebook:discovery [note] [--score N] [--tags a,b]`: links sessions that carry one piece of work (same pull request, feature branch, handoff file, continued opening, shared files), scans each chain for topics, ranks the best 3 and logs the one you pick
- `casebook discover [--dry-run]` and `casebook discover pick <discovery-id> <n>`; a pick refuses a log changed since the discovery ran
- A merged log's old ID still works in `show`, `mark`, `unmark`, `written` and the skills (it points to the surviving log); `delete` takes exact IDs only
- `/casebook:handoff <id…>` checks logs against `handoff.md` and writes a handoff folder (`handoff.md` + `logs/`) for a writer; `casebook out-path --handoff` names the folder
- `out-path` names files and folders with the local date instead of the UTC date

## porch 0.2.0 — 2026-11-19
- One store for all work: `$PORCH_HOME` (default `~/.porch`), so the plugin works from any folder; replaces per-project `.porch/<slug>/`
- `/porch:brief <path> <article|case-study> [note]` checks the intake first (subject, first-hand part, 3+ concrete facts, point; see `references/intake.md`), then copies it into `<store>/{articles|case-studies}/<uuid>/` and writes `brief.md`; a thin intake creates nothing
- `/porch:draft <id>` and `/porch:push <id>` now take a work id
- `porch` CLI: `init`, `list`, `read`, `set`, `delete`, `home`; each work folder keeps its state (title, slug, tags, status, timestamps) in `state.json`
- Voice override moves to `$PORCH_HOME/voice.md`
- Breaking: `<project>/.porch/<slug>/` is no longer read; `porch import` brings those folders into the store (approved drafts stay pushable; the rest are briefed again with `/porch:brief <id>`)

## casebook 0.1.0 — 2026-11-16
- SessionEnd scout with Haiku, per-project privacy policies (public / anonymize / skip)
- `/casebook:mark`, `list` (with `--marked`), `show`, `write`, `delete` (by ID or batch)
- SessionStart sweep for missed sessions
- `case-study-writer` agent producing Markdown with stable frontmatter
- One fully separate store per Claude config directory (`~/.casebook/<profile>/`), `casebook profiles`, global `--profile`; the scout always runs as the session's own profile
- `/casebook:scout`: scout the current session now (marked `partial` until the session ends), another session, or `--pending` missed ones
- Logs gain `profile`, `partial`, `scouted_at` and `scout_mode` frontmatter; `list` shows `4…` for partial logs
