import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// Every layout the view buttons can select has to hold up, not just the default.
const SIZES = [3, 4, 5];
const TOWNS = SIZES.map(n =>
  JSON.parse(fs.readFileSync(new URL(`../public/art/town-${n}.json`, import.meta.url))));
const town = TOWNS[TOWNS.length - 1];        // 5x5 is the default view

const inBounds = (t, c) => c.x >= 0 && c.y >= 0 && c.x < t.w && c.y < t.h;

test('every layout carries the same repos', () => {
  for (const t of TOWNS) {
    assert.equal(t.repos.length, town.repos.length, `size ${t.size}`);
    assert.deepEqual(t.repos.map(r => r.sign), town.repos.map(r => r.sign), `size ${t.size}`);
  }
});
test('every layout has a slot for every repo', () => {
  for (const t of TOWNS) assert.ok(t.slots.length >= t.repos.length,
    `size ${t.size}: ${t.slots.length} slots for ${t.repos.length} repos`);
});
// The client appends a crons pen after the real repos. If the grid is exactly full it
// falls off the field with nothing to show that scheduled jobs exist at all.
test('every layout keeps a free slot for the crons pen', () => {
  for (const t of TOWNS) assert.ok(t.slots.length > t.repos.length,
    `size ${t.size}: ${t.slots.length} slots, ${t.repos.length} repos, no room for crons`);
});
test('a smaller grid gives bigger plots', () => {
  const area = TOWNS.map(t => t.slots[0].pen.w * t.slots[0].pen.h);
  for (let i = 1; i < area.length; i++) assert.ok(area[i] < area[i - 1], `areas ${area}`);
});
test('slot geometry stays on the map', () => {
  for (const t of TOWNS) for (const s of t.slots) {
    assert.ok(inBounds(t, s.gate), `gate off map, size ${t.size}`);
    assert.ok(inBounds(t, s.door), `door off map, size ${t.size}`);
    assert.ok(inBounds(t, s.outside), `outside off map, size ${t.size}`);
    for (const d of s.desks) assert.ok(inBounds(t, d), `desk off map, size ${t.size}`);
    assert.ok(s.pen.x + s.pen.w <= t.w && s.pen.y + s.pen.h <= t.h, `pen off map, size ${t.size}`);
  }
});
test('slots never overlap', () => {
  for (const t of TOWNS) {
    const r = t.slots.map(s => s.pen);
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i], b = r[j];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
        `size ${t.size}: slots ${i} and ${j} overlap`);
    }
  }
});
test('plots are roomy enough to roam', () => {
  for (const t of TOWNS) {
    const s = t.slots[0];
    assert.ok(s.pen.w >= 8 && s.pen.h >= 5, `size ${t.size} plot is ${s.pen.w}x${s.pen.h}`);
    assert.ok(s.desks.length >= 24, `size ${t.size} has only ${s.desks.length} spots`);
  }
});
test('every layout fits a typical stage without scrolling', () => {
  for (const t of TOWNS) {
    assert.ok(t.w * t.tile <= 1210, `size ${t.size}: ${t.w * t.tile}px wide at 1x`);
    assert.ok(t.h * t.tile <= 880, `size ${t.size}: ${t.h * t.tile}px tall at 1x`);
  }
});
test('nothing is ever placed on a plot border', () => {
  // A sprite is wider than its tile, so anything on the edge row hangs over the outline.
  for (const t of TOWNS) for (const s of t.slots) {
    const { x0, x1, y0, y1 } = s.inner;
    assert.ok(x0 > s.pen.x && x1 < s.pen.x + s.pen.w - 1, `size ${t.size}: inner touches the side`);
    assert.ok(y0 > s.pen.y && y1 < s.pen.y + s.pen.h - 1, `size ${t.size}: inner touches top/bottom`);
    for (const d of s.desks) {
      assert.ok(d.x >= x0 && d.x <= x1 && d.y >= y0 && d.y <= y1,
        `size ${t.size}: work spot ${d.x},${d.y} outside the inset area`);
    }
  }
});
test('spawn is walkable', () => {
  for (const t of TOWNS) assert.equal(t.collision[t.spawn.y][t.spawn.x], 1, `size ${t.size}`);
});
test('every repo got a unique sign', () => {
  const s = town.repos.map(r => r.sign);
  assert.equal(new Set(s).size, s.length);
});
