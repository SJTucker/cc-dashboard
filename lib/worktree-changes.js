'use strict';

// Which files changed in a worker's worktree, found with git, for the DRIFT check of
// `bin/transcript-index --watch --run`. It sees edits made through Bash (sed -i, a
// heredoc, a script), which the transcript's Edit and Write steps do not show.

const path = require('path');
const { execFileSync } = require('child_process');

// git's output in the worktree, or null when git fails or takes over 5 s. The watch
// skips a poll on null rather than stopping. --no-optional-locks keeps git from
// rewriting the index, so a poll never holds index.lock while the worker commits.
// GIT_CEILING_DIRECTORIES stops git at the worktree's parent: a worktree folder left
// without its .git file sits inside the main checkout and would read that instead.
function gitOut(worktree, args) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', worktree, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(worktree) },
    });
  } catch {
    return null;
  }
}

// Uncommitted files against HEAD (deletions included) and untracked files git does
// not ignore. Each porcelain -z entry is "XY <path>".
function uncommitted(worktree) {
  const out = gitOut(worktree, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']);
  return out === null ? null : out.split('\0').filter(Boolean).map((e) => e.slice(3));
}

// Files the commits since head touch, counting only commits no other branch holds.
// A merge of the plan branch brings in commits the plan branch holds, so their files
// are not the worker's edits. Merge commits list no files.
function committed(worktree, head) {
  const branch = gitOut(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  if (!branch) return null;
  const exclude = branch === 'HEAD' ? [] : [`--exclude=${branch}`];
  const out = gitOut(worktree, ['log', '--format=', '--name-only', '--no-renames', '-z', 'HEAD', '--not', head, ...exclude, '--branches']);
  return out === null ? null : out.split(/[\0\n]/).filter(Boolean);
}

// Absolute paths, sorted: files changed since head by the worker, committed or not,
// deletions included, and untracked files git does not ignore. Null when git fails.
function changedSince(worktree, head) {
  const root = path.resolve(worktree);
  const now = uncommitted(root);
  const since = now === null ? null : committed(root, head);
  if (since === null) return null;
  return [...new Set([...now, ...since])].sort().map((f) => path.join(root, f));
}

// The worktree's HEAD when a watch starts, and the files already changed then. The
// watch reports only files that changed later, so a re-armed watch does not repeat
// what the last one saw. Null when git fails.
function worktreeBase(worktree) {
  const head = gitOut(path.resolve(worktree), ['rev-parse', 'HEAD'])?.trim();
  if (!head) return null;
  const before = changedSince(worktree, head);
  return before === null ? null : { head, before: new Set(before) };
}

module.exports = { changedSince, worktreeBase };
