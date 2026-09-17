// Desktop notifications, fired by the SERVER so they arrive whether or not a browser
// is open. macOS shows them through osascript, which is already on the machine: no
// dependency, no permission prompt in the page, nothing to keep alive.
//
// The only real risk is crying wolf. A notifier that repeats itself, or that empties
// its backlog into your face every time the server restarts, gets muted once and then
// never helps again. So: nothing on the first look around, one alert per transition,
// and services are ignored entirely.
import { execFile } from 'node:child_process';
import path from 'node:path';
// The 151 names, from the same file the field draws from. Duplicating that list in the
// server would be a second copy of the one thing that must agree with what you are
// looking at: the Pokemon in the notification has to be the Pokemon on the pen.
import { DEX } from '../../public/js/dex.js';

const MIN = 60 * 1000;

// The same answer the panel gets from cronState in public/js/crons.js, narrowed to
// the two states worth interrupting someone for. tests/notify.test.js runs both over
// the same jobs, so the copy cannot drift away from the original in silence.
export function cronTrouble(job, now = Date.now()) {
  if (!job || job.running) return null;
  if (job.status != null && job.status !== 0) return 'failed';
  if (!job.loaded && !job.isCrontab) return null;
  if (job.next && job.next < now - 30 * MIN) return 'stalled';
  return null;
}

export const penName = (dir) => (dir ? path.basename(dir) : 'unmapped');

// The same hash the client uses in public/js/world.js, so a workspace gets the same
// Pokemon here as it does on the field. tests/notify.test.js imports the client's hash
// and checks the two agree, so the copy cannot drift.
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
export function speciesFor(workspaceId) {
  const [dex, name] = DEX[hash(workspaceId + 'v2') % DEX.length];
  return { dex, name };
}

// One line, the width of a notification. Transcript text is markdown written for a
// terminal, so the first line is the news and the rest is detail nobody reads from
// the corner of a screen.
export function summarise(text, max = 110) {
  let s = String(text ?? '').split('\n').map(l => l.trim()).find(l => l) || '';
  s = s.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '')
       .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const SAID = {
  'needs-you': 'needs you',
  finished: 'finished',
  died: 'died',
  'cron-failed': 'cron failed',
  'cron-stalled': 'cron stalled, it has not run',
};
const SOUND = { 'needs-you': 'Glass', died: 'Basso', 'cron-failed': 'Basso', 'cron-stalled': 'Basso' };

// What the notification actually reads like: who, where, what happened, and what it
// was doing. An agent alert is named for its Pokemon and its repo, because that is how
// you find it on the field; a cron has neither, so it is named for the job.
export function describe({ kind, species, pen, label, detail } = {}) {
  const title = species ? `${species.name} · ${pen || 'unmapped'}` : (label || 'cron');
  return { title, subtitle: SAID[kind] || kind, body: summarise(detail, 110), sound: SOUND[kind] };
}

// Which transitions are worth an interruption. The watcher says only WHAT happened and
// to whom: reading a transcript to find out what an agent was doing costs a file read,
// so the caller does that for the one or two agents that actually changed, never for
// the whole field on every broadcast.
function alertFor(prev, a) {
  const at = { workspaceId: a.workspaceId, key: a.workspaceId, dir: a.dir, title: a.title };
  if (a.status === 'BLOCKED') return { ...at, kind: 'needs-you' };
  if (a.status === 'FAINTED') return { ...at, kind: 'died' };
  if (a.status === 'ASLEEP' && ['WORKING', 'THINKING', 'BLOCKED'].includes(prev))
    return { ...at, kind: 'finished' };
  return null;
}

// Remembers what everything was last time and reports only what changed. Pure: it
// decides, the caller delivers, so the decision is testable without a desktop.
//
// A change is not enough on its own. cmux is polled every 3s, and an agent between two
// tool calls reads as Idle for a single poll, so a plain transition watcher announced
// "finished" in the middle of a long task and the agent carried straight on working.
// A state has to HOLD for `settle` before it is worth interrupting someone, which is
// the whole difference between telling you something and narrating at you. Anything
// that resolves itself inside the window is never mentioned at all, and it must not
// arrive late either: the pending alert is dropped, not deferred.
const SETTLE = Number(process.env.POKECLAUDE_SETTLE_MS) || 20000;

