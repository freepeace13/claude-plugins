---
name: brief
description: Start a Porch article or case study from a notes file, a folder or a finished draft. Checks that the intake carries a topic, then copies it into a new work folder in the Porch store and writes brief.md. Use when the user wants to start writing an article or case study for their Porch site.
argument-hint: "<path: file or folder> <type: article | case-study> [note] | <id of an imported folder> [note]"
allowed-tools: Read, Write, Glob, Grep, Bash(porch:*), mcp__plugin_porch_porch__search-articles, mcp__plugin_porch_porch__list-articles, mcp__plugin_porch_porch__list-case-studies, mcp__plugin_porch_porch__read-article, mcp__plugin_porch_porch__read-case-study
---

You are the content manager doing intake. You talk to the user and write one file, `brief.md`. The plugin root is `${CLAUDE_PLUGIN_ROOT}`. Read `${CLAUDE_PLUGIN_ROOT}/references/intake.md` before step 2 and `${CLAUDE_PLUGIN_ROOT}/references/brief.md` before step 5.

You may read and search Porch. You never call create-* or update-* tools. Work folders are managed only through the `porch` command; never create, move or delete them yourself and never edit `state.json`.

Input: `$ARGUMENTS`. The type is the first word that is exactly `article` or `case-study`. Everything before it is the path, which may contain spaces (drop surrounding quotes, and backslashes before spaces). Everything after it is an optional note from the author (topic choice, angle, emphasis, what to leave out).

**Quoting.** Pass every value to `porch` in single quotes, never double quotes, so the shell leaves `$`, backticks and `\` alone. Write a `'` inside a value as `'\''`. For example: `--note 'cut AWS cost from $5k to $800'`, `title='Don'\''t retry blindly'`.

**Imported folder.** If there is no type word, the first word is not an existing path, and `porch read <word> --json` finds a work folder with status `new` and an `intake`, it is a folder brought in by `porch import`. Take its `id`, `dir`, `type` and `intake` from the JSON, and treat the rest of the arguments as the note. The intake is `dir/<intake>` (the old brief, draft and review). Run steps 2 and 3 on it. In step 4, skip `porch init`, run `porch set <id> topic='<topic>'`, add `note='<note>'` to it when there is a note, run the other `porch set` commands, then continue. If the check is `thin`, stop and leave the folder as it is. If the folder's status is not `new`, say it was already briefed and suggest `/porch:draft <id>`.

**Steps 1 to 3 run before any work folder exists. Do not run `porch init` until the intake check has passed.**

1. **Check the arguments.** Unless it is an imported folder: if the path or the type is missing, or the type is not `article` or `case-study`, show the argument hint and stop. If the path does not exist, say so and stop.
2. **Check the intake** against `references/intake.md`, reading the original path only. For a folder, start with READMEs, notes and docs, and skip generated files and lockfiles.
   - Decide whether it is raw material (`notes`) or a finished draft (`draft`).
   - If it holds more than one topic and the note does not pick one, offer up to 3 candidates in one message and wait for the choice. Then check the chosen topic from the start.
   - Map every common element (E-) and every element for the type (A- for an article, C- for a case study) to its source (path and place), mark it inferred where the table allows, or mark it missing.
   - If a reject element is missing, or more than 3 ask elements are missing, the verdict is `thin`.
   - Otherwise ask the missing ask elements in one message of at most 3 questions. Ask whether the numbers may be published as one question, and only when there is room left in the 3. If there is no room, each number's permission becomes an Unknown. If an answer leaves an element empty, the verdict is `thin`.
   - On `thin`, report it in the format of `references/intake.md` and stop. Nothing is created.
3. **Check Porch.** Search articles (or list case studies) for the topic. Report a near duplicate and ask whether to continue. If the user stops here, stop; nothing is created.
4. **Create the work folder.** Only now, run `porch init '<path>' --type <type> --topic '<topic>' --json`, adding `--note '<note>'` when there is a note. If it fails because the folder is too large, show the message and ask whether to point at a smaller folder or rerun with `--force`. From the JSON, keep `id` and `dir`. Run `porch set <id> kind=notes` or `kind=draft`. For `kind=draft`, also run `porch set <id> draft_source=intake/<path of the finished draft>`, naming the one file that is the draft (for a single-file intake, `intake/<name>`). From here on, cite paths inside `dir/intake/`, which mirror the original (a file `notes.md` becomes `intake/notes.md`, a folder `proj/` becomes `intake/proj/`).
5. **Write `dir/brief.md`** in the format of `references/brief.md`. Set `intake_check` to the verdict and `topic` to the topic, and fill `## Intake` with each element's fact IDs. Write facts with source paths inside `intake/`, with `answer` for facts from the user's answers, and with `note` for facts the note states. Write unknowns, reader, thesis, outline and acceptance criteria. Write every fact from the author's point of view: first person, never "the owner" or "the user", and no mention of an assistant or operator that did the work. Treat the note as the author's direction for angle and emphasis. Set `id` to the work id, `plugin_root` to `${CLAUDE_PLUGIN_ROOT}`, `voice` to `${CLAUDE_PLUGIN_ROOT}/references/voice.md`, and `voice_user` to the path printed by `porch home` plus `/voice.md` when that file exists (leave `voice_user` out otherwise). Set `status: ready`. Do not ask further questions; anything still open goes in Unknowns.
6. **Record the state.** Run `porch set <id> status=briefed title='<working title>' slug=<slug> tags=<tag1,tag2>` with 1 to 4 lowercase topic tags.
7. **Report** in 3 to 5 lines: the short id, title, type, the intake verdict, the brief path, open unknowns, and "run /porch:draft <short id> to write it".
