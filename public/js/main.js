import { connect, onState, state, api } from './net.js';
import { World, hash } from './world.js';
import { drawTrainer, drawPoke, drawBall, bubble, waitLabel, signPlate, img,
         toolPop, thinking, dust, selectMark, serviceMark, cronMark,
         deskPC, keystrokes, typeBob } from './sprites.js';
import * as ui from './ui.js';
import { isHidden, mountFilter, onFilterChange } from './filter.js';
import { visiblePlots, drawField } from './field.js';
import { CRON_PEN, CRON_DIR, cronActors, cronGrid, untilText, cronState } from './crons.js';
import { renderStatus } from './statusbar.js';
import { fieldExtent, ashTile, deskSpot, deskBusy, deskPlan, deskTyping } from './frontdesk.js';
import { keepCenter, panelWidth } from './view.js';
import { mountAuthBar } from './authbar.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const stage = document.getElementById('stage');
const panelEl = document.getElementById('panel');
const feedWrap = document.getElementById('feed-wrap');

// Collapsible side panes. Collapsing gives the field its width back, so the map
// can hold a bigger integer zoom; every toggle re-runs resize().
let panelWidthBeforeCollapse = null;
function setPane(el, key, collapsed) {
  el.classList.toggle('collapsed', collapsed);
  // The drag handle sets inline widths, which would beat the .collapsed rule. Clear
  // them while collapsed and put the dragged width back on expand.
  if (el === panelEl) {
    if (collapsed) {
      // Remember the exact width we are collapsing from, so expanding restores it
      // rather than whatever happens to be in storage.
      if (el.style.width) panelWidthBeforeCollapse = el.style.width;
      el.style.width = el.style.minWidth = el.style.maxWidth = '';
    } else {
      let w = panelWidthBeforeCollapse;
      if (!w) { try { w = localStorage.getItem('pc.panelW'); } catch {} if (w) w += 'px'; }
      if (w) el.style.width = el.style.minWidth = el.style.maxWidth = w;
    }
  }
  const btn = el.querySelector('button');
  if (btn) {
    const isPanel = el === panelEl;
    btn.textContent = collapsed ? (isPanel ? '▶' : '◀') : (isPanel ? '◀' : '▶');
    btn.title = collapsed ? 'Expand' : 'Collapse';
  }
  try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch {}
  resize();
}
function initPanes() {
  // Activity starts collapsed: the map needs ~940px for a crisp 2x, and two open
  // panes do not leave that on a laptop. Expanding it is one click / the ] key.
  let p = '0', f = '1';
  try { p = localStorage.getItem('pc.panel') ?? '0'; f = localStorage.getItem('pc.feed') ?? '1'; } catch {}
  setPane(panelEl, 'pc.panel', p === '1');
  setPane(feedWrap, 'pc.feed', f === '1');
  panelEl.querySelector('#panel-toggle').onclick = () =>
    setPane(panelEl, 'pc.panel', !panelEl.classList.contains('collapsed'));
  feedWrap.querySelector('#feed-toggle').onclick = () =>
    setPane(feedWrap, 'pc.feed', !feedWrap.classList.contains('collapsed'));
}
let SCALE = 2;
let town, world;
const player = { x: 0, y: 0, tx: 0, ty: 0, facing: 'down', frame: 0, ft: 0, moving: false,
                 idle: 0 };
const PLAYER_SPECIES = 25;                       // the player is a Pokémon now (Pikachu)
const ranger = { tx: 0, ty: 0 };                 // Ash: fixed tile, bottom right of the MAP
const desk = { tx: 0, ty: 0 }, seat = { tx: 0, ty: 0 };   // his computer, and Pikachu's chair
// The drawn field, in tiles. Smaller than the town whenever the grid is not full:
// empty slot rows are cut off rather than drawn as a field of grass nobody uses.
let extent = { w: 0, h: 0 };
const keys = {};
let tabCycle = -1;   // first Tab lands on the longest-waiting agent
let selected = null; // the agent whose chat is open, marked on the map
const prevStatus = new Map();

function fitScale() {
  if (!town) return;
  const w = stage.clientWidth - 12, h = stage.clientHeight - 12;
  if (userZoom) { SCALE = userZoom; updateZoomUI(); return; }
  // Auto-fit: prefer the largest INTEGER zoom that fits both ways, since integers
  // keep the pixels square. Fall back to quarter steps when nothing integral fits.
  const raw = Math.min(w / (extent.w * town.tile), h / (extent.h * town.tile));
  // Quarter steps at every size. Flooring to whole numbers used to drop a map that
  // just missed 2x all the way to 1x; 1.75x is far better than half-size.
  SCALE = Math.max(0.25, Math.floor(raw * 4) / 4);
  updateZoomUI();
}

