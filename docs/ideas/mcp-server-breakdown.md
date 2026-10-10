# MCP server breakdown

Group MCP tool calls by server in the Tool calls panel, and show each server's share
of context at session start. Recorded on 2026-10-10.

## What exists

- MCP tools are named `mcp__<server>__<tool>`. The Tool calls panel
  (`public/panels/tools.mjs`) lists each one as its own tool.
- Context at session start (`lib/efficiency.js`) includes every MCP server's tool
  definitions, but the number cannot be split by source.

## What it could show

- Calls and errors per MCP server, with the server's tools listed under it.
- Servers that are connected but never called in the range. Their tool definitions
  are paid for in every session's context.

## Open questions

- Finding connected but unused servers needs the list of configured servers. The mod
  may be able to read it, or the dashboard could read `.mcp.json` and the
  `mcpServers` keys in the settings files.
- Measuring a server's share of session-start context. `/context` shows it, but it
  writes no transcript line.
