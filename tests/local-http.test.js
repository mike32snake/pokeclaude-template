import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { localRequestAllowed } from '../src/server/local-http.js';

// Run the actual HTTP entry point on an ephemeral port, excluding startup polling
// and machine integrations. Only the hook reducer is replaced with a counter.
const source = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
const entry = source.slice(source.indexOf('const server = http.createServer('));
const bodySource = source.slice(source.indexOf('function readBody(req)'), source.indexOf('// True once the composer'));
// Every name the entry point reaches for has to be injected here: a free identifier in
// that region is a ReferenceError, and inside the hook handler's try/catch it is a
// SWALLOWED one, so the symptom is a hook that silently does nothing. backendName is
// here because /api/hook now takes the backend - the hook fires for every Claude Code
// session on this machine, and only one backend's ids are ours. outbox is here because
// a hook is a pen changing state, which is when a waiting reply may go.
const start = new Function('http', 'PORT', 'log', 'sendJson', 'state', 'applyHook',
  'broadcast', 'localRequestAllowed', 'backendName', 'outbox',
  bodySource + entry + '\nreturn server;');

async function fixture(t) {
  let hooks = 0, kicks = 0;
  const state = {};
  const outbox = { kick: async () => { kicks++; } };
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = start(http, 0, () => {}, json, state, () => hooks++,
    () => {}, localRequestAllowed, 'cmux', outbox);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  return { server, hooks: () => hooks, kicks: () => kicks, port: server.address().port };
}

function request(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/hook',
      method: 'POST', headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('the HTTP entry point binds only to loopback', async t => {
  const { server } = await fixture(t);
  assert.equal(server.address().address, '127.0.0.1');
});

test('foreign website posts and rebinding hosts are refused before the hook runs', async t => {
  const f = await fixture(t);
  const host = `localhost:${f.port}`;
  for (const headers of [
    { host, origin: 'https://evil.example' },
    { host, origin: 'null' },
    { host, origin: `http://localhost:${f.port + 1}` },
    { host: `evil.example:${f.port}` },
    { host, 'sec-fetch-site': 'cross-site' },
    { host, 'sec-fetch-site': 'same-site' },
  ]) assert.equal(await request(f.port, headers), 403, JSON.stringify(headers));
  assert.equal(f.hooks(), 0);
});

test('same-origin browsers and native localhost hooks still work', async t => {
  const f = await fixture(t);
  for (const name of ['localhost', '127.0.0.1', '[::1]']) {
    const host = `${name}:${f.port}`;
    assert.equal(await request(f.port, { host }), 200);
    assert.equal(await request(f.port, { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), 200);
  }
  assert.equal(f.hooks(), 6);
  assert.equal(f.kicks(), 6, 'every accepted hook should give the reply queue a look');
});
