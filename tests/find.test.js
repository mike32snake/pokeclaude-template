// Cmd+F in a conversation.
//
// The browser's own find sees only what is drawn, and the panel draws the opening ask
// plus the last forty turns. A word said an hour ago is under "earlier turns not
// shown", so the native find reports no match for something that is in the transcript.
// PokeClaude.app has no find at all. So the panel has its own, and it reads the whole
// conversation before it says "no matches".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segments, step, countLabel, mergeTail } from '../public/js/find.js';

test('a text is cut into the parts that match and the parts that do not', () => {
  assert.deepEqual(segments('run npm test, then npm start', 'npm'), [
    { text: 'run ', hit: false }, { text: 'npm', hit: true },
    { text: ' test, then ', hit: false }, { text: 'npm', hit: true },
    { text: ' start', hit: false },
  ]);
});

test('matching ignores case and keeps the text as it was written', () => {
  assert.deepEqual(segments('Deploy to VERCEL', 'vercel'),
    [{ text: 'Deploy to ', hit: false }, { text: 'VERCEL', hit: true }]);
});

test('the query is plain text, never a pattern', () => {
  assert.deepEqual(segments('claude-opus-5[1m] (1M context)', '[1m]').filter(p => p.hit),
    [{ text: '[1m]', hit: true }]);
  assert.equal(segments('abc', '.').some(p => p.hit), false, 'a dot is a dot');
});

test('an empty query matches nothing', () => {
  assert.deepEqual(segments('hello', ''), [{ text: 'hello', hit: false }]);
});

test('next and previous wrap around the ends', () => {
  assert.equal(step(0, 3, 1), 1);
  assert.equal(step(2, 3, 1), 0);
  assert.equal(step(0, 3, -1), 2);
  assert.equal(step(0, 0, 1), 0, 'nothing to step through');
});

test('the counter says where you are, and says so when there is nothing', () => {
  assert.equal(countLabel(2, 12, 'npm'), '3 of 12');
  assert.equal(countLabel(0, 0, 'npm'), 'no matches');
  assert.equal(countLabel(0, 0, ''), '');
});

const m = (uuid, text, o = {}) => ({ uuid, role: 'assistant', text, tools: [], asks: [], ...o });

test('a live refresh adds new turns to the whole conversation', () => {
  const whole = [m('a', 'first'), m('b', 'second'), m('c', 'third')];
  const recent = [m('a', 'first'), { role: 'gap', text: '' }, m('c', 'third'), m('d', 'fourth')];
  assert.deepEqual(mergeTail(whole, recent).map(x => x.uuid), ['a', 'b', 'c', 'd'],
    'the middle the refresh left out must stay, and the gap marker must not come in');
});

test('a turn that grew while streaming is replaced in place', () => {
  const whole = [m('a', 'first'), m('b', 'wri')];
  const out = mergeTail(whole, [m('b', 'writing it all out')]);
  assert.deepEqual(out.map(x => x.text), ['first', 'writing it all out']);
});

test('turns with no id are matched by what they are, not added twice', () => {
  const whole = [m(null, 'hello codex', { role: 'user', at: 5 })];
  const out = mergeTail(whole, [m(null, 'hello codex', { role: 'user', at: 5 }), m(null, 'reply', { at: 6 })]);
  assert.deepEqual(out.map(x => x.text), ['hello codex', 'reply']);
});