const ZOOM_MIN = 0.25, ZOOM_MAX = 4, ZOOM_STEP = 0.25;
let userZoom = null;                 // null = auto-fit
// What the bar needs about the open agent: identity from the sprite, live numbers
// looked up from state so context keeps ticking while you read.
function selectedInfo() {
  if (!selected?.agent) return null;
  return { workspaceId: selected.agent.workspaceId, sign: selected.plot?.sign,
           species: selected.species?.[1], ...selected.agent };
}
function statusTick() {
  if (!town) return;
  renderStatus({ agents: state.agents, usage: state.usage, town, selected: selectedInfo(),
                 scale: SCALE, hidden: town.repos.length - (town.visible?.length ?? town.repos.length) });
}
function updateZoomUI() {
  const el = document.getElementById('zoom-pct');
  if (el) {
    el.textContent = Math.round(SCALE * 100) + '%';
  statusTick();
    el.title = userZoom ? 'Click to go back to auto-fit' : 'Auto-fit · click to lock';
    el.classList.toggle('auto', !userZoom);
  }
}
function setZoom(z) {
  userZoom = z == null ? null : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 4) / 4));
  try { localStorage.setItem('pc.zoom', userZoom == null ? '' : String(userZoom)); } catch {}
  resize();
}

// Scheduled jobs get a pen of their own, appended after the real repos so it takes
// the next free slot. It behaves like any other plot: it can be hidden from FILTER,
// it reflows, and clicking it opens the timetable.
function addCronPen() {
  if (!town.repos.some(r => r.dir === CRON_DIR)) town.repos.push({ ...CRON_PEN });
}
function worldAgents() {
  // Only as many jobs as the pen can actually hold, worst first. The rest are in the
  // CRONS panel, which lists every job whether or not it earned a sprite.
  const pen = (town.plots || []).find(p => p.dir === CRON_DIR);
  const cap = pen ? cronGrid(pen).cap : 0;
  return state.agents.concat(cronActors(state.crons, cap));
}

// Switching grid size swaps the whole town file, then rebuilds the field in place.
async function setGrid(size) {
  try { localStorage.setItem('pc.grid', String(size)); } catch {}
  const next = await (await fetch(`/art/town-${size}.json`)).json();
  Object.assign(town, next);
  addCronPen();
  town.visible = visiblePlots(town);
  town.plots = town.visible;
  world.setPlots(town.visible);
  world.sync(worldAgents());
  markGrid(size);
  placeRanger();                 // the extent must be known before anything is fitted
  resize();
  spawnPlayer();
  ui.renderQueue(true);
}
function markGrid(size) {
  document.querySelectorAll('#grid-ctl button').forEach(b =>
    b.classList.toggle('on', b.dataset.grid === String(size)));
}
// Drag the divider to trade panel width against field width. Persisted.
function initDrag() {
  const bar = document.getElementById('drag');
  if (!bar) return;
  const apply = (px) => {
    const w = panelWidth(px, innerWidth);
    panelEl.style.width = w + 'px';
    panelEl.style.maxWidth = w + 'px';
    panelEl.style.minWidth = w + 'px';
    try { localStorage.setItem('pc.panelW', String(w)); } catch {}
    resize();
  };
  try { const saved = localStorage.getItem('pc.panelW'); if (saved) apply(Number(saved)); } catch {}
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    bar.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => apply(ev.clientX - panelEl.getBoundingClientRect().left);
    const up = () => {
      bar.classList.remove('dragging');
      document.body.classList.remove('resizing');
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  // A window dragged narrower has to pull an over-wide panel back with it, or the
  // field is squeezed out of existence by a width that was fine on a bigger screen.
  addEventListener('resize', () => {
    if (panelEl.style.width) apply(parseFloat(panelEl.style.width));
  });
  bar.addEventListener('dblclick', () => {            // double click resets
    panelEl.style.width = panelEl.style.maxWidth = panelEl.style.minWidth = '';
    try { localStorage.removeItem('pc.panelW'); } catch {}
    resize();
  });
}

function initGrid() {
  document.querySelectorAll('#grid-ctl button').forEach(b => {
    b.onclick = () => setGrid(Number(b.dataset.grid));
  });
  markGrid(town.size);
}

function initZoom() {
  try { const z = localStorage.getItem('pc.zoom'); if (z) userZoom = Number(z) || null; } catch {}
  document.getElementById('zoom-in').onclick = () => setZoom((userZoom || SCALE) + ZOOM_STEP);
  document.getElementById('zoom-out').onclick = () => setZoom((userZoom || SCALE) - ZOOM_STEP);
  document.getElementById('zoom-pct').onclick = () => setZoom(userZoom ? null : SCALE);
}
function resize() {
  if (!town) return;
  // Zooming and collapsing a pane both resize the canvas under the scroll box. Note
  // where the middle of the view is first, or the field jumps somewhere else and
  // finding what you were looking at again is a hunt.
  const before = { scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop,
                   clientWidth: stage.clientWidth, clientHeight: stage.clientHeight,
                   canvasW: canvas.width, canvasH: canvas.height };
  const wasScale = SCALE;
  fitScale();
  canvas.width = extent.w * town.tile * SCALE;
  canvas.height = extent.h * town.tile * SCALE;
  ctx.imageSmoothingEnabled = false;
  if (before.canvasW) {
    const next = keepCenter(before, wasScale, SCALE);
    stage.scrollLeft = next.left; stage.scrollTop = next.top;
  }
  requestAnimationFrame(alignGrass);
}

// Put the middle of the map in the middle of the view. Used once at boot, so a map
// bigger than the stage does not open scrolled into its top-left corner.
function centerView() {
  stage.scrollLeft = Math.max(0, (canvas.width - stage.clientWidth) / 2);
  stage.scrollTop = Math.max(0, (canvas.height - stage.clientHeight) / 2);
  alignGrass();
}

// Drag the field to look around it. Anything the drag passes over is NOT clicked:
// a pan that also opened a repo would make the field unusable at any zoom.
let panned = false;
function initPan() {
  let sx = 0, sy = 0, sl = 0, st = 0, dragging = false, moved = 0;
  const DEAD = 4;                     // px of slop before a click becomes a drag
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = 0;
    sx = e.clientX; sy = e.clientY; sl = stage.scrollLeft; st = stage.scrollTop;
  });
  addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    if (moved < DEAD) return;
    e.preventDefault();
    stage.classList.add('panning');
    stage.scrollLeft = sl - dx; stage.scrollTop = st - dy;
  });
  addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('panning');
    panned = moved >= DEAD;           // read and cleared by the click handler
  });
}

