# Changelog

## casebook 0.1.0 — 2026-11-16
- SessionEnd scout with Haiku, per-project privacy policies (public / anonymize / skip)
- `/casebook:mark`, `list` (with `--marked`), `show`, `write`, `delete` (by ID or batch)
- SessionStart sweep for missed sessions
- `case-study-writer` agent producing Markdown with stable frontmatter
- One fully separate store per Claude config directory (`~/.casebook/<profile>/`), `casebook profiles`, global `--profile`; the scout always runs as the session's own profile
- `/casebook:scout`: scout the current session now (marked `partial` until the session ends), another session, or `--pending` missed ones
- Logs gain `profile`, `partial`, `scouted_at` and `scout_mode` frontmatter; `list` shows `4…` for partial logs
