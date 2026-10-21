// Choosing which thing drives the pens.
//
// index.js talks to ONE module about terminals, and there are now two that can answer.
// The switch is a flag rather than an edit, so it can be thrown and thrown back while
// you are working. Native is the default; cmux is one flag away.
//
// The parity test below is the real "can we switch yet" check: it fails the moment the
// two drift, which is exactly what would otherwise be found at the worst moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, BACKENDS, NAMES } from '../src/server/backend.js';
import * as cmux from '../src/server/cmux.js';
import * as native from '../src/server/native.js';

// The switch. The nine live conversations were moved onto relays first (migrate.js) and
// then this moved, in that order - flipping first would have shown an empty ranch.
test('native is the default now, and cmux is still one flag away', () => {
  assert.equal(pick(undefined).name, 'native');
  assert.equal(pick('').name, 'native');
  assert.equal(pick(null).name, 'native');
  assert.equal(pick('cmux').name, 'cmux', 'going back must stay possible');
});

test('the flag chooses, and a name we do not have is refused loudly', () => {
  assert.equal(pick('native').name, 'native');
  assert.equal(pick('cmux').name, 'cmux');
  assert.equal(pick('CMUX').name, 'cmux');
  assert.throws(() => pick('tmux'), /not a backend/i);
  assert.deepEqual(NAMES.sort(), ['cmux', 'native']);
});

// Everything index.js asks of a terminal backend. If native.js is missing one of these
// the switch breaks at runtime, on whichever pen you touch first.
const REQUIRED = [
  'listWorkspaces', 'readScreen', 'readText', 'send', 'tap', 'press', 'sendKey',
  'sendLiteral', 'probeDraft', 'newWorkspace', 'closeWorkspace', 'selectWorkspace',
  'readSessionJson', 'parseFooter', 'agentFacts', 'parseUsage',
];

test('both backends answer everything index.js asks of one', () => {
  for (const [name, mod] of Object.entries(BACKENDS)) {
    for (const fn of REQUIRED) {
      assert.equal(typeof mod[fn], 'function', `${name} is missing ${fn}`);
    }
    // Not a function, but index.js reads it for an fs.watch.
    assert.ok('sessionJsonPath' in mod, `${name} is missing sessionJsonPath`);
  }
});

test('the screen readers are literally the same code, not two copies of it', () => {
  // A second implementation of parseFooter would drift, and the bug would look like a
  // model name that goes missing only on one backend.
  for (const fn of ['parseFooter', 'agentFacts', 'parseUsage']) {
    assert.equal(native[fn], cmux[fn], `${fn} is duplicated rather than shared`);
  }
});

// index.js awaits all of these. A backend that returns a plain object is fine; one that
// throws synchronously is not, because the await never catches it.
test('every call answers, rather than throwing, when asked about a pen that is not there', async () => {
  for (const [name, mod] of Object.entries(BACKENDS)) {
    for (const [fn, args] of [
      ['readScreen', ['no-such-pen', 10]],
      ['probeDraft', ['no-such-pen']],
    ]) {
      const r = await mod[fn](...args);
      assert.equal(typeof r, 'object', `${name}.${fn} did not answer with a result`);
      assert.ok('ok' in r, `${name}.${fn} answered without an ok field`);
    }
  }
});

// OPEN TAB used to run `open -a cmux` from index.js whatever the backend was, so on a
// native ranch it launched an app that holds none of the pens. Bringing a pen forward
// belongs to the backend: cmux has a window for it, native has only our own terminal.
test('showing a pen is the backend\'s job, and native never reaches for another app', async () => {
  for (const [name, mod] of Object.entries(BACKENDS)) {
    assert.equal(typeof mod.showWorkspace, 'function', `${name} is missing showWorkspace`);
  }
  const r = await native.showWorkspace('no-such-pen');
  assert.equal(r.ok, false, 'native has no window to show');
  assert.equal(r.useTerminal, true, 'the panel should open the live terminal instead');
});

// Delivery used to sleep a fixed 150ms before Enter and 250ms between looks at the box.
// That was the price of a cmux round trip. Native has the screen in memory and an event
// when a redraw ends, so its wait is that event and not a guess.
test('waiting for the screen is the backend\'s job: cmux sleeps, native listens', async () => {
  for (const [name, mod] of Object.entries(BACKENDS)) {
    assert.equal(typeof mod.settle, 'function', `${name} is missing settle`);
  }
  let t = Date.now();
  await cmux.settle('any-pen', 120);
  assert.ok(Date.now() - t >= 100, 'cmux has no redraw event, so it still waits the time out');
  t = Date.now();
  await native.settle('no-such-pen', 2000);
  assert.ok(Date.now() - t < 100, 'native waited on a pen that is not there');
});

test('a backend nobody selected is not started up as a side effect', () => {
  // Importing must not attach to relays or talk to cmux. Selecting is what does that.
  assert.deepEqual(native.listWorkspaces(), [], 'native attached something on import');
});
