# Other coding agents

Read the session logs of other coding agents, such as Codex CLI, so the dashboard
covers all of one person's agent usage. Recorded on 2026-10-10, from the second
round of research. ccusage reads Codex, opencode, Gemini and Copilot logs, and
tokscale reads several agents.

## What exists

- Every reader in `lib/` assumes Claude Code's transcript format and folder layout.
- Codex CLI writes rollout JSONL files under `~/.codex/sessions` with `token_count`
  events. Not checked here.

## Open questions

- Whether this is in scope. The mod, the plan limits, the Setup changes panel and
  the session reviews are all Claude Code specific.
- Pricing: `lib/pricing.js` holds Anthropic prices only.
- Whether a second agent shows as its own model family in the existing panels, or
  as a separate panel.
