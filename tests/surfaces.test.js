// Which terminal surface a workspace's keystrokes and reads are addressed to.
//
// This was looked up fresh on EVERY read and every keypress, as `cmux rpc
// surface.list` - a process spawn, measured at 188ms on one machine against 1ms
// for the same call over the socket. The socket path added for sendText was therefore
// dead: every 1ms socket call sat behind a 188ms spawn to find out where to send it.
//
// A 40-line paste walks the composer with a poll per line, so it was ~320 spawns in a
// burst, and cmux's CLI helper was crashing mid-write when our timeout closed its pipe.
// The id is stable for the life of a terminal, so it is looked up once and kept.
//
// Kept, not trusted forever: a tab whose terminal went away must not be addressed at
// its old surface. cmux says "Terminal surface not found" for exactly that, which is
// the same string state.js reads to decide a tab is hollow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceCache, isStaleSurface, withSurface } from '../src/server/surfaces.js';

const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const fail = (stderr) => ({ ok: false, stdout: '', stderr });
const GONE = 'Terminal surface not found';

// A lookup that counts how often it was actually asked.
function fakeLookup(answers) {
  const calls = [];
  return {
    calls,
    fn: async (ws) => { calls.push(ws); return answers.shift(); },
  };
}

test('the surface is looked up once and then reused', async () => {
  const cache = createSurfaceCache();
  const look = fakeLookup(['surf-1', 'surf-1', 'surf-1']);
  const ran = [];
  const run = async (surface) => { ran.push(surface); return ok('screen'); };
  for (let i = 0; i < 3; i++) {
    const r = await withSurface(cache, 'workspace:29', look.fn, run);
    assert.equal(r.ok, true);
  }
  assert.deepEqual(ran, ['surf-1', 'surf-1', 'surf-1']);
  assert.equal(look.calls.length, 1, 'three reads must not be three lookups');
});

test('two workspaces keep their own surface, never each others', async () => {
  const cache = createSurfaceCache();
  const look = fakeLookup(['surf-a', 'surf-b']);
  const ran = [];
  const run = async (s) => { ran.push(s); return ok(); };
  await withSurface(cache, 'workspace:1', look.fn, run);
  await withSurface(cache, 'workspace:2', look.fn, run);
  await withSurface(cache, 'workspace:1', look.fn, run);
  assert.deepEqual(ran, ['surf-a', 'surf-b', 'surf-a']);
  assert.equal(look.calls.length, 2);
});

// The whole risk of caching: the terminal went away and we are still addressing its id.
test('a surface that has gone is dropped and looked up again, once', async () => {
  const cache = createSurfaceCache();
  const look = fakeLookup(['old', 'new']);
  const seen = [];
  const run = async (s) => { seen.push(s); return s === 'old' ? fail(GONE) : ok('screen'); };
  const r = await withSurface(cache, 'workspace:29', look.fn, run);
  assert.equal(r.ok, true, 'the retry on a fresh surface must be the answer');
  assert.deepEqual(seen, ['old', 'new']);
  assert.equal(look.calls.length, 2);
});

// A tab cmux restored but nobody has clicked has no terminal at all. Retrying finds
// the same nothing, and the caller needs that failure: state.js reads it to decide the
// tab is hollow and hide the Pokemon. It must not become a different error.
test('a tab with no terminal still reports the failure the hollow check reads', async () => {
  const cache = createSurfaceCache();
  const look = fakeLookup(['gone', null]);
  const r = await withSurface(cache, 'workspace:7', look.fn,
    async () => fail(GONE));
  assert.equal(r.ok, false);
  assert.ok(isStaleSurface(r), 'state.js keys off this exact wording');
});

