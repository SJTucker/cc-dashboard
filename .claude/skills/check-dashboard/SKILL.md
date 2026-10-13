---
name: check-dashboard
description: Verify a change to public/ or to a server.js route in a real browser. Use before saying a dashboard panel renders, a button works, or a UI bug is fixed. Covers starting a throwaway server, reading console errors and failed requests, checking a panel by text, taking an element screenshot, mocking a POST route, and stopping the server.
---

# Check the dashboard in a browser

Do not report a panel as working from the source alone. Run these steps and report what the browser showed.

## 1. Start a throwaway server

Run from the checkout under test (the main checkout or a worktree). `server.js` reads `PORT` (or `--port`) and always binds 127.0.0.1.

```bash
SP=<your scratchpad dir>
PORT=$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
(PORT=$PORT nohup node server.js > $SP/server.log 2>&1 & echo $! > $SP/server.pid)
until curl -sf -o /dev/null http://localhost:$PORT/api/limits; do sleep 1; done
```

Earlier sessions used fixed ports such as 3611 and 3658. A fixed port can collide with another session's server, so pick a free one.

Never run `pkill -f "node server.js"`. It kills the owner's own dashboard and other sessions' servers. Stop only your own pid (step 6).

## 2. Choose the data

- Read-only checks of layout, cards and charts: run against the real `~/.claude`, with no extra variables. Sessions did this most often, because real data has the shapes that break layouts.
- Checks that write (dismiss, undo, Check prices) or that need controlled numbers: point the server at a scratch config folder with `CLAUDE_CONFIG_DIR` (read in `lib/config-dir.js`). The server writes `cc-dashboard/transcripts.db` under that folder, so the real file stays untouched.

```bash
F=$SP/fixture; mkdir -p $F/projects/demo
# write one or more transcript .jsonl files into $F/projects/demo
CLAUDE_CONFIG_DIR=$F RTK_DB=$F/none.db PORT=$PORT node server.js
```

`RTK_DB` (also read in `lib/config-dir.js`) stops the server reading the real rtk history. An empty `CLAUDE_CONFIG_DIR` gives the empty-state view. To copy real data instead, copy `~/.claude/cc-dashboard/transcripts.db` into `$F/cc-dashboard/` (one earlier session did this with `sqlite3 ... ".backup"`).

## 3. Load the page and read the console

```bash
playwright-cli open http://localhost:$PORT/ >/dev/null
sleep 3
playwright-cli console error
playwright-cli requests
```

`console error` lists errors only. `requests` numbers every request since load. Open a failing one with `playwright-cli request <index>`. Reload with `playwright-cli reload` after each edit to `public/`. Restart the server after an edit to `server.js` or `lib/`.

## 4. Check a panel by text

Use text, not screenshots.

```bash
playwright-cli find "Session reviews"
playwright-cli --raw eval "document.getElementById('cardCostNote').textContent"
playwright-cli --raw eval "JSON.stringify([...document.querySelectorAll('#headerCards .card')].map(c => c.textContent))"
```

Panels fill in after their fetch finishes. Wrap a read that runs right after a click in `new Promise(r => setTimeout(() => r(...), 3000))`, as earlier sessions did. For a long script, write it to a file and pass it with `--raw eval "$(cat $SP/check.js)"`.

Range buttons are clicked with `playwright-cli click "getByRole('button', { name: '7d', exact: true })"`. Narrow layouts are checked with `playwright-cli resize 390 844`, then `reload`. Scroll position and sticky headers are read with `eval` on `getBoundingClientRect().top` and `window.scrollY`.

## 5. Screenshot only for layout

A screenshot stays in context for the rest of the session. Take one only when appearance is the thing being checked, and take it of one element:

```bash
playwright-cli screenshot ".topbar" --filename=$SP/topbar.png
```

## 6. Mock a response

Mocks keep a test from writing to real data or from needing a specific state. Sessions mocked GET routes this way:

```bash
playwright-cli route "**/api/records" --body='{"allTime":{"date":"2026-01-05","tokens":999000000000,"cost":1234.5}}'
playwright-cli goto http://localhost:$PORT/
playwright-cli unroute
```

For a body kept in a file, use `playwright-cli --raw run-code "async page => { await page.route('**/api/sessions/live', r => r.fulfill({ contentType: 'application/json', body: require('fs').readFileSync('$SP/live.json', 'utf8') })); await page.reload(); }"`.

The dismiss and undo route is `POST /api/reviews/:sessionId/suggestions/:idx/dismiss` (`DISMISS_PATH` in `server.js`). It writes to `transcripts.db`. No transcript shows a session mocking it. The same `route` command takes a path glob such as `**/api/reviews/*/suggestions/*/dismiss*`. The reply the page expects is `{"ok":true,"sessionId":...,"idx":...,"dismissedAt":...}` (`server.js` line 291). Alternatively run against a scratch `CLAUDE_CONFIG_DIR` and let the real route write there.

## 7. Stop

```bash
playwright-cli close
kill $(cat $SP/server.pid)
```

`server.js` closes `transcripts.db` cleanly on SIGTERM. Confirm the port is free with `lsof -ti tcp:$PORT || echo free`.
