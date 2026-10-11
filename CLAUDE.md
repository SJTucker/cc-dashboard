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
