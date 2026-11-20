---
name: handoff
description: Gather what a writer needs from one or more casebook logs, given their IDs, and check it against the handoff checks. Writes a handoff folder (handoff.md plus the source logs) ready for writing. Use when the user wants to prepare, hand off or check casebook logs before an article or case study is written.
argument-hint: "<log-id> [<log-id>…] [--out <dir>] [extra instructions]"
allowed-tools: Read, Write, Glob, Grep, Bash(casebook:*), Bash(git remote:*), Bash(git show:*), Bash(git log:*)
---

Prepare a handoff from casebook logs. Arguments: `$ARGUMENTS`

You gather and check material. You do not write the piece. The checks are in `${CLAUDE_PLUGIN_ROOT}/handoff.md`: read it before step 4, and read it again each time, because its tables can change.

The **intake** is the source logs (and, under `public`, the repository they came from). The **note** is the extra instructions. Answers are what the user tells you in step 5.

## Steps

1. **Parse the arguments.** Pull the log IDs (`cb-` + 6 letters/digits) out of the arguments, and `--out <dir>` if given. Everything else is the note. If there are no IDs, run `casebook list --marked` and ask the user which IDs to use. Stop there.
2. **Check each ID** with `casebook show <id> --path`. If any is missing, say which one and stop.
3. **Read the logs** with `casebook show <id>`. Order them by `started_at`; later sessions are the next chapter, not a repeat. Use the strictest policy among them: `anonymize` beats `public`.
   - `public`: if the current directory is the logs' repository (`git remote get-url origin` matches the log's `repo`), you may read the listed files and commits (`git show`, `git log`) to find more facts. Cite them as `repo:<path>:<line>` or `repo:<short hash>`.
   - `anonymize`: never name the client, employer, company, product, repository, domain, people or internal URLs. Use generic descriptions ("a B2B logistics platform"). No commit hashes, file paths or code from the repository. Keep the technical story, stack and numbers.
4. **Run the checks** in `handoff.md`: the core elements (E-), then the elements for the type. The type is `article` unless the note names another type that `handoff.md` defines.
   - **One topic.** If the logs (or the note) hold more than one subject and the note does not pick one, offer up to 3 candidates in one message, each with its subject and the facts behind it, and wait. Then check the chosen topic from the start. Never merge several topics.
   - Map each element to its sources: `logs/<id>.md#<Section>` for a section of a log (Problem, Approach, Outcome, Evidence, Key decision, a mark note), or a `repo:` source. Mark it inferred where the table allows it, or missing.
   - A log's mark notes and key decision are the developer's own words and count as intake. The note and answers never count toward E-3's 3 facts.
   - Facts the scout flagged as "not independently re-checked" still count, but each one also becomes an Unknown to verify.
   - The verdict is `thin` if a **reject** element is missing or more than 3 **ask** elements are missing.
5. **Ask, once.** If the verdict is not yet `thin`, put every missing **ask** element into one message of at most 3 questions, plus, when there is room left, one question on whether the numbers may be published. Wait for the answers. An answer that leaves an element empty makes the verdict `thin`. Ask nothing after this.
6. **On `thin`:** create nothing. Reply in this shape and stop:

   ```text
   Not enough for a handoff. Nothing was written.
   - E-3 only 1 concrete fact (cb-7k2m9q#Outcome: "retries dropped"). Add the before and after numbers or the error message.
   - E-2 no first-hand part. Add what you did or decided.
   Add them with /casebook:mark <id> "<the facts>", or scan the session again with /casebook:scout <session-id>, then run /casebook:handoff again.
   ```

   Cite the log and section for each missing element. Mark notes are part of the log, so `/casebook:mark` is how the developer adds facts.
7. **Make the folder.** Pick a working title (outcome-focused, no hype). Get the folder path with
   `casebook out-path --handoff --project "<project, or 'anonymized' under anonymize>" --title "<title>"`
   and add `--dir <dir>` when `--out` was given. It prints a path that does not exist yet; create it by writing the files below into it.
8. **Write the files.**
   - `logs/<id>.md` for each log: the log as `casebook show <id>` prints it. Under `anonymize`, set `project` to `anonymized`, and drop `repo`, `branch`, `profile`, `session_id`, `sessions`, `session_turns`, `partial_sessions`, `merged_from`, `commits`, `files`, `written_to`, `written_at` and `discovery_note` from the frontmatter, rewrite each `marks` note the same way as the body, and remove anything else, in the frontmatter or the body, that names what must not be named.
   - `handoff.md` in the format below.
9. **Report** in 3 to 6 lines: the folder path, the topic, the verdict, the open Unknowns, and that the folder is ready for a writer. Do not run `casebook written`: a handoff is not a write-up.

## Writing the facts

- Each fact is one claim, number, name, step or quote, stated exactly as it may be written, with its source. Copy numbers, error messages and names exactly; never round or reword them.
- Write every fact from the developer's point of view, in first person ("I limited CI to pull requests into main"). Logs often say "the team" or describe an assistant doing the work: restate it as the developer's own action and drop the assistant, unless the piece is about it.
- Never invent metrics, timelines, team sizes or results. Never count one fact twice.
- Items under a log's "Open threads" are Unknowns, not facts, unless the note or an answer says they are resolved.
- A log with `partial: true` was scouted while its session was still running: add an Unknown for it.

## handoff.md format

```markdown
---
type: article                     # a type that handoff.md defines
verdict: pass                     # pass | pass-with-answers
topic: Queue retries storming Redis after deploys
title: Working title
project: acme-api                 # "anonymized" under anonymize
repo: github.com/owner/repo       # omit under anonymize or when unknown
policy: public                    # public | anonymize
source_logs: [cb-7k2m9q, cb-p3x8aa]
period: 2026-11-02 – 2026-11-16   # from the logs' started_at and ended_at
stack: [Laravel 12, Redis]
tags: [laravel, queues]
reader: Backend engineers running queue workers
pov: first person, the developer is the author
numbers_publishable: yes          # yes | no | unknown
never_name: []                    # names that must not appear; under anonymize, the ones you removed
created_at: 2026-11-19
---

## Note
The extra instructions, verbatim, or "none".

## Checks
| # | Element | Status | Facts |
|---|---|---|---|
| E-1 | Subject | found | F-1 |
| E-2 | First-hand part | found | F-2, F-3 |
| E-3 | Concrete facts | found | F-1, F-4, F-5 |
| E-4 | Reader | inferred | |
| A-1 | Point | answered | F-8 |
| A-2 | Reasoning | found | F-6 |
| A-3 | Takeaway | inferred | F-7 |

## Facts
- F-1 (source: logs/cb-7k2m9q.md#Problem) ...
- F-2 (source: logs/cb-7k2m9q.md#Key decision) ...
- F-6 (source: repo:3fa91c2) ...
- F-7 (inferred from F-4, F-6) ...
- F-8 (source: answer) ...

## Unknowns
- U-1 What is not known and the writer must write around, with the log it came from

## Answers
- Q: the question as asked
  A: the answer, verbatim
```

Use one row per element in `handoff.md`, in its order, with the status `found`, `inferred` or `answered`. Leave `## Answers` out when nothing was asked. A handoff with any element still missing is never written.
