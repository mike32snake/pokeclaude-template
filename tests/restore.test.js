import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreModel, restoreKey } from '../public/js/restore.js';

const lost = [
  { sessionId: 'a', dir: '/x/pokeclaude', engine: 'claude', title: '✳ Fix the hook', status: 'BLOCKED' },
  { sessionId: 'b', dir: '/x/pokeclaude', engine: 'codex', title: '', status: 'WORKING' },
  { sessionId: 'c', dir: '/x/unmapped', engine: 'claude', title: 'notes', status: 'ASLEEP' },
];
const signFor = (dir) => ({ '/x/pokeclaude': 'POKECLAUDE' })[dir] || null;

test('every lost session starts ticked, and unticking one leaves it out', () => {
  const all = restoreModel(lost, new Set(), signFor);
  assert.deepEqual(all.picked, ['a', 'b', 'c']);
  assert.equal(all.rows.every(r => r.checked), true);
  const some = restoreModel(lost, new Set(['b']), signFor);
  assert.deepEqual(some.picked, ['a', 'c']);
  assert.equal(some.rows[1].checked, false);
});

test('each row names the repo, the task and what the agent was doing', () => {
  const { rows } = restoreModel(lost, new Set(), signFor);
  assert.equal(rows[0].sign, 'POKECLAUDE');
  assert.equal(rows[0].title, '✳ Fix the hook');
  assert.equal(rows[0].was, 'was waiting on you');
  assert.equal(rows[1].was, 'was working');
  assert.equal(rows[1].engine, 'CODEX');
  // A tab with no title still says something, and a folder with no plot uses its name.
  assert.equal(rows[1].title, 'untitled session');
  assert.equal(rows[2].sign, 'unmapped');
  assert.equal(rows[2].was, 'was idle');
});

test('the render key changes when the list or a tick changes', () => {
  const k = restoreKey(lost, new Set());
  assert.notEqual(k, restoreKey(lost, new Set(['a'])));
  assert.notEqual(k, restoreKey(lost.slice(1), new Set()));
  assert.equal(restoreKey([], new Set(['a'])), '');
});
