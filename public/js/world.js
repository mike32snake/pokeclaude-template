// Agent placement + movement in the town.
export function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

import { DEX } from './dex.js';
import { cronSlot } from './crons.js';

export class World {
  constructor(town) {
    this.town = town; this.T = town.tile;
    this.byDir = new Map();
    this.unmapped = [];
    this.setPlots(town.plots || []);
    this.actors = new Map();   // workspaceId -> actor
  }
  plotFor(dir) { return (dir && this.byDir.get(dir)) || null; }

  // Called whenever the visible set changes: agents move to their repo's new slot.
  setPlots(plots) {
    this.town.plots = plots;
    this.byDir = new Map(plots.filter(p => p.dir).map(p => [p.dir, p]));
  }

  sync(agents, now = Date.now()) {
    const seen = new Set();
    // stable town-square slots for long-blocked agents, 2 tiles apart, no overlap
    const gathered = agents.filter(a => a.status === 'BLOCKED' && a.kind !== 'cron'
      && now - a.since > 30 * 60e3)
      .sort((x, y) => x.since - y.since);
    this.square = new Map();
    const s = this.town.spawn, COLS = 6;
    gathered.forEach((a, k) => {
      this.square.set(a.workspaceId, { x: s.x - 7 + (k % COLS) * 3, y: s.y - 3 + Math.floor(k / COLS) * 3 });
    });
    // Anything not actively working lines up in the top-left queue: waiting on you
    // first (oldest first), then idle. Working agents roam instead.
    const IDLE_STATES = new Set(['BLOCKED', 'ASLEEP', 'FAINTED']);
    const blockedIndex = new Map();
    const perPen = new Map();
    const queueOrder = [...agents]
      .filter(x => x.kind === 'cron' || (IDLE_STATES.has(x.status) && x.kind !== 'service'))
      .sort((x, y) => (x.status === 'BLOCKED' ? 0 : 1) - (y.status === 'BLOCKED' ? 0 : 1)
        || x.since - y.since);
    for (const a of queueOrder) {
      const p0 = this.plotFor(a.dir); if (!p0) continue;
      const key = p0.plot;
      const n = perPen.get(key) || 0;
      blockedIndex.set(a.workspaceId, n);
      perPen.set(key, n + 1);
    }
    const groups = new Map();
    const taken = new Map();              // plot id -> Set of "x,y" already claimed
    const claim = (plotId, x, y) => {
      if (!taken.has(plotId)) taken.set(plotId, new Set());
      const set = taken.get(plotId);
      const k = x + ',' + y;
      if (set.has(k)) return false;
      set.add(k); return true;
    };
    this.unmapped = [];
    for (const a of agents) {
      const plot = this.plotFor(a.dir);
      if (!plot) { this.unmapped.push(a); continue; }   // no pen: add it to config/repos.json
      if (!groups.has(plot.plot)) groups.set(plot.plot, []);
      groups.get(plot.plot).push(a);
    }
    for (const [pn, list] of groups) {
      list.sort((x, y) => x.workspaceId < y.workspaceId ? -1 : 1);
      const plot = this.town.plots.find(p => p.plot === pn);
      list.forEach((a, i) => {
        seen.add(a.workspaceId);
        let ac = this.actors.get(a.workspaceId);
        if (!ac) {
          // Born in place, not outside: a new agent must never appear on the edge of
          // its plot and then wander in. `fresh` is cleared once its target is known.
          ac = { id: a.workspaceId, fresh: true,
                 x: plot.gate.x * this.T, y: (plot.gate.y + 1) * this.T,
                 variant: 1 + hash(a.workspaceId) % 9,
                 species: DEX[hash(a.workspaceId + 'v2') % DEX.length],
                 trail: [], facing: 'down', frame: 0, ft: 0,
                 phase: (hash(a.workspaceId) % 100) / 100 * 6.28,   // desync the breathing
                 wanderIn: 2 + (hash(a.workspaceId) % 60) / 10,
                 pop: null, seenSeq: a.toolSeq || 0, spotIdx: null };
          this.actors.set(a.workspaceId, ac);
        }
        ac.agent = a; ac.plot = plot;
        if ((a.toolSeq || 0) > ac.seenSeq) {          // a real tool call happened
          ac.seenSeq = a.toolSeq;
          ac.pop = { tool: a.lastTool || 'tool', t: 0 };
          ac.wanderIn = Math.min(ac.wanderIn, 1.2);   // it gets up and shifts about
        }
        const wait = now - a.since;
        let t;
        if (a.kind === 'cron') {
          // A timetable, not a workplace: fixed columns clear of the shed, so the
          // "next run" chips never sit on top of each other or on the tower.
          const bi = blockedIndex.get(a.workspaceId) ?? 0;
          ac.slot = bi;
          const c = cronSlot(plot, bi);
          claim(plot.plot, c.x, c.y);
          t = { x: c.x, y: c.y, f: 'down' };
        } else if (IDLE_STATES.has(a.status) && a.kind !== 'service') {
          // Line up inside the front fence, facing out, so a blocked agent always
          // stays in its own pen. Urgency is carried by the bubble and the timer,
          // not by wandering into the next pen's space.
          // Waiting agents gather at the TOP-LEFT of the plot, two tiles apart so the
          // sprites, their bubbles and their timers never sit on top of each other.
          // Top-left because the shed occupies the top-right.
          const bi = blockedIndex.get(a.workspaceId) ?? 0;
          ac.slot = bi;
          const inn = plot.inner;
          const cols = Math.max(1, Math.floor((inn.x1 - inn.x0) / 2) + 1);
          const rows = Math.max(1, Math.floor((inn.y1 - inn.y0) / 2) + 1);
          t = null;
          for (let k = 0; k < cols * rows && !t; k++) {     // first free slot from mine
            const n = (bi + k) % (cols * rows);
            const x = inn.x0 + (n % cols) * 2;
            const y = inn.y0 + Math.floor(n / cols) * 2;
            if (claim(plot.plot, x, y)) t = { x, y, f: 'down' };
          }
          if (!t) t = { x: inn.x0, y: inn.y0, f: 'down' };
        } else if (a.kind === 'service') {
          // Top-right of its plot, directly in front of the shed it belongs to.
          ac.slot = 0;
          t = { x: plot.inner.x1, y: plot.inner.y0, f: 'down' };
          claim(plot.plot, t.x, t.y);
        } else {
          ac.slot = 0;
          // Stay out of the waiting cluster: lower rows, or the right-hand side.
          const inn = plot.inner;
          const cutX = inn.x0 + Math.floor((inn.x1 - inn.x0) / 2);
          const cutY = inn.y0 + Math.floor((inn.y1 - inn.y0) / 2);
          const room = plot.desks.filter(d => d.y > cutY || d.x > cutX);
          ac.pool = room.length ? room : plot.desks;
          if (ac.spotIdx == null) ac.spotIdx = (i + hash(a.workspaceId)) % ac.pool.length;
          t = null;
          for (let k = 0; k < ac.pool.length && !t; k++) {  // nearest free work spot
            const d = ac.pool[(ac.spotIdx + k) % ac.pool.length];
            if (claim(plot.plot, d.x, d.y)) { ac.spotIdx = (ac.spotIdx + k) % ac.pool.length; t = { x: d.x, y: d.y, f: 'down' }; }
          }
          if (!t) { const d = ac.pool[ac.spotIdx % ac.pool.length]; t = { x: d.x, y: d.y, f: 'down' }; }
        }
        ac.target = { x: t.x * this.T, y: t.y * this.T, f: t.f };
        if (ac.fresh) {                       // snap into the plot on first placement
          ac.x = ac.target.x; ac.y = ac.target.y; ac.facing = t.f || 'down';
          ac.fresh = false;
        }
      });
    }
    for (const id of [...this.actors.keys()]) if (!seen.has(id)) this.actors.delete(id);
  }

