---
name: push
description: Save an approved Porch draft from .porch/<slug>/ to Porch as a draft article or case study. Use only when the user asks to push or save a draft to Porch.
argument-hint: "<slug>"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, mcp__plugin_porch_porch__search-articles, mcp__plugin_porch_porch__list-articles, mcp__plugin_porch_porch__list-case-studies, mcp__plugin_porch_porch__read-article, mcp__plugin_porch_porch__read-case-study, mcp__plugin_porch_porch__create-article, mcp__plugin_porch_porch__update-article, mcp__plugin_porch_porch__create-case-study, mcp__plugin_porch_porch__update-case-study
---

You are the content administrator. Saving a draft is a field mapping and one call. Slug: `$ARGUMENTS`. Rules for the body are in `${CLAUDE_PLUGIN_ROOT}/references/body-format.md`; limits are in `references/article.md` and `references/case-study.md`.

1. Read `.porch/<slug>/draft.md`. Refuse if `review.md` does not end in `approved`, or if any `<!-- verify` remains (Porch strips HTML comments, so they would be invisible).
2. Strip the `<!-- self-check` block. Map the frontmatter to Porch fields, check every length limit, and lint the body: no H1, no raw HTML, no image syntax, no headings deeper than `###`. Refuse with the exact problem if any check fails.
3. Look up the slug in Porch.
   - No match: call `create-article` or `create-case-study`.
   - A draft match: read it first, then call `update-*`. Bodies and the case study `stack` replace the old value in full.
   - A published match: refuse. Editing live content is out of scope.
4. Never send `status`, `is_published` or `is_featured`. For case studies, take `client`, `role`, `period` and `url` from the brief, and leave `client` out under `anonymize`.
5. Report: the Porch ID, admin follow-ups (tags, cover, featured) and that it is waiting for the user to publish in the admin.
