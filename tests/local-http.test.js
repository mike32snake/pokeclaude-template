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
const start = new Function('http', 'PORT', 'log', 'sendJson', 'state', 'applyHook',
  'broadcast', 'localRequestAllowed', bodySource + entry + '\nreturn server;');

async function fixture(t) {
  let hooks = 0;
  const state = {};
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = start(http, 0, () => {}, json, state, () => hooks++,
    () => {}, localRequestAllowed);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  return { server, hooks: () => hooks, port: server.address().port };
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
});