  step(dt, now = performance.now() / 1000) {
    const sp = 90 * dt;   // px/s
    for (const ac of this.actors.values()) {
      // A service is a box on the ground, not a creature: it never walks anywhere.
      // A cron is the same: it stands on its time slot, so it SNAPS there rather than
      // strolling over. Snapping also has to happen here, not by skipping the movement
      // code below, or a grid change leaves it stranded in the old pen's coordinates.
      const fixed = ac.agent?.kind === 'service' || ac.agent?.kind === 'cron';
      if (fixed && ac.target) {
        ac.x = ac.target.x; ac.y = ac.target.y; ac.facing = 'down';
        ac.breathe = Math.sin(now * 1.9 + ac.phase);   // it is still alive, so it breathes
        continue;
      }
      ac.breathe = Math.sin(now * 1.9 + ac.phase);          // -1..1, drives a 1px bob
      if (ac.pop) { ac.pop.t += dt; if (ac.pop.t > 2.4) ac.pop = null; }
      // A working agent does not stand still: every few seconds it moves to another
      // spot in its pen and looks around. Idle and blocked agents stay put.
      const st = ac.agent?.status;
      if (ac.agent?.kind === 'service') continue;      // machines do not roam
      if (st === 'WORKING' || st === 'THINKING') {
        ac.wanderIn -= dt;
        if (ac.wanderIn <= 0 && ac.pool?.length > 1) {
          // Only move somewhere nobody else is heading, so wandering cannot stack two
          // sprites on the same tile.
          const busy = new Set();
          for (const other of this.actors.values()) {
            if (other === ac || other.plot?.plot !== ac.plot?.plot || !other.target) continue;
            busy.add(Math.round(other.target.x / this.T) + ',' + Math.round(other.target.y / this.T));
          }
          for (let k = 1; k <= ac.pool.length; k++) {
            const idx = (ac.spotIdx + k) % ac.pool.length;
            const d = ac.pool[idx];
            if (busy.has(d.x + ',' + d.y)) continue;
            ac.spotIdx = idx;
            ac.target = { x: d.x * this.T, y: d.y * this.T, f: 'down' };
            break;
          }
          ac.wanderIn = 6 + Math.abs(ac.breathe) * 9;
        }
      }
      const { target } = ac; if (!target) continue;
      let moved = false;
      if (Math.abs(ac.x - target.x) > 1) {
        ac.facing = ac.x < target.x ? 'right' : 'left';
        ac.x += Math.sign(target.x - ac.x) * Math.min(sp, Math.abs(target.x - ac.x)); moved = true;
      } else if (Math.abs(ac.y - target.y) > 1) {
        ac.facing = ac.y < target.y ? 'down' : 'up';
        ac.y += Math.sign(target.y - ac.y) * Math.min(sp, Math.abs(target.y - ac.y)); moved = true;
      } else { ac.facing = target.f || 'down'; }
      ac.ft += dt;
      if (moved) { if (ac.ft > 0.12) { ac.frame = (ac.frame + 1) % 4; ac.ft = 0; } }
      else if (ac.agent?.status === 'WORKING') { if (ac.ft > 0.35) { ac.frame = (ac.frame + 1) % 4; ac.ft = 0; } }
      else ac.frame = 0;
      // follower trail
      ac.trail.unshift({ x: ac.x, y: ac.y });
      if (ac.trail.length > 120) ac.trail.pop();
    }
  }
}
