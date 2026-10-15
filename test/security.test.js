'use strict';

// Access control of the legacy Smart Bridge: exact Origin allow-list, loopback
// Host, Private Network Access preflight, pairing token. Boots the real
// smart-bridge.js (throwaway HOME so it can't touch the user's Claude config).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const sec = require('../bridge-security');

const APP = 'https://www.clashcontrol.io';
const EVIL = 'https://evil.example.com';
const WS_PORT = 19802; // fixed in smart-bridge.js

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function request(port, method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const outcome = (url, opts) => new Promise((resolve) => {
  const ws = new WebSocket(url, opts);
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
  ws.on('error', () => resolve('error'));
});

describe('legacy smart-bridge.js access control', () => {
  let child, REST, home;

  before(async () => {
    REST = await freePort();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legacy-sec-'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'smart-bridge.js')], {
      env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home, APPDATA: home, PORT: String(REST) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start')), 10000);
      const onData = (d) => { if (String(d).includes('REST API')) { clearTimeout(t); resolve(); } };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('exit', (c) => reject(new Error('bridge exited early: ' + c)));
    });
    await new Promise((r) => setTimeout(r, 300));
  });

  after(() => {
    if (child) child.kill();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  const pair = async () => JSON.parse((await request(REST, 'POST', '/pair', { Origin: APP })).body).token;

  test('the wildcard CORS header is gone', async () => {
    for (const hdrs of [{}, { Origin: APP }, { Origin: EVIL }]) {
      const r = await request(REST, 'GET', '/status', hdrs);
      assert.notStrictEqual(r.headers['access-control-allow-origin'], '*');
    }
  });

  test('hostile origin is refused everywhere, including the self-update trigger', async () => {
    for (const [m, p] of [['GET', '/status'], ['GET', '/tools'], ['POST', '/update'], ['POST', '/call/get_clashes'], ['POST', '/pair'], ['OPTIONS', '/call/x']]) {
      const r = await request(REST, m, p, { Origin: EVIL });
      assert.strictEqual(r.status, 403, m + ' ' + p);
      assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
    }
  });

  test('"null" origin and localhost dev origins are refused', async () => {
    for (const o of ['null', 'http://localhost:3000', 'http://127.0.0.1:5173']) {
      assert.strictEqual((await request(REST, 'GET', '/status', { Origin: o })).status, 403, o);
    }
  });

  test('DNS-rebinding Host is refused', async () => {
    assert.strictEqual((await request(REST, 'GET', '/status', { Host: 'attacker.example:' + REST })).status, 421);
  });

  test('preflight from the app answers Private Network Access and allows the token header', async () => {
    const r = await request(REST, 'OPTIONS', '/call/x', { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['access-control-allow-origin'], APP);
    assert.strictEqual(r.headers['access-control-allow-private-network'], 'true');
    assert.match(r.headers['access-control-allow-headers'], /X-CC-Pairing-Token/i);
  });

  test('browser calls need a pairing token; /status does not; a paired token unlocks the API', async () => {
    assert.strictEqual((await request(REST, 'GET', '/status', { Origin: APP })).status, 200);
    const noTok = await request(REST, 'GET', '/tools', { Origin: APP });
    assert.strictEqual(noTok.status, 401);
    assert.strictEqual(noTok.headers['access-control-allow-origin'], APP);
    assert.strictEqual((await request(REST, 'GET', '/tools', { Origin: APP, 'X-CC-Pairing-Token': 'nope' })).status, 401);
    const token = await pair();
    assert.strictEqual((await request(REST, 'GET', '/tools', { Origin: APP, 'X-CC-Pairing-Token': token })).status, 200);
  });

  test('origin-less local tooling (curl, ChatGPT-actions tunnel, MCP) needs no token', async () => {
    assert.strictEqual((await request(REST, 'GET', '/tools')).status, 200);
    assert.strictEqual((await request(REST, 'GET', '/openapi.json')).status, 200);
  });

  test('WS: hostile origin / no token / bad token refused; paired app origin connects', async () => {
    const token = await pair();
    assert.strictEqual(await outcome(`ws://127.0.0.1:${WS_PORT}/?cc_token=${token}`, { origin: EVIL }), 403);
    assert.strictEqual(await outcome(`ws://127.0.0.1:${WS_PORT}/?cc_token=${token}`, { origin: 'null' }), 403);
    assert.strictEqual(await outcome(`ws://127.0.0.1:${WS_PORT}/`, { origin: APP }), 401);
    assert.strictEqual(await outcome(`ws://127.0.0.1:${WS_PORT}/?cc_token=nope`, { origin: APP }), 401);
    assert.strictEqual(await outcome(`ws://127.0.0.1:${WS_PORT}/?cc_token=${token}`, { origin: APP }), 'open');
  });

  test('WS: an Origin-less local peer (the REST<->MCP relay) still connects', async () => {
    assert.strictEqual(await outcome(`ws://127.0.0.1:${WS_PORT}/`), 'open');
  });
});

describe('bridge-security helpers', () => {
  test('allow-list is exact and dev origins are opt-in', () => {
    assert.ok(sec.isAllowedOrigin(APP, {}));
    for (const o of ['null', '', 'http://localhost:3000', 'https://clashcontrol.io.evil.com', 'http://www.clashcontrol.io']) assert.ok(!sec.isAllowedOrigin(o, {}), o);
    assert.ok(sec.isAllowedOrigin('http://localhost:8000', { CLASHCONTROL_ALLOWED_ORIGINS: 'http://localhost:8000' }));
    assert.ok(!sec.isAllowedOrigin('*', { CLASHCONTROL_ALLOWED_ORIGINS: '*' }));
  });
  test('tokens expire and are capped', () => {
    let t = 0;
    const st = sec.createPairingStore({ ttlMs: 1000, maxTokens: 2, now: () => t });
    const a = st.issue().token, b = st.issue().token, c = st.issue().token;
    assert.ok(!st.valid(a) && st.valid(b) && st.valid(c));
    t += 1001;
    assert.ok(!st.valid(b) && !st.valid(c));
  });
});
