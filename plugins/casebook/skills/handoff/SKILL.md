---
name: handoff
description: Gather what a writer needs from one or more casebook logs, given their IDs, and check it against the handoff checks. Writes a handoff folder (handoff.md plus the source logs) ready for writing. Use when the user wants to prepare, hand off or check casebook logs before a case study is written.
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
   - `anonymize`: never name the client, employer, company, product, repository, domain, people or internal URLs. Use generic descriptions ("a B2B logistics platform"). No commit hashes, file paths or code from the repository. Keep the technical story, stack and numbers. If the current directory is the logs' repository, you may still read it (the same commands) to settle open items, but write only what may be named and cite it as `repo` alone.
4. **Run the checks** in `handoff.md`: the core elements (E-), then the case study elements (C-). Casebook hands off case studies only: each log's `type` is `case-study` (a log from an older casebook has none and is one too). If the note asks for another kind of piece, say casebook prepares case studies only and stop.
   - **One topic.** If the logs (or the note) hold more than one subject and the note does not pick one, offer up to 3 candidates in one message, each with its subject and the facts behind it, and wait. Then check the chosen topic from the start. Never merge several topics.
   - Map each element to its sources: `logs/<id>.md#<Section>` for a section of a log (Problem, Approach, Outcome, Evidence, Key decision, a mark note), or a `repo:` source. Mark it inferred where the table allows it, or missing.
   - A log's mark notes and key decision are the developer's own words and count as intake. The note and answers never count toward E-3's 3 facts.
   - Facts a log flags as "not independently re-checked" still count, but each one also becomes an Unknown to verify.
   - The verdict is `thin` if a **reject** element is missing or more than 3 **ask** elements are missing.
   - **List the open items** as `handoff.md` defines them, and settle what you can from the repository.
5. **Ask, once.** If the verdict is not yet `thin`, send one message: the missing **ask** elements (at most 3 questions), one question on whether the numbers may be published, then every open item still unsettled as a numbered list, each with what the logs say now. For example:

   ```text
   Open items. Reply "all as stated", or correct any by number:
   1. Release: merged to main, not released (changelog under Unreleased). Still true?
   2. Stale lock after a killed merge: still open, no recovery. Still true?
   3. Migration size: not in the log. How many folders or logs moved, or "not known"?
   ```

   Wait for the answers. An answer that leaves an element empty makes the verdict `thin`. Ask nothing after this.
6. **On `thin`:** create nothing. Reply in this shape and stop:

   ```text
   Not enough for a handoff. Nothing was written.
   - E-3 only 1 concrete fact (cb-7k2m9q#Outcome: "retries dropped"). Add the before and after numbers or the error message.
   - E-2 no first-hand part. Add what you did or decided.
   Add them with /casebook:mark <id> "<the facts>", then run /casebook:handoff again.
   ```

   Cite the log and section for each missing element. Mark notes are part of the log, so `/casebook:mark` is how the developer adds facts.
7. **Make the folder.** Pick a working title (outcome-focused, no hype). Get the folder path with
   `casebook out-path --project "<project, or 'anonymized' under anonymize>" --title "<title>"`
   and add `--dir <dir>` when `--out` was given. It prints a path that does not exist yet; create it by writing the files below into it.
8. **Write the files.**
   - `logs/<id>.md` for each log: the log as `casebook show <id>` prints it, named by the `id` in its frontmatter (an ID merged into another log prints that log: use its ID, here and in `source_logs`, and write each log once). Under `anonymize`, set `project` to `anonymized`, and drop `repo`, `branch`, `profile`, `session_id`, `sessions`, `session_turns`, `partial_sessions`, `merged_from`, `commits`, `files`, `written_to`, `written_at` and `discovery_note` from the frontmatter, rewrite each `marks` note the same way as the body, and remove anything else, in the frontmatter or the body, that names what must not be named.
   - `handoff.md` in the format below.
9. **Report** in 3 to 6 lines: the folder path, the topic, the verdict, the open items settled, any Unknowns left, and that the folder is ready for a writer. Writing the piece is not part of casebook.

## Writing the facts

- Each fact is one claim, number, name, step or quote, stated exactly as it may be written, with its source. Copy numbers, error messages and names exactly; never round or reword them.
- Write every fact from the developer's point of view, in first person ("I limited CI to pull requests into main"). Logs often say "the team" or describe an assistant doing the work: restate it as the developer's own action and drop the assistant, unless the piece is about it.
- Never invent metrics, timelines, team sizes or results. Never count one fact twice.
- Items under a log's "Open threads" are open items, not facts, until the repository or an answer settles them. Each settled item becomes a fact, dated when it can change ("As of 2026-11-21, …"). "Not known" becomes a fact that says what the writer may write ("The size of the migration was not recorded: give no count.").
- A still-open trade-off is a fact once the author confirms it ("As of 2026-11-21, a stale lock can remain after a killed merge; there is no recovery yet."), not an Unknown.
- A log with `partial: true` (from an older casebook) was logged while its session was still running: it is an open item.
- `## Unknowns` holds only items the author left unanswered. Normally it reads "none".

## handoff.md format

```markdown
---
type: case-study
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
| C-1 | Problem | found | F-1 |
| C-2 | Role and actions | found | F-2, F-3 |
| C-3 | Result | found | F-5 |
| C-4 | Client | inferred | F-9 |
| C-5 | Period, stack, URL | answered | F-10 |

## Facts
- F-1 (source: logs/cb-7k2m9q.md#Problem) ...
- F-2 (source: logs/cb-7k2m9q.md#Key decision) ...
- F-6 (source: repo:3fa91c2) ...
- F-7 (inferred from F-4, F-6) ...
- F-8 (source: answer) ...
- F-9 (source: policy) The project is anonymized; no client is named.
- F-10 (source: answer) No public URL.
- F-11 (source: repo) As of 2026-11-19, the change is released in version 1.4.

## Open items
- O-1 Release status (cb-7k2m9q#Open threads): settled by F-11
- O-2 Size of the backlog drained (not in the logs): settled by F-12

## Unknowns
none

## Answers
- Q: the question as asked
  A: the answer, verbatim
```

Use one row per element in `handoff.md`, in its order, with the status `found`, `inferred` or `answered`. List every open item under `## Open items` with the fact that settles it, or the Unknown it stayed as. Leave `## Answers` out when nothing was asked. A handoff with any element still missing is never written.
