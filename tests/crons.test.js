import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronState, penJobs, allJobs, cronActors, untilText, agoText, cronGrid, cronSlot,
         STEP_X, STEP_Y, CRON_DIR } from '../public/js/crons.js';
import { readFileSync } from 'node:fs';

const TOWNS = [3, 4, 5].map(n =>
  JSON.parse(readFileSync(new URL(`../public/art/town-${n}.json`, import.meta.url))));

const NOW = Date.parse('2026-08-22T10:00:00Z');
const MIN = 60e3;
const job = (o) => ({ label: 'com.x.' + (o.name || 'j'), name: o.name || 'j', schedule: 'daily',
  next: NOW + 24 * 60 * MIN, lastRun: NOW - 60 * MIN, status: 0, running: false,
  loaded: true, ...o });

test('a non-zero exit is a failure, whatever the schedule says', () => {
  assert.equal(cronState(job({ status: 1 }), NOW), 'failed');
});

test('a live PID beats everything: it is running', () => {
  assert.equal(cronState(job({ running: true, status: 1 }), NOW), 'running');
});

test('an unloaded job is called out rather than shown as healthy', () => {
  assert.equal(cronState(job({ loaded: false }), NOW), 'unloaded');
});

test('a next run half an hour in the past means the schedule stopped firing', () => {
  assert.equal(cronState(job({ next: NOW - 45 * MIN }), NOW), 'stalled');
  // still inside the grace window: launchd may simply not have got to it yet
  assert.equal(cronState(job({ next: NOW - 5 * MIN }), NOW), 'due');
});

test('due covers the next 90 minutes, and nothing beyond it', () => {
  assert.equal(cronState(job({ next: NOW + 80 * MIN }), NOW), 'due');
  assert.equal(cronState(job({ next: NOW + 100 * MIN }), NOW), 'ok');
});

test('the pen shows trouble first and never overflows its cap', () => {
  const many = [
    ...Array.from({ length: 30 }, (_, i) => job({ name: 'ok' + i, next: NOW + 500 * MIN })),
    ...Array.from({ length: 5 }, (_, i) => job({ name: 'bad' + i, status: 1 })),
    job({ name: 'soon', next: NOW + 10 * MIN }),
  ];
  assert.equal(penJobs(many, Infinity, NOW).length, 6);   // 5 failed + 1 due; healthy stay out
  const pen = penJobs(many, 4, NOW);
  assert.equal(pen.length, 4);
  assert.ok(pen.every(j => j.state === 'failed'));        // the cap keeps the worst
});

test('a healthy job is never given a sprite', () => {
  assert.equal(penJobs([job({ next: NOW + 500 * MIN })], Infinity, NOW).length, 0);
});

// The pen must hold its sprites the way every other plot does: inside the ground,
// off the borders, never two on a tile, and never under the shed.
const cronPen = (t) => {
  const s = t.slots[t.repos.length];                      // the client appends the pen here
  return { ...s, shed: { x: s.pen.x + s.pen.w - 4 } };     // CRON_PEN.hutTilesW
};

test('every layout can seat at least four scheduled jobs', () => {
  for (const t of TOWNS) assert.ok(cronGrid(cronPen(t)).cap >= 4,
    `size ${t.size}: capacity ${cronGrid(cronPen(t)).cap}`);
});

test('cron slots stay inside the pen, clear of the shed, and never collide', () => {
  for (const t of TOWNS) {
    const p = cronPen(t), g = cronGrid(p), seen = new Set();
    for (let i = 0; i < g.cap; i++) {
      const s = cronSlot(p, i);
      assert.ok(s.x >= p.inner.x0 && s.x <= p.inner.x1, `size ${t.size} slot ${i} x ${s.x}`);
      assert.ok(s.y >= p.inner.y0 && s.y <= p.inner.y1, `size ${t.size} slot ${i} y ${s.y}`);
      assert.ok(s.x < p.shed.x, `size ${t.size} slot ${i} is under the shed`);
      const k = s.x + ',' + s.y;
      assert.ok(!seen.has(k), `size ${t.size}: two jobs on tile ${k}`);
      seen.add(k);
    }
  }
});

test('columns are far enough apart for a next-run chip', () => {
  assert.ok(STEP_X >= 3);                                 // ~48px: wider than "running"
  assert.ok(STEP_Y >= 2);
});

test('the panel lists everything, trouble first', () => {
  const all = allJobs([job({ name: 'fine', next: NOW + 500 * MIN }), job({ name: 'broke', status: 2 })], NOW);
  assert.equal(all.length, 2);
  assert.equal(all[0].name, 'broke');
});

test('cron actors carry the shape the world places agents by', () => {
  const [a] = cronActors([job({ name: 'broke', status: 1 })], Infinity, NOW);
  assert.equal(a.kind, 'cron');
  assert.equal(a.dir, CRON_DIR);
  assert.equal(a.status, 'BLOCKED');                 // a failure is something waiting on you
  assert.equal(a.workspaceId, 'cron:com.x.broke');
  assert.equal(a.cron.name, 'broke');
});

test('a running job reads as working, not waiting', () => {
  assert.equal(cronActors([job({ running: true })], Infinity, NOW)[0].status, 'WORKING');
});

test('near times count down, far times name the day', () => {
  assert.equal(untilText(NOW + 12 * MIN, NOW), 'in 12m');
  assert.equal(untilText(NOW + 3 * 60 * MIN, NOW), 'in 3h');
  assert.equal(untilText(NOW - MIN, NOW), 'overdue');
  assert.equal(untilText(null, NOW), '—');
  assert.match(untilText(NOW + 3 * 24 * 60 * MIN, NOW), /^[A-Z][a-z]{2} /);
});

test('a job that has never run says so', () => {
  assert.equal(agoText(null, NOW), 'never');
  assert.equal(agoText(NOW - 90 * MIN, NOW), '2h ago');
});
