import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalAction, chooseOption } from '../src/server/terminal.js';
const picker = (selected = 1, question = 'Approve this command?') => `${question}\n${selected === 1 ? '›' : ' '} 1. Yes\n${selected === 2 ? '›' : ' '} 2. No\nPress enter to confirm`;
function pane(screen) {
  const keys = [];
  return { keys, screen, async read() { return { ok: true, stdout: this.screen }; },
    async key(ws, key) { keys.push(key); if (key === 'down') this.screen = picker(2); return { ok: true }; },
    async write(ws, text) { keys.push(text); return { ok: true }; } };
}
test('terminal controls reject a stale screen without a keystroke', async () => {
  const io = pane(picker());
  assert.equal((await terminalAction('w', { screen: 'old', key: 'enter' }, io)).ok, false);
  assert.deepEqual(io.keys, []);
});
test('manual text never carries Enter or terminal escape sequences', async () => {
  for (const text of ['hello\nworld', '\u001b[H', 'a\rb']) {
    const io = pane(picker());
    assert.equal((await terminalAction('w', { screen: io.screen, text }, io)).ok, false);
    assert.deepEqual(io.keys, []);
  }
});
test('picker navigation reads back the actual cursor before confirming', async () => {
  const io = pane(picker());
  assert.equal((await chooseOption('w', { optionIndex: 2, optionLabel: 'No' }, io)).ok, true);
  assert.deepEqual(io.keys, ['down', 'enter']);
});
test('a question change during navigation never gets confirmed', async () => {
  const io = pane(picker());
  io.key = async (ws, key) => { io.keys.push(key); io.screen = picker(2, 'Delete everything?'); return { ok: true }; };
  assert.equal((await chooseOption('w', { optionIndex: 2, optionLabel: 'No' }, io)).ok, false);
  assert.deepEqual(io.keys, ['down']);
});
test('picker errors and missing labels never become approvals', async () => {
  const io = pane(picker());
  assert.equal((await chooseOption('w', { optionIndex: 1 }, io)).ok, false);
  assert.deepEqual(io.keys, []);
});
test('a refused cursor movement never gets followed by Enter', async () => {
  const io = pane(picker());
  io.key = async (ws, key) => { io.keys.push(key); return { ok: false, stderr: 'socket denied' }; };
  assert.equal((await chooseOption('w', { optionIndex: 2, optionLabel: 'No' }, io)).ok, false);
  assert.deepEqual(io.keys, ['down']);
});
test('the panel question is checked even when the new options have identical labels', async () => {
  const io = pane(picker(1, 'Approve a different command?'));
  assert.equal((await chooseOption('w', { optionIndex: 1, optionLabel: 'Yes', question: 'Approve this command?' }, io)).ok, false);
  assert.deepEqual(io.keys, []);
});
test('manual text is literal and never adds a submission', async () => {
  const io = pane(picker());
  const text = 'custom answer with a literal \\n';
  assert.equal((await terminalAction('w', { screen: io.screen, text }, io)).ok, true);
  assert.deepEqual(io.keys, [text]);
});

const composer = (activity, text = '') => `${activity}\n────────────────\n❯ ${text}\n────────────────\n? for shortcuts`;
test('changing progress above an unchanged composer does not block Escape', async () => {
  const io = pane(composer('Working 11 seconds'));
  assert.equal((await terminalAction('w', { screen: composer('Working 10 seconds'), key: 'escape' }, io)).ok, true);
  assert.deepEqual(io.keys, ['escape']);
});
test('an updated terminal draft is still protected even if the previous output matches', async () => {
  const io = pane(composer('Working', 'new draft'));
  assert.equal((await terminalAction('w', { screen: composer('Working', 'old draft'), key: 'enter' }, io)).ok, false);
  assert.deepEqual(io.keys, []);
});
test('a new approval cannot receive a key intended for the composer', async () => {
  const io = pane(picker());
  assert.equal((await terminalAction('w', { screen: composer('Working'), key: 'enter' }, io)).ok, false);
  assert.deepEqual(io.keys, []);
});
