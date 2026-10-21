// The native preview is a terminal-control API on loopback, and /api/spawn RUNS A
// COMMAND. That makes every rule index.js already follows apply here too, and the first
// version of this file followed none of them - it was a parallel server that skipped
// the project's own boundary (local-http.js, used at index.js:495).
//
// A localhost server is not private. Any page in your browser can POST to it, and a
// form with enctype="text/plain" is a SIMPLE request: no CORS preflight, so no CORS
// protection. readBody parsed it as JSON regardless of content type, so any website you
// visited could have run a command of its choosing on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreviewServer } from '../tools/native-preview.js';

const server = createPreviewServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
test.after(() => server.close());

const call = (path, opts = {}) => fetch(BASE + path, {
  ...opts,
  headers: { host: `127.0.0.1:${PORT}`, ...(opts.headers || {}) },
});

// The command an attacker would want to run, and a marker to prove it did not. A
// status code is the wrong assertion on its own: while writing these I got one of them
// wrong, the request went through as legitimately local, and the command RAN. So the
// test now checks the thing that matters - that nothing was executed.
const MARK = path.join(os.tmpdir(), `pc-guard-${process.pid}-${Date.now()}`);
const SPAWN = JSON.stringify({ cwd: os.tmpdir(), command: `touch ${MARK}` });
const ranSomething = () => fs.existsSync(MARK);

test.after(() => { try { fs.unlinkSync(MARK); } catch {} });

test('a POST from another website is refused, not run', async () => {
  const r = await call('/api/spawn', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: SPAWN,
  });
  assert.equal(r.status, 403);
});

test('sec-fetch-site marks a cross-site request even with no Origin header', async () => {
  const r = await call('/api/spawn', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: SPAWN,
  });
  assert.equal(r.status, 403);
});

// DNS rebinding: the attacker's name resolves to 127.0.0.1, so the connection is local
// but the Host header is theirs. fetch() will not send a Host it was given - the name
// is forbidden to scripts - so this goes over a raw socket, which is what the attacker
// actually has, and using fetch here tested nothing at all.
const raw = (headers, body = '{}') => new Promise((done) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/spawn', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
    (res) => { res.resume(); done(res.statusCode); });
  req.on('error', () => done(0));
  req.end(body);
});

test('a request addressed to someone elses hostname is refused', async () => {
  assert.equal(await raw({ host: 'evil.example' }, SPAWN), 403);
  assert.equal(await raw({ host: 'pokeclaude.attacker.test' }, SPAWN), 403);
  // and the real one still gets through
  assert.equal(await raw({ host: `127.0.0.1:${PORT}` }, '{}'), 400);
});

// The one that makes CORS irrelevant. text/plain, multipart/form-data and
// application/x-www-form-urlencoded are the three a <form> can send with no preflight.
test('a form-posted body is refused even though it parses as JSON', async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const r = await call('/api/spawn', {
      method: 'POST', headers: { 'content-type': type }, body: SPAWN,
    });
    assert.equal(r.status, 415, `${type} was accepted, so a plain form could spawn`);
  }
});

test('the page itself still works', async () => {
  const r = await call('/api/agents', { headers: { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' } });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).agents));
});

test('a native client with no Origin at all is still allowed', async () => {
  assert.equal((await call('/api/agents')).status, 200);
});

// Reading the screen is not harmless either: it is the contents of your terminals.
test('every route is behind the guard, not just the dangerous-looking ones', async () => {
  for (const [path, opts] of [
    ['/api/agents', {}],
    ['/api/screen?id=x', {}],
    ['/', {}],
    ['/js/termview.js', {}],
    ['/api/input', { method: 'POST', body: '{"id":"x","text":"y"}', headers: { 'content-type': 'application/json' } }],
    ['/api/close', { method: 'POST', body: '{"id":"x"}', headers: { 'content-type': 'application/json' } }],
  ]) {
    const r = await call(path, { ...opts, headers: { origin: 'https://evil.example', ...(opts.headers || {}) } });
    assert.equal(r.status, 403, `${path} answered a cross-origin request`);
  }
});

// .env in this repo holds CMUX_SOCKET_PASSWORD.
// The assertion the status codes are standing in for.
test('none of the refused requests actually ran anything', async () => {
  await new Promise(r => setTimeout(r, 400));
  assert.equal(ranSomething(), false, `a refused request still executed its command (${MARK})`);
});

test('the static route cannot be walked out of public/', async () => {
  for (const path of [
    '/js/../../.env', '/js/%2e%2e/%2e%2e/.env', '/js/..%2f..%2f.env',
    '/js/....//....//.env', '/js/../src/server/cmux.js',
  ]) {
    const r = await call(path);
    assert.notEqual(r.status, 200, `${path} served something outside public/js`);
  }
});
