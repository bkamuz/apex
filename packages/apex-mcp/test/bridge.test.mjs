// Live bridge: localhost only, token required, requests round-trip to the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { LiveBridge, AutoBackend, isLocalOrigin, HeadlessBackend } from '../dist/index.js';

const open = (url, headers) =>
  new Promise((res) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => res({ ws, ok: true }));
    ws.once('unexpected-response', (_req, r) => res({ ok: false, status: r.statusCode }));
    ws.once('error', () => res({ ok: false }));
  });

test('origin check', () => {
  assert.equal(isLocalOrigin('http://localhost:5173'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:4173'), true);
  assert.equal(isLocalOrigin('https://evil.example'), false);
  assert.equal(isLocalOrigin('http://localhost.evil.example'), false);
});

test('refuses non-loopback binds', async () => {
  await assert.rejects(LiveBridge.start({ port: 0, host: '0.0.0.0', token: 't' }));
});

test('token and origin are enforced; requests round-trip', async () => {
  const bridge = await LiveBridge.start({ port: 0, token: 'secret-token', timeoutMs: 2000 });
  try {
    assert.equal((await open(`${bridge.url}/?token=wrong`)).status, 401);
    assert.equal((await open(`${bridge.url}/?token=secret-token`, { Origin: 'https://evil.example' })).status, 403);
    assert.equal(bridge.connected(), false);
    await assert.rejects(bridge.query({ op: 'summary' }), /no Apex app is connected/);

    const { ws, ok } = await open(`${bridge.url}/?token=secret-token`, { Origin: 'http://localhost:5173' });
    assert.ok(ok);
    ws.send(JSON.stringify({ type: 'hello', app: 'fake' }));
    ws.on('message', (raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      if (method === 'query') ws.send(JSON.stringify({ id, result: { echoed: params.query.op } }));
      else ws.send(JSON.stringify({ id, error: `unsupported ${method}` }));
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.connected(), true);
    assert.deepEqual(await bridge.query({ op: 'summary' }), { echoed: 'summary' });
    await assert.rejects(bridge.execute({ op: 'undo' }), /unsupported execute/);

    // Auto routes to the live app while it is connected, headless otherwise.
    const auto = new AutoBackend(await HeadlessBackend.create(), bridge);
    assert.deepEqual(await auto.query({ op: 'summary' }), { echoed: 'summary' });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const local = await auto.query({ op: 'summary' });
    assert.equal(typeof local.element_count, 'number');
  } finally {
    await bridge.close();
  }
});
