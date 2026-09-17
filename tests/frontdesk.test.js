// Where the field ends, and where the front desk stands.
//
// Two things are settled here. The canvas is trimmed to the slots that are actually
// in use, so an unfilled grid does not leave a field of empty grass under the pens.
// And Ash stands on a FIXED tile in the bottom-right corner of THAT, so he is next to
// the last pen instead of marooned below it, and does not jump when the zoom changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fieldExtent, ashTile, deskSpot, deskBusy, deskPlan, deskTyping } from '../public/js/frontdesk.js';

const TOWNS = [3, 4, 5].map(n =>
  JSON.parse(readFileSync(new URL(`../public/art/town-${n}.json`, import.meta.url))));

// what the client hands in: the slots the visible repos were placed on
const withUsed = (t, n) => ({ ...t, visible: t.slots.slice(0, n) });
const walkable = (t, p) => p.x >= 0 && p.y >= 0 && p.x < t.w && p.y < t.h && t.collision[p.y][p.x] === 1;
const inPenGround = (t, p) => (t.visible || t.slots).some(s =>
  p.x >= s.inner.x0 && p.x <= s.inner.x1 && p.y >= s.inner.y0 && p.y <= s.inner.y1);

test('a full grid is drawn whole', () => {
  for (const t of TOWNS) {
    const e = fieldExtent(withUsed(t, t.slots.length));
    assert.equal(e.w, t.w, `size ${t.size} width`);
    assert.equal(e.h, t.h, `size ${t.size} height`);
  }
});

test('unused slots are cut off the canvas instead of drawn as empty grass', () => {
  const five = TOWNS.find(t => t.size === 5);          // 25 slots, 13 in use
  const e = fieldExtent(withUsed(five, 13));
  assert.ok(e.h < five.h - 6, `expected the two empty slot rows to go, got ${e.h}/${five.h}`);
  const rows = five.slots.slice(0, 13);
  assert.ok(e.h > Math.max(...rows.map(s => s.pen.y + s.pen.h)),
    'the last pen in use must still be inside the canvas');
});

test('the extent never grows past the map itself', () => {
  for (const t of TOWNS) {
    const e = fieldExtent(withUsed(t, t.slots.length));
    assert.ok(e.w <= t.w && e.h <= t.h, `size ${t.size}`);
  }
});

test('Ash takes the bottom-right corner of the field that is actually drawn', () => {
  for (const n of [6, 13]) {
    for (const t of TOWNS) {
      const town = withUsed(t, Math.min(n, t.slots.length));
      const e = fieldExtent(town), a = ashTile(town);
      assert.ok(a.x >= e.w - 3 && a.x < e.w, `size ${t.size}/${n}: x ${a.x} of ${e.w}`);
      assert.ok(a.y >= e.h - 3 && a.y < e.h, `size ${t.size}/${n}: y ${a.y} of ${e.h}`);
      // a sprite is drawn a few pixels below its tile: never the last row of canvas
      assert.ok(a.y <= e.h - 2, `size ${t.size}/${n}: Ash is on the canvas edge`);
      assert.ok(walkable(t, a), `size ${t.size}/${n}: Ash is off the map`);
      assert.ok(!inPenGround(town, a), `size ${t.size}/${n}: Ash is standing inside a pen`);
    }
  }
});

// The front desk used to stand on the first tile past the last pen, which read as
// crowding the fence it was next to and left a whole tile of grass going spare in the
// corner behind it. It stands a tile further out now, deeper into the corner, and the
// canvas keeps a margin tile past THAT for the sprites to hang into.
test('the front desk stands clear of the last pen, a tile deeper into the corner', () => {
  for (const t of TOWNS) {
    const town = withUsed(t, Math.min(13, t.slots.length));
    const used = town.visible;
    const penRight = Math.max(...used.map(s => s.pen.x + s.pen.w));
    const penBottom = Math.max(...used.map(s => s.pen.y + s.pen.h));
    const a = ashTile(town), e = fieldExtent(town);
    assert.equal(a.x, penRight + 1, `size ${t.size}: x`);
    assert.equal(a.y, penBottom + 1, `size ${t.size}: y`);
    assert.equal(e.w - a.x, 2, `size ${t.size}: a margin column past Ash`);
    assert.equal(e.h - a.y, 2, `size ${t.size}: a margin row past Ash`);
  }
});

test('Ash does not move when the zoom or the panes change, only when the field does', () => {
  for (const t of TOWNS) {
    const town = withUsed(t, Math.min(13, t.slots.length));
    assert.deepEqual(ashTile(town), ashTile(town));      // pure: no screen input at all
    const smaller = withUsed(t, 3);
    assert.notDeepEqual(ashTile(smaller), ashTile(town), 'hiding repos must pull the desk in');
  }
});