test('a workspace that never had a surface is not cached as one', async () => {
  const cache = createSurfaceCache();
  const look = fakeLookup([null, null, 'surf-1']);
  const r1 = await withSurface(cache, 'w', look.fn, async () => ok());
  assert.equal(r1.ok, false);
  assert.match(r1.stderr, /unique terminal/i);
  await withSurface(cache, 'w', look.fn, async () => ok());
  await withSurface(cache, 'w', look.fn, async () => ok());
  assert.equal(look.calls.length, 3, 'a null answer must be asked again next time');
});

// Any other failure is a read that did not happen, not evidence that the surface moved.
// Re-looking-up on every timeout would put the spawn straight back on the hot path.
test('an ordinary failure keeps the cached surface and does not retry', async () => {
  const cache = createSurfaceCache();
  const look = fakeLookup(['surf-1', 'surf-1']);
  const seen = [];
  const run = async (s) => { seen.push(s); return fail('cmux socket timed out'); };
  const r = await withSurface(cache, 'w', look.fn, run);
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ['surf-1'], 'one attempt, not two');
  await withSurface(cache, 'w', look.fn, run);
  assert.equal(look.calls.length, 1, 'the surface is still good; do not look it up again');
});

test('isStaleSurface recognises the wording and nothing else', () => {
  assert.ok(isStaleSurface(fail('Terminal surface not found')));
  assert.ok(isStaleSurface(fail('error: terminal SURFACE NOT FOUND for workspace:3')));
  assert.ok(!isStaleSurface(fail('cmux socket timed out')));
  assert.ok(!isStaleSurface(ok('Terminal surface not found')), 'a successful read is not stale');
  assert.ok(!isStaleSurface(null));
});

// cmux answers surface.list for an UNKNOWN workspace with the focused workspace's
// surfaces, and says ok. Not an error, not an empty list: someone else's terminal.
// Both transports do it, and `surface.list {"workspace_id": ""}` does it too.
//
// So a read aimed at a pen that has gone away came back with whatever pane you happened
// to be looking at - probeDraft on a dead ref returned a live draft from another repo -
// and the same lookup is what send and send-key address. That is the one mistake
// AGENTS.md says must never happen: browser focus must not redirect chat.
//
// Every reply carries workspace_ref, and it is correct whenever the workspace is real,
// so the answer is checked against the question.
import { terminalSurfaceFor } from '../src/server/cmux.js';

const reply = (ref, ids) => ({
  workspace_ref: ref, workspace_id: 'uuid-of-' + ref,
  surfaces: ids.map(id => ({ type: 'terminal', id })),
});

test('a surface list for the workspace we asked about is used', () => {
  assert.equal(terminalSurfaceFor(reply('workspace:29', ['surf-29']), 'workspace:29'), 'surf-29');
  // Addressed by id rather than ref is still the same workspace.
  assert.equal(terminalSurfaceFor(reply('workspace:29', ['surf-29']), 'uuid-of-workspace:29'), 'surf-29');
});

test('a surface list for a DIFFERENT workspace is refused, however ok it claims to be', () => {
  assert.equal(terminalSurfaceFor(reply('workspace:31', ['surf-31']), 'workspace:29'), null);
  assert.equal(terminalSurfaceFor(reply('workspace:31', ['surf-31']), 'no-such-pen'), null);
  assert.equal(terminalSurfaceFor(reply('workspace:31', ['surf-31']), ''), null);
});

test('a pane with more than one terminal is still refused, as it always was', () => {
  assert.equal(terminalSurfaceFor(reply('workspace:29', ['a', 'b']), 'workspace:29'), null);
  assert.equal(terminalSurfaceFor(reply('workspace:29', []), 'workspace:29'), null);
});

test('a reply we cannot make sense of is not a surface', () => {
  assert.equal(terminalSurfaceFor(null, 'workspace:29'), null);
  assert.equal(terminalSurfaceFor({}, 'workspace:29'), null);
  assert.equal(terminalSurfaceFor({ surfaces: [{ type: 'terminal', id: 'x' }] }, 'workspace:29'), null,
    'a reply with no workspace_ref cannot be checked, so it is not trusted');
});
