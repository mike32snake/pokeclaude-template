// Scheduled jobs, shown as residents of their own pen.
// The pen is for what needs your eyes: jobs running now, jobs that failed, jobs whose
// schedule has clearly stopped firing, and whatever runs next. The full timetable
// lives in the panel, because 33 sprites in one pen is a crowd, not information.

export const CRON_DIR = '__crons__';
// The id must be a NUMBER: the agent list keys its expand/collapse state by
// Number(plot.id), so a string id makes the crons group refuse to open. -1 can never
// collide with a real repo, which the town builder numbers from 0.
export const CRON_PEN = {
  id: -1, dir: CRON_DIR, rawDir: CRON_DIR, sign: 'crons',
  archetype: 'tower', tint: [156, 132, 214], hutW: 64, hutH: 40, hutTilesW: 4,
};

const MIN = 60e3;
const SOON = 90 * MIN;      // "runs next" horizon
// Sprites stand 3 tiles apart in both directions, not the 2 an idle agent uses. Every
// cron carries a chip saying when it next runs: at 2 columns those chips collide with
// each other, and at 2 rows a chip lands on the sprite in the row above. The grid also
// stops short of the shed so no chip covers the tower.
export const STEP_X = 3, STEP_Y = 3;
export function cronGrid(plot) {
  const inn = plot.inner;
  const x0 = inn.x0;
  const x1 = Math.min(inn.x1, (plot.shed ? plot.shed.x : inn.x1 + 1) - 1);
  const cols = Math.max(1, Math.floor((x1 - x0) / STEP_X) + 1);
  const rows = Math.max(1, Math.floor((inn.y1 - inn.y0) / STEP_Y) + 1);
  return { x0, y0: inn.y0, cols, rows, cap: cols * rows };
}
export function cronSlot(plot, i) {
  const g = cronGrid(plot);
  return { x: g.x0 + (i % g.cols) * STEP_X, y: g.y0 + Math.floor(i / g.cols) * STEP_Y };
}

// A job's health, from the two facts launchd gives us: exit code and when it last wrote.
//   failed  - last run exited non-zero
//   stalled - an interval job whose next run is long past, so it is not firing at all
//   running - a live PID right now
//   due     - fires within the next 90 minutes
//   ok      - everything else
export function cronState(job, now = Date.now()) {
  if (job.running) return 'running';
  if (job.status != null && job.status !== 0) return 'failed';
  if (!job.loaded && !job.isCrontab) return 'unloaded';
  if (job.next && job.next < now - 30 * MIN) return 'stalled';
  if (job.next && job.next - now < SOON) return 'due';
  return 'ok';
}

const RANK = { failed: 0, stalled: 1, running: 2, unloaded: 3, due: 4, ok: 5 };

// Which jobs earn a sprite: everything unhealthy, then whatever runs soonest.
export function penJobs(crons, cap = Infinity, now = Date.now()) {
  return [...(crons || [])]
    .map(j => ({ ...j, state: cronState(j, now) }))
    .filter(j => j.state !== 'ok')
    .sort((a, b) => RANK[a.state] - RANK[b.state] || (a.next ?? Infinity) - (b.next ?? Infinity))
    .slice(0, cap);
}

// Sorted for the panel: trouble first, then by next run.
export function allJobs(crons, now = Date.now()) {
  return [...(crons || [])]
    .map(j => ({ ...j, state: cronState(j, now) }))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || (a.next ?? Infinity) - (b.next ?? Infinity));
}

// Cron jobs ride the same placement and drawing code as agents, so they need the same
// shape. `kind: 'cron'` is what every consumer keys off to treat them differently.
const STATUS = { running: 'WORKING', failed: 'BLOCKED', stalled: 'BLOCKED',
                 unloaded: 'ASLEEP', due: 'ASLEEP', ok: 'ASLEEP' };

export function cronActors(crons, cap = Infinity, now = Date.now()) {
  return penJobs(crons, cap, now).map(j => ({
    workspaceId: 'cron:' + j.label,
    dir: CRON_DIR, rawDir: j.dir || CRON_DIR,
    title: j.name, sign: 'crons',
    kind: 'cron', cron: j,
    status: STATUS[j.state] || 'ASLEEP',
    since: j.lastRun || now,
    toolSeq: 0,
  }));
}

// "in 12m" / "in 3h" / "Tue 07:00" — near things get a countdown, far things a clock.
export function untilText(ms, now = Date.now()) {
  if (!ms) return '—';
  const d = ms - now;
  if (d < 0) return 'overdue';
  if (d < 60e3) return 'now';
  if (d < 60 * MIN) return 'in ' + Math.round(d / MIN) + 'm';
  if (d < 24 * 60 * MIN) return 'in ' + Math.round(d / (60 * MIN)) + 'h';
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function agoText(ms, now = Date.now()) {
  if (!ms) return 'never';
  const d = now - ms;
  if (d < 60e3) return 'just now';
  if (d < 60 * MIN) return Math.round(d / MIN) + 'm ago';
  if (d < 24 * 60 * MIN) return Math.round(d / (60 * MIN)) + 'h ago';
  return Math.round(d / (24 * 60 * MIN)) + 'd ago';
}