// Line the stage's repeating grass up with the canvas grid so the seam is invisible.
function alignGrass() {
  const px = town.tile * SCALE;
  stage.style.backgroundSize = `${px}px ${px}px`;
  const c = canvas.getBoundingClientRect(), s2 = stage.getBoundingClientRect();
  const mod = (n) => ((n % px) + px) % px;
  stage.style.backgroundPosition = `${mod(c.left - s2.left)}px ${mod(c.top - s2.top)}px`;
}
addEventListener('resize', resize);
stage.addEventListener('scroll', alignGrass);

async function boot() {
  const size = (() => { try { return localStorage.getItem('pc.grid') || '5'; } catch { return '5'; } })();
  town = await (await fetch(`/art/town-${size}.json`)).json();
  addCronPen();
  world = new World(town);
  ui.init(world, {
    town: () => town,
    focusOn: (ac) => { const T = town.tile; player.tx = Math.round(ac.x / T); player.ty = Math.round(ac.y / T) + 1;
      if (!walkable(player.tx, player.ty)) player.ty = Math.round(ac.y / T);
      player.x = player.tx * T; player.y = player.ty * T; player.facing = 'up'; takeControl(); },
    nextBlocked: () => setTimeout(() => warpToBlocked(0), 400),
    select: (ac) => { selected = ac; statusTick(); },
    // Opening a view is pointless if the pane it renders into is shut. Clicking a
    // Pokemon while the panel was collapsed used to look like a dead click: the
    // conversation loaded behind a 38px strip.
    reveal: () => { if (panelEl.classList.contains('collapsed')) setPane(panelEl, 'pc.panel', false); },
    reloadTown: async () => { await setGrid(town.size); },
  });
  initPanes();
  initDrag();
  initZoom();
  initGrid();
  const refreshField = () => {
    town.visible = visiblePlots(town);
    town.plots = town.visible;              // world/ui read town.plots
    world.setPlots(town.visible);
    // Hiding a repo shrinks the field, so the canvas is re-trimmed and the front desk
    // moves in with it. This is the ONLY thing that moves Ash.
    placeRanger();
    resize();
    ui.renderQueue(true);
    statusTick();
  };
  // Subscribe rather than relying on the menu's callback, so the field also reflows
  // when the filter is changed from anywhere else.
  onFilterChange(refreshField);
  mountFilter(town);
  refreshField();
  // Ash and his desk take fixed tiles in the bottom-right corner of the drawn field.
  // Talk to him to spawn a new agent; he belongs to no repo. Pikachu starts at his
  // side, because the town's own spawn tile can be on ground that was trimmed away.
  spawnPlayer();
  connect();
  // The auth strip under the field: every login on this Mac, red when one has
  // lapsed. A red chip opens a cmux tab running that tool's sign-in command.
  const renderAuth = mountAuthBar(document.getElementById('auth-bar'), {
    onFix: async (id) => {
      const r = await api.authLogin(id).catch((e) => ({ error: String(e) }));
      ui.toast(r.error ? `sign-in failed: ${r.error}` : (r.warning || 'Sign-in opened. Complete it in Brave or the selected cmux tab; the login strip will recheck automatically.'));
    },
    onRefresh: async () => {
      renderAuth(null);
      const r = await api.auth(true).catch(() => null);
      if (r?.auth) { state.auth = r.auth; renderAuth(state.auth); }
    },
  });
  renderAuth(state.auth);
  setInterval(() => renderAuth(state.auth), 60_000);     // the "3m ago" keeps counting
  onState(() => {
    renderAuth(state.auth);
    world.sync(worldAgents()); updateFeed(); notifyBlocked(); ui.renderQueue();
    renderStatus({ agents: state.agents, usage: state.usage, town, selected: selectedInfo(),
                   scale: SCALE, hidden: town.repos.length - town.visible.length });
  });
  // Debug handle for tests and screenshots. Read-only conveniences, no game logic here.
  window.__pc = {
    player, ranger, desk, seat, town, world, ui, state,
    setZoom, fleetMood,
    goto(tx, ty) { player.tx = tx; player.ty = ty; player.x = tx * town.tile; player.y = ty * town.tile; takeControl(); },
    door(sign) { const p = town.plots.find(pp => pp.sign === sign); if (p) { this.goto(p.door.x, p.door.y); return p; } },
    openPC(sign) { const p = town.plots.find(pp => pp.sign === sign); if (p) ui.openPC(p); return !!p; },
  };
  initPan();
  centerView();
  requestAnimationFrame(loop);
}


