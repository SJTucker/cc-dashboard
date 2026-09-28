# Refresh prices button

Add a button to the **Cost by model** panel (`#modelList` in `public/index.html`) that
updates the price table from Anthropic's published pricing, so a new model or a price
change does not need a code edit in `lib/pricing.js`.

## First decision: the no-network promise

The README says the dashboard makes "no outbound network calls of its own" (line 11)
and "does not fetch pricing from the internet" (line 157). A refresh button breaks
both statements. If this goes ahead:

- The fetch runs only when someone clicks the button. It never runs on page load or
  on a timer.
- The server makes the request. The browser's Content-Security-Policy is
  `default-src 'self'`, so the page could not fetch the pricing page anyway.
- Both README statements change to say exactly which request exists and what
  triggers it.

## How to get the prices

Anthropic has no pricing API. `GET /v1/models` returns ids, display names, context
windows and capabilities, but no prices.

The pricing page is also served as plain markdown at
`https://platform.claude.com/docs/en/about-claude/pricing.md`. A plain `fetch` of that
URL returns the tables as text, so neither a browser nor Playwright is needed. That
page has three things to parse:

1. The **Model pricing** table: base input, 5m and 1h cache writes, cache hits, and
   output per model.
2. The cache-read footnotes: 0.025x on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5,
   and 0.1x for every other model.
3. The **Fast mode pricing** table.

Checked on 2026-09-28: every price in `lib/pricing.js` matched that page.

A Playwright scrape of the rendered page is the fallback if the `.md` URL goes away.
It would add a large dependency to a project that has two, so it is not the first
choice.

## Sketch

1. `lib/price-fetch.js` fetches the `.md` page and parses the tables into rows with
   the same shape as `PRICE_TABLE`. Display names map to match keys, for example
   "Claude Opus 5.5" to `opus-5-5`.
2. `POST /api/prices/refresh`, with the same same-origin check `/api/refresh` uses.
   It returns the parsed rows and a diff against the prices in use, and changes
   nothing yet.
3. The panel shows the diff (new models, changed prices). An Apply button writes the
   rows to an override file, for example `~/.claude/cc-dashboard/prices.json`, with a
   fetched-at date.
4. `lib/pricing.js` loads the override file over the built-in table at startup and
   again after an apply. The built-in table stays as the fallback for when the file
   is missing or fails validation.
5. The panel shows where the prices came from: "built-in, 2026-09-28" or "fetched
   2026-10-15".

## Open questions

- **Validation.** A parse that returns nonsense must be refused. For example: every
  row needs positive input and output prices, output above input, and at least the
  models already in the built-in table. A refused parse keeps the current prices and
  says why.
- **Which panel.** The request said "that panel". This note assumes Cost by model,
  since it shows prices per model through its $/MTok column.
- **Where the override file lives.** Keeping it outside the repo means a `git pull`
  never conflicts with fetched prices. Keeping it inside the repo would let the
  fetched prices be committed.
