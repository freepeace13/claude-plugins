---
name: write
description: Write a case study Markdown file from one or more casebook logs, given their IDs. Use when the user wants to turn casebook logs into a case study.
argument-hint: "<log-id> [<log-id>…] [--out <dir>] [extra instructions]"
allowed-tools: Bash(casebook:*)
---

Write a case study from casebook logs. Arguments: `$ARGUMENTS`

1. Pull the log IDs (`cb-` + 6 letters/digits) out of the arguments. If there are none, run `casebook list --marked` and ask the user which IDs to use. Stop there.
2. Check each ID exists with `casebook show <id> --path`. If any is missing, say which one and stop.
3. Delegate to the **case-study-writer** subagent. Pass it the IDs, any `--out <dir>`, and the rest of the arguments as instructions from the user. Several IDs means one merged case study, unless the user asked for separate ones.
4. When it returns, reply with:
   - the output file path
   - the title
   - a one-sentence summary
   - any "verify" items the writer flagged

   Don't paste the whole case study unless asked.
