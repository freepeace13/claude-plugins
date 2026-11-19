# Body format

The body is one Markdown string. Porch renders it with `Str::markdown` (GitHub-flavored, `html_input: strip`) and edits it in Filament's Markdown editor.

| Rule | Why |
|---|---|
| No `# H1`. Sections are `##`, sub-sections `###`, nothing deeper. | The page already renders the title as the H1. |
| Fenced code blocks with a language tag (`php`, `sql`, `json`, `bash`), kept short. | The site styles `pre` and inline code. |
| Tables, lists, blockquotes, bold, `---` rules and inline code are fine. | GitHub-flavored Markdown, styled under `.article-body`. |
| Links are `https://...` or relative site paths such as `/work/equalsite`. | Unsafe links are neutralised. |
| No raw HTML, including comments, in the final body. | Stripped on render. `<!-- verify -->` markers must be resolved before push. |
| No images: no `![]()` and no image URLs. | The workflow is text-only. |
| Open with a paragraph, not a heading or a "TL;DR" label. | Matches existing articles and the card excerpt. |
| Case studies use the headings The problem, What I did, The result. | The admin helper text and the MCP tool suggest them. |

The draft file keeps its frontmatter and a self-check block while in `.porch/`. `/porch:push` removes both before sending the body.
