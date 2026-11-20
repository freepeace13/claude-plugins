---
name: push
description: Save an approved Porch draft from a Porch work folder to Porch as a draft article or case study, by work id. Use only when the user asks to push or save a draft to Porch.
argument-hint: "<id>"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(porch:*), mcp__plugin_porch_porch__search-articles, mcp__plugin_porch_porch__list-articles, mcp__plugin_porch_porch__list-case-studies, mcp__plugin_porch_porch__read-article, mcp__plugin_porch_porch__read-case-study, mcp__plugin_porch_porch__create-article, mcp__plugin_porch_porch__update-article, mcp__plugin_porch_porch__create-case-study, mcp__plugin_porch_porch__update-case-study
---

You are the content administrator. Saving a draft is a field mapping and one call. Work id: `$ARGUMENTS`. Rules for the body are in `${CLAUDE_PLUGIN_ROOT}/references/body-format.md`; limits are in `references/article.md` and `references/case-study.md`.

1. If no id was given, run `porch list --status approved` and ask which one. If `porch read` finds no match and `.porch/<id>/` exists in the current directory, it is a 0.1.0 folder: tell the user to run `porch import .porch/<id>`, then push the id it prints. Run `porch read <id> --json` and keep `id`, `dir`, `status`, `porch_id` and `tags`. Refuse unless `status` is `approved` or `pushed`. Read `dir/draft.md`. Refuse if `dir/review.md` does not end in `approved`, or if any `<!-- verify` remains (Porch strips HTML comments, so they would be invisible).
2. Strip the `<!-- self-check` block. Map the frontmatter to Porch fields, check every length limit, and lint the body: no H1, no raw HTML, no image syntax, no headings deeper than `###`. Refuse with the exact problem if any check fails. Search the body for "the owner", "the user", "operator" and "Claude"; if any hit is in prose, show each one and push only if the author confirms they mean it.
3. Find the Porch record: by `porch_id` when set, else look up the slug.
   - No match: call `create-article` or `create-case-study`.
   - A draft match: read it first, then call `update-*`. Bodies and the case study `stack` replace the old value in full.
   - A published match: refuse. Editing live content is out of scope.
4. Never send `status`, `is_published` or `is_featured`. For case studies, take `client`, `role`, `period` and `url` from `dir/brief.md`, and leave `client` out under `anonymize`.
5. Run `porch set <id> status=pushed porch_id=<Porch ID>`.
6. Report: the Porch ID, admin follow-ups (the work folder's tags to add, cover, featured) and that it is waiting for the user to publish in the admin.
