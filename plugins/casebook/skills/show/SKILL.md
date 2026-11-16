---
name: show
description: Show one casebook log by ID.
argument-hint: "<log-id>"
allowed-tools: Bash(casebook:*)
---

Run `casebook show $ARGUMENTS` (fall back to `node "${CLAUDE_PLUGIN_ROOT}/bin/casebook" show $ARGUMENTS` if `casebook` is not on PATH).

Show the log as printed. Then add one line: its score, whether it is marked, and whether it has been written up. Offer `/casebook:write <id>` if it hasn't been.
