# Brief contract

`.porch/<slug>/brief.md` is the contract between intake and the writer. The writer may use only what is in it. Review checks the draft against its acceptance criteria.

A brief is **ready** only when every required field is filled or explicitly marked unknown.

## Format

```markdown
---
type: article            # article | case-study
slug: backoff-after-deploys
status: ready            # draft | ready
plugin_root: /abs/path/to/plugin
voice: /abs/path/to/voice.md   # .porch/voice.md when present, else references/voice.md
reader: Backend engineers running queue workers
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

## Facts
- F-1 (source: notes/queue.md) Claim, number or name, stated exactly as it may be written
- F-2 (source: prompt) ...

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
- AC-5 Passes voice.md rules
- AC-6 Never names anything in never_name
- AC-7 Follows body-format.md and the type's template
- AC-8+ Piece-specific criteria added by intake
```

## Rules

- Facts are the writer's whole world. Each fact has an ID and a source path (or `prompt`). The writer may not add claims, numbers, names or timelines that are not facts.
- Unknowns are listed, not guessed. The writer writes around them and leaves `<!-- verify: U-n what to check -->` at the spot.
- AC-1 to AC-7 are standard. Intake adds criteria specific to the piece, such as "mentions the ruled-out option".
- For a case study the outline is exactly: The problem, What I did, The result.
- Case-study outcome must trace to a fact.
