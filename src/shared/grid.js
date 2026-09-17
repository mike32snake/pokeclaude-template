// How big the field is, for a given grid button and a given number of repos.
//
// The button picks COLUMNS, not plots. Rows grow so a long repo list never silently
// drops a pen off the map. Growing rows used to grow the field with them, which ran
// the 3-wide view to 928px tall and pushed the bottom row off the stage. The plot
// height gives way instead: a shorter plot is still readable, a field you have to
// scroll is not.
export const TILE = 16;
export const MAX_W_PX = 1210;   // a typical stage with both side panes open
export const MAX_H_PX = 880;
const DESK_ROOM = 2;            // Ash and Pikachu stand past the last pen
const CRON_SLOTS = 1;           // the client appends a crons pen after the real repos
const MIN_PEN_H = 5;            // below this a plot has nowhere to roam

const BASE = {
  3: { cols: 3, rows: 3, penW: 13, penH: 8, hutRow: 1, gapX: 0, gapY: 0, border: 1 },
  4: { cols: 4, rows: 4, penW: 11, penH: 7, hutRow: 1, gapX: 0, gapY: 0, border: 1 },
  5: { cols: 5, rows: 5, penW: 9,  penH: 6, hutRow: 1, gapX: 0, gapY: 0, border: 1 },
};
export const GRID_SIZES = Object.keys(BASE).map(Number);

const widthOf = L => L.border * 2 + L.cols * L.penW + (L.cols - 1) * L.gapX + DESK_ROOM;
const heightOf = (L, rows, penH) =>
  L.border * 2 + rows * (penH + L.hutRow) + (rows - 1) * L.gapY + DESK_ROOM;

export function gridFor(size, repoCount) {
  const L = BASE[size];
  if (!L) throw new Error(`unknown grid size ${size}; expected ${GRID_SIZES.join(', ')}`);
  const rows = Math.max(L.rows, Math.ceil((repoCount + CRON_SLOTS) / L.cols));

  // The tallest plot that still leaves the whole field inside the stage.
  const budget = Math.floor(MAX_H_PX / TILE) - L.border * 2 - DESK_ROOM - (rows - 1) * L.gapY;
  const fits = Math.floor(budget / rows) - L.hutRow;
  const penH = Math.max(MIN_PEN_H, Math.min(L.penH, fits));

  const w = widthOf(L), h = heightOf(L, rows, penH);
  return { ...L, rows, penH, w, h,
           overflows: w * TILE > MAX_W_PX || h * TILE > MAX_H_PX };
}