// Activity feed: one line per status transition, newest on top.
const feedEl = document.getElementById('feed');   // lives in the left panel
const feedLines = [];
function pushFeed(text, status) {
  if (!feedEl) return;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
  feedLines.unshift({ time: `${hh}:${mm}`, text, status });
  if (feedLines.length > 60) feedLines.pop();
  feedEl.replaceChildren(...feedLines.map(l => {
    const row = document.createElement('div');
    row.className = `fl st-${/^[A-Z]+$/.test(l.status || '') ? l.status : 'NONE'}`;
    const ts = document.createElement('span'); ts.className = 'ft'; ts.textContent = l.time;
    row.append(ts, ` ${l.text}`);
    return row;
  }));
}
const FEED_VERB = { WORKING: 'is working', BLOCKED: 'needs you', ASLEEP: 'fell asleep', FAINTED: 'fainted' };
const lastSeq = new Map();
function updateFeed() {
  const seen = new Set();
  for (const a of state.agents) {
    seen.add(a.workspaceId);
    // one line per real tool call, so the feed shows activity, not just transitions
    const seq = a.toolSeq || 0, prevSeq = lastSeq.get(a.workspaceId);
    if (prevSeq != null && seq > prevSeq && a.lastTool) {
      const sp = world.actors.get(a.workspaceId)?.species?.[1] || 'agent';
      pushFeed(`${sp} · ${world.plotFor(a.dir)?.sign || '?'} ran ${a.lastTool}`, 'WORKING');
    }
    lastSeq.set(a.workspaceId, seq);
    const was = prevStatus.get(a.workspaceId);
    if (was === a.status) continue;
    const species = world.actors.get(a.workspaceId)?.species?.[1] || 'agent';
    const sign = world.plotFor(a.dir)?.sign || 'no pen';
    if (!was) pushFeed(`${species} joined ${sign}`, a.status);
    else pushFeed(`${species} · ${sign} ${FEED_VERB[a.status] || a.status.toLowerCase()}`, a.status);
  }
  for (const id of [...prevStatus.keys()])
    if (!seen.has(id)) prevStatus.delete(id);
}
function notifyBlocked() {
  for (const a of state.agents) {
    const was = prevStatus.get(a.workspaceId);
    if (was && was !== 'BLOCKED' && a.status === 'BLOCKED' && document.hidden && Notification.permission === 'granted') {
      const plot = world.plotFor(a.dir);
      new Notification(`${plot?.sign || 'unmapped'}: agent needs you`, { body: a.title });
    }
    prevStatus.set(a.workspaceId, a.status);
  }
}

// Bounded by the DRAWN field, not the town: walking into the trimmed-off rows would
// take Pikachu off the canvas entirely.
const walkable = (x, y) => x >= 0 && y >= 0 && x < extent.w && y < extent.h &&
  town.collision[y][x] === 1;

function tryMove(dx, dy, facing) {
  player.facing = facing;
  if (player.moving) return;
  const nx = player.tx + dx, ny = player.ty + dy;
  if (walkable(nx, ny)) { player.tx = nx; player.ty = ny; player.moving = true; }
}

