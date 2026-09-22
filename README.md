# My Claude Code Dashboard

A small, local, offline dashboard for your Claude Code usage: daily and cumulative cost,
daily tokens broken out by input / output / cache-write / cache-read, cost by model with
dollars per million tokens, and a weekday-by-hour heatmap of when the spend happens.

Built to be easy to fully read in one sitting — four small files, two dependencies,
no telemetry, no CDN, no outbound network calls of its own.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3600**.

Options:
```bash
node server.js --port 3601      # use a different port
node server.js --open           # also open your browser automatically
```

By default it reads `~/.claude/projects`. If you use a custom Claude config
location, set `CLAUDE_CONFIG_DIR` before starting it, same as Claude Code itself:

```bash
CLAUDE_CONFIG_DIR=/path/to/.claude npm start
```

## What it does and doesn't do

- **Read-only.** It only ever calls `fs.readdirSync` / `fs.createReadStream` on your
  `~/.claude/projects` folder. There is no file-write code path anywhere in this
  project — grep for `writeFile` yourself and you won't find it.
- **No network calls.** Unlike some similar tools, this one does not fetch pricing
  from the internet, load a charting library from a CDN, or phone home in any way.
  The bar charts are hand-drawn SVG (see `public/app.js`). Pricing is a small
  hardcoded table in `lib/pricing.js`. The only thing that could make this reach the
  network is `npm install` itself, to fetch its two dependencies.
- **Localhost only.** The server binds to `127.0.0.1` and rejects any request whose
  `Host` header isn't `localhost`/`127.0.0.1`, which blocks the DNS-rebinding trick
  where a malicious website re-points its own hostname at your machine (see
  `lib/net-guard.js` for the full explanation). There's no login, so don't change
  the bind address to something network-reachable unless you understand that
  trade-off.
- **Pricing is an estimate.** `lib/pricing.js` has a hardcoded price-per-token table
  for Opus/Sonnet/Haiku/Fable/Mythos. Anthropic's pricing can change — check
  <https://claude.com/pricing> and edit the numbers at the top of that file if they
  drift. Any model it doesn't recognize is still counted in token totals but shown
  as "unpriced" rather than silently costed at $0.

## File layout

```
server.js          Express app: binds to localhost, serves /api/summary, serves public/
lib/scan.js         Walks ~/.claude/projects, parses JSONL, aggregates by day and model
lib/pricing.js       Offline per-token price table + cost calculation
lib/net-guard.js    Host-header check + security headers
public/index.html   Page shell
public/style.css    All styling
public/app.js        Fetches /api/summary, draws the SVG bar charts, no dependencies
```

## Extending it

A few obvious next steps if you want to keep going, roughly in order of effort:
- **Session drill-down**: `lib/scan.js` already has everything needed per-file; add
  an `/api/sessions` route that returns per-session totals instead of only the
  daily/model rollups.
- **Per-project breakdown**: project folder names under `~/.claude/projects` are
  the encoded path (e.g. `-Users-you-code-myapp`) — decode and group by them.
  Skipped in this offline version to keep the pricing table's approach honest: it's
  an estimate, and cost figures for pieces smaller than the machine-wide daily total
  didn't feel worth the extra code.
- **5-hour billing-window blocks**: mirror what `/usage` shows, by bucketing
  messages into rolling 5-hour windows instead of calendar days.
- **A `--live` mode**: rerun the scan on an interval and push updates over SSE
  instead of requiring a manual refresh.
