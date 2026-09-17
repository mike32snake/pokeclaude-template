// The panel keeps pace with the terminal because a transcript write pushes an event
// down the SSE stream. The throttle used to be leading-edge only: it fired on the
// first write and DROPPED anything inside the next 200ms.
//
// That lost the writes that matter most. Claude writes its reply text and then the
// AskUserQuestion block milliseconds apart, so the question was thrown away and the
// panel showed the reply with no question under it until the next write arrived,
// which was the answer typed in the terminal minutes later. A trailing call fixes it:
// bursts still collapse into one event, but the last write is always announced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesce } from '../src/server/coalesce.js';

// A clock the test drives, so this stays fast and does not depend on real timers.
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}
const spy = () => { const calls = []; const f = () => calls.push(true); f.count = () => calls.length; return f; };

test('the first write is announced at once, with no wait', () => {
  const c = fakeClock(), f = spy();
  coalesce(f, 200, c)();
  assert.equal(f.count(), 1);
});

test('a burst of writes collapses into one event, not one per write', () => {
  const c = fakeClock(), f = spy();
  const fire = coalesce(f, 200, c);
  fire(); c.advance(10); fire(); c.advance(10); fire();
  assert.equal(f.count(), 1, 'still the leading call only');
});

test('the last write in a burst is always announced, never dropped', () => {
  const c = fakeClock(), f = spy();
  const fire = coalesce(f, 200, c);
  fire();                    // the reply text lands
  c.advance(20); fire();     // the question lands 20ms later: this is the one that was lost
  c.advance(500);
  assert.equal(f.count(), 2, 'the trailing write must reach the panel');
});

test('a quiet stretch after a burst adds no extra events', () => {
  const c = fakeClock(), f = spy();
  const fire = coalesce(f, 200, c);
  fire(); c.advance(20); fire();
  c.advance(5000);
  assert.equal(f.count(), 2);
});

test('a write long after the last one is immediate again, not queued behind a timer', () => {
  const c = fakeClock(), f = spy();
  const fire = coalesce(f, 200, c);
  fire(); c.advance(1000);
  fire();
  assert.equal(f.count(), 2, 'an isolated write must not wait for the window to pass');
});