// Ash is the front desk, and he stands on ONE tile: the open ground at the bottom
// right of the map, chosen from the town file alone. He used to be pinned to the
// corner of the screen and recomputed every frame so he could never scroll away,
// which made him jump on every zoom, pane toggle and grid change and dragged Pikachu
// after him. The field can be dragged now, so a fixed desk is reachable and still.
function placeRanger() {
  extent = fieldExtent(town);
  const a = ashTile(town);
  ranger.tx = a.x; ranger.ty = a.y;
  const d = deskSpot(town, a);
  desk.tx = d.desk.x; desk.ty = d.desk.y;
  seat.tx = d.seat.x; seat.ty = d.seat.y;
}

// Pikachu lives at the front desk: his chair, or the nearest tile to it he can stand
// on if something is already there.
function spawnPlayer() {
  const at = walkable(seat.tx, seat.ty) ? { x: seat.tx, y: seat.ty } : besideSeat();
  if (!at) return;
  player.tx = at.x; player.ty = at.y;
  player.x = player.tx * town.tile; player.y = player.ty * town.tile;
}

// Only used when the chair itself is unusable, which the town files make unlikely.
function besideSeat() {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]]
    .map(([dx, dy]) => ({ x: seat.tx + dx, y: seat.ty + dy }))
    .find(p => walkable(p.x, p.y) && !occupiedTile(p.x, p.y)) || null;
}

// Pikachu must never stand on another sprite, so the no-overlap rule holds for it too.
function occupiedTile(tx, ty) {
  if (atRanger(tx, ty)) return true;
  if (tx === desk.tx && ty === desk.ty) return true;      // the computer is furniture
  const T = town.tile;
  for (const ac of world.actors.values())
    if (Math.round(ac.x / T) === tx && Math.round(ac.y / T) === ty) return true;
  return false;
}
// One tile towards a target, longest axis first. Returns false when both ways are
// blocked, so the caller can choose somewhere else.
function stepToward(x, y) {
  const dx = x - player.tx, dy = y - player.ty;
  const tries = Math.abs(dx) >= Math.abs(dy)
    ? [[Math.sign(dx), 0], [0, Math.sign(dy)]]
    : [[0, Math.sign(dy)], [Math.sign(dx), 0]];
  for (const [mx, my] of tries) {
    if (!mx && !my) continue;
    const nx = player.tx + mx, ny = player.ty + my;
    if (walkable(nx, ny) && !occupiedTile(nx, ny)) {
      player.tx = nx; player.ty = ny; player.moving = true;
      player.facing = mx ? (mx > 0 ? 'right' : 'left') : (my > 0 ? 'down' : 'up');
      return true;
    }
  }
  return false;
}
// Driving it, or warping it to an agent, parks it there. After a few quiet seconds it
// makes its own way back to the desk.
function takeControl() {
  player.idle = 0;
}

function playerStep(dt) {
  const T = town.tile, sp = 120 * dt;
  const gx = player.tx * T, gy = player.ty * T;
  if (player.x !== gx || player.y !== gy) {
    player.x += Math.sign(gx - player.x) * Math.min(sp, Math.abs(gx - player.x));
    player.y += Math.sign(gy - player.y) * Math.min(sp, Math.abs(gy - player.y));
    player.ft += dt; if (player.ft > 0.1) { player.frame = (player.frame + 1) % 4; player.ft = 0; }
    return;
  }
  player.moving = false; player.frame = 0;
  player.idle += dt;
  // Pikachu works the front desk and nothing else. deskPlan owns the decision, so
  // there is one place to read it; this only carries the answer out.
  const atSeat = player.tx === seat.tx && player.ty === seat.ty;
  const busy = deskBusy(state.agents, ui.ashWorking());
  player.typing = deskTyping({ atSeat, busy });
  const driving = keys.ArrowUp || keys.w || keys.ArrowDown || keys.s ||
                  keys.ArrowLeft || keys.a || keys.ArrowRight || keys.d;
  switch (deskPlan({ driving, busy, atSeat, sinceInput: player.idle })) {
    case 'drive':
      takeControl();
      player.typing = false;
      if (keys.ArrowUp || keys.w) tryMove(0, -1, 'up');
      else if (keys.ArrowDown || keys.s) tryMove(0, 1, 'down');
      else if (keys.ArrowLeft || keys.a) tryMove(-1, 0, 'left');
      else if (keys.ArrowRight || keys.d) tryMove(1, 0, 'right');
      return;
    case 'sit':
      // Facing the screen, not the camera: the desk is beside him, never below.
      player.facing = desk.tx < seat.tx ? 'left' : 'right';
      player.moving = false;
      return;
    case 'walk':
      stepToward(seat.tx, seat.ty);
      return;
    default:                     // 'stay': parked by hand, holding the spot a moment
      return;
  }
}

