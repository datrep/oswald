// test/desk-singleton.test.js — 2026-10-18 (feature desk-singleton-guard): the boot-time probe that refuses
// a SECOND desk. The defect it answers is measured, not theoretical: two desks ran at once on different
// interfaces and every capture reached the stale one while restarts reported success.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { probeExistingDesk } = require('../trading/lib/singleton');

function serve(body, status = 200) {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => { res.writeHead(status); res.end(body); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('probe: a desk answering /healthz with ok is ALIVE (boot must refuse)', async () => {
  const { srv, port } = await serve('ok');
  try {
    const r = await probeExistingDesk({ port, timeoutMs: 500 });
    assert.equal(r.alive, true);
    assert.equal(r.statusCode, 200);
  } finally { srv.close(); }
});

test('probe: nothing listening is NOT alive (boot proceeds)', async () => {
  // Bind then close to get a port that is reliably free.
  const { srv, port } = await serve('ok');
  await new Promise((r) => srv.close(r));
  const r = await probeExistingDesk({ port, timeoutMs: 300 });
  assert.equal(r.alive, false);
});

test('probe: a listener that is NOT a desk (200 but wrong body) must not block boot', async () => {
  // The port being occupied is not the question — something else could hold 8115 on a rebuilt machine.
  const { srv, port } = await serve('<html>not a desk</html>');
  try {
    const r = await probeExistingDesk({ port, timeoutMs: 500 });
    assert.equal(r.alive, false, 'a foreign listener must not be mistaken for a desk');
  } finally { srv.close(); }
});

test('probe: a non-200 answer is NOT alive', async () => {
  const { srv, port } = await serve('ok', 500);
  try {
    const r = await probeExistingDesk({ port, timeoutMs: 500 });
    assert.equal(r.alive, false);
  } finally { srv.close(); }
});