test('the desk and the seat sit beside Ash, on the map and on real ground', () => {
  for (const t of TOWNS) {
    const town = withUsed(t, Math.min(13, t.slots.length));
    const a = ashTile(town), e = fieldExtent(town);
    const { desk, seat } = deskSpot(town, a);
    for (const [name, p] of [['desk', desk], ['seat', seat]]) {
      assert.ok(walkable(t, p), `size ${t.size}: the ${name} is off the map`);
      assert.ok(p.x >= 0 && p.x < e.w, `size ${t.size}: the ${name} is off the canvas`);
      assert.notDeepEqual(p, a, `size ${t.size}: the ${name} is on top of Ash`);
    }
    assert.notDeepEqual(desk, seat);
    assert.equal(desk.y, a.y, 'the front desk is one row, so the whole scene reads together');
    assert.equal(seat.y, a.y);
    assert.equal(Math.abs(seat.x - desk.x), 1);    // Pikachu sits at the keyboard
    assert.ok(Math.abs(seat.x - a.x) <= 3);
  }
});

// Pikachu works at the desk whenever there is work on the field. Roaming while the
// fleet is busy is what made it look like it was doing nothing.
const agent = (o) => ({ workspaceId: 'w' + (o.id || 1), status: 'ASLEEP', ...o });

test('any working agent puts Pikachu at the keyboard', () => {
  assert.equal(deskBusy([agent({ status: 'WORKING' })], false), true);
  assert.equal(deskBusy([agent({ status: 'THINKING' })], false), true);
});

test('Ash answering is work too, even with the whole field asleep', () => {
  assert.equal(deskBusy([agent({ status: 'ASLEEP' })], true), true);
});

test('a quiet field is not work, so Pikachu sits rather than types', () => {
  assert.equal(deskBusy([agent({ status: 'ASLEEP' }), agent({ id: 2, status: 'BLOCKED' })], false), false);
  assert.equal(deskBusy([], false), false);
  assert.equal(deskBusy(null, false), false);
});

test('a running service is not work: it just sits there serving', () => {
  assert.equal(deskBusy([agent({ status: 'WORKING', kind: 'service' })], false), false);
  assert.equal(deskBusy([agent({ status: 'WORKING', kind: 'cron' })], false), true);
});

// Pikachu does not roam. He is at the desk, and the only thing that takes him off it
// is you driving him with the arrow keys. This is the whole decision, in one place,
// because it used to be spread over an idle timer, a rest timer and a random walk.
test('the arrow keys always win: driving beats every other rule', () => {
  assert.equal(deskPlan({ driving: true, busy: true, atSeat: true, sinceInput: 0 }), 'drive');
  assert.equal(deskPlan({ driving: true, busy: false, atSeat: false, sinceInput: 99 }), 'drive');
});

test('on his seat he stays on his seat, busy field or quiet one', () => {
  assert.equal(deskPlan({ driving: false, busy: true, atSeat: true, sinceInput: 99 }), 'sit');
  assert.equal(deskPlan({ driving: false, busy: false, atSeat: true, sinceInput: 99 }), 'sit');
});

test('left anywhere else he walks back to the desk, never anywhere else', () => {
  assert.equal(deskPlan({ driving: false, busy: false, atSeat: false, sinceInput: 99 }), 'walk');
  assert.equal(deskPlan({ driving: false, busy: true, atSeat: false, sinceInput: 99 }), 'walk');
});

test('work on the field pulls him back at once, with no pause first', () => {
  assert.equal(deskPlan({ driving: false, busy: true, atSeat: false, sinceInput: 0 }), 'walk');
});

test('parked by hand on a quiet field he waits a few seconds before walking back', () => {
  // Tab warps him to a blocked agent to point at it. Returning instantly would undo
  // that gesture before it could be read.
  assert.equal(deskPlan({ driving: false, busy: false, atSeat: false, sinceInput: 0 }), 'stay');
  assert.equal(deskPlan({ driving: false, busy: false, atSeat: false, sinceInput: 2.9 }), 'stay');
  assert.equal(deskPlan({ driving: false, busy: false, atSeat: false, sinceInput: 3.1 }), 'walk');
});

test('he types only while sitting at a desk that has work', () => {
  assert.equal(deskTyping({ atSeat: true, busy: true }), true);
  assert.equal(deskTyping({ atSeat: true, busy: false }), false);
  assert.equal(deskTyping({ atSeat: false, busy: true }), false);
});
