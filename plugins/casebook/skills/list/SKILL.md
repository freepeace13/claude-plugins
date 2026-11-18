---
name: list
description: List casebook logs (potential case studies) for the current project or all projects, with IDs, scores and marks. Use when the user asks what is in their casebook or which sessions could become case studies.
argument-hint: "[--marked] [--all | --project <name>] [--min-score N] [--unwritten | --written] [--since 30d] [--profile <name>]"
allowed-tools: Bash(casebook:*)
---

Run `casebook list $ARGUMENTS` in the current directory. Logs are kept per Claude config directory (profile); the first line of the output names the profile, and `--profile <name>` shows another one. With no `--project` or `--all`, it lists the project of the current repository.

Show the output exactly as printed, inside a code block. Do not reformat it or summarize the titles. Legend: MRK 📌 = marked with `/casebook:mark`; WRT ✓ = a case study was already written from it.

After the block, add at most one line of next steps: `/casebook:show <id>` to read a log, `/casebook:write <id…>` to write a case study, `/casebook:delete` to clean up. If no logs matched and the output names other projects, suggest `--all`.
