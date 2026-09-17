import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAgent } from '../src/server/startup.js';

const frame = draft => `› ${draft || 'Ask Codex to do anything'}\n\n  gpt-6-astra xhigh fast · /tmp`;
const task = '/tmp/screenshot.png\ncan you fix this issue on the website?';
const attached = '[Image #1]\n  can you fix this issue on the website?';

function pane({ draft = attached, swallowed = false, typeError = false, keyError = false,
  after = frame(''), readFailsAfter = false } = {}) {
  let screen = frame(''), submitted = false, readsAfter = 0;
  const writes = [], keys = [];
  const io = {
    sleep: async () => {},
    read: async () => {
      if (submitted && ++readsAfter > 2) {
        return readFailsAfter ? { ok: false } : { ok: true, stdout: swallowed ? screen : after };
      }
      return { ok: true, stdout: screen };
    },
    type: async (ws, text) => {
      writes.push([ws, text]); screen = frame(draft); submitted = false; readsAfter = 0;
      return typeError ? { ok: false, stderr: 'line 2 did not land' } : { ok: true };
    },
    key: async (ws, key) => {
      keys.push([ws, key]); submitted = true;
      return keyError ? { ok: false, stderr: 'terminal unavailable' } : { ok: true };
    },
  };
  return { io, writes, keys };
}

test('startup submits an image attachment and waits for the composer to clear', async () => {
  const p = pane();
  assert.equal((await startAgent('workspace:42', task, p.io)).ok, true);
  assert.deepEqual(p.writes, [['workspace:42', task]]);
  assert.deepEqual(p.keys, [['workspace:42', 'enter']]);
});

test('startup also submits a plain text task', async () => {
  const p = pane({ draft: 'hello' });
  assert.equal((await startAgent('workspace:42', 'hello', p.io)).ok, true);
});

test('a swallowed Enter fails without submitting or typing a second time', async () => {
  const p = pane({ swallowed: true });
  const result = await startAgent('workspace:42', task, p.io);
  assert.equal(result.ok, false);
  assert.match(result.error, /submission/i);
  assert.equal(p.writes.length, 1);
  assert.equal(p.keys.length, 1);
});

test('partial typing is reported immediately without submitting or retrying', async () => {
  const p = pane({ typeError: true });
  const result = await startAgent('workspace:42', task, p.io);
  assert.equal(result.ok, false);
  assert.match(result.error, /line 2/);
  assert.equal(p.writes.length, 1);
  assert.equal(p.keys.length, 0);
});

test('an Enter transport failure is reported', async () => {
  const p = pane({ keyError: true });
  const result = await startAgent('workspace:42', task, p.io);
  assert.equal(result.ok, false);
  assert.match(result.error, /terminal unavailable/);
  assert.equal(p.keys.length, 1);
});

for (const after of ['', 'user@host % ', 'Do you trust the contents of this directory?\n› 1. Yes, continue', '› Ask Codex to do anything\nEnter to select']) {
  test(`an unexpected screen after Enter does not confirm delivery: ${JSON.stringify(after)}`, async () => {
    const p = pane({ after });
    assert.equal((await startAgent('workspace:42', task, p.io)).ok, false);
    assert.equal(p.keys.length, 1);
  });
}

test('unreadable screens after Enter do not confirm delivery', async () => {
  const p = pane({ readFailsAfter: true });
  assert.equal((await startAgent('workspace:42', task, p.io)).ok, false);
  assert.equal(p.keys.length, 1);
});

test('an unrelated draft or a new dialog is never submitted', async () => {
  for (const draft of ['some other task', '1. Yes, continue\nDo you trust the contents of this directory?\n[Image #1]']) {
    const p = pane({ draft });
    assert.equal((await startAgent('workspace:42', task, p.io)).ok, false);
    assert.equal(p.keys.length, 0);
  }
});

test('startup waits through a trust dialog and an unreadable frame before typing', async () => {
  const p = pane();
  const read = p.io.read;
  let n = 0;
  p.io.read = async () => ++n <= 2
    ? n === 1 ? { ok: false } : { ok: true, stdout: 'Do you trust the contents of this directory?\n› 1. Yes, continue' }
    : read();
  assert.equal((await startAgent('workspace:42', task, p.io)).ok, true);
  assert.deepEqual(p.keys.map(k => k[1]), ['enter', 'enter']);
  assert.equal(p.writes.length, 1);
});

test('startup never types into a shell', async () => {
  const p = pane();
  p.io.read = async () => ({ ok: true, stdout: 'user@host % ' });
  assert.equal((await startAgent('workspace:42', task, p.io)).ok, false);
  assert.equal(p.writes.length, 0);
  assert.equal(p.keys.length, 0);
});
