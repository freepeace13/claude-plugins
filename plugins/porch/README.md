# Porch

Turns notes or a prompt into a reviewed article or case study and saves it to [Porch](https://kinbasco.dev) as a **draft** through Porch's MCP server. You publish it in the Porch admin; the plugin never does.

```text
/plugin install porch@kinbasco-plugins
/porch:draft notes/queue-backoff.md --type article
/porch:push backoff-after-deploys
```

- `/porch:draft <path | prompt>` writes a brief, asks at most 3 questions, runs the writer agent and reviews the draft against the brief (2 revision rounds, then it hands back to you). Files live in `.porch/<slug>/`.
- `/porch:push <slug>` refuses unless the draft is approved and has no `<!-- verify` markers, then creates or updates the Porch draft.
- A `PreToolUse` hook blocks any `status: "published"` or `is_published: true` call to Porch.
- Put your own voice rules in `.porch/voice.md` to replace the default.

Text only: no images in or out. Tags, covers and featuring stay admin steps.

The MCP URL is in `.mcp.json`; edit it to point at a local Porch.
