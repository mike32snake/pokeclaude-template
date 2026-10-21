// A two-question ask whose second question is a multi-select, captured screen by screen
// from a real Claude Code pen (v2.1.286) on 2026-09-30. Someone had to finish exactly this
// shape of question in Terminal controls: the panel could tick boxes but could not
// submit them, and on most of these screens it could not see the question at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pendingPrompt, parseAsk, stepsTo } from '../src/server/pending.js';
import { chooseOption } from '../src/server/terminal.js';

const DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', 'multiselect');
const screen = (name) => fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8');
const ask = (name) => parseAsk(pendingPrompt(screen(name)));
const SCREENS = ['q1', 'q2', 'q2-red', 'q2-redblue', 'q2-ontype', 'q2-onsubmit', 'review'];

// The message you sent is echoed into the scrollback as "❯ your words". It was taken
// for the input box, and everything under it - the whole question - was thrown away.
test('the message you sent, echoed above a question, is not the input box', () => {
  for (const name of SCREENS) assert.ok(pendingPrompt(screen(name)), `${name}: the question was not seen`);
});

test('once the question is answered, the echoed messages do not make it look asked', () => {
  assert.equal(pendingPrompt(screen('answered')), null);
});

// A ticked box is drawn "[✔]", not "[x]". Unread, it stayed in the label, the tick was
// lost, and the next click named an option the panel had never offered.
test('a tick drawn as [✔] is state, and the label is just the answer', () => {
  const a = ask('q2-redblue');
  assert.equal(a.multi, true);
  const by = Object.fromEntries(a.options.map(o => [o.label, o]));
  assert.equal(by.Red.checked, true);
  assert.equal(by.Blue.checked, true);
  assert.equal(by.Green.checked, false);
  assert.ok(!a.options.some(o => o.label.includes('[')), 'a checkbox is still in a label');
});

// An answered question is marked ☒ in the strip across the top, and was dropped.
test('an answered question keeps its tab, marked done', () => {
  assert.deepEqual(ask('q2').tabs, [{ label: 'Fruit', done: true }, { label: 'Colors', done: false }]);
  assert.deepEqual(ask('q1').tabs, [{ label: 'Fruit', done: false }, { label: 'Colors', done: false }]);
});

// The multi-select's own Submit row carries no number, so the panel could not see it,
// reach it, or press it. It is an option of its own kind, numbered 0.
test('a multi-select offers its Submit row, and knows when the cursor is on it', () => {
  const a = ask('q2-redblue');
  const submit = a.options.find(o => o.kind === 'submit');
  assert.ok(submit, 'no Submit row');
  assert.equal(submit.n, 0);
  assert.equal(submit.selected, false);
  assert.equal(ask('q2-onsubmit').options.find(o => o.kind === 'submit').selected, true);
  assert.equal(ask('q1').options.find(o => o.kind === 'submit'), undefined, 'a single-select has no Submit row');
});

test('the way to Submit is counted from the cursor like any other option', () => {
  assert.deepEqual(stepsTo(ask('q2-redblue').options, 0), { key: 'down', count: 2 });
});

test('the review screen is an ordinary question the panel can answer', () => {
  const a = ask('review');
  assert.equal(a.multi, false);
  assert.deepEqual(a.options.map(o => [o.n, o.label]), [[1, 'Submit answers'], [2, 'Cancel']]);
});

// The pane, replayed: each key moves to the next real screen, in the order they came.
function replay(start, moves) {
  const keys = [];
  return { keys, now: screen(start),
    async read() { return { ok: true, stdout: this.now }; },
    async key(ws, key) { keys.push(key); const next = moves[`${this.name || start}|${key}`];
      if (next) { this.name = next; this.now = screen(next); } return { ok: true }; },
    async sleep() {} };
}

test('Submit from the panel walks to the row and presses Enter there, and nowhere else', async () => {
  const io = replay('q2-redblue', {
    'q2-redblue|down': 'q2-ontype', 'q2-ontype|down': 'q2-onsubmit', 'q2-onsubmit|enter': 'review',
  });
  const r = await chooseOption('w', { optionIndex: 0, optionLabel: 'Submit', question: 'Which colors?' }, io);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(io.keys, ['down', 'down', 'enter']);
  assert.equal(r.stillAsking, true, 'the review screen is still a question');
});

test('ticking a box from the panel still works once one is ticked', async () => {
  const io = replay('q2-red', {});
  const r = await chooseOption('w', { optionIndex: 1, optionLabel: 'Red', question: 'Which colors?' }, io);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(io.keys, ['enter']);
});
