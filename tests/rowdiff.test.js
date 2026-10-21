// Sending a screen to a browser without freezing it.
//
// The first version of the preview pushed the whole grid on every frame: 25KB of JSON
// at up to 20 frames a second, and a full DOM rebuild of several thousand nodes each
// time. An idle agent was fine. A TUI drawing a spinner froze the tab outright, which
// no test caught and opening the page did.
//
// A redraw almost never touches every row, so only the rows that changed go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, rowKey } from '../public/js/rowdiff.js';

const row = (y, text, extra = {}) => ({ y, text, runs: [{ text, start: 0, fg: null, bg: null,
  fg256: null, bg256: null, bold: false, dim: false, italic: false, underline: false,
  inverse: false, strike: false, ...extra }] });
const screen = (...texts) => texts.map((t, y) => row(y, t));

test('the first send is everything, because the page has nothing yet', () => {
  const d = diffRows(null, screen('a', 'b', 'c'));
  assert.equal(d.full, true);
  assert.equal(d.rows.length, 3);
});

test('a screen that did not change sends nothing at all', () => {
  const s = screen('a', 'b', 'c');
  const d = diffRows(diffRows(null, s).keys, screen('a', 'b', 'c'));
  assert.equal(d.full, false);
  assert.equal(d.rows.length, 0);
});

test('only the rows that moved are sent, and they carry their own row number', () => {
  const first = diffRows(null, screen('a', 'b', 'c', 'd'));
  const d = diffRows(first.keys, screen('a', 'CHANGED', 'c', 'ALSO'));
  assert.equal(d.full, false);
  assert.deepEqual(d.rows.map(r => r.y), [1, 3]);
  assert.equal(d.rows[0].runs[0].text, 'CHANGED');
});

// Text alone is not the row. Claude Code marks its composer suggestion by making the
// same words dim, and a diff that missed that would leave the page showing a draft
// that is not there.
test('a row whose only change is its styling still counts as changed', () => {
  const first = diffRows(null, [row(0, 'same')]);
  const d = diffRows(first.keys, [row(0, 'same', { dim: true })]);
  assert.equal(d.rows.length, 1);
  assert.notEqual(rowKey(row(0, 'same')), rowKey(row(0, 'same', { dim: true })));
});

test('a colour change counts too', () => {
  const a = rowKey(row(0, 'x', { fg: 0xff0000 }));
  const b = rowKey(row(0, 'x', { fg: 0x00ff00 }));
  assert.notEqual(a, b);
});

test('a screen that got shorter says which rows are gone', () => {
  const first = diffRows(null, screen('a', 'b', 'c'));
  const d = diffRows(first.keys, screen('a'));
  assert.deepEqual(d.removed, [1, 2]);
});

test('a screen that got taller sends the new rows as changed', () => {
  const first = diffRows(null, screen('a'));
  const d = diffRows(first.keys, screen('a', 'b'));
  assert.deepEqual(d.rows.map(r => r.y), [1]);
  assert.deepEqual(d.removed, []);
});

// The number the whole change is for.
test('a one-line change is a fraction of the payload a whole screen is', () => {
  const big = Array.from({ length: 45 }, (_, y) => row(y, 'x'.repeat(160)));
  const full = diffRows(null, big);
  const next = big.map((r, y) => (y === 20 ? row(20, 'one line moved') : r));
  const small = diffRows(full.keys, next);
  const fullBytes = JSON.stringify(full.rows).length;
  const smallBytes = JSON.stringify(small.rows).length;
  assert.equal(small.rows.length, 1);
  assert.ok(smallBytes * 20 < fullBytes, `${smallBytes} vs ${fullBytes} is not a saving worth having`);
});
