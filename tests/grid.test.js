import test from 'node:test';
import assert from 'node:assert';
import { gridFor, MAX_W_PX, MAX_H_PX, TILE } from '../src/shared/grid.js';

const SIZES = [3, 4, 5];

// The grid button picks COLUMNS. Rows grow to hold every repo, so the 3-wide view of a
// long repo list used to run 928px tall and scroll the field off the bottom of the
// screen. Rows growing is right; the field growing past the stage is not. The plot
// height gives way instead.
test('every grid size fits the stage, however many repos', () => {
  for (const repos of [1, 9, 12, 15, 16, 20, 23]) {
    for (const size of SIZES) {
      const g = gridFor(size, repos);
      assert.ok(g.w * TILE <= MAX_W_PX, `${size}-wide, ${repos} repos: ${g.w * TILE}px wide`);
      assert.ok(g.h * TILE <= MAX_H_PX, `${size}-wide, ${repos} repos: ${g.h * TILE}px tall`);
    }
  }
});

test('no repo is ever left without a slot, and the crons pen keeps one', () => {
  for (const repos of [1, 9, 15, 16, 23]) {
    for (const size of SIZES) {
      const g = gridFor(size, repos);
      assert.ok(g.cols * g.rows >= repos + 1, `${size}-wide, ${repos} repos: ${g.cols * g.rows} slots`);
    }
  }
});

test('plots stay roomy enough to roam', () => {
  for (const repos of [1, 16, 23]) {
    for (const size of SIZES) {
      const g = gridFor(size, repos);
      assert.ok(g.penH >= 5, `${size}-wide, ${repos} repos: plot is ${g.penW}x${g.penH}`);
      assert.ok(g.penW >= 8, `${size}-wide, ${repos} repos: plot is ${g.penW}x${g.penH}`);
    }
  }
});

// A short repo list must look exactly as it did before. Shrinking plots that already
// fit would make everyone's field worse to fix a case they do not have.
test('a list that already fits is untouched', () => {
  assert.deepEqual(
    [3, 4, 5].map(n => gridFor(n, 8)).map(g => [g.cols, g.rows, g.penW, g.penH]),
    [[3, 3, 13, 8], [4, 4, 11, 7], [5, 5, 9, 6]]);
});

// Past the point where a plot would be smaller than a plot should be, the field is
// allowed to overflow rather than silently become unusable. Say so out loud.
test('an impossible repo count reports that it overflows', () => {
  const g = gridFor(3, 60);
  assert.equal(g.penH, 5, 'clamped at the floor');
  assert.equal(g.overflows, true);
});
