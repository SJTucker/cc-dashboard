---
name: check-dashboard
description: Verify a change to public/ or to a server.js route in a real browser. Use before saying a dashboard panel renders, a button works, or a UI bug is fixed. Covers starting a throwaway server, handing the browser steps to the ui-check agent, reading console errors and failed requests, checking a panel by text, taking an element screenshot, mocking a POST route, and stopping the server.
---

# Check the dashboard in a browser

Do not report a panel as working from the source alone. Run these steps and report what the browser showed.

You start and stop the server and choose the data (sections 1, 2 and 8). The `ui-check` agent runs the browser steps (section 3). Sections 4 to 7 show how to read this page. Use them to write the checklist, or to run the steps yourself when you are debugging.

## 1. Start a throwaway server

Run from the checkout under test (the main checkout or a worktree). `server.js` reads `PORT` (or `--port`) and always binds 127.0.0.1.

```bash
SP=<your scratchpad dir>
PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
(CC_DASHBOARD_PRICE_CHECK=off CC_DASHBOARD_USAGE_REFRESH=off PORT=$PORT nohup node server.js > $SP/server.log 2>&1 & echo $! > $SP/server.pid)
until curl -sf -o /dev/null http://localhost:$PORT/api/limits; do sleep 1; done
```

Earlier sessions used fixed ports such as 3611 and 3658. A fixed port can collide with another session's server, so pick a free one.

`CC_DASHBOARD_USAGE_REFRESH=off` stops the server running `claude -p /usage`, which would rewrite the real `~/.claude.json` cache during a check.

Never run `pkill -f "node server.js"`. It kills the owner's own dashboard and other sessions' servers. Stop only your own pid (section 8).

## 2. Choose the data

- Read-only checks of layout, cards and charts: run against the real `~/.claude`, with no extra variables. Sessions did this most often, because real data has the shapes that break layouts.
- Checks that write (dismiss, undo, Check prices) or that need controlled numbers: point the server at a scratch config folder with `CLAUDE_CONFIG_DIR` (read in `lib/config-dir.js`). The server writes `cc-dashboard/transcripts.db` under that folder, so the real file stays untouched.

```bash
F=$SP/fixture; mkdir -p $F/projects/demo
# write one or more transcript .jsonl files into $F/projects/demo
CLAUDE_CONFIG_DIR=$F RTK_DB=$F/none.db CC_DASHBOARD_PRICE_CHECK=off CC_DASHBOARD_USAGE_REFRESH=off PORT=$PORT node server.js
```

`RTK_DB` (also read in `lib/config-dir.js`) stops the server reading the real rtk history. An empty `CLAUDE_CONFIG_DIR` gives the empty-state view. To copy real data instead, copy `~/.claude/cc-dashboard/transcripts.db` into `$F/cc-dashboard/` with `sqlite3 ~/.claude/cc-dashboard/transcripts.db ".backup $F/cc-dashboard/transcripts.db"`.

Use a copy for any branch that changes `EXTRACT_VERSION`. A worktree shares the real `transcripts.db` with the main checkout, and the owner usually has a server from `main` running on it. The branch's server writes rows at the new version, and `loadAll` in the older server skips rows newer than its own version, so the owner's dashboard loses history. Tell subagents this explicitly.
When `$F/projects` links or copies the real transcripts, the stored rows still name `~/.claude/projects/...`, so the server treats every stored file as deleted and reads each transcript again under its new path, and the old rows win where rows are deduplicated. Rewrite the stored paths after the copy: `sqlite3 $F/cc-dashboard/transcripts.db "update files set path = replace(path, '$HOME/.claude/projects', '$F/projects')"`.

## 3. Hand the browser steps to ui-check

When the check is a list of things to confirm, dispatch the `ui-check` agent instead of running `playwright-cli` yourself. It runs on Haiku, so each browser round costs far less than a round in your own context. Give it:

