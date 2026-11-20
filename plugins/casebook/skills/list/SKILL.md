---
name: list
description: List casebook logs (potential case studies) for the current project or all projects, with IDs, scores and marks. Use when the user asks what is in their casebook or which sessions could become case studies.
argument-hint: "[--marked] [--all | --project <name>] [--min-score N] [--since 30d]"
allowed-tools: Bash(casebook:*)
---

Run `casebook list $ARGUMENTS` in the current directory. Logs from every Claude config directory (profile) are in one store, so this lists them all. With no `--project` or `--all`, it lists the project of the current repository.

Show the output exactly as printed, inside a code block. Do not reformat it or summarize the titles. Legend: MRK 📌 = marked with `/casebook:mark`.

After the block, add at most one line of next steps: `/casebook:show <id>` to read a log, `/casebook:handoff <id…>` to prepare a handoff, `/casebook:delete` to clean up. If no logs matched, suggest `/casebook:discovery` to find topics; if the output names other projects, suggest `--all`.
