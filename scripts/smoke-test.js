// scripts/smoke-test.js
// Minimal smoke test: boots the server and verifies the /api/settings endpoint
// responds (that endpoint does not require a database connection).
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3999;

function fetchSettings() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/api/settings`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), SERVER_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  // Give the server a moment to start listening.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  try {
    const { status, body } = await fetchSettings();
    if (status !== 200) {
      console.error(`Smoke test FAILED: /api/settings returned ${status}`);
      process.exitCode = 1;
    } else {
      console.log(`Smoke test OK: /api/settings -> ${status} (${body.length} bytes)`);
    }
  } catch (err) {
    console.error('Smoke test FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main();
