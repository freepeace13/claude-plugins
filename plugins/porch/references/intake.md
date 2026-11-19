# Intake check

`/porch:brief` runs this check on the original file or folder, reading only, **before** any work folder exists. A work folder is created only after the intake passes. A failed intake leaves nothing behind.

The intake must carry one topic: one specific subject, told first-hand, with enough facts to write it. Every intake is checked against the common elements, and then against the elements for its type.

Every element is either found in the intake (cite the path and the line or section), inferred where the table allows it, answered by the author, or missing.

**If missing** says what happens when an element is not found:

- **reject:** the intake is `thin`. Asking cannot fill it.
- **ask:** it goes into the one message of questions.
- **infer:** derive it from the intake and record it as inferred; ask only if it cannot be derived.
- **unknown:** it goes to the brief's Unknowns and never blocks.

## Common elements (article and case study)

| # | Element | Passes when | If missing |
|---|---|---|---|
| E-1 | Subject | One concrete thing: a bug, a decision, a system, a migration, a project. "Queue retries storming Redis after deploys" passes; "Laravel queues" does not. | reject |
| E-2 | First-hand part | Something the author did, decided, built, measured or saw. A summary of other people's work fails. | reject |
| E-3 | Concrete facts | At least 3 specifics from the intake itself: numbers, error messages, names, steps, code, dates, before and after. Opinions and general advice do not count. The note and answers do not count toward the 3. | reject |
| E-4 | Reader | Who it is for, and what they already know. | infer from how technical the intake is, else ask |

## Article elements

An article argues one point and backs it with what happened.

| # | Element | Passes when | If missing |
|---|---|---|---|
| A-1 | Point | A thesis the whole piece can defend: what was learned, why X over Y, what changed. The note may supply it. | ask |
| A-2 | Reasoning | Why the point holds: the cause found, the trade-off weighed, or an option ruled out and why. A claim with no reason fails. | ask |
| A-3 | Takeaway | Something the reader can reuse: a rule, a check, a config, a pattern. | infer from the facts, else ask |

## Case study elements

A case study tells one engagement: The problem, What I did, The result. Its thesis is the problem and the result in one sentence, so it needs no separate point.

| # | Element | Passes when | If missing |
|---|---|---|---|
| C-1 | Problem | The situation before, and why it mattered to the client or the project. | ask |
| C-2 | Role and actions | What the author personally did, not what the team did. Stricter than E-2: at least 2 actions the author owns. | reject |
| C-3 | Result | An outcome that rests on a fact: a number, a shipped change, a before and after. | ask once; still missing after the answer: reject |
| C-4 | Client | A client name, or whether to anonymize. | ask |
| C-5 | Period, stack, URL | Optional. | unknown |

## Rules

- **Reject** elements cannot be filled by asking. The facts must come from the intake, not from a conversation.
- **Ask** elements share one message of at most 3 questions. If more than 3 are missing, the intake is `thin`.
- Whether numbers may be published is one question for all numbers, and it counts toward the 3. Ask it only when there is room left. If there is none, each number's permission becomes an Unknown, so the writer leaves a verify marker and `/porch:push` refuses until it is settled. It never makes the intake `thin`.
- An answer can fill an ask element, and becomes a fact with source `answer`. If an answer leaves the element empty, the intake is `thin`.
- **More than one topic** (common for a folder): the note may pick one. If it does not, offer up to 3 candidate topics in one message, each with its subject and the facts behind it, and let the author pick. Then check the chosen topic from the start. Never cover all of them together.
- **Finished draft:** check it the same way, using the draft as the intake.
- Never fill an element by guessing, and never count a fact twice.

## Verdicts

| Verdict | Meaning | Next |
|---|---|---|
| `pass` | Every common element and every element for the type is found or inferred. | create the work folder |
| `pass-with-answers` | Ask elements were answered and filled. | create the work folder |
| `thin` | A reject element is missing, more than 3 elements need asking, or an answer left one empty. | stop; no work folder |

`split` is not a verdict. It is a step that comes before one.

## Report for `thin`

List each missing element by ID, say what to add, and name the file to add it to. For example:

```text
Intake is too thin for an article. Nothing was created.
- E-3 only 1 concrete fact (notes.md: "retries spiked"). Add the before and after numbers, the error message, or the config you changed.
- E-2 no first-hand part. Add what you did or decided.
Run /porch:brief again once notes.md has these.
```

## Record

On a pass, the brief's frontmatter records the result, and `/porch:draft` refuses a brief without it:

```yaml
intake_check: pass         # pass | pass-with-answers
topic: Queue retries storming Redis after deploys
```

Each element maps to fact IDs in the brief's `## Intake` section, for example `E-3: F-1, F-2, F-4` or `A-1: F-5`.
