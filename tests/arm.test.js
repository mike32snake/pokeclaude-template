// Two-step confirmation for the buttons that end something.
//
// They used to call window.confirm. In a browser that asks; inside the desktop app it
// does not. A WKWebView whose host implements no WKUIDelegate answers every JS dialog
// as if Cancel was clicked, so KILL, STOP and cron delete did nothing at all in the
// app, with no error anywhere to say why. Nothing in the page may depend on the host
// having a dialog to show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeArm } from '../public/js/arm.js';

const clock = (t0 = 0) => { let t = t0; return { now: () => t, tick: (ms) => (t += ms) }; };

test('one press never ends a session: it only arms the button', () => {
  const a = makeArm({ now: clock().now });
  assert.equal(a.press('kill:w1'), false);
  assert.equal(a.armed('kill:w1'), true);
});

test('the second press is the one that does it', () => {
  const c = clock();
  const a = makeArm({ now: c.now });
  a.press('kill:w1');
  c.tick(400);
  assert.equal(a.press('kill:w1'), true);
  assert.equal(a.armed('kill:w1'), false, 'firing disarms, or a third click kills twice');
});

test('a button left armed goes cold, so a click minutes later asks again', () => {
  const c = clock();
  const a = makeArm({ now: c.now, window: 6000 });
  a.press('kill:w1');
  c.tick(6001);
  assert.equal(a.press('kill:w1'), false, 'a stale arm must re-ask, never fire');
  assert.equal(a.armed('kill:w1'), true);
});

test('arming one button disarms the other, so an armed KILL cannot be fired by a STOP', () => {
  const a = makeArm({ now: clock().now });
  a.press('kill:w1');
  assert.equal(a.press('stop:w2'), false);
  assert.equal(a.armed('kill:w1'), false);
  assert.equal(a.armed('stop:w2'), true);
});

test('leaving the view disarms everything', () => {
  const a = makeArm({ now: clock().now });
  a.press('kill:w1');
  a.reset();
  assert.equal(a.armed('kill:w1'), false);
  assert.equal(a.press('kill:w1'), false, 'coming back must ask again');
});

test('the armed button says what the next click does', () => {
  const a = makeArm({ now: clock().now });
  assert.equal(a.label('kill:w1', 'KILL'), 'KILL');
  a.press('kill:w1');
  assert.equal(a.label('kill:w1', 'KILL'), 'SURE?');
  assert.equal(a.label('stop:w2', 'STOP'), 'STOP');
});
