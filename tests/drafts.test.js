// An unsent message belongs to the Pokemon it was typed at. Clicking another one and
// coming back must show it again, so the box is per-agent, not one shared buffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDrafts } from '../public/js/drafts.js';

const fakeStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

test('each agent keeps its own unsent text', () => {
  const d = makeDrafts(fakeStore());
  d.set('ws-a', 'half a thought');
  d.set('ws-b', 'something else');
  assert.equal(d.get('ws-a'), 'half a thought');
  assert.equal(d.get('ws-b'), 'something else');
});

test('an agent with nothing typed at it reads as an empty box', () => {
  const d = makeDrafts(fakeStore());
  assert.equal(d.get('ws-a'), '');
  assert.equal(d.get(null), '');
});

test('clearing the box forgets the draft instead of storing an empty one', () => {
  const d = makeDrafts(fakeStore());
  d.set('ws-a', 'typed');
  d.set('ws-a', '   ');
  assert.equal(d.get('ws-a'), '');
  assert.equal(d.count(), 0);
});

test('whitespace inside a real draft is kept exactly as typed', () => {
  const d = makeDrafts(fakeStore());
  d.set('ws-a', 'line one\n  indented');
  assert.equal(d.get('ws-a'), 'line one\n  indented');
});

test('drafts survive a reload, because they are written to storage', () => {
  const store = fakeStore();
  makeDrafts(store).set('ws-a', 'still here');
  assert.equal(makeDrafts(store).get('ws-a'), 'still here');
});

test('a broken store never stops the composer from working', () => {
  const bad = { getItem: () => '{{{', setItem: () => { throw new Error('full'); } };
  const d = makeDrafts(bad);
  d.set('ws-a', 'typed');
  assert.equal(d.get('ws-a'), 'typed');
});

test('sending clears only that agent, not the rest', () => {
  const d = makeDrafts(fakeStore());
  d.set('ws-a', 'a'); d.set('ws-b', 'b');
  d.clear('ws-a');
  assert.equal(d.get('ws-a'), '');
  assert.equal(d.get('ws-b'), 'b');
});
