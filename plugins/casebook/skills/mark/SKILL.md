---
name: mark
description: Mark the current session, or an existing casebook log by ID, as a potential case study, with an optional note. Use when the user wants to flag work worth a case study.
argument-hint: "[note] | <log-id> [note]"
disable-model-invocation: true
allowed-tools: Bash(casebook:*)
---

Mark a potential case study for casebook. Arguments: `$ARGUMENTS`

Run exactly one command:

- If the arguments start with a log ID (`cb-` followed by 6 letters/digits), mark that log:
  `casebook mark <log-id> -- "<rest of the arguments as the note>"`
- Otherwise mark the current session:
  `casebook mark --session ${CLAUDE_SESSION_ID} -- "<note>"`
  The note is the arguments. If there are none, write a note of at most 15 words naming the most significant problem solved or decision made so far in this session.

Quote the note safely for the shell.

Reply with the command's one-line output and nothing else, then carry on with whatever the user was doing.
