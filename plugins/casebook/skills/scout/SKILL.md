---
name: scout
description: Scout the current session (or another session, or all missed sessions) into a casebook log right now, instead of waiting for the session to end.
argument-hint: "[<session-id> | --pending] [--background] [--force]"
disable-model-invocation: true
allowed-tools: Bash(casebook:*)
---

Scout a session for casebook now. Arguments: `$ARGUMENTS`

Each scout is one headless model call, so run exactly what is described here and nothing more. If `casebook` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/casebook"` with the same arguments instead.

## Bash timeout

A foreground scout can take 20 to 90 seconds. Run every `casebook scout` command below with the Bash tool's `timeout` set to `(scout.timeoutSec + 30) * 1000` ms. The default `scout.timeoutSec` is 240, so use `270000`. Never go above `600000`. Commands with `--background` or `--dry-run` return at once and need no special timeout.

## Which command

- **No session ID and no `--pending`** (the current session):
  `casebook scout --session ${CLAUDE_SESSION_ID} --live`
- **A session ID** (the first argument is not a flag):
  `casebook scout --session <that id>`
- **`--pending`** (catch up on missed sessions): do it in two steps.
  1. Run `casebook scout --pending --dry-run --exclude ${CLAUDE_SESSION_ID}`. Show the list as printed, in a code block. If it says there is nothing to catch up on, say so in one line and stop.
  2. Ask the user to confirm, since each session is one model call. Only when they confirm, run `casebook scout --pending --exclude ${CLAUDE_SESSION_ID}`.

Append `--background` and/or `--force` to the command when the user's arguments include them. Pass `--limit N` through to `--pending` when given. Do not add any other flags.

## Reply

Relay the command's output exactly as printed, inside a code block, then stop. Do not summarize it or add commentary. If the scout failed, show the error line and nothing else.
