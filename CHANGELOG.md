# Changelog

## Unreleased
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
