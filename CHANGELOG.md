# Changelog

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
