// A suggested prompt painted in an empty box is not a draft.
//
// After a turn, Claude Code paints a dimmed suggestion for the next prompt in the
// empty composer, and Tab takes it. read-screen returns no styles, so the panel read
// it as unsent text, refused every send to that pane, and "discard" backspaced
// fifty times over a box that held nothing, then reported the text still sitting
// there. Only its behaviour tells it from a draft: backspace does nothing to it,
// typing replaces it, and emptying the box brings it back. So the pane is asked:
// type one letter and look. A box that shows only the letter held nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeDraft } from '../src/server/cmux.js';

// A pane with a box. `held` is the real draft; `suggested` is what Claude Code
// paints whenever the box is empty. Captured behaviour, live on workspace:11.
function pane({ held = '', suggested = '' } = {}) {
  const log = [];
  let box = held;
  const shown = () => box || suggested;
  const io = {
    async write(ws, text) { log.push(['w', text]); box += text; return { ok: true }; },
    async key(ws, k) { log.push(['k', k]); if (k === 'backspace') box = box.slice(0, -1); return { ok: true }; },
    async read() {
      log.push(['r']);
      return { ok: true, stdout: '────────\n❯ ' + shown().replace(/\n/g, '\n  ') + '\n────────\n  ⏵⏵ bypass permissions on' };
    },
    async sleep() {},
  };
  return { io, log, box: () => box };
}

test('a suggestion painted in an empty box is a ghost, and the box is left empty', async () => {
  const p = pane({ suggested: 'AF is AdventHealth, Maria Sanchez, add her last name' });
  const r = await probeDraft('workspace:1', p.io);
  assert.equal(r.ghost, true);
  assert.equal(r.draft, 'AF is AdventHealth, Maria Sanchez, add her last name');
  assert.equal(p.box(), '', 'the probe leaves nothing behind');
});

test('a real draft is not a ghost, and comes through the probe untouched', async () => {
  const p = pane({ held: 'update PROJECT_STATE.md' });
  const r = await probeDraft('workspace:1', p.io);
  assert.equal(r.ghost, false);
  assert.equal(r.draft, 'update PROJECT_STATE.md');
  assert.equal(p.box(), 'update PROJECT_STATE.md');
});

test('a real draft that ends in a space keeps its space', async () => {
  const p = pane({ held: 'abc ' });
  const r = await probeDraft('workspace:1', p.io);
  assert.equal(r.ghost, false);
  assert.equal(p.box(), 'abc ');
});

test('a multi-line draft is not a ghost', async () => {
  const p = pane({ held: 'first\nsecond' });
  const r = await probeDraft('workspace:1', p.io);
  assert.equal(r.ghost, false);
  assert.equal(p.box(), 'first\nsecond');
});

test('an empty box is neither, and nothing is typed into it', async () => {
  const p = pane();
  const r = await probeDraft('workspace:1', p.io);
  assert.deepEqual(r, { ghost: false, draft: '' });
  assert.deepEqual(p.log.filter(e => e[0] !== 'r'), []);
});

test('the probe is one letter and one backspace, nothing more', async () => {
  const p = pane({ held: 'hello' });
  await probeDraft('workspace:1', p.io);
  assert.deepEqual(p.log.filter(e => e[0] !== 'r'), [['w', 'x'], ['k', 'backspace']]);
});

test('a pane that will not take the letter is reported, not guessed', async () => {
  const p = pane({ held: 'hello' });
  p.io.write = async () => ({ ok: false, stderr: 'no such surface' });
  const r = await probeDraft('workspace:1', p.io);
  assert.equal(r.ok, false);
  assert.equal(r.ghost, undefined);
});

test('a cursor in the middle of a draft is restored without a false freeze', async () => {
  let box = 'hello world';
  const io = {
    async write(ws, text) { box = box.slice(0, 5) + text + box.slice(5); return { ok: true }; },
    async key() { box = box.slice(0, 5) + box.slice(6); return { ok: true }; },
    async read() { return { ok: true, stdout: `────────\n❯ ${box}\n────────\n? for shortcuts` }; },
    async sleep() {},
  };
  const result = await probeDraft('w', io);
  assert.equal(result.ghost, false);
  assert.equal(box, 'hello world');
});
test('a swallowed cleanup does not permit a send with the probe still in the box', async () => {
  const p = pane({ suggested: 'next suggestion' });
  p.io.key = async () => ({ ok: true });
  const result = await probeDraft('w', p.io);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /cleanup/);
});
test('a picker is never probed by typing into its selected option', async () => {
  const p = pane();
  p.io.read = async () => ({ ok: true, stdout: '› 1. Yes\n  2. No\nPress enter to confirm' });
  const result = await probeDraft('w', p.io);
  assert.equal(result.ok, false);
  assert.deepEqual(p.log, []);
});
