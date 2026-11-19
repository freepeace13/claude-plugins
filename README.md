# Kin Basco's Claude Code plugins

A plugin marketplace for [Claude Code](https://code.claude.com).

```text
/plugin marketplace add freepeace13/claude-plugins
/plugin install <plugin>@kinbasco-plugins
```

| Plugin | What it does |
|---|---|
| [casebook](plugins/casebook) | Logs potential case studies from every session automatically. You can mark and list the logs, and write case studies from them as Markdown by ID. |
| [porch](plugins/porch) | Turns a notes file, folder or draft into a reviewed article or case study and saves it to Porch as a draft. You publish it in the admin. |

## Development

```bash
node --test tests/*.test.js          # end-to-end tests (no API calls: a stub replaces `claude -p`)
claude plugin validate .             # marketplace manifest
claude plugin validate plugins/casebook
claude plugin validate plugins/porch
claude --plugin-dir plugins/casebook # try a plugin without installing it
```

MIT licensed.
