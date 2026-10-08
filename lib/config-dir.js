'use strict';

const os = require('os');
const path = require('path');

// The one place the dashboard resolves CLAUDE_CONFIG_DIR. It requires nothing from
// lib/, so any module can require it without creating a require cycle.
function getConfigDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR.replace(/^~/, os.homedir());
  return path.join(os.homedir(), '.claude');
}

module.exports = { getConfigDir };
