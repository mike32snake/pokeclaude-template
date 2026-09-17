// Where the field ends, and where the front desk stands.
//
// The town file is a whole grid of slots, but only the slots in use are worth
// drawing: an unfilled grid used to leave a field of empty grass under the pens,
// which pushed the front desk far away from everything and made auto-fit zoom the
// whole map down to fit ground nobody looks at. `fieldExtent` trims the canvas to
// the pens in use plus a margin row, and Ash takes the bottom-right corner of that.
//
// Ash used to be pinned to the corner of the SCREEN and recomputed every frame so he
// could never scroll away. That made him jump across the map on every zoom, pane
// toggle and grid change, and dragged Pikachu after him. The field can be dragged
// now, so a fixed tile stays reachable and stays still.

const walkable = (t, x, y) =>
  x >= 0 && y >= 0 && x < t.w && y < t.h && t.collision[y][x] === 1;

// The slots the visible repos were placed on. The client keeps that in `visible`;
// falling back to one slot per repo keeps this usable straight from a town file.
function usedSlots(town) {
  const vis = town.visible || town.plots;
  if (vis?.length) return vis;
  const n = (town.repos || []).length || (town.slots || []).length;
  return (town.slots || []).slice(0, n);
}

// Canvas size in TILES: the pens in use, plus three tiles. The first is the ground
// between the last pen and the front desk, the second is the row and column the desk
// stands on, and the third is there for the sprites to hang their few pixels of
// overlap into. Two tiles used to be the whole margin, which stood the desk hard
// against the last fence with the corner going spare behind it.
const DESK_ROOM = 3;

export function fieldExtent(town) {
  const used = usedSlots(town);
  if (!used.length) return { w: town.w, h: town.h };
  return {
    w: Math.min(town.w, Math.max(...used.map(s => s.pen.x + s.pen.w)) + DESK_ROOM),
    h: Math.min(town.h, Math.max(...used.map(s => s.pen.y + s.pen.h)) + DESK_ROOM),
  };
}

// Bottom-right corner of the drawn field, off the ground the agents roam. Scanning
// backwards means the desk hugs the corner even when the last row is a full pen.
export function ashTile(town) {
  const e = fieldExtent(town);
  const used = usedSlots(town);
  const inPen = (x, y) => used.some(s =>
    x >= s.inner.x0 && x <= s.inner.x1 && y >= s.inner.y0 && y <= s.inner.y1);
  for (let y = e.h - 2; y >= 1; y--) {
    for (let x = e.w - 2; x >= 1; x--) {
      if (walkable(town, x, y) && !inPen(x, y)) return { x, y };
    }
  }
  return { x: town.spawn.x, y: town.spawn.y };
}

// Desk, then Pikachu, then a gap, then Ash: one row, read left to right. The bottom
// row of the field has nothing under it, so the seat is beside the screen, never below.
export function deskSpot(town, ash) {
  const row = (dx) => ({ x: ash.x + dx, y: ash.y });
  const left = { desk: row(-3), seat: row(-2) };
  if (walkable(town, left.desk.x, left.desk.y)) return left;
  const right = { desk: row(3), seat: row(2) };
  if (walkable(town, right.desk.x, right.desk.y)) return right;
  return { desk: row(-1), seat: row(-2) };
}

// Is there work to be at the desk FOR? Anything actually running counts, and so does
// Ash writing an answer. A service is not work: it sits there serving, and a field of
// services would keep Pikachu typing forever.
export function deskBusy(agents, ashBusy) {
  if (ashBusy) return true;
  return (agents || []).some(a => a.kind !== 'service' &&
    (a.status === 'WORKING' || a.status === 'THINKING'));
}

// Pikachu's whole decision, in one place. He does not roam. He used to patrol the
// ground around Ash on an idle timer, which read as a pet with nothing to do and
// dragged the eye away from the pens where the actual work is.
//
// The only thing that takes him off the seat is you driving him. After a warp (Tab
// points him at a blocked agent) he holds that spot for a moment, so the gesture can
// be read, then walks back. Work on the field skips the pause: there is a keyboard
// to be at.
export const RETURN_AFTER = 3;   // seconds parked before he makes his own way back

export function deskPlan({ driving, busy, atSeat, sinceInput, delay = RETURN_AFTER }) {
  if (driving) return 'drive';
  if (atSeat) return 'sit';
  if (!busy && sinceInput < delay) return 'stay';
  return 'walk';
}

// The typing animation is about the work, not about the chair: sitting at a quiet
// desk is sitting, not typing.
export const deskTyping = ({ atSeat, busy }) => !!(atSeat && busy);
