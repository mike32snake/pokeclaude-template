// Visible repos occupy the first N slots, in the order the filter menu lists them.
// Hiding one reflows the rest up and left, so the field never shows a gap where a
// repo used to be, and dragging one up the menu walks it up the field the same way.
import { isHidden, repoOrder } from './filter.js';
import { applyOrder } from './order.js';

export function visiblePlots(town) {
  const out = [];
  let n = 0;
  for (const repo of applyOrder(town.repos, repoOrder())) {
    if (isHidden(repo.id)) continue;
    const slot = town.slots[n++];
    if (!slot) break;                       // more repos than slots; drop the overflow
    // where the shed actually sits, for hit-testing a click on the house
    const shed = { x: slot.pen.x + slot.pen.w - repo.hutTilesW, y: slot.pen.y,
                   w: repo.hutTilesW, h: 1 };
    // The sign hangs over the house, centred on it, so the name sits with the thing
    // that identifies the repo instead of floating in the corner of the ground.
    const T = town.tile;
    const shedPx = (shed.x + shed.w / 2) * T;
    const signPx = { x: shedPx, y: (slot.pen.y + 1) * T - repo.hutH - 4, center: true };
    out.push({ ...repo, ...slot, shed, signPx, plot: repo.id });
  }
  return out;
}

// Paint the whole field: grass, then each visible plot's tint, shed and nothing else.
export function drawField(ctx, town, plots, img) {
  const T = town.tile;
  const grass = img('/art/tiles/grass.png');
  if (grass.complete && grass.naturalWidth) {
    for (let y = 0; y < town.h; y++)
      for (let x = 0; x < town.w; x++) ctx.drawImage(grass, x * T, y * T);
  } else {
    ctx.fillStyle = '#7bc47f';
    ctx.fillRect(0, 0, town.w * T, town.h * T);
  }

  for (const p of plots) {
    const [r, g, b] = p.tint;
    const x0 = p.pen.x * T + 3, y0 = p.pen.y * T;
    const w = p.pen.w * T - 7, h = p.pen.h * T;
    ctx.save();
    ctx.fillStyle = `rgba(${r},${g},${b},.35)`;
    ctx.beginPath(); ctx.roundRect(x0, y0, w, h, 6); ctx.fill();
    ctx.strokeStyle = `rgba(${r},${g},${b},.9)`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x0, y0, w, h, 6); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x0 + 2, y0 + 2, w - 4, h - 4, 5); ctx.stroke();
    ctx.restore();

    const shed = img(`/art/buildings/${p.archetype}.png`);
    if (shed.complete && shed.naturalWidth) {
      const hx = (p.pen.x + p.pen.w - p.hutTilesW) * T + Math.floor((p.hutTilesW * T - p.hutW) / 2);
      ctx.drawImage(shed, hx, p.pen.y * T + T - p.hutH);
    }
  }
}
