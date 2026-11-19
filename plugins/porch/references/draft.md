# draft.md format

```markdown
---
type: article            # article | case-study
title: ...
slug: ...                # from the brief
excerpt: ...             # article
summary: ...             # case study
outcome: ...             # case study
seo_title: ...
seo_description: ...
stack: [..]              # case study
---

Opening paragraph...

## Section
...

<!-- self-check
AC-1 pass
AC-2 pass
...
Revision: what changed in this round, if any
-->
```

The self-check block is the last thing in the file, an HTML comment starting `<!-- self-check`. It has one line per acceptance criterion. `/porch:push` strips it. Any other `<!-- verify: ... -->` marker must be resolved before push.
