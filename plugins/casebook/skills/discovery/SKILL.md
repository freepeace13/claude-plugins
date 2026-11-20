---
name: discovery
description: Discover case study topics across past sessions, linking work that was carried over several sessions into one topic, rank the best 3 and log the one the user picks. Use when the user wants to find a topic in their sessions, or when one piece of work was split into several logs.
argument-hint: "[note] [--score N] [--tags a,b] [--all | --project <name>] [--since 90d]"
disable-model-invocation: true
allowed-tools: Bash(casebook:*), AskUserQuestion
---

Discover casebook topics across linked sessions. Arguments: `$ARGUMENTS`

Discovery reads every session of this profile, links the ones that continue each other (same pull request, same feature branch, a handoff file, a "continue where we left off" opening, the same files) and scans each chain for topics, including sessions already logged, since a new scan can find another angle. Each scan sees the existing logs, so a topic that is already logged updates that log instead of being logged twice. It returns the best 3 topics. Scanning is one headless model call per candidate, at most 5, run side by side.

## 1. Build the command

Start from `casebook discover --exclude ${CLAUDE_SESSION_ID}` and add:

- **note**: everything in the arguments that is not a flag. It can name a topic ("websocket + redis stream worked together") or give rules. Pass it verbatim as `--note "<note>"`, quoted safely for the shell.
- **score**: `--score N` becomes `--min-score N`, which keeps topics scoring N or higher (1 to 5). If the note states a threshold in words instead, convert it: "scores > 3" or "above 3" is `--min-score 4`, "at least 3" is `--min-score 3`. Leave the note as it is.
- **tags**: `--tags a,b` passes through as `--tags a,b`. A topic must mention at least one of them.
- `--all`, `--project <name>` and `--since <age>` pass through. Add no other flags.

## 2. Run it

Run the command with the Bash tool's `timeout` set to `600000` ms. A candidate can take two model runs (a retry with fewer flags on older Claude Code), and reading the sessions comes first. If the command is cut off by that timeout, say so and suggest running it again with a shorter `--since` (or without `--all`).

- If it prints `Nothing to discover` or `No topic matched`, relay that line (and any `failed` line) in a code block and stop. When a `--min-score` or tags were given, add one line suggesting a lower score or fewer tags.
- If it failed, show the error line and stop.

Otherwise it prints a discovery ID (`d-xxxxxx`) and up to 3 ranked topics. Show the output exactly as printed, inside a code block.

## 3. Ask which one to log

Ask with AskUserQuestion: one single-select question, "Which topic should become a casebook log?", with one option per topic in rank order. Topic 1 is the highest score: label it `<title> (Recommended)`. Each label is the title, shortened to fit; each description is `score N · <angle> · K sessions · ` followed by the topic's last line (`new log`, `updates <id>` or `merges <ids>`).

If the user picks none of them (types something else), do what they say: rerun discovery with a different note, or stop.

## 4. Log the chosen topic

Run `casebook discover pick <discovery-id> <rank>` and relay its output in a code block. `Created` is a new log; `Updated` means the topic was already logged and that log now covers it. If it lists logs merged into it, they were duplicates of this topic (often one log per session): their marks moved into the surviving log.

End with one line: `/casebook:show <id>` to read it, `/casebook:handoff <id>` to prepare it for a writer.
