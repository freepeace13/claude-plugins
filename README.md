# Kin Basco's Claude Code plugins

A plugin marketplace for [Claude Code](https://code.claude.com).

```text
/plugin marketplace add freepeace13/claude-plugins
/plugin install <plugin>@kinbasco-plugins
```

| Plugin | What it does |
|---|---|
| [casebook](plugins/casebook) | Logs potential case studies from every session automatically. You can mark and list the logs, and write case studies from them as Markdown by ID. |

## Development

```bash
node --test tests/*.test.js          # end-to-end tests (no API calls: a stub replaces `claude -p`)
claude plugin validate .             # marketplace manifest
claude plugin validate plugins/casebook
claude --plugin-dir plugins/casebook # try a plugin without installing it
```

MIT licensed.
