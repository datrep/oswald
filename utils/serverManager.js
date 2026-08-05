// utils/serverManager.js
// Generic child-process manager for the side services the dashboard can
// start/stop from the UI (e.g. the MCP filesystem server and the Oswald
// Fileserver). Adding a new managed server is just one new entry in
// DEFINITIONS — no new controller/route/UI copies.
//
// Note: spawned children are children of the dashboard process. On Windows an
// orphaned child survives if the dashboard dies, so a detached instance may
// still be listening on a port after a crash — the UI shows this via
// `portActive` when a definition exposes a `port`.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// name -> { label, description, port?, spawn() -> { command, args, options, logFile } }
const DEFINITIONS = {
  mcp: {
    label: 'MCP Filesystem Server',
    description: 'Model Context Protocol filesystem server, scoped to the project root.',
    spawn: () => ({
      command: process.execPath,
      args: [
        path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'),
        ROOT,
      ],
      options: { cwd: ROOT, windowsHide: true },
      logFile: path.join(ROOT, 'mcp.server.log'),
    }),
  },
  fileserver: {
    label: 'Oswald Fileserver',
    description: 'Separate HTTPS web UI + network share service on :8090.',
    port: 8090,
    spawn: () => ({
      command: process.execPath,
      args: [path.join(ROOT, 'fileserver', 'server.js')],
      options: { cwd: ROOT, windowsHide: true },
      logFile: path.join(ROOT, 'fileserver.log'),
    }),
  },
};

const children = {}; // name -> child process

function isRunning(name) {
  const c = children[name];
  return !!c && c.exitCode === null && !c.killed;
}

function attach(name, child, logFile) {
  try {
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
  } catch (err) {
    console.error(`[servers] ${name}: cannot open log ${logFile}:`, err.message);
  }
  child.on('error', (err) => {
    console.error(`[servers] ${name} spawn error:`, err.message);
    delete children[name];
  });
  child.on('exit', (code, signal) => {
    console.log(`[servers] ${name} exited (code=${code}, signal=${signal})`);
    delete children[name];
  });
}

function start(name) {
  const def = DEFINITIONS[name];
  if (!def) return { error: `Unknown server "${name}"` };
  if (isRunning(name)) {
    return { name, label: def.label, running: true, alreadyRunning: true, pid: children[name].pid };
  }
  const spec = def.spawn();
  const child = spawn(spec.command, spec.args, spec.options);
  children[name] = child;
  attach(name, child, spec.logFile);
  return { name, label: def.label, running: true, pid: child.pid };
}

function stop(name) {
  const def = DEFINITIONS[name];
  if (!def) return { error: `Unknown server "${name}"` };
  const child = children[name];
  if (!child) return { name, label: def.label, running: false };
  try {
    child.kill();
  } catch (err) {
    console.error(`[servers] ${name} stop error:`, err.message);
  }
  delete children[name];
  return { name, label: def.label, running: false };
}

// Synchronous status (no network probes) — safe to call from /api/health.
function status(name) {
  const def = DEFINITIONS[name];
  if (!def) return { error: `Unknown server "${name}"` };
  return {
    name,
    label: def.label,
    description: def.description,
    running: isRunning(name),
    pid: children[name] ? children[name].pid : null,
  };
}

// Does something already listen on 127.0.0.1:port? (a detached/other instance)
function probePort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// Async status that also probes the configured port (detached/external instance).
async function statusOne(name) {
  const s = status(name);
  if (DEFINITIONS[name] && DEFINITIONS[name].port) {
    s.portActive = await probePort(DEFINITIONS[name].port);
  }
  return s;
}

async function statusAll() {
  const out = [];
  for (const name of Object.keys(DEFINITIONS)) out.push(await statusOne(name));
  return out;
}

module.exports = { start, stop, status, statusOne, statusAll, DEFINITIONS };
