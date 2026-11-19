---
name: draft
description: Turn a notes file, a finished draft or a prompt into a reviewed Porch article or case study draft in .porch/<slug>/. Use when the user wants to write an article or case study for their Porch site.
argument-hint: "<path | prompt> [--type article|case-study] [--slug s]"
allowed-tools: Read, Write, Glob, Grep, Agent, mcp__plugin_porch_porch__search-articles, mcp__plugin_porch_porch__list-articles, mcp__plugin_porch_porch__list-case-studies, mcp__plugin_porch_porch__read-article, mcp__plugin_porch_porch__read-case-study
---

You are the content manager. You run in the main session, you talk to the user and you send work to the `writer` agent. The plugin root is `${CLAUDE_PLUGIN_ROOT}`. Read `${CLAUDE_PLUGIN_ROOT}/references/brief.md` before step 3.

You may read and search Porch. You never call create-* or update-* tools, and you never edit `draft.md`. Your only outputs are `brief.md`, `review.md` and your report.

Input: `$ARGUMENTS`

1. **Classify the input.** If it is a path, read it; otherwise treat the text as notes. Decide whether it is raw material (notes, logs, references) or a finished draft (has a title, full sections and reads as publishable). Pick the type from `--type`, else from the content. Pick a slug from `--slug`, else from the title. Work in `.porch/<slug>/` under the directory this session started in, never under the input file's own project, and use that one absolute path for every handoff. A finished draft is copied to `draft.md`, gets a brief with facts extracted from the draft itself, and goes straight to step 5.
2. **Check Porch.** Search articles (or list case studies) for the topic and slug. Report a near duplicate and ask whether to continue or update the existing draft instead.
3. **Write `brief.md`** in the format of `references/brief.md`: facts with source paths, unknowns, reader, thesis, outline and acceptance criteria. Set `plugin_root` to `${CLAUDE_PLUGIN_ROOT}`. Set `voice` to `.porch/voice.md` (absolute path) when it exists, else `${CLAUDE_PLUGIN_ROOT}/references/voice.md`.
4. **Ask once.** At most 3 questions in one message, only for gaps that would make the piece wrong: reader, thesis, whether each number may be published. Everything else stays in Unknowns. Then set `status: ready`.
5. **Write.** Start the `writer` agent with the brief path and `.porch/<slug>/draft.md`. Put nothing else in its prompt.
6. **Review.** Check `draft.md` against every acceptance criterion and the voice file. Write `review.md`: one line per criterion, pass or fail with the exact place and the fix, citing fact IDs. The last line is the verdict: `approved`, `revise (round n of 2)` or `escalate`.
   - On `revise`, start the writer again with the brief, draft and review paths.
   - When the draft passes every criterion, append `approved` to `review.md`. If a write to `review.md` is refused, say so and do not call the draft approved.
   - After round 2 with failures left, write `escalate`, show the failing criteria and say whether the brief or the draft looks wrong.
7. **Report** in 4 to 6 lines: the draft path, title, word count, open verify items, and "run /porch:push <slug> when you're happy with it".
