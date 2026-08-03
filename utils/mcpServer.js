// utils/mcpServer.js
// Manages the MCP filesystem server as a child process, scoped to the project
// directory only (NOT the whole machine). Started/stopped on demand from the
// dashboard instead of being auto-launched from start.ps1.

const { spawn } = require('child_process');
const path = require('path');

const MCP_ENTRY = path.join(
  __dirname,
  '..',
  'node_modules',
  '@modelcontextprotocol',
  'server-filesystem',
  'dist',
  'index.js'
);
// Scope the filesystem server to the project root.
const ALLOWED_DIR = path.join(__dirname, '..');

let child = null;

function isRunning() {
  return child !== null && child.exitCode === null && !child.killed;
}

function start() {
  if (isRunning()) {
    return { running: true, alreadyRunning: true, pid: child.pid, allowedDir: ALLOWED_DIR };
  }

  child = spawn(process.execPath, [MCP_ENTRY, ALLOWED_DIR], {
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('error', (err) => {
    console.error('[MCP] failed to spawn filesystem server:', err);
    child = null;
  });

  child.on('exit', (code, signal) => {
    console.log(`[MCP] filesystem server exited (code=${code}, signal=${signal})`);
    child = null;
  });

  return { running: true, pid: child.pid, allowedDir: ALLOWED_DIR };
}

function stop() {
  if (!child) {
    return { running: false };
  }
  try {
    child.kill();
  } catch (err) {
    console.error('[MCP] error stopping filesystem server:', err);
  }
  child = null;
  return { running: false };
}

function status() {
  return { running: isRunning(), pid: child ? child.pid : null, allowedDir: ALLOWED_DIR };
}

module.exports = { start, stop, status };
