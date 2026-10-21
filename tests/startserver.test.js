// tools/start-server.sh is the one way to start the server, for a person and for
// PokeClaude.app alike. The native backend needs no cmux, so it runs under pm2; only
// POKECLAUDE_BACKEND=cmux still needs a cmux workspace, whose socket is cmuxOnly.
//
// Stubs stand in for pm2 and cmux on PATH and write down how they were called, so no
// test here starts, stops or restarts the real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'start-server.sh');

function run({ backend, pm2Knows = false, withPm2 = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-start-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls');
  const stub = (name, body = '') => fs.writeFileSync(path.join(bin, name),
    `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`, { mode: 0o755 });
  if (withPm2) stub('pm2', `[ "$1" = describe ] && exit ${pm2Knows ? 0 : 1}; exit 0`);
  stub('cmux');
  stub('nohup');
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, PC_CMUX_BIN: path.join(bin, 'cmux') };
  if (backend) env.POKECLAUDE_BACKEND = backend;
  execFileSync('/bin/bash', [SCRIPT], { env, cwd: dir });
  // The no-pm2 path backgrounds its child, so give that stub a moment to write. One
  // second was not enough under a full `npm test`, and the test failed about half the time.
  for (let i = 0; i < 250 && !fs.existsSync(calls); i++) execFileSync('/bin/sleep', ['0.02']);
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
}

test('native, first time: pm2 starts the server by name from the repo', () => {
  const calls = run();
  const start = calls.find(c => c.startsWith('pm2 start'));
  assert.ok(start, `pm2 was not asked to start anything: ${calls}`);
  assert.match(start, /src\/server\/index\.js/);
  assert.match(start, /--name pokeclaude/);
  assert.ok(!calls.some(c => c.startsWith('cmux')), 'native must not touch cmux');
});

test('native, pm2 already knows it: start it by name, do not add a second copy', () => {
  const calls = run({ pm2Knows: true });
  assert.ok(calls.includes('pm2 start pokeclaude'), `got: ${calls}`);
  assert.ok(!calls.some(c => /index\.js/.test(c)), 'a second registration would crash-loop on the port');
});

test('native without pm2 still starts, detached, and still without cmux', () => {
  const calls = run({ withPm2: false });
  assert.ok(calls.some(c => c.startsWith('nohup') && /run-server\.sh/.test(c)), `got: ${calls}`);
  assert.ok(!calls.some(c => c.startsWith('cmux')));
});

test('the cmux backend still opens its own cmux workspace, and never pm2', () => {
  const calls = run({ backend: 'cmux' });
  assert.ok(calls.some(c => c.startsWith('cmux new-workspace') && /run-server\.sh/.test(c)), `got: ${calls}`);
  assert.ok(!calls.some(c => c.startsWith('pm2')));
});