// Pikachu carries the field's headline over its head: the worst thing happening
// anywhere, in the same vocabulary the individual sprites already use. Ash runs the
// front desk; Pikachu tells you whether you need to walk over to it.
function fleetMood() {
  const now = Date.now();
  let worstWait = -1, working = 0;
  for (const a of state.agents) {
    if (a.kind === 'service' || a.status === 'FAINTED') continue;
    if (a.status === 'BLOCKED') worstWait = Math.max(worstWait, now - a.since);
    else if (a.status === 'WORKING' || a.status === 'THINKING') working++;
  }
  // A broken schedule needs you as much as a waiting agent does, and is easier to miss.
  const cronTrouble = (state.crons || [])
    .some(c => ['failed', 'stalled'].includes(cronState(c, now)));
  if (worstWait > 30 * 60e3) return 'warn2';
  if (worstWait > 5 * 60e3 || cronTrouble) return 'warn';
  if (worstWait >= 0) return 'ask';
  if (working) return 'think';
  return 'z';
}

const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
function facingTile() { const [dx, dy] = DIRV[player.facing]; return { x: player.tx + dx, y: player.ty + dy }; }

function actorAt(tx, ty) {
  const T = town.tile;
  for (const ac of world.actors.values()) {
    const ax = Math.round(ac.x / T), ay = Math.round(ac.y / T);
    if (ax === tx && ay === ty) return ac;
  }
  return null;
}
const atRanger = (tx, ty) => tx === ranger.tx && (ty === ranger.ty || ty === ranger.ty - 1);
// The desk and the chair belong to the front desk too: clicking the computer Pikachu
// is typing at should open what it is typing.
const atFrontDesk = (tx, ty) => atRanger(tx, ty) || atRanger(tx, ty + 1)
  || ((tx === desk.tx || tx === seat.tx) && (ty === desk.ty || ty === desk.ty - 1));
function interact() {
  const f = facingTile();
  if (atFrontDesk(f.x, f.y) || atFrontDesk(player.tx, player.ty)) return ui.openRanger(town);
  const ac = actorAt(f.x, f.y) || actorAt(player.tx, player.ty);
  if (ac) return ui.openAgent(ac);
  for (const p of town.plots) {
    if ((p.door.x === f.x && p.door.y === f.y) || (p.door.x === player.tx && p.door.y === player.ty))
      return ui.openPC(p);
  }
}
function warpToBlocked(dirn = 1) {
  const blocked = [...world.actors.values()].filter(a => a.agent?.status === 'BLOCKED')
    .sort((a, b) => a.agent.since - b.agent.since);
  if (!blocked.length) { ui.back(); return ui.toast('nobody is blocked ✓'); }
  tabCycle = dirn === 0 ? 0 : ((tabCycle + dirn) % blocked.length + blocked.length) % blocked.length;
  ui.openAgent(blocked[tabCycle], true);
}
function jumpToPlot(n) {
  const p = town.plots.find(pp => pp.plot === n - 1);
  if (!p) return;
  const T = town.tile;
  player.tx = p.gate.x; player.ty = p.gate.y;
  player.x = player.tx * T; player.y = player.ty * T;
  player.facing = 'up';
  takeControl();
}

addEventListener('keydown', (e) => {
  if (Notification.permission === 'default') Notification.requestPermission();
  if (ui.typing()) return;                       // let the reply box own the keyboard
  if (e.key === 'Escape') { ui.back(); e.preventDefault(); return; }
  if (ui.pcKey(e)) { e.preventDefault(); return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  keys[k] = true;
  if (e.key === 'Tab') { e.preventDefault(); warpToBlocked(e.shiftKey ? -1 : 1); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); interact(); }
  else if (k === 'n') ui.openSpawn(town);
  else if (/^[1-9]$/.test(k)) jumpToPlot(Number(k));
  else if (k === '-' || k === '_') setZoom((userZoom || SCALE) - ZOOM_STEP);
  else if (k === '=' || k === '+') setZoom((userZoom || SCALE) + ZOOM_STEP);
  else if (k === '0') setZoom(null);
  else if (k === '[') setPane(panelEl, 'pc.panel', !panelEl.classList.contains('collapsed'));
  else if (k === ']') setPane(feedWrap, 'pc.feed', !feedWrap.classList.contains('collapsed'));
});
addEventListener('keyup', (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; keys[k] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
// Click anywhere on the canvas. Coordinates MUST come from the canvas rect, not
// raw clientX: the left panel offsets the canvas by a third of the window.
function pointToWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { wx: (e.clientX - r.left) / SCALE, wy: (e.clientY - r.top) / SCALE };
}

// A sprite is drawn upward from its tile, so the pixels you click are above its
// feet. Match on the foot tile or the one below, then fall back to the nearest
// sprite within a sprite's width so a click never feels dead.
// The shed occupies its row plus the tile above it, where the roof is drawn.
function onShed(p, tx, ty) {
  return p.shed && tx >= p.shed.x && tx < p.shed.x + p.shed.w &&
    ty >= p.shed.y - 1 && ty <= p.shed.y;
}

function pickActor(wx, wy) {
  const T = town.tile, tx = Math.floor(wx / T), ty = Math.floor(wy / T);
  const hit = actorAt(tx, ty) || actorAt(tx, ty + 1);
  if (hit && !isHidden(hit.plot?.plot)) return hit;
  let best = null, bestD = 22 * 22;
  for (const ac of world.actors.values()) {
    if (isHidden(ac.plot?.plot)) continue;
    const dx = wx - (ac.x + 8), dy = wy - (ac.y + 2);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = ac; }
  }
  return best;
}

