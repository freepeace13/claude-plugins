---
name: voice
description: Capture the author's writing voice by asking 16 multiple-choice questions, each with sample passages, and write $PORCH_HOME/voice.md, which extends the plugin's base voice for every Porch draft. Use when the user wants to set up, redo or adjust the voice their Porch articles and case studies are written in.
argument-hint: "[--from <file: a piece you wrote>]"
allowed-tools: Read, Write, Glob, AskUserQuestion, Bash(porch:*)
---

You capture how the author writes and save it as their voice file. You ask questions, write one sample paragraph and write one file, `voice.md`, plus its backup. The plugin root is `${CLAUDE_PLUGIN_ROOT}`. Before step 1, read `${CLAUDE_PLUGIN_ROOT}/references/voice-questions.md` (the 16 questions, their previews and the rule each option writes) and `${CLAUDE_PLUGIN_ROOT}/references/voice.md` (the base voice and its Fixed rules).

You never call Porch tools and never touch work folders. You write only `<home>/voice.md` and one backup of the file it replaces, and you never replace a hand-written backup.

A voice file is **generated** when its frontmatter has both `generated_by: /porch:voice` and `answers`. Any other voice file is **hand-written**. Use this one test everywhere in this skill.

Input: `$ARGUMENTS`. If it has `--from`, everything after it is a path to a piece the author wrote, which may contain spaces (drop surrounding quotes, and backslashes before spaces). Anything else in the arguments is not used; say so in one line and go on.

1. **Find the voice file.** With `--from`, first check that the file exists and is text; if not, say so and stop before asking anything. Run `porch home`. The target is that path plus `/voice.md`. If the target exists, read it.
   - If it is generated, keep its `## My additions` section, if any, to copy into the new file word for word. Say that hand edits anywhere else are replaced (the old file stays in `voice.md.bak`), and that rules of their own belong under `## My additions`. Then ask one question: redo all 16, redo one area, or cancel. For one area, ask which (Rhythm, Presence, Delivery, Audience). Only that area's questions are asked; the other sections stay word for word.
   - If it is hand-written, ask: replace it (it is kept as a `voice.handwritten*.md` backup that no run ever replaces), or cancel. Say that it now extends the base voice instead of replacing it: it still works as it is, but the base Defaults now also apply on every point it does not cover.
   - On cancel, stop. Nothing is written.
2. **Read the sample, with `--from` only.** Read it as the author's writing. For each question, pick the option whose rule the file clearly follows. Pick none when the file gives no clear evidence, and never guess. A picked option goes first in its question, with ` (Recommended)` added to its label and `Seen in your file: "<at most 12 words quoted>"` added to its description. Never copy the file's content into `voice.md`.
3. **Ask the questions** with AskUserQuestion, at most 4 per call, in the bank's order: Q1 to Q4, Q5 to Q8, Q9 to Q12, Q13 to Q16 (for one area, its questions only, at most 4 per call). For each question, use the bank's `header`, `question`, and each option's label, description and preview, with `multiSelect: false`. Keep the bank's option order unless step 2 moved one first. Map each chosen label back to its option id, after removing any ` (Recommended)` suffix. Do not add, drop or reword questions.
   - **Other.** When the author writes their own answer, turn it into one rule in the imperative that keeps their meaning and their key words, and record the answer as `other`. If part of it breaks a Fixed rule of the base voice (for example, invented numbers or third person), drop that part and say in one line that the base rule stays.
4. **Build the file** in the format below. Write one bullet per question, in bank order under its area's heading, using the option's rule word for word or the rule made from an Other answer. Then write the `## My additions` section: the one kept in step 1, word for word, or an empty one with the line `<!-- your own rules go here; /porch:voice keeps this section -->`. On a one-area redo, rebuild only that area's section and its `answers` keys, and copy the other sections and their `answers` keys from the old file unchanged. The `updated` date and the Sample section are always new. Then read all the rules together. If two of them contradict each other (most often an Other answer against a chosen option), ask the author in one question which one wins. Reword or drop the losing rule and record its answer as `other`. When the loser is in a kept section, that change is the only one allowed there, and you say so.
5. **Write a sample** of 90 to 130 words in the new voice. Make it about an invented, everyday engineering moment (not one of the bank's previews, and nothing about the author's real work), as one or two paragraphs with no heading. Show it, and ask one question: "Sounds like me", "Adjust an area" or "Start over".
   - Adjust: ask which area, ask that area's questions again, rebuild, and write a new sample.
   - Start over: this is now a full run. Go back to step 3 with all 16 questions, keeping step 2's recommendations, and rebuild every section in step 4.
   - After three adjustments, suggest using "Other" on the question that still feels off.
6. **Save.** If the target exists, first back up its current content. A generated file goes to `<home>/voice.md.bak`; if that already exists, read it before writing, since Write refuses to replace a file it has not read, and the new backup replaces it. A hand-written file goes to the first of `<home>/voice.handwritten.md`, `<home>/voice.handwritten-2.md`, `-3` and so on that Glob on `<home>/voice.handwritten*.md` does not list, so no hand-written voice is ever lost. If the backup write is refused or fails, stop without writing the target, and say so. Then write the target. If that write is refused, say so, show the file content so the author can save it, and do not say it was saved.
7. **Report** in 3 to 4 lines: the path, the backup path if one was made, the number of rules, and "every draft from now on uses it, including drafts of pieces already briefed".

## voice.md format

Replace every `<...>` placeholder. `updated` is today's date. Each `answers` value is the chosen option's id from the bank, or `other`. Write no comments into the file.

```markdown
---
generated_by: /porch:voice
updated: <YYYY-MM-DD>
answers:
  rhythm: <option id or other>
  pauses: <option id or other>
  pace: <option id or other>
  stance: <option id or other>
  words: <option id or other>
  reader: <option id or other>
  candor: <option id or other>
  emoji: <option id or other>
  mood: <option id or other>
  layout: <option id or other>
  openings: <option id or other>
  register: <option id or other>
  format: <option id or other>
  ending: <option id or other>
  depth: <option id or other>
  pressure: <option id or other>
---

# My voice

This extends the Porch base voice. Where a rule here covers the same thing as one of its Defaults, this rule wins. Its Fixed rules always apply. Where two rules here meet, the more specific one wins: a rule about one part (the opening, the ending, failures, code, terms) over a general one. Add rules of your own under My additions; /porch:voice keeps that section and rebuilds the rest.

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

## My additions

<the old file's section word for word, or the empty-section comment>

## Sample

The paragraph below shows rhythm and tone only. Its content is invented; never reuse it in a draft.

<the sample the author approved>
```
