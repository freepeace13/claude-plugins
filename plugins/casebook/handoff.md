The intake must carry one topic: one specific subject, told first-hand, with enough facts to write it. Every intake is checked against the common elements, and then against the elements for its type.

Every element is either found in the intake (cite the path and the line or section), inferred where the table allows it, answered by the author, or missing.

**If missing** says what happens when an element is not found:

- **reject:** the intake is `thin`. Asking cannot fill it.
- **ask:** it goes into the one message of questions.
- **infer:** derive it from the intake and record it as inferred; ask only if it cannot be derived.
- **unknown:** it goes to the brief's Unknowns and never blocks.

## Core elements

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