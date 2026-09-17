// Desktop notifications. The server fires them, not the page, so they arrive whether
// or not a browser is open. The whole risk here is crying wolf: a notifier that
// repeats itself, or that empties its backlog into your face when the server
// restarts, gets muted by the person it was built for and then never helps again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatcher, appleScript, cronTrouble, speciesFor, describe, summarise, makeSender }
  from '../src/server/notify.js';
import { hash } from '../public/js/world.js';
import { DEX } from '../public/js/dex.js';
import { cronState } from '../public/js/crons.js';

const agent = (o = {}) => ({ workspaceId: 'w1', dir: '/repos/pokeclaude', title: 'a task',
  status: 'ASLEEP', kind: 'agent', ...o });
const NOW = 1e12;

test('the first look around is silent: a restart must not replay the whole field', () => {
  const w = makeWatcher({ settle: 0 });
  assert.deepEqual(w.check([agent({ status: 'BLOCKED' }), agent({ workspaceId: 'w2', status: 'FAINTED' })], [], NOW), []);
});

test('an agent that starts needing you is worth one interruption, and only one', () => {
  const w = makeWatcher({ settle: 0 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  const [a] = w.check([agent({ status: 'BLOCKED' })], [], NOW + 1000);
  assert.equal(a.workspaceId, 'w1', 'the caller has to know who, to look up what it was doing');
  assert.equal(a.kind, 'needs-you');
  assert.deepEqual(w.check([agent({ status: 'BLOCKED' })], [], NOW + 2000), [], 'still blocked is not news');
});

test('a finished agent is announced when it stops working, not when it was already idle', () => {
  const w = makeWatcher({ settle: 0 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  const [a] = w.check([agent({ status: 'ASLEEP' })], [], NOW + 1000);
  assert.equal(a.kind, 'finished');
  assert.deepEqual(w.check([agent({ status: 'ASLEEP' })], [], NOW + 2000), []);
});

test('an agent that dies says so once', () => {
  const w = makeWatcher({ settle: 0 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  const [a] = w.check([agent({ status: 'FAINTED' })], [], NOW + 1000);
  assert.equal(a.kind, 'died');
  assert.deepEqual(w.check([agent({ status: 'FAINTED' })], [], NOW + 2000), []);
});

test('a service is not an agent: a dev server idling is not worth your attention', () => {
  const w = makeWatcher({ settle: 0 });
  w.check([agent({ kind: 'service', status: 'WORKING' })], [], NOW);
  assert.deepEqual(w.check([agent({ kind: 'service', status: 'ASLEEP' })], [], NOW + 1000), []);
  assert.deepEqual(w.check([agent({ kind: 'service', status: 'BLOCKED' })], [], NOW + 2000), []);
});

test('an agent that appears mid-run is learned quietly, then watched like the rest', () => {
  const w = makeWatcher({ settle: 0 });
  w.check([agent()], [], NOW);
  assert.deepEqual(w.check([agent(), agent({ workspaceId: 'w2', status: 'BLOCKED' })], [], NOW + 1000), [],
    'a workspace seen for the first time has no transition to report');
  const out = w.check([agent(), agent({ workspaceId: 'w2', status: 'WORKING' })], [], NOW + 2000);
  assert.deepEqual(out, []);
  const [a] = w.check([agent(), agent({ workspaceId: 'w2', status: 'BLOCKED' })], [], NOW + 3000);
  assert.equal(a.kind, 'needs-you');
});

// Cron health is classified in public/js/crons.js for the panel. The server needs the
// same answer for notifications, and two copies of a rule drift apart in silence, so
// this pins them together instead of trusting them to stay equal.
test('the server calls a job failed or stalled exactly when the panel does', () => {
  const cases = [
    { label: 'ok', status: 0, next: NOW + 60e3, loaded: true, running: false },
    { label: 'failed', status: 1, next: NOW + 60e3, loaded: true, running: false },
    { label: 'stalled', status: 0, next: NOW - 40 * 60e3, loaded: true, running: false },
    { label: 'running', status: 1, next: NOW + 60e3, loaded: true, running: true },
    { label: 'due', status: 0, next: NOW + 1000, loaded: true, running: false },
  ];
  for (const j of cases) {
    const panel = cronState(j, NOW);
    const server = cronTrouble(j, NOW);
    assert.equal(server, panel === 'failed' || panel === 'stalled' ? panel : null,
      `${j.label}: panel says ${panel}, server says ${server}`);
  }
});

test('a job going bad interrupts once, and recovering re-arms it', () => {
  const w = makeWatcher({ settle: 0 });
  const ok = { label: 'nightly', status: 0, next: NOW + 60e3, loaded: true, running: false };
  const bad = { ...ok, status: 1 };
  w.check([], [ok], NOW);
  const [a] = w.check([], [bad], NOW + 1000);
  assert.equal(a.kind, 'cron-failed');
  assert.equal(a.label, 'nightly');
  assert.deepEqual(w.check([], [bad], NOW + 2000), [], 'still failed is not news');
  w.check([], [ok], NOW + 3000);
  assert.equal(w.check([], [bad], NOW + 4000).length, 1, 'failing again is news again');
});

// The alert text goes into an AppleScript source string. A title is whatever the agent
// called itself, so a quote in it must not end the string and run the rest as script.

// Only interrupt for something that is actually waiting on you. cmux is polled every
// 3s and an agent between tool calls reads as Idle for a single poll, so every long
// task used to fire "finished" at you and then carry straight on working. A state now
// has to hold before it is worth a banner.
test('a state that flickers and resolves itself never interrupts you', () => {
  const w = makeWatcher({ settle: 20000 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  assert.deepEqual(w.check([agent({ status: 'ASLEEP' })], [], NOW + 3000), [], 'not yet');
  assert.deepEqual(w.check([agent({ status: 'WORKING' })], [], NOW + 6000), [], 'it went back to work');
  assert.deepEqual(w.check([agent({ status: 'WORKING' })], [], NOW + 60000), [],
    'and the alert it nearly sent must not arrive late');
});

test('a state that holds is announced once, after it has settled', () => {
  const w = makeWatcher({ settle: 20000 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  // The window opens when the state is first SEEN, at +5000, so it closes at +25000.
  assert.deepEqual(w.check([agent({ status: 'ASLEEP' })], [], NOW + 5000), [], 'too soon to be sure');
  assert.deepEqual(w.check([agent({ status: 'ASLEEP' })], [], NOW + 24000), [], 'still inside the window');
  const [a] = w.check([agent({ status: 'ASLEEP' })], [], NOW + 26000);
  assert.equal(a.kind, 'finished');
  assert.deepEqual(w.check([agent({ status: 'ASLEEP' })], [], NOW + 60000), [], 'and only once');
});

test('what it settles into is the news, not what it passed through', () => {
  const w = makeWatcher({ settle: 20000 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  w.check([agent({ status: 'BLOCKED' })], [], NOW + 2000);   // asked, then answered itself
  w.check([agent({ status: 'ASLEEP' })], [], NOW + 4000);
  const [a] = w.check([agent({ status: 'ASLEEP' })], [], NOW + 30000);
  assert.equal(a.kind, 'finished', 'the passing BLOCKED must not be reported as needing you');
});

test('the clock restarts when the state changes, so a busy agent stays quiet', () => {
  const w = makeWatcher({ settle: 20000 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  w.check([agent({ status: 'ASLEEP' })], [], NOW + 1000);
  // Still inside the first window, but this is a different state: it starts its own.
  assert.deepEqual(w.check([agent({ status: 'BLOCKED' })], [], NOW + 15000), []);
  assert.deepEqual(w.check([agent({ status: 'BLOCKED' })], [], NOW + 21000), [],
    'the first window closing here must not fire the second state early');
  assert.equal(w.check([agent({ status: 'BLOCKED' })], [], NOW + 36000).length, 1,
    'it lands 20s after the change, not 20s after the first one');
});

test('an agent that goes away while settling takes its alert with it', () => {
  const w = makeWatcher({ settle: 20000 });
  w.check([agent({ status: 'WORKING' })], [], NOW);
  w.check([agent({ status: 'ASLEEP' })], [], NOW + 1000);
  assert.deepEqual(w.check([], [], NOW + 2000), [], 'closed the tab');
  assert.deepEqual(w.check([], [], NOW + 60000), []);
});

test('a cron has to stay broken too, so one bad poll is not an alarm', () => {
  const w = makeWatcher({ settle: 20000 });
  const job = (o = {}) => ({ label: 'nightly', running: false, loaded: true, status: 0, next: NOW + 6e4, ...o });
  w.check([], [job()], NOW);
  assert.deepEqual(w.check([], [job({ status: 1 })], NOW + 3000), []);
  assert.deepEqual(w.check([], [job()], NOW + 6000), [], 'it recovered on the next poll');
  assert.deepEqual(w.check([], [job({ status: 1 })], NOW + 9000), [], 'the new failure starts its own window');
  const [a] = w.check([], [job({ status: 1 })], NOW + 30000);
  assert.equal(a.kind, 'cron-failed', 'a failure that sticks still gets through');
  assert.equal(a.label, 'nightly');
});

test('a quote in an agent title cannot break out of the script', () => {
  const s = appleScript({ title: 'say "hi"', body: 'back\\slash "quoted"' });
  assert.ok(!/[^\\]"hi"/.test(s), 'the inner quotes must be escaped');
  assert.ok(s.includes('\\\\slash'), 'a backslash must be escaped too');
  assert.ok(s.startsWith('display notification'));
});

test('a newline in a title cannot smuggle a second AppleScript statement in', () => {
  const s = appleScript({ title: 'one\ndo shell script "rm -rf /"', body: 'x' });
  assert.equal(s.split('\n').length, 1, 'the whole thing has to stay one statement');
});

// A notification that says "an agent needs you" makes you go and find out which one.
// The name on the pen, the repo it is in, and what it actually asked for are the whole
// point: enough to decide whether to get up, without opening anything.
test('the same workspace gets the same Pokemon the field drew for it', () => {
  for (const id of ['20151D9B-A5D9', 'workspace:5', 'B89A3A51-7952-40D4']) {
    const [dex, name] = DEX[hash(id + 'v2') % DEX.length];
    assert.deepEqual(speciesFor(id), { dex, name }, id);
  }
});

test('the alert names the Pokemon, the repo, what happened, and what it was doing', () => {
  const n = describe({ kind: 'needs-you', species: { name: 'Pikachu' }, pen: 'pokeclaude',
                       detail: 'Which grid size should the field use?' });
  assert.equal(n.title, 'Pikachu · pokeclaude');
  assert.match(n.subtitle, /needs you/i);
  assert.equal(n.body, 'Which grid size should the field use?');
});

test('each kind says what happened in its own words', () => {
  const of = (kind) => describe({ kind, species: { name: 'Eevee' }, pen: 'api', detail: 'x' }).subtitle;
  assert.match(of('finished'), /finished|done/i);
  assert.match(of('died'), /died|gone/i);
  assert.match(of('cron-failed'), /failed/i);
  assert.match(of('cron-stalled'), /stalled|has not run/i);
});

test('a cron alert is named after the job, since no Pokemon owns it', () => {
  const n = describe({ kind: 'cron-failed', label: 'com.work.weekly', detail: 'exit 1' });
  assert.match(n.title, /weekly/);
  assert.equal(n.body, 'exit 1');
});

test('nothing known about the work still produces a usable notification', () => {
  const n = describe({ kind: 'finished', species: { name: 'Snorlax' }, pen: 'website' });
  assert.equal(n.title, 'Snorlax · website');
  assert.ok(n.subtitle.length);
  assert.ok(typeof n.body === 'string');
});

// A notification is one or two lines wide. Anything that reads like a document has to
// be cut down to the sentence that carries the news.
test('a long answer is cut to something that fits on the screen', () => {
  const long = 'I moved the front desk into the corner and rebuilt the town files. ' +
    'The margin now allows for sprite overhang so nothing clips at the canvas edge.';
  const s = summarise(long, 90);
  assert.ok(s.length <= 90, `${s.length} chars`);
  assert.ok(s.startsWith('I moved the front desk'));
  assert.ok(s.endsWith('…'), 'a cut sentence has to look cut');
});

test('only the first line survives, and markdown noise does not', () => {
  assert.equal(summarise('## Done\n\nRebuilt the town files', 90), 'Done');
  assert.equal(summarise('- fixed the drop\n- fixed the watcher', 90), 'fixed the drop');
  assert.equal(summarise('**bold** and `code`', 90), 'bold and code');
});

test('a short line is left exactly as it is', () => {
  assert.equal(summarise('Pushed to master', 90), 'Pushed to master');
  assert.equal(summarise('', 90), '');
  assert.equal(summarise(null, 90), '');
});

// macOS credits a notification to the process that asked for it, and shows THAT app's
// name and icon, so an applet of our own would carry the Pokeball instead of the Script
// Editor icon. It cannot: on macOS 26 `usernoted` DENIES the legacy notification
// connection an AppleScript applet opens, so every alert it sends is dropped in
// silence. Signing the bundle and moving it to /Applications changed nothing. Script
// Editor is the one process on the machine already allowed to deliver these, which is
// why osascript is not a fallback here. It is the only path that arrives.
test('every notification goes through osascript, even with an app bundle sitting there', () => {
  const calls = [];
  const send = makeSender({ spawn: (cmd, args) => calls.push([cmd, args]) });
  send({ title: 'Pikachu · pokeclaude', subtitle: 'needs you', body: 'ran the nightly sync', sound: 'Glass' });
  assert.equal(calls.length, 1);
  const [cmd, args] = calls[0];
  assert.equal(cmd, 'osascript', 'an applet is denied by macOS, so it must never be preferred');
  assert.equal(args[0], '-e');
  assert.match(args[1], /^display notification "ran the nightly sync" with title "Pikachu · pokeclaude"/);
  assert.match(args[1], /subtitle "needs you"/);
  assert.match(args[1], /sound name "Glass"/);
});

// The applet took its text as ARGUMENTS, so a quote in a title was data. A script has
// no such protection: a title comes off a terminal tab and can hold quotes, backslashes
// and newlines, any of which would end the string and run the rest as script.
test('a title full of quotes and newlines stays data, not script', () => {
  const calls = [];
  const send = makeSender({ spawn: (cmd, args) => calls.push(args) });
  send({ title: 'say "hi" \\ ok\nthen quit', subtitle: 's', body: 'b' });
  const script = calls[0][1];
  assert.match(script, /with title "say \\"hi\\" \\\\ ok then quit"/);
  assert.equal(script.includes('\n'), false, 'a newline would end the AppleScript string');
});

test('a missing sound is left out rather than passed as the word undefined', () => {
  const calls = [];
  const send = makeSender({ spawn: (c, a) => calls.push(a) });
  send({ title: 't', subtitle: 's', body: 'b' });
  assert.equal(calls[0][1].includes('sound name'), false);
  assert.equal(calls[0][1].includes('undefined'), false);
});

// The desktop app is the better notifier when it is running: it posts through
// UNUserNotificationCenter, so the alert carries the Pokeball and the name PokeClaude
// instead of arriving as "Script Editor". It is not always running, and notifications
// have to survive it being closed, so osascript stays as the floor under it.
test('a connected app takes the alert, and osascript is left alone', () => {
  const calls = [], toApp = [];
  const send = makeSender({ spawn: (c, a) => calls.push([c, a]),
    toApp: (note) => { toApp.push(note); return true; } });
  assert.equal(send({ title: 'Pikachu · pokeclaude', subtitle: 'needs you', body: 'b', sound: 'Glass' }), true);
  assert.equal(toApp.length, 1);
  assert.equal(toApp[0].title, 'Pikachu · pokeclaude');
  assert.deepEqual(calls, [], 'two notifications for one event is worse than none');
});

test('an app that did not take it falls through to osascript, not into a hole', () => {
  const calls = [];
  const send = makeSender({ spawn: (c, a) => calls.push([c, a]), toApp: () => false });
  send({ title: 'Eevee · api', subtitle: 'finished', body: 'ran the nightly sync' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
});

test('the kill switch stops the app path too, not only osascript', () => {
  const calls = [], toApp = [];
  const send = makeSender({ spawn: (c, a) => calls.push(a), toApp: (n) => { toApp.push(n); return true; },
    muted: true });
  assert.equal(send({ title: 't', subtitle: 's', body: 'b' }), false);
  assert.deepEqual([calls.length, toApp.length], [0, 0]);
});

test('the kill switch stops every path', () => {
  const calls = [];
  const send = makeSender({ spawn: (c, a) => calls.push(a), muted: true });
  assert.equal(send({ title: 't', subtitle: 's', body: 'b' }), false);
  assert.equal(calls.length, 0);
});
