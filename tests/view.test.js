// Panning and zooming the field. The stage is a scroll box around a full-size canvas,
// so "where am I looking" is a scroll offset, and a zoom must not throw it away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepCenter, worldAt, panelWidth, PANEL_MIN } from '../public/js/view.js';

// a 400x300 window onto an 800x600 canvas drawn at 1x
const view = (o = {}) => ({ scrollLeft: 0, scrollTop: 0, clientWidth: 400, clientHeight: 300,
                            canvasW: 800, canvasH: 600, ...o });

test('the map point in the middle of the window is what zoom holds still', () => {
  assert.deepEqual(worldAt(view({ scrollLeft: 200, scrollTop: 150 }), 1), { x: 400, y: 300 });
});

test('a canvas smaller than the window is centred, so the middle is its middle', () => {
  const v = view({ canvasW: 200, canvasH: 150 });
  assert.deepEqual(worldAt(v, 1), { x: 100, y: 75 });
});

test('zooming in keeps the same map point under the middle of the window', () => {
  const v = view({ scrollLeft: 200, scrollTop: 150 });
  const next = keepCenter(v, 1, 2);
  assert.deepEqual(next, { left: 600, top: 450 });
  // the same point is still in the middle afterwards
  assert.deepEqual(worldAt({ ...v, scrollLeft: next.left, scrollTop: next.top,
                             canvasW: 1600, canvasH: 1200 }, 2), { x: 400, y: 300 });
});

test('zooming out until the map fits scrolls back to nothing', () => {
  const next = keepCenter(view({ scrollLeft: 200, scrollTop: 150 }), 1, 0.25);
  assert.deepEqual(next, { left: 0, top: 0 });
});

test('the view can never be scrolled past the edge of the map', () => {
  // hard against the right/bottom edge at 2x, then zoomed out: the middle of the
  // window wants to sit past the end of the map, so it is pinned to the end instead
  const next = keepCenter(view({ scrollLeft: 1200, scrollTop: 900,
                                 canvasW: 1600, canvasH: 1200 }), 2, 1);
  assert.equal(next.left, 800 - 400);
  assert.equal(next.top, 600 - 300);
});

test('a zoom that changes nothing leaves the view exactly where it was', () => {
  assert.deepEqual(keepCenter(view({ scrollLeft: 137, scrollTop: 42 }), 2, 2),
                   { left: 137, top: 42 });
});

// The panel divider. The clamp lives in a module rather than in the drag handler
// because the interesting cases are the ones a mouse cannot easily produce: a window
// too narrow to honour the minimum, and a saved width from a wider screen.
test('the panel keeps a usable width and never eats the field', () => {
  assert.equal(panelWidth(500, 1600), 500, 'a width in range is taken as asked');
  assert.equal(panelWidth(120, 1600), 300, 'too narrow is pulled back to the minimum');
  assert.equal(panelWidth(5000, 1600), 900, 'too wide stops at the maximum');
});

test('a narrow window leaves room for the field, whatever was asked for', () => {
  // 1000 - 420 = 580 of field, so the panel cannot have more than that.
  assert.equal(panelWidth(900, 1000), 580);
});

test('the minimum wins on a window too small to satisfy both', () => {
  // 600 - 420 = 180, below the 300 minimum. A panel narrower than 300 is unusable,
  // so it is the field that gives way, not the panel.
  assert.equal(panelWidth(400, 600), 300);
});

test('a width restored from a wider screen is clamped, not obeyed', () => {
  assert.equal(panelWidth(880, 1200), 780, 'yesterday\'s 880 on a 1200 window fits to 780');
});

test('nonsense in gets the default out rather than NaN across the layout', () => {
  assert.equal(panelWidth(NaN, 1600), 300);
  assert.equal(panelWidth(null, 1600), 300);
});
