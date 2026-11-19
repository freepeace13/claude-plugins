# Porch

Turns a notes file, folder or finished draft into a reviewed article or case study and saves it to [Porch](https://kinbasco.dev) as a **draft** through Porch's MCP server. You publish it in the Porch admin; the plugin never does.

```text
/plugin install porch@kinbasco-plugins
/porch:brief notes/queue-backoff.md article "focus on the retry storm, skip the Redis tuning"
/porch:draft 1a2b3c4d
/porch:push 1a2b3c4d
```

- `/porch:brief <path> <article | case-study> [note]` first checks that the intake carries one topic (a concrete subject, a first-hand part, at least 3 concrete facts, a point; see [references/intake.md](references/intake.md)). It asks at most 3 questions and checks Porch for duplicates. Only then does it copy the file or folder into a new work folder and write `brief.md`. A thin intake creates nothing and tells you what to add.
- `/porch:draft <id>` runs the writer agent on a ready brief and reviews the draft against it (2 revision rounds, then it hands back to you).
- `/porch:push <id>` refuses unless the draft is approved and has no `<!-- verify` markers, then creates or updates the Porch draft.
- A `PreToolUse` hook blocks any `status: "published"` or `is_published: true` call to Porch.

Text only: no images in or out. Tags, covers and featuring stay admin steps; the work folder suggests tags.

## The store

Everything lives in one store, so the plugin works from any folder you start Claude Code in.

```text
$PORCH_HOME                 default ~/.porch
├── voice.md                optional: your voice rules, replacing the default
├── articles/<uuid>/
└── case-studies/<uuid>/
    ├── state.json          id, type, status, title, topic, slug, tags, note, source, porch_id, timestamps
    ├── intake/<name>       copy of the file or folder you gave /porch:brief
    ├── brief.md
    ├── draft.md
    └── review.md
```

Status moves `new → briefed → drafting → approved → pushed` (or `escalated` when review gives up).

To move the store, set `PORCH_HOME` to an absolute path (or one starting with `~/`), for example in `~/.claude/settings.json`:

```json
{ "env": { "PORCH_HOME": "~/Documents/porch" } }
```

## The `porch` command

On your `PATH` inside Claude Code while the plugin is enabled; outside it, run `plugins/porch/bin/porch`. The skills use it for every change to the store, so you and the agent see the same thing.

```text
porch init <path> --type article|case-study --topic text [--note text] [--force] [--json]
porch import <project>/.porch/<slug>… [--json]
porch list [--type t] [--status s[,s…]] [--tag x] [--json]
porch read <id> [brief|draft|review|state] [--path] [--json]
porch set <id> key=value…      title, topic, slug, tags, status, kind, note, porch_id
porch delete <id>… [--yes]     dry run without --yes
porch home
```

An id may be any unique prefix of 4 or more characters. `init` copies real files only: it skips `.git`, `node_modules`, symlinks and the store itself, and refuses intakes over 2000 files or 25 MB unless you pass `--force`. A failed `init` leaves nothing in the store.

The writer agent writes `draft.md` in the store, outside your project, so Claude Code may ask before the first write. Allow `Write(~/.porch/**)` to skip the prompt.

## Upgrading from 0.1.0

0.1.0 kept work in `<project>/.porch/<slug>/`. Those folders are no longer read. Import them from each project:

```text
porch import .porch/*/
```

Each folder becomes a work folder holding its `brief.md`, `draft.md` and `review.md`. An approved draft keeps status `approved` and can be pushed with `/porch:push <id>`. Anything else comes in as `new`. Its brief has no intake check, so start it again with `/porch:brief`. A project's `.porch/voice.md` is not used any more; `import` tells you to copy it to `$PORCH_HOME/voice.md`.

The MCP URL is in `.mcp.json`; edit it to point at a local Porch.
