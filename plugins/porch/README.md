# Porch

Turns a notes file, folder or finished draft into a reviewed article or case study and saves it to [Porch](https://kinbasco.dev) as a **draft** through Porch's MCP server. You publish it in the Porch admin; the plugin never does.

```text
/plugin install porch@kinbasco-plugins
/porch:voice
/porch:brief notes/queue-backoff.md article "focus on the retry storm, skip the Redis tuning"
/porch:draft 1a2b3c4d
/porch:push 1a2b3c4d
```

- `/porch:voice [--from <file>]` captures how you write. It asks 16 multiple-choice questions in 4 rounds, and every option previews one topic written in that style. It then writes a sample paragraph for you to approve and saves `$PORCH_HOME/voice.md` (see [Your voice](#your-voice)).
- `/porch:brief <path> <article | case-study> [note]` first checks that the intake carries one topic (a concrete subject, a first-hand part, at least 3 concrete facts, a point; see [references/intake.md](references/intake.md)). It asks at most 3 questions and checks Porch for duplicates. Only then does it copy the file or folder into a new work folder and write `brief.md`. A thin intake creates nothing and tells you what to add.
- `/porch:draft <id>` runs the writer agent on a ready brief and reviews the draft against it (2 revision rounds, then it hands back to you).
- `/porch:push <id>` refuses unless the draft is approved and has no `<!-- verify` markers, then creates or updates the Porch draft.
- A `PreToolUse` hook blocks any `status: "published"` or `is_published: true` call to Porch.

Text only: no images in or out. Tags, covers and featuring stay admin steps; the work folder suggests tags.

## Your voice

[references/voice.md](references/voice.md) is the base voice. Its **Fixed** rules always apply: first person, no invented facts or numbers, and verify markers for anything unknown. Its **Defaults** (short sentences, no hype, no emoji, no closing summary, and so on) apply unless your voice says otherwise. `$PORCH_HOME/voice.md` extends it: where one of your rules covers the same thing as a Default, your rule wins.

`/porch:voice` builds that file from 16 questions. Each one turns a speaking trait into a writing trait:

| Area | Questions |
|---|---|
| Vocal characteristics → Rhythm | sentence length, pauses, pace, confidence, word choice |
| Body language and stage presence → Presence | addressing the reader, openness about mistakes, emoji, feeling |
| Content and delivery → Delivery | layout, how ideas come in, formality, formatting, endings |
| Audience → Audience | how much background the brief's reader gets, how failures are told |

Each answer writes a set rule from [references/voice-questions.md](references/voice-questions.md), so the same answers give the same rules, unless you settle a clash between two of them during the run (the sample paragraph and the date change on each run). A rule never asks for content the brief lacks, and the brief's reader, outline and length always win. "Other" turns your own words into the rule. `--from <file>` reads a piece you wrote and marks the option it matches as "(Recommended)" on each question where the evidence is clear. Run it again to redo everything or one area. The previous file is kept as `voice.md.bak`, and a hand-written one you replace as `voice.handwritten.md` (or `voice.handwritten-2.md` and so on), which no run ever replaces. Add rules of your own to a generated file under `## My additions`: reruns keep that section word for word and rebuild the rest. If you keep a hand-written file, add `extends: base` to its frontmatter to stop `/porch:brief` reminding you that the base Defaults now apply. A hand-written `voice.md` works too, since it also extends the base voice.

## The store

Everything lives in one store, so the plugin works from any folder you start Claude Code in.

```text
$PORCH_HOME                 default ~/.porch
├── voice.md                optional: your voice, from /porch:voice; extends the base voice
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
porch set <id> key=value…      title, topic, slug, tags, status, kind, draft_source, note, porch_id
porch delete <id>… [--yes]     dry run without --yes
porch home
```

An id may be any unique prefix of 4 or more characters. `init` copies real files and folders only. It skips `.git`, `node_modules`, symlinks, the store itself and anything it cannot read (it lists those). It stops as soon as an intake passes 2000 files or 25 MB unless you pass `--force`. A failed `init` leaves nothing in the store, and only a new store gets mode 0700.

The writer agent writes `draft.md` in the store, outside your project, so Claude Code may ask before the first write. Allow `Write(~/.porch/**)` to skip the prompt, and `Edit(~/.porch/**)` for `/porch:draft`, which updates an older brief's paths before writing.

## Upgrading from 0.2.0

A hand-written `$PORCH_HOME/voice.md` used to replace the base voice. It now extends it, so the base Defaults (short sentences, no emoji, no hedging, no closing summary) apply on every point your file does not cover. Add a rule for each one you want changed (for example "Long, flowing sentences are fine"), or run `/porch:voice`. `/porch:draft` points older briefs at the current plugin folder and at your voice file before writing.

## Upgrading from 0.1.0

0.1.0 kept work in `<project>/.porch/<slug>/`. Those folders are no longer read. Import them from each project:

```text
porch import .porch/*/
```

Each folder becomes a work folder holding its `brief.md`, `draft.md` and `review.md`. An approved draft keeps status `approved` and can be pushed with `/porch:push <id>`. Anything else comes in as `new`, with the old files as its intake. Brief it again with `/porch:brief <id>`, which runs the intake check on them. A project's `.porch/voice.md` is not used any more; `import` tells you to copy it to `$PORCH_HOME/voice.md`.

The MCP URL is in `.mcp.json`; edit it to point at a local Porch.
