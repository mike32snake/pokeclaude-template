// Reading back through a conversation while the agent is still working.
//
// The pane refreshes itself: on every transcript write, and every two seconds while a
// question is pending. Each refresh replaced the whole thread and pinned the scroll to
// the newest turn, so scrolling up to read something lasted about two seconds. The
// older path was worse in its own way: if you were NOT at the bottom it sent you to
// the very top, which is not where you were either.
//
// Two rules fix it. Do not re-render at all when nothing has changed, and when
// something has, leave the scroll where the reader put it unless they were already
// following the newest turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadKey, atBottom, nextTop, FOLLOW_SLACK } from '../public/js/thread.js';

const msg = (o = {}) => ({ uuid: 'u1', role: 'assistant', text: 'hello', tools: [], ...o });
const payload = (o = {}) => ({ messages: [msg()], pending: null, ambiguous: false, ...o });

test('a payload that renders the same thing has the same key', () => {
  assert.equal(threadKey(payload()), threadKey(payload()),
    'an unchanged pane must not be torn down and rebuilt under the reader');
});

test('a new turn changes the key', () => {
  const before = payload();
  const after = payload({ messages: [msg(), msg({ uuid: 'u2', text: 'next' })] });
  assert.notEqual(threadKey(before), threadKey(after));
});

test('a turn that grows as it streams changes the key', () => {
  const before = payload({ messages: [msg({ text: 'wri' })] });
  const after = payload({ messages: [msg({ text: 'writing it all out' })] });
  assert.notEqual(threadKey(before), threadKey(after));
});

test('a tool call added to the newest turn changes the key', () => {
  const before = payload();
  const after = payload({ messages: [msg({ tools: [{ tool: 'Bash', arg: 'npm test' }] })] });
  assert.notEqual(threadKey(before), threadKey(after));
});

test('a question appearing, changing or being answered changes the key', () => {
  const quiet = payload();
  const asking = payload({ pending: { screen: ['❯ 1. yes', '  2. no'], ask: null } });
  const moved = payload({ pending: { screen: ['  1. yes', '❯ 2. no'], ask: null } });
  assert.notEqual(threadKey(quiet), threadKey(asking));
  assert.notEqual(threadKey(asking), threadKey(moved), 'the cursor moving is a change');
  assert.equal(threadKey(quiet), threadKey(payload()));
});

// Context percentage and the model tick over constantly. Rebuilding the thread for
// them would undo the reader's scroll for something they are not looking at.
test('numbers in the header that change on their own do not force a rebuild', () => {
  assert.equal(threadKey(payload({ contextPct: 12, model: 'x' })),
               threadKey(payload({ contextPct: 88, model: 'y' })));
});

test('reading the newest turn counts as being at the bottom, near enough', () => {
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 940, clientHeight: 60 }), true);
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 940 - FOLLOW_SLACK + 1, clientHeight: 60 }), true);
  assert.equal(atBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 60 }), false);
});

test('a pane too short to scroll is always at the bottom', () => {
  assert.equal(atBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 300 }), true);
});

test('following the newest turn keeps following it as the thread grows', () => {
  assert.equal(nextTop({ wasAtBottom: true, prevTop: 940, scrollHeight: 1400, clientHeight: 60 }), 1340);
});

test('reading further up stays exactly where it was', () => {
  assert.equal(nextTop({ wasAtBottom: false, prevTop: 200, scrollHeight: 1400, clientHeight: 60 }), 200,
    'not the top, and not the bottom: where the reader left it');
});

test('a thread that shrank cannot scroll past its own end', () => {
  assert.equal(nextTop({ wasAtBottom: false, prevTop: 900, scrollHeight: 400, clientHeight: 60 }), 340);
});

// Opening an agent that is asking something. Scrolling to the end of the thread puts
// the BOTTOM of the question box against the bottom of the pane, and a box with a
// header, a question and four answers in it is taller than the pane, so what falls off
// the top is the "WAITING ON YOU" badge and the question itself. You are left looking
// at four unlabelled answers to a question you cannot see.
import { openTop } from '../public/js/thread.js';

test('a question the agent is asking is opened at its top, not at the end', () => {
  // 6956 of thread, a 522px box starting at 6434, in a 497px pane.
  assert.equal(openTop({ askTop: 6434, scrollHeight: 6956, clientHeight: 497 }), 6434);
});

test('with no question up, opening still lands on the newest turn', () => {
  assert.equal(openTop({ askTop: null, scrollHeight: 6956, clientHeight: 497 }), 6459);
});

// A short question in a long thread must not scroll past the end of the content.
test('the question box is never scrolled past the end of the thread', () => {
  assert.equal(openTop({ askTop: 900, scrollHeight: 1000, clientHeight: 400 }), 600);
});

test('a thread shorter than the pane does not scroll at all', () => {
  assert.equal(openTop({ askTop: 40, scrollHeight: 300, clientHeight: 400 }), 0);
});

test('queued reply status refreshes even when transcript is unchanged', () => {
 assert.notEqual(threadKey(payload()),threadKey(payload({outbox:[{id:'1',status:'queued',text:'hello'}]})));
 assert.notEqual(threadKey(payload({outbox:[{id:'1',status:'queued'}]})),threadKey(payload({outbox:[{id:'1',status:'review'}]})));
});
