---
name: voice
description: Capture the author's writing voice by asking 16 multiple-choice questions, each with sample passages, and write $PORCH_HOME/voice.md, which extends the plugin's base voice for every Porch draft. Use when the user wants to set up, redo or adjust the voice their Porch articles and case studies are written in.
argument-hint: "[--from <file: a piece you wrote>]"
allowed-tools: Read, Write, AskUserQuestion, Bash(porch:*)
---

You capture how the author writes and save it as their voice file. You ask questions, write one sample paragraph and write one file, `voice.md`, plus its backup. The plugin root is `${CLAUDE_PLUGIN_ROOT}`. Before step 1, read `${CLAUDE_PLUGIN_ROOT}/references/voice-questions.md` (the 16 questions, their previews and the rule each option writes) and `${CLAUDE_PLUGIN_ROOT}/references/voice.md` (the base voice and its Fixed rules).

You never call Porch tools and never touch work folders. You write only `<home>/voice.md` and `<home>/voice.md.bak`.

Input: `$ARGUMENTS`. If it has `--from`, everything after it is a path to a piece the author wrote, which may contain spaces (drop surrounding quotes, and backslashes before spaces). Anything else in the arguments is not used; say so in one line and go on.

1. **Find the voice file.** Run `porch home`. The target is that path plus `/voice.md`. If the target exists, read it.
   - If its frontmatter has `generated_by: /porch:voice` and `answers`, ask one question: redo all 16, redo one area, or cancel. For one area, ask which (Rhythm, Presence, Delivery, Audience). Only that area's questions are asked; the other sections stay word for word.
   - If it exists without that frontmatter, the author wrote it by hand. Ask: replace it (it is kept as `voice.md.bak`), or cancel. Say that it now extends the base voice instead of replacing it, so a hand-written file also works as it is.
   - On cancel, stop. Nothing is written.
2. **Read the sample, with `--from` only.** If the file is missing or not text, say so and stop. Read it as the author's writing. For each question, pick the option whose rule the file clearly follows. Pick none when the file gives no clear evidence, and never guess. A picked option goes first in its question, with ` (Recommended)` added to its label and `Seen in your file: "<at most 12 words quoted>"` added to its description. Never copy the file's content into `voice.md`.
3. **Ask the questions** with AskUserQuestion, at most 4 per call, in the bank's order: Q1 to Q4, Q5 to Q8, Q9 to Q12, Q13 to Q16 (for one area, its questions only, at most 4 per call). For each question, use the bank's `header`, `question`, and each option's label, description and preview, with `multiSelect: false`. Keep the bank's option order unless step 2 moved one first. Map each chosen label back to its option id. Do not add, drop or reword questions.
   - **Other.** When the author writes their own answer, turn it into one rule in the imperative that keeps their meaning and their key words, and record the answer as `other`. If part of it breaks a Fixed rule of the base voice (for example, invented numbers or third person), drop that part and say in one line that the base rule stays.
4. **Build the file** in the format below. Write one bullet per question, in bank order under its area's heading, using the option's rule word for word or the rule made from an Other answer. On a one-area redo, rebuild only that area's section and its `answers` keys, and copy everything else from the old file unchanged.
5. **Write a sample** of 90 to 130 words in the new voice. Make it about an invented, everyday engineering moment (not one of the bank's previews, and nothing about the author's real work), with one heading if the layout answer uses headings. Show it, and ask one question: "Sounds like me", "Adjust an area" or "Start over".
   - Adjust: ask which area, ask that area's questions again, rebuild, and write a new sample.
   - Start over: go back to step 3 with all 16.
   - After three adjustments, suggest using "Other" on the question that still feels off.
6. **Save.** If the target exists, first write its current content to `<home>/voice.md.bak`, replacing any older backup. Then write the target. If a write is refused, say so, show the file content so the author can save it, and do not say it was saved.
7. **Report** in 3 to 4 lines: the path, the backup path if one was made, the number of rules, and "new briefs from /porch:brief use it; briefs written earlier keep the voice they name".

## voice.md format

```markdown
---
generated_by: /porch:voice
updated: 2026-11-20          # today's date
answers:
  rhythm: punch              # option id, or other
  pauses: oneline
  pace: first
  stance: reasoned
  words: gloss
  reader: advice
  candor: relevant
  emoji: never
  mood: dry
  layout: skim
  openings: story
  register: neutral
  format: lists
  ending: takeaway
  depth: brief
  pressure: calm
---

# My voice

This extends the Porch base voice. Where a rule here covers the same thing as one of its Defaults, this rule wins. Its Fixed rules always apply.

## Rhythm
- <rhythm rule>
- <pauses rule>
- <pace rule>
- <stance rule>
- <words rule>

## Presence
- <reader rule>
- <candor rule>
- <emoji rule>
- <mood rule>

## Delivery
- <layout rule>
- <openings rule>
- <register rule>
- <format rule>
- <ending rule>

## Audience
- <depth rule>
- <pressure rule>

## Sample

The paragraph below shows rhythm and tone only. Its content is invented; never reuse it in a draft.

<the sample the author approved>
```
