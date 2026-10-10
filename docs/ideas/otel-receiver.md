# Receive Claude Code's OpenTelemetry export

Accept Claude Code's OpenTelemetry metrics and events on a local endpoint, for the
data that transcripts do not hold. Recorded on 2026-10-10, from the second round of
research (claude-code-otel and Anthropic's monitoring docs at
https://code.claude.com/docs/en/monitoring-usage).

## What the export has that transcripts lack

- `claude_code.active_time.total`, split into user time and CLI time.
- `claude_code.code_edit_tool.decision`: accepted and rejected edits, per tool.
- `claude_code.commit.count` and `claude_code.pull_request.count`.
- `api_request` events with duration, and `api_error` events with status codes.
- `permission_mode_changed` events. [Subagent permission prompts](subagent-permission-prompts.md)
  is blocked on reading the permission mode, and this event may answer it.

## Open questions

- The server listens only on `127.0.0.1`. An OTLP receiver adds a write endpoint,
  which needs the same Host check as the other routes (`lib/net-guard.js`).
- OTLP over HTTP with JSON is the simplest to parse with no new dependency. Check
  that Claude Code can send it (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`).
- Turning the export on means setting environment variables in `settings.json`.
  The dashboard writes no Claude Code setting, so SETUP.md would give the steps.
- Where the events are stored, and for how long.