export function makeWatcher({ settle = SETTLE } = {}) {
  // What the world looks like AS FAR AS YOU KNOW: updated the moment a state is too
  // dull to mention, and otherwise only once its alert has actually been sent.
  const agents = new Map();          // workspaceId -> status
  const jobs = new Map();            // cron label -> trouble state or null
  const pending = new Map();         // key -> { state, since } waiting out the window
  let primed = false;                // the first look is for learning, not announcing

  // Has this state held long enough to be worth a banner? Restarts its own clock
  // whenever the state changes, so an agent moving about stays quiet throughout.
  const settled = (key, state, now) => {
    let p = pending.get(key);
    if (!p || p.state !== state) { p = { state, since: now }; pending.set(key, p); }
    return now - p.since >= settle;
  };

  return {
    check(list, crons, now = Date.now()) {
      const out = [];
      const seen = new Set();
      for (const a of list || []) {
        seen.add(a.workspaceId);
        const prev = agents.get(a.workspaceId);
        // A service is a dev server, not an agent: it has no task and finishing is
        // not something it does. A workspace seen for the first time has no
        // transition to report, which is also what makes a restart quiet.
        if (a.kind === 'service' || !primed || prev === undefined) {
          agents.set(a.workspaceId, a.status);
          pending.delete(a.workspaceId);
          continue;
        }
        if (a.status === prev) { pending.delete(a.workspaceId); continue; }
        const alert = alertFor(prev, a);
        // Nothing to say about it, so it becomes the new baseline immediately. Without
        // this, work done between two quiet states would be judged against a status
        // from an hour ago.
        if (!alert) { agents.set(a.workspaceId, a.status); pending.delete(a.workspaceId); continue; }
        if (!settled(a.workspaceId, a.status, now)) continue;
        agents.set(a.workspaceId, a.status);
        pending.delete(a.workspaceId);
        out.push(alert);
      }
      for (const id of [...agents.keys()]) if (!seen.has(id)) { agents.delete(id); pending.delete(id); }
      // An agent that vanished mid-window must not be announced when it comes back.
      for (const key of [...pending.keys()]) if (!key.startsWith('cron:') && !seen.has(key)) pending.delete(key);

      for (const j of crons || []) {
        const state = cronTrouble(j, now);
        const prev = jobs.get(j.label);
        const key = `cron:${j.label}`;
        if (!primed || prev === undefined) { jobs.set(j.label, state); pending.delete(key); continue; }
        if (state === prev) { pending.delete(key); continue; }
        // Recovering is good news, and good news is not an interruption. It is still
        // recorded, so the next failure counts as a change and gets through.
        if (!state) { jobs.set(j.label, state); pending.delete(key); continue; }
        if (!settled(key, state, now)) continue;
        jobs.set(j.label, state);
        pending.delete(key);
        out.push({ key, kind: state === 'failed' ? 'cron-failed' : 'cron-stalled',
                   label: j.label, detail: j.status ? `exit ${j.status}` : '' });
      }
      primed = true;
      return out;
    },
  };
}

// One AppleScript statement, whatever the agent called itself. A title comes from a
// terminal tab, so it can hold quotes, backslashes and newlines, and any of the three
// would otherwise end the string and leave the rest of it running as script.
export function appleScript({ title, subtitle, body, sound } = {}) {
  const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  return `display notification "${esc(body)}" with title "${esc(title)}"`
    + (subtitle ? ` subtitle "${esc(subtitle)}"` : '')
    + (sound ? ` sound name "${esc(sound)}"` : '');
}

// Fire and forget, with a timeout. Nothing here may ever hold up a hook or a poll: a
// notification that delays the fleet is worse than a notification you missed.
//
// Two paths, in order. The desktop app posts through UNUserNotificationCenter, so its
// alerts carry the Pokeball and the name PokeClaude and get their own line in System
// Settings. It is only there when it is running, so osascript is the floor under it,
// and macOS then credits the alert to "Script Editor" with a script icon.
//
// The ugly path is not optional. We shipped an applet of our own to get the branding
// without an app, and on macOS 26 it delivered NOTHING for a day, in two ways at once.
// macOS hands an applet launched from a path NO argv, so `item 1 of argv` threw and it
// put up a modal "Can't get item 1. (-1728)" carrying our Pokeball, once per alert,
// waiting for a click: that is what "the notifications" looked like from the outside,
// and it is why the applet HUNG on every run after the first. Fixing the arguments
// would not have helped either. An applet that asks for nothing still gets denied:
// `usernoted` logs "Denying message 3 from connection <LegacyConnection ...>" and
// drops the alert, signed or not, in /Applications or not. Only a real signed binary
// on the modern API gets past that, which is what the app is.
export function makeSender({ spawn = run, toApp = () => false,
                             muted = process.env.POKECLAUDE_NOTIFY === '0' } = {}) {
  return (note) => {
    if (muted) return false;
    if (toApp(note)) return true;
    spawn('osascript', ['-e', appleScript(note)]);
    return true;
  };
}

function run(cmd, args) { execFile(cmd, args, { timeout: 4000 }, () => {}); }

// The one the server uses. Built once, because the only thing it reads is the kill
// switch, and an environment variable does not change while the process is up. Whether
// the app is listening DOES change, so that question is asked per notification through
// the hook the server installs here.
let sender = null;
let appDeliver = () => false;
export function onAppDeliver(fn) { appDeliver = fn || (() => false); }
export function fire(note) {
  if (!sender) sender = makeSender({ toApp: (n) => appDeliver(n) });
  return sender(note);
}
