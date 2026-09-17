// The order repos are listed in the filter menu IS the order they take slots on the
// field. Dragging a row is the only thing that changes it, so the arithmetic of "put
// this one where that one is" lives here, away from the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { move, applyOrder, dropTarget } from '../public/js/order.js';

const ids = (list) => list.map(r => r.id);
const repos = (...n) => n.map(id => ({ id, sign: 's' + id }));

test('dragging a row down puts it after the row it was dropped on', () => {
  assert.deepEqual(move([0, 1, 2, 3], 0, 1), [1, 0, 2, 3]);
  assert.deepEqual(move([0, 1, 2, 3], 0, 3), [1, 2, 3, 0]);
});

test('dragging a row up puts it before the row it was dropped on', () => {
  assert.deepEqual(move([0, 1, 2, 3], 3, 1), [0, 3, 1, 2]);
  assert.deepEqual(move([0, 1, 2, 3], 2, 0), [2, 0, 1, 3]);
});

test('a drop on itself, or on a row that is not there, moves nothing', () => {
  assert.deepEqual(move([0, 1, 2], 1, 1), [0, 1, 2]);
  assert.deepEqual(move([0, 1, 2], 1, 9), [0, 1, 2]);
  assert.deepEqual(move([0, 1, 2], 9, 1), [0, 1, 2]);
});

test('move never mutates the list it was given', () => {
  const before = [0, 1, 2];
  move(before, 0, 2);
  assert.deepEqual(before, [0, 1, 2]);
});

test('repos are sorted into the saved order', () => {
  assert.deepEqual(ids(applyOrder(repos(0, 1, 2), [2, 0, 1])), [2, 0, 1]);
});

test('with no saved order the repos keep the order config gave them', () => {
  assert.deepEqual(ids(applyOrder(repos(0, 1, 2), [])), [0, 1, 2]);
  assert.deepEqual(ids(applyOrder(repos(0, 1, 2))), [0, 1, 2]);
});

// A repo added to config/repos.json after the order was saved has no rank. It must
// still appear, and it must not shuffle the ranked ones around.
test('a repo the saved order has never seen goes to the end, in config order', () => {
  assert.deepEqual(ids(applyOrder(repos(0, 1, 2, 3, 4), [2, 0])), [2, 0, 1, 3, 4]);
});

// The crons pen is repo -1, appended to town.repos at boot. It is reorderable like
// any other pen, and an order saved before it existed must not lose it.
test('an id the saved order does not list survives a reorder of the rest', () => {
  assert.deepEqual(ids(applyOrder(repos(0, 1, -1), [1, 0])), [1, 0, -1]);
});

test('ids in the saved order that no longer exist are ignored', () => {
  assert.deepEqual(ids(applyOrder(repos(0, 2), [2, 7, 0])), [2, 0]);
});

// Which row the pointer is over. The menu drags with pointer events, not HTML5
// drag-and-drop, so the row under the finger is worked out from the row boxes.
const boxes = () => [{ id: 0, top: 100, height: 20 }, { id: 1, top: 120, height: 20 },
                     { id: 2, top: 140, height: 20 }];

test('the row under the pointer is the row it will drop on', () => {
  assert.equal(dropTarget(boxes(), 105), 0);
  assert.equal(dropTarget(boxes(), 130), 1);
  assert.equal(dropTarget(boxes(), 159), 2);
});

test('a drag that overshoots the list lands on the nearest end row', () => {
  assert.equal(dropTarget(boxes(), 10), 0);
  assert.equal(dropTarget(boxes(), 900), 2);
});

test('an empty list has nothing to drop on', () => {
  assert.equal(dropTarget([], 120), null);
});