canvas.addEventListener('click', (e) => {
  if (panned) { panned = false; return; }        // that click was a drag of the field
  const T = town.tile;
  const { wx, wy } = pointToWorld(e);
  const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
  if (atFrontDesk(tx, ty)) return ui.openRanger(town);
  const ac = pickActor(wx, wy);
  if (ac) return ac.agent?.kind === 'cron' ? ui.openCrons(ac.agent.cron.label) : ui.openAgent(ac);
  const p = town.plots.find(pp => tx >= pp.pen.x && tx < pp.pen.x + pp.pen.w &&
    ty >= pp.pen.y - town.layout.hutRow && ty < pp.pen.y + pp.pen.h);
  if (!p || isHidden(p.plot)) return;
  // The house is the door to new work: click it to start an agent in that repo.
  if (p.dir === CRON_DIR) return ui.openCrons();
  if (onShed(p, tx, ty)) return ui.openSpawn(town, p.rawDir);
  ui.openPC(p);
});

// Pointer feedback so it is obvious the sprites are clickable.
canvas.addEventListener('mousemove', (e) => {
  if (!town) return;
  const T = town.tile;
  const { wx, wy } = pointToWorld(e);
  const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
  const overShed = town.plots.some(p => !isHidden(p.plot) && onShed(p, tx, ty));
  const over = pickActor(wx, wy) || overShed || atFrontDesk(tx, ty);
  // Empty ground is the handle you drag the field by, so it says so.
  canvas.style.cursor = over ? 'pointer' : 'grab';
});

