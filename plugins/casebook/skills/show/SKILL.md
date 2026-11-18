---
name: show
description: Show one casebook log by ID. Use when the user wants to read a log (IDs like cb-abc123).
argument-hint: "<log-id>"
allowed-tools: Bash(casebook:*)
---

Run `casebook show $ARGUMENTS`.

Show the log as printed. Then add one line: its score, whether it is marked, and whether it has been written up. Offer `/casebook:write <id>` if it hasn't been.
