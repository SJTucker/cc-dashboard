'use strict';

const os = require('os');
const path = require('path');

// The one place the dashboard reads its environment. The server and each bin/
// script call loadConfig once and pass the paths down. It requires nothing from
// lib/, so any module can require it without creating a require cycle.
//   CLAUDE_CONFIG_DIR  Claude Code's config folder. Default ~/.claude.
//   CHANGES_FILE       the hand-written setup changes. Default <repo>/changes.json.
//   RTK_DB             rtk's history. Default is the macOS location. There is no
//                      platform-detection branch: Linux and Windows users set it.
//   PORT               the server's port, as given. server.js validates it, so a bad
//                      value cannot stop the bin/ recorders.
// A leading ~ in a path is expanded. An empty value counts as unset.
function loadConfig(env = process.env) {
  const home = os.homedir();
  const expand = (p) => p.replace(/^~/, home);
  const configDir = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  return {
    configDir,
    // Claude Code keeps .claude.json in the home folder, and inside the config
    // folder only when CLAUDE_CONFIG_DIR is set.
    claudeJsonPath: env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json'),
    changesFile: env.CHANGES_FILE ? expand(env.CHANGES_FILE) : path.join(__dirname, '..', 'changes.json'),
    rtkDb: env.RTK_DB ? expand(env.RTK_DB) : path.join(home, 'Library', 'Application Support', 'rtk', 'history.db'),
    port: env.PORT || null,
  };
}

module.exports = { loadConfig };
