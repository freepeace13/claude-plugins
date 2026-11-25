The intake must carry one topic: one specific subject, told first-hand, with enough facts to write it. Casebook hands off case studies. Every intake is checked against the core elements, then the case study elements.

A handoff is complete: a writer can write from it without asking anyone or checking anything. Every element and every open item is settled before the handoff is written.

Every element is either found in the intake (cite the path and the line or section), inferred where the table allows it, answered by the author, or missing.

**If missing** says what happens when an element is not found:

- **reject:** the intake is `thin`. Asking cannot fill it.
- **ask:** it goes into the one message of questions.
- **infer:** derive it from the intake and record it as inferred; ask only if it cannot be derived.
- **unknown:** it becomes an open item (below).

## Core elements

| # | Element | Passes when | If missing |
|---|---|---|---|
| E-1 | Subject | One concrete thing: a bug, a decision, a system, a migration, a project. "Queue retries storming Redis after deploys" passes; "Laravel queues" does not. | reject |
| E-2 | First-hand part | Something the author did, decided, built, measured or saw. A summary of other people's work fails. | reject |
| E-3 | Concrete facts | At least 3 specifics from the intake itself: numbers, error messages, names, steps, code, dates, before and after. Opinions and general advice do not count. The note and answers do not count toward the 3. | reject |
| E-4 | Reader | Who it is for, and what they already know. | infer from how technical the intake is, else ask |

## Case study elements

A case study tells one piece of work: the problem, what the author did, the result. Its thesis is the problem and the result in one sentence, so it needs no separate point.

| # | Element | Passes when | If missing |
|---|---|---|---|
| C-1 | Problem | The situation before, and why it mattered to the client or the project. | ask |
| C-2 | Role and actions | What the author personally did, not what the team did. Stricter than E-2: at least 2 actions the author owns. | reject |
| C-3 | Result | An outcome that rests on a fact: a number, a shipped change, a before and after. | ask once; still missing after the answer: reject |
| C-4 | Client | A client name, or that it is the author's own project, or that it is anonymized. | infer from the policy and the logs, else ask |
| C-5 | Period, stack, URL | Period and stack from the logs. URL: the public link, or "none". | infer, else open item |
| C-6 | System | What the system is and does, in one or two sentences: the kind of software, its job, who uses it, its main parts or stack. "A Node.js CLI that mines editor session logs for case-study topics" passes; "a plugin" does not. Under `anonymize`, described without names. | infer from the logs' System section (and the repository's README when you are in it), else ask |
| C-7 | Evidence | Under `public`: the repository URL and at least one link a reader can follow to the work itself: a commit, a pull request, or a file at a commit with its lines. Under `anonymize`: none, and none may appear anywhere in the handoff. | under `public`, infer from the repository, else open item; under `anonymize`, passes as "none" |

## What may be named

| | `public` | `anonymize` |
|---|---|---|
| What the system is and does | always | always, without names |
| Project, product or app name | yes | no |
| Repository, commit, pull request and file links | yes, only ones that resolve publicly | never |
| Code (one excerpt, at most 15 lines) | yes | yes, with names renamed generically |

Code never carries secrets, tokens, keys, passwords, connection strings, internal hostnames or IPs, customer data or personal data. When in doubt, leave it out.

## Open items

An open item is anything a writer would otherwise have to hedge, guess or mark for checking:

- a log's "Open threads" item that touches the topic (one that does not is dropped, not kept);
- a status that can change after the session: released or not, still open or fixed, still in use;
- a number, size or result the story needs that the logs do not give;
- a fact a log flags as "not independently re-checked";
- a missing key decision in the author's own words, when the story turns on a decision;
- an element above whose **If missing** leads here.

Settle each one before the handoff is written:

1. **From the repository,** when the current directory is the logs' repository: read only, and under `anonymize` write only what may be named. A settled status is dated: "As of 2026-11-21, the change is merged but not released."
2. **From the author,** in the one message of questions. List each item with what the logs say now, so the author can confirm it, correct it, or say it is not known.

Every settled item becomes a fact. "Not known" or "leave it out" also becomes a fact, written as what the writer may say: "The size of the migration was not recorded: give no count." The handoff's Unknowns hold only what the author chose to leave unanswered.

## Rules

- **Reject** elements cannot be filled by asking. The facts must come from the intake, not from a conversation.
- **Ask** elements share one message of at most 3 questions. If more than 3 are missing, the intake is `thin`.
- Whether numbers may be published is one question for all numbers. It does not count toward the 3.
- Open items go in the same message, as a numbered list after the questions. They have no limit and never make the intake `thin`.
- An answer can fill an ask element, and becomes a fact with source `answer`. If an answer leaves an element empty, the intake is `thin`.
- Never fill an element by guessing, and never count a fact twice.