- the URL from section 1, and a session name such as `-s=dash-check`
- numbered steps, each with the exact text or value expected, for example "Click the `7d` range button. The Tool calls panel's Read row shows `0.4% err`."
- a request for console errors and failed requests
- any route mock from section 7, written out as the full command
- for a layout check, which element to screenshot and the path to save it to

Pass `model: "sonnet"` when a step needs a probe you cannot spell out, such as reading app state through `eval` or computing positions. Read the screenshots it returns yourself. It reports paths and does not judge appearance.

Run `playwright-cli` yourself when the browser is part of debugging, where each result decides your next edit. Also run it yourself when `ui-check` is not in your list of agent types.

## 4. Load the page and read the console

Every `playwright-cli` command takes the same `-s=dash-check` name, `open` and `close` included.

```bash
playwright-cli -s=dash-check open http://localhost:$PORT/ >/dev/null
sleep 3
playwright-cli -s=dash-check console error
playwright-cli -s=dash-check requests
```

`console error` lists errors only. `requests` numbers every request since load. Open a failing one with `playwright-cli -s=dash-check request <index>`. Reload with `playwright-cli -s=dash-check reload` after each edit to `public/`. Restart the server after an edit to `server.js` or `lib/`.

## 5. Check a panel by text

Use text, not screenshots.

```bash
playwright-cli -s=dash-check find "Session reviews"
playwright-cli -s=dash-check --raw eval "document.getElementById('cardCostNote').textContent"
playwright-cli -s=dash-check --raw eval "JSON.stringify([...document.querySelectorAll('#headerCards .card')].map(c => c.textContent))"
```

Panels fill in after their fetch finishes. Wrap a read that runs right after a click in `new Promise(r => setTimeout(() => r(...), 3000))`, as earlier sessions did. For a long script, write it to a file and pass it with `--raw eval "$(cat $SP/check.js)"`.

Range buttons are clicked with `playwright-cli -s=dash-check click "getByRole('button', { name: '7d', exact: true })"`. Narrow layouts are checked with `playwright-cli -s=dash-check resize 390 844`, then `reload`. Scroll position and sticky headers are read with `eval` on `getBoundingClientRect().top` and `window.scrollY`.

## 6. Screenshot only for layout

A screenshot stays in context for the rest of the session. Take one only when appearance is the thing being checked, and take it of one element:

```bash
playwright-cli -s=dash-check screenshot ".topbar" --filename=$SP/topbar.png
```

## 7. Mock a response

Mocks keep a test from writing to real data or from needing a specific state. Sessions mocked GET routes this way:

```bash
playwright-cli -s=dash-check route "**/api/records" --body='{"recentDays":[{"date":"2026-01-05","tokens":999000000000,"cost":1234.5}]}'
playwright-cli -s=dash-check goto http://localhost:$PORT/
playwright-cli -s=dash-check unroute
```

For a body kept in a file, use `playwright-cli -s=dash-check --raw run-code "async page => { await page.route('**/api/sessions/live', r => r.fulfill({ contentType: 'application/json', body: require('fs').readFileSync('$SP/live.json', 'utf8') })); await page.reload(); }"`.

The dismiss and undo route is `POST /api/reviews/:sessionId/suggestions/:idx/dismiss` (`DISMISS_PATH` in `server.js`). It writes to `transcripts.db`. No transcript shows a session mocking it. The same `route` command takes a path glob such as `**/api/reviews/*/suggestions/*/dismiss*`. The reply the page expects is `{"ok":true,"sessionId":...,"idx":...,"dismissedAt":...}` (`server.js` line 291). Alternatively run against a scratch `CLAUDE_CONFIG_DIR` and let the real route write there.

## 8. Stop

```bash
playwright-cli -s=dash-check close
kill $(cat $SP/server.pid)
```

`server.js` closes `transcripts.db` cleanly on SIGTERM. Confirm the port is free with `lsof -ti tcp:$PORT || echo free`.
