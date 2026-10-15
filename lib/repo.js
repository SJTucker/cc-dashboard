'use strict';

// The git repo a path belongs to, for the Lines of code chart. A worktree counts as
// its main checkout, so the worktrees of one repo add up to one line.

const fs = require('fs');
const path = require('path');

// The folder name Claude Code gives a session's working folder under projects/:
// every character other than a letter or digit becomes '-'.
function encodeFolder(dir) {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

// The repo of a folder that holds `.git`, or null when it holds none. A `.git` file
// whose gitdir ends in /.git/worktrees/<name> belongs to a worktree, and the repo is
// the folder holding that .git. Any other `.git` file (a submodule, or one that
// cannot be read) makes the folder itself the repo.
function gitRoot(dir) {
  const dotGit = path.join(dir, '.git');
  const st = statOrNull(dotGit);
  if (!st) return null;
  if (st.isDirectory()) return dir;
  if (!st.isFile()) return null;
  let text;
  try {
    text = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return dir;
  }
  const line = /^gitdir:\s*(.+)$/m.exec(text);
  if (!line) return dir;
  const gitdir = path.resolve(dir, line[1].trim());
  const worktree = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
  return worktree ? worktree[1] : dir;
}

// A missing folder named <a>.<b> whose sibling <a> holds a .git folder is a deleted
// worktrunk worktree of <a>. A repo name can hold dots (next.js), so each dot
// position is tried from left to right and the first sibling with a .git folder wins.
function worktrunkSibling(dir) {
  const name = path.basename(dir);
  for (let dot = name.indexOf('.', 1); dot > 0; dot = name.indexOf('.', dot + 1)) {
    const sibling = path.join(path.dirname(dir), name.slice(0, dot));
    if (statOrNull(path.join(sibling, '.git'))?.isDirectory()) return sibling;
  }
  return null;
}

const repoByStart = new Map();

// The main checkout of the repo holding folder `start`, or null. Walks up one folder
// at a time. A deleted folder under <repo>/.claude/worktrees needs no rule of its
// own, because the walk reaches <repo>. A found repo is cached for the life of the
// process. A null is not cached, because a folder that Claude just wrote into can
// get a .git later (git init), and a stored null would never be corrected.
function findRepo(start) {
  if (typeof start !== 'string' || !path.isAbsolute(start)) return null;
  if (repoByStart.has(start)) return repoByStart.get(start);
  let repo = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    repo = statOrNull(dir) ? gitRoot(dir) : worktrunkSibling(dir);
    if (repo || path.dirname(dir) === dir) break;
  }
  if (repo) repoByStart.set(start, repo);
  return repo;
}

const repoByFolder = new Map();

// The repo for a transcript folder name such as
// -Users-bing-code-f-forge--claude-worktrees-poc2-taxi-lanes, for stored rows whose
// transcript is gone. The encoding loses which '-' was a '/', so this walks the file
// system from `root` and enters only folders whose encoded path is still a prefix of
// `folder`. The deepest folder reached that resolves through gitRoot wins.
function repoFromProjectFolder(folder, root = '/') {
  const key = `${root}\0${folder}`;
  if (repoByFolder.has(key)) return repoByFolder.get(key);
  let best = null;
  let bestLength = -1;
  const visit = (dir) => {
    const encoded = encodeFolder(dir);
    const prefix = encoded.endsWith('-') ? encoded : `${encoded}-`;
    if (folder !== encoded && !folder.startsWith(prefix)) return;
    const repo = gitRoot(dir);
    if (repo && encoded.length > bestLength) {
      best = repo;
      bestLength = encoded.length;
    }
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) if (child.isDirectory()) visit(path.join(dir, child.name));
  };
  visit(root);
  repoByFolder.set(key, best);
  return best;
}

// The folder under projects/ that holds a transcript, or null when the path has no
// projects segment followed by a folder and a file.
function projectFolderOf(transcriptPath) {
  const parts = String(transcriptPath).split(/[\\/]/);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === 'projects') return parts[i + 1] || null;
  }
  return null;
}

module.exports = { encodeFolder, findRepo, repoFromProjectFolder, projectFolderOf };
