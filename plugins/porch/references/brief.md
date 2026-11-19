# Brief contract

`brief.md` in a work folder (`$PORCH_HOME/<articles|case-studies>/<id>/`, made by `/porch:brief`) is the contract between intake and the writer. The writer may use only what is in it. Review checks the draft against its acceptance criteria.

A brief is written only after the intake passed `references/intake.md`. It is **ready** only when every required field is filled or explicitly marked unknown and `intake_check` is `pass` or `pass-with-answers`.

## Format

```markdown
---
id: 1a2b3c4d-...          # work id from `porch init`
type: article            # article | case-study
intake_check: pass       # pass | pass-with-answers, from references/intake.md
topic: Queue retries storming Redis after deploys
slug: backoff-after-deploys
status: ready            # draft | ready
plugin_root: /abs/path/to/plugin
voice: /abs/path/to/voice.md   # $PORCH_HOME/voice.md when present, else references/voice.md
reader: Backend engineers running queue workers
pov: first person, the site owner is the author   # fixed; never "the owner" or "the user"
thesis: One sentence the whole piece defends
length: 700-1100         # words
never_name: [Acme Corp]  # names that must not appear
anonymize: false
client: ""               # case study only; omitted when anonymize is true
role: ""                 # case study only
period: ""               # case study only
url: ""                  # case study only, http(s)
stack: [Laravel, Redis]  # case study only
---

## Intake
- E-1 Subject: F-1
- E-2 First-hand part: F-2
- E-3 Concrete facts: F-1, F-3, F-4
- E-4 Point: F-5
- E-5 Reader: inferred

## Facts
- F-1 (source: intake/queue.md) Claim, number or name, stated exactly as it may be written
- F-2 (source: note) ...
- F-3 (source: answer) Filled by the author's answer to an intake question

## Unknowns
- U-1 What is not known and the writer must write around

## Outline
1. Heading: what it covers (F-1)
2. Heading: what it covers (F-2, U-1)

## Acceptance
- AC-1 Every number in the draft traces to a fact ID
- AC-2 States the thesis in the first two paragraphs
- AC-3 Follows the outline's section order and headings
- AC-4 Length within range
- AC-5 Passes voice.md rules; first person throughout, no "the owner", "the user" or operator
- AC-6 Never names anything in never_name
- AC-7 Follows body-format.md and the type's template
- AC-8+ Piece-specific criteria added by intake
```

## Rules

- Point of view: the site owner is the author and writes in first person. Source notes often call the author "the owner" or "the user" and name an assistant or operator who did the work. Intake restates every fact as the author's own action ("I chose ...", not "the owner chose ...") and drops mentions of the assistant or operator unless the piece is about them.
- Facts are the writer's whole world. Each fact has an ID and a source path inside `intake/`, or `note` for the note given to `/porch:brief`, or `answer` for an answer to an intake question. The writer may not add claims, numbers, names or timelines that are not facts.
- Unknowns are listed, not guessed. The writer writes around them and leaves `<!-- verify: U-n what to check -->` at the spot.
- AC-1 to AC-7 are standard. Intake adds criteria specific to the piece, such as "mentions the ruled-out option".
- For a case study the outline is exactly: The problem, What I did, The result.
- Case-study outcome must trace to a fact.
