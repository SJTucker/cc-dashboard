# Docker for the dashboard

Check whether a Docker image makes the dashboard easier to ship and run. Asked for on
2026-10-08, as one of two steps toward getting the project ready to ship. The other
is [a setup script](setup-script.md).

## What exists

- `npm start` runs `server.js` on Node 22.13 or later. The server reads Claude Code's
  files under `CLAUDE_CONFIG_DIR` (default `~/.claude`) and writes
  `<cfg>/cc-dashboard/transcripts.db` and `prices.json`. `SETUP.md` lists every path.
- `server.js` binds `127.0.0.1` only (`HOST`, not configurable).
  `hostGuard` in `lib/net-guard.js` answers 403 to any `Host` header that is not a
  loopback name.
- The mod in `mod/` runs inside Claude Code on the host. It runs the `bin/` scripts
  directly, so the host needs `node` on Claude Code's PATH whether or not the server
  runs in a container.
- `bin/review-session` and the server both write `transcripts.db`, which runs in
  SQLite WAL mode.

## Open questions

- **What the image is for.** The server only, with the mod and `bin/` scripts still
  on the host. Decide whether that saves a new user any step, given the host still
  needs Node for the mod.
- **SQLite WAL across the container boundary.** On macOS, Docker Desktop runs
  containers in a VM and shares host folders over a file-sharing layer. WAL needs
  shared memory (`transcripts.db-shm`) that every writer maps. A host
  `bin/review-session` and a containerised server writing the same file may not see
  each other's locks. Test this before anything else, because it can corrupt the
  database.
- **Binding and the host check.** A container must listen on `0.0.0.0` to be
  reachable through a published port. `HOST` and `hostGuard` would need a way to
  allow that, without opening the server to the network. One option is to publish
  only on `127.0.0.1:3600` on the host.
- **Mounts.** `~/.claude` mounted read-write (the server writes `cc-dashboard/`), and
  rtk's `~/Library/Application Support/rtk/history.db` mounted read-only with
  `RTK_DB` set.
- **File ownership.** Files the container writes under `~/.claude/cc-dashboard/` must
  stay owned by the host user, or the host scripts cannot write them.
- **Base image and size.** For example `node:22-alpine`, `npm ci --omit=dev`, and no
  build step.
- **Whether to ship it.** If the WAL question has no safe answer, record that here and
  close the idea in favour of the setup script.