const cam = { x: 0, y: 0 };
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  playerStep(dt); world.step(dt);
  const T = town.tile;
  cam.x = 0; cam.y = 0;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#7bc47f'; ctx.fillRect(0, 0, town.w * T, town.h * T);
  drawField(ctx, town, town.visible, img);
  const t = now / 1000;

  // sign plates
  const blockedByPlot = new Map();
  for (const a of state.agents) {
    if (a.status !== 'BLOCKED') continue;
    const p = world.plotFor(a.dir);
    if (p && !isHidden(p.plot)) blockedByPlot.set(p.plot, (blockedByPlot.get(p.plot) || 0) + 1);
  }
  for (const p of town.visible)
    signPlate(ctx, p.signPx.x, p.signPx.y, p.sign, blockedByPlot.get(p.plot) || 0, t, p.signPx.center);
  // actors + player, y-sorted
  const drawList = [...world.actors.values()]
    .filter(a => !isHidden(a.plot?.plot))
    .map(a => ({ kind: 'actor', y: a.y, a }));
  drawList.push({ kind: 'player', y: player.y });
  drawList.push({ kind: 'ranger', y: ranger.ty * T });
  drawList.push({ kind: 'desk', y: desk.ty * T });
  drawList.sort((x, y) => x.y - y.y);
  for (const d of drawList) {
    if (d.kind === 'player') {
      // At the desk the sheets have no typing pose, so the motion has to be around it:
      // the walk frames cycled in place, a 1px bounce, and keystrokes coming off the
      // keyboard. Standing still at a lit screen looked like nothing was happening.
      const frame = player.typing ? Math.floor(t * 9) % 4 : player.frame;
      const bob = player.typing ? typeBob(t) : 0;
      const ptop = drawPoke(ctx, PLAYER_SPECIES, player.x + 8, player.y + 16 + bob,
                            player.facing, frame, player.moving || player.typing);
      if (player.typing) keystrokes(ctx, player.x + 8, ptop, t, seat.tx < desk.tx ? 1 : -1);
      const mood = fleetMood();
      // A walking Pikachu with zzz over it would contradict itself, so the all-quiet
      // marker only shows while it is standing still.
      if (mood === 'think') thinking(ctx, player.x + 8, ptop, t);
      // zzz over a Pokemon that is walking, or typing, would contradict itself
      else if (mood !== 'z' || (!player.moving && !player.typing))
        bubble(ctx, player.x + 8, ptop, mood, t);
      continue;
    }
    if (d.kind === 'desk') {
      deskPC(ctx, desk.tx * T + 8, desk.ty * T + 16,
             deskBusy(state.agents, ui.ashWorking()), t, seat.tx > desk.tx ? 1 : -1);
      continue;
    }
    if (d.kind === 'ranger') { drawTrainer(ctx, 0, ranger.tx * T + 8, ranger.ty * T + 16, 'down', 0); continue; }
    const ac = d.a, ag = ac.agent || {};
    const cx = ac.x + 8, cy = ac.y + 16;
    for (let j = (ag.followers || 0) - 1; j >= 0; j--) {
      const p = ac.trail[Math.min(ac.trail.length - 1, (j + 1) * 10)] || ac;
      drawBall(ctx, p.x + 8, p.y + 16, t + j * 0.6);
    }
    if (ac === selected) selectMark(ctx, cx, ac.y + 16, t);
    // A killed agent dissolves rather than lying around as a corpse.
    if (ag.status === 'FAINTED') {
      const gone = ag.faintedAt ? (Date.now() - ag.faintedAt) / 6000 : 0.5;
      ctx.globalAlpha = Math.max(0, 1 - gone);
    }
    const movingNow = Math.abs(ac.x - (ac.target?.x ?? ac.x)) > 1 || Math.abs(ac.y - (ac.target?.y ?? ac.y)) > 1;
    if (movingNow) dust(ctx, cx, cy + 14, t);
    // Everything alive breathes 1px. Sleepers breathe slower and deeper.
    const rest = ag.status === 'ASLEEP' ? Math.sin(t * 0.9 + (ac.phase || 0)) : (ac.breathe || 0);
    const bob = ag.status === 'FAINTED' ? 0 : (rest > 0.55 ? -1 : 0);
    const top = drawPoke(ctx, ac.species[0], cx, cy + bob, ac.facing, ac.frame, movingNow);
    ctx.globalAlpha = 1;
    // A scheduled job shows when it next fires, or why it needs you.
    if (ag.kind === 'cron') {
      const st = cronState(ag.cron);
      const label = st === 'failed' ? 'failed' : st === 'stalled' ? 'stalled'
        : st === 'unloaded' ? 'off' : st === 'running' ? 'running' : untilText(ag.cron.next);
      cronMark(ctx, cx, top, cy, label, st, t);
      if (st === 'failed' || st === 'stalled') bubble(ctx, cx, top - 14, 'warn', t + hash(ac.id) % 10);
      continue;
    }
    // A service keeps its Pokemon; the exhaust and port float over it instead.
    if (ag.kind === 'service') {
      serviceMark(ctx, cx, top, cy, ag.ports?.[0], t, ag.status !== 'FAINTED');
      continue;                                   // no !/thinking bubbles for a service
    }
    // Only escalation earns an icon. Idle is silent, and a freshly blocked agent is
    // silent too: nothing shouts until it has actually been waiting.
    const wait = Date.now() - (ag.since || Date.now());
    if (ag.status === 'BLOCKED') {
      // Done and waiting on you: blue "..." straight away, then it escalates to red.
      const lift = (ac.slot || 0) % 2 ? 9 : 0;      // stagger neighbours
      const kind = wait > 30 * 60e3 ? 'warn2' : wait > 5 * 60e3 ? 'warn' : 'ask';
      bubble(ctx, cx, top - lift, kind, t + hash(ac.id) % 10);
      if (wait > 5 * 60e3) waitLabel(ctx, cx, cy, wait);
    } else if (ag.status === 'ASLEEP') {
      bubble(ctx, cx, top, 'z', t + (ac.phase || 0));   // finished, gone quiet
    } else if (ag.status === 'FAINTED' && Date.now() - (ag.faintedAt || 0) < 2500) {
      bubble(ctx, cx, top, 'x', t);
    } else if (ag.status === 'WORKING' && !ac.pop && ag.lastToolAt
               && Date.now() - ag.lastToolAt > 8000) {
      thinking(ctx, cx, top, t + (ac.phase || 0));
    }
    if (ac.pop) toolPop(ctx, cx, top, ac.pop.tool, ac.pop.t);
  }
  // tooltip: repo under player
  const here = town.plots.find(p => player.tx >= p.pen.x - 1 && player.tx <= p.pen.x + p.pen.w &&
    player.ty >= p.pen.y - town.layout.hutRow && player.ty <= p.pen.y + p.pen.h);
  if (here) { tooltip.style.display = 'block'; tooltip.textContent = `${here.sign}  ·  ${here.rawDir}`; }
  else tooltip.style.display = 'none';
  requestAnimationFrame(loop);
}
boot();
