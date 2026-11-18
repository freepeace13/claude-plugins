---
name: delete
description: Delete casebook logs, either specific IDs or a batch selected by filters. Use only when the user explicitly asks to remove logs.
argument-hint: "<log-id>… | [--project P] [--below-score N] [--older-than 30d] [--unmarked] [--written | --unwritten]"
disable-model-invocation: true
allowed-tools: Bash(casebook:*)
---

Delete casebook logs. Arguments: `$ARGUMENTS`

- **Specific IDs** (`cb-xxxxxx`): the user named them, so run `casebook delete <ids…>` directly and show the output.
- **Batch by filters**: run `casebook delete <filters>` first, without `--yes`. That is a dry run. Show the list it would delete in a code block and ask the user to confirm. Run it again with `--yes` only after they say yes.
- **No arguments**: ask whether they want to delete specific IDs (suggest `/casebook:list`) or a batch by filter. Show the filter options from the argument hint.

A deleted log's session is never scouted again. Case study files that were already written are not touched.
