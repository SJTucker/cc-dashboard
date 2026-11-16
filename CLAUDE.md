# cc-dashboard

## Keep SETUP.md current

`SETUP.md` lists everything a new user needs to run the dashboard. Update it in the
same change whenever that change does any of these:

- changes `engines` in `package.json`, or adds a dependency that needs a newer Node
- adds or removes a `process.env` read in `server.js`, `lib/`, `bin/` or `mod/`, or
  changes its default
- adds, moves or removes a file or folder under `<cfg>/cc-dashboard/`, or any other
  path outside the repo that the server, the `bin/` scripts or the mod read or write
- changes a file the mod reads to record setup changes
- changes how the mod is installed or finds `bin/`
- adds a network request or a model call

`bin/setup` runs the steps in "Quick setup". When a change alters a step it runs
(the Node floor, `npm install`, the mod link, `claude plugin validate`), change
`bin/setup` and `test/setup.test.js` in the same change.

Check the environment variable table and the files table in `SETUP.md` against the
code, not against the README.

## Scope

- The mod is the only supported way to feed the dashboard. Do not document, design
  for or mention a route without the mod, such as a user's statusline script piping
  into `bin/record-statusline` or a `SessionEnd` hook in settings.json. When a design
  needs data only the statusline JSON carries, say the mod cannot see it.
  Describing what the dashboard shows when the mod is not loaded is fine.
- Node 22.13 is the floor. New features may use `node:sqlite` and `transcripts.db`
  without a fallback, and designs and plans do not mention older Node versions. The
  existing degrade code in `lib/store.js` and `lib/rtk.js` stays unless the owner
  asks to remove it.
- A setting that hides or turns off a feature stops every call that feeds it: the
  page's `/api/*` request, the server's work, `bin/` scripts, and any model call the
  mod makes for it in `mod/hooks/register.ts`. A design for one lists which calls
  stop. Settings the mod honours live in a file under `<cfg>/cc-dashboard/`, because
  the mod cannot read the browser's localStorage.

## Tests

- Dashboard: `npm test`, which runs `node --test test/*.test.js`. A bare
  `node --test` also collects `mod/hooks/*.test.ts`, which import
  `claude-code/testing` and fail.
- Mod: `claude plugin test mod` from the repo root. `claude plugin validate mod`
  checks what the engine refuses to load.
- Live checks of the mod in a real session: the `check-mod` skill.
- Before designing around Claude Code behaviour, read
  `docs/claude-code-facts.md`. Each fact names the version it was checked on.

## UI

- A style change to one bar or chart applies to its siblings in the same panel.
  List the siblings and decide for all of them, and ask when the mapping is unclear.
- Split bars keep a fixed segment order and are never sorted by size. In Where usage
  goes, both bars draw the solid part on the left and the dim stripes on the right:
  Subagents | Main thread, and Under 150k | Over 150k.

## Ideas

- When the owner raises a future idea for cc-dashboard, write it as one file in
  `docs/ideas/` with a row in `docs/ideas/README.md`, and commit it. The file holds
  what was asked for, the decisions made and the open questions. This is an
  exception to the rule that design docs stay untracked. Plans and specs under
  `docs/superpowers/` stay untracked.
- Only ideas the owner raises go there. Deferred review findings are listed in chat.
- When an idea ships, delete its file and its README row in the same change.
- Ask before deleting an idea for a reason the owner has not stated. Claude Code's
  compaction is never a reason to drop handoff or resume work. The owner finds
  compaction summaries poor and prefers a handoff file, `/clear` and a resume.

## Worktrees

Create a worktree with worktrunk, based on local `main`:

```bash
wt switch --create <branch> --base main --no-cd
```

Local `main` is often ahead of `origin/main`. A worktree based on `origin/main`
leaves out the unpushed commits. `EnterWorktree` bases on `origin/main` by
default and turns on the isolation guard, so don't use it here.

## Commits

Squash a branch's commits into one before it merges into `main`. Use
`git reset --soft $(git merge-base main HEAD)` in the branch's worktree, then
commit once with a message that covers the whole branch.
