# Case study template

Fields, taken from Porch's `create-case-study` / `update-case-study` tools:

| Field | Limit |
|---|---|
| `title` | required, 160 max |
| `slug` | from the brief, 160 max |
| `summary` | required, 500 max, shown on the card |
| `outcome` | 200 max, the headline result; must trace to a fact |
| `stack` | list, each item 30 max |
| `seo_title`, `seo_description` | 70 / 320 max, kept in the draft for the admin |

`client`, `role`, `period` and `url` come from the brief, not from frontmatter the writer invents.

Body, exactly three sections:

## The problem
Open with what the system is and does (the brief's `system`), so a reader with no context knows what was being built. Then what was wrong, for whom, and the constraints.

## What I did
The approach, the decisions, what was ruled out and why. Show the brief's `## Code` excerpt where it explains a decision.

## The result
What changed. Only numbers that are facts. Where a result is unknown, write around it and add a verify comment.

Evidence: when the brief is not anonymized, link each evidence fact that carries a URL at the place the claim is made (the commit beside the change, the pull request beside the review, the lines beside the code), and the repository once early on. Use only URLs from the facts.

Default length 600 to 1,000 words unless the brief says otherwise. Under `anonymize`, never name the client, company, product, repository, domain or people, and give no links, commit hashes or file paths; still say what the system is and does.
