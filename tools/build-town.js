// Emits public/art/town-<size>.json: a field of plots, one per repo.
// Usage: node tools/build-town.js [3|4|5]   (then compose_town.py with the same size)
// No fences: each plot is a tinted patch of ground with a themed shed at its back.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { signNames } from '../src/server/signs.js';
import { normalizeDir } from '../src/server/paths.js';
import { gridFor, GRID_SIZES, TILE } from '../src/shared/grid.js';


const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
import { ensureRepoConfig } from '../src/server/config.js';
const cfg = ensureRepoConfig(root);
const T = TILE;
const HUT = JSON.parse(fs.readFileSync(path.join(root, 'public/art/buildings/sizes.json'), 'utf8'));

// Fewer columns means bigger plots, and the overall map stays about the same size so
// the zoom does not lurch when you switch. src/shared/grid.js owns that arithmetic,
// including how a plot shortens once the repo list needs more rows than the button
// reserved. The front desk room (Ash and Pikachu past the last pen) is in there too.
const SIZE = Number(process.argv[2] || 5);
const repos = [...cfg.repos];
const L = gridFor(SIZE, repos.length);
const { rows, w: W, h: H } = L;
if (L.overflows) console.warn(`town-${SIZE}: ${repos.length} repos will not fit the stage; the field scrolls`);

// Ground is uniform grass drawn by the client; nothing is baked, so hiding a repo
// leaves ordinary ground behind instead of a patched-over rectangle.
const col = Array.from({ length: H }, () => Array(W).fill(1));

const folderNames = repos.map(r => r.sign || path.basename(r.dir));
const signs = signNames(folderNames);

// Evenly spaced hues so neighbouring plots never look alike, whatever the archetype.
function hue(i, n) {
  const h = (i / Math.max(1, n)) * 360, s = 0.55, v = 0.95;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const H_ = H;
const slots = [];
for (let i = 0; i < L.cols * rows; i++) {
  const c = i % L.cols, r = Math.floor(i / L.cols);
  const px = L.border + c * (L.penW + L.gapX);
  const hy = L.border + r * (L.penH + L.hutRow + L.gapY);
  const py = hy + L.hutRow;
  const x1 = px + L.penW - 1, y1 = py + L.penH - 1;
  const gate = { x: px + Math.floor(L.penW / 2), y: y1 };
  const door = { x: x1 - 2, y: py + 1 };
  const inner = { x0: px + 1, x1: x1 - 1, y0: py + 1, y1: y1 - 1 };
  const desks = [];
  for (let y = inner.y0; y <= inner.y1; y++) for (let x = inner.x0; x <= inner.x1; x++) {
    if (x === door.x && y === door.y) continue;
    desks.push({ x, y });
  }
  slots.push({
    slot: i,
    pen: { x: px, y: py, w: L.penW, h: L.penH },
    inner,
    door, gate, desks,
    outside: { x: gate.x, y: Math.min(H - 1, y1 + 1) },
    signPx: { x: px * T + 3, y: py * T + 12 },
  });
}

// Repo identity: which shed, which colour. Position comes from whichever slot it
// lands in at render time.
const repoList = repos.map((repo, i) => ({
  id: i,
  dir: normalizeDir(repo.dir),
  rawDir: repo.dir,
  sign: signs[i],
  archetype: repo.archetype,
  tint: hue(i, repos.length),
  hutW: HUT[repo.archetype].w,
  hutH: HUT[repo.archetype].h,
  hutTilesW: Math.min(HUT[repo.archetype].tilesW, L.penW - 2),
}));

// The shed's tiles within a slot, so a click on the house can be told apart from a
// click on the open ground of the plot.
for (const slot of slots) {
  slot.shed = { w: 0, x: 0, y: slot.pen.y };      // width filled in per repo at runtime
}



// You start beside Ash in the bottom-right corner, not stranded mid-field.
const spawn = { x: W - 4, y: H - 2 };
const town = { size: SIZE, tile: T, w: W, h: H, spawn, collision: col,
  slots, repos: repoList, layout: { ...L, rows }, fitToScreen: true };
const outName = `town-${SIZE}.json`;
fs.writeFileSync(path.join(root, 'public/art', outName), JSON.stringify(town));
console.log(`${outName}: ${W}x${H} tiles (${W * T}x${H * T}px), ${repoList.length} repos, ${slots.length} slots`);
