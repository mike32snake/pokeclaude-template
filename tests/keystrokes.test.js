// What the panel actually types when it sends a message.
//
// cmux turns every newline in `send` text into a carriage return, and a carriage
// return is Enter. A three-line message was therefore three submits: the first line
// went as its own prompt, and whatever Claude Code was mid-transition for was left
// sitting in its input box until the next send pressed Enter on top of it. That is
// the "my message vanished, then a later message sent it" report this file exists for.
//
// The carrier that survived a live pane is Option+Enter: one keypress, no CR in the
// text at all. Bracketed paste, Ctrl+J, the Shift+Enter escape sequences and the
// backslash-Enter continuation all typed junk at least some of the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedLines, typeInto } from '../src/server/cmux.js';

test('a single line is typed as it is', () => {
  assert.deepEqual(typedLines('hello there'), ['hello there']);
});

test('CRLF, CR and LF each split a line', () => {
  assert.deepEqual(typedLines('one\r\ntwo\rthree\nfour'), ['one', 'two', 'three', 'four']);
});

test('a literal backslash-n in the text is text, not a newline', () => {
  assert.deepEqual(typedLines('split on \\n here'), ['split on \\n here']);
});

test('a tab is typed as spaces, because Tab is a key in Claude Code and is eaten', () => {
  assert.deepEqual(typedLines('a\tb'), ['a    b']);
});

test('a backslash before a newline gets a space, because Claude Code eats it otherwise', () => {
  assert.deepEqual(typedLines('C:\\path\\\nnext'), ['C:\\path\\ ', 'next']);
  // On the last line there is no newline after it, so nothing is added.
  assert.deepEqual(typedLines('ends in \\'), ['ends in \\']);
});

test('empty and missing text type nothing', () => {
  assert.deepEqual(typedLines(''), []);
  assert.deepEqual(typedLines(null), []);
});

// Claude Code takes input one read at a time, and the pty merges writes that land
// before it reads them. So the panel types one thing, watches the pane until that
// thing is on screen, then types the next. Evidence, not a sleep: a busy pane renders
// late, and a sleep that is long enough for it is too long for everything else.

// A pane that echoes what it is typed, showing each write only after `lag` reads.
function fakePane({ lag = 0, paste = false } = {}) {
  const log = [];
  let typed = '', shown = '', shownCount = 0;
  const queue = [];
  const push = (text) => { typed += text; queue.push({ text: typed, left: lag }); return { ok: true }; };
  const io = {
    async write(ws, text) { log.push(['w', text]); return push(text); },
    async key(ws, k) { log.push(['k', k]); return push(k === 'alt+enter' ? '\n' : ''); },
    async read() {
      log.push(['r']);
      while (queue.length && queue[0].left <= 0) { shown = queue.shift().text; shownCount++; }
      if (queue.length) queue[0].left--;
      const body = paste ? Array.from({ length: shownCount }, (_, k) => `[Pasted text #${k + 1} +3 lines]`).join('')
        : shown.replace(/\n/g, '\n  ');
      return { ok: true, stdout: '────────\n❯ ' + body + '\n────────\n  ⏵⏵ bypass permissions on' };
    },
    async sleep() { log.push(['s']); },
  };
  return { io, log, typed: () => typed };
}
const kinds = (log) => log.map(e => e[0]).join('');

test('each line is its own write, each newline its own key, with a look in between', async () => {
  const pane = fakePane();
  const r = await typeInto('workspace:1', 'one\ntwo\nthree', pane.io);
  assert.equal(r.ok, true);
  assert.equal(pane.typed(), 'one\ntwo\nthree');
  assert.deepEqual(pane.log.filter(e => e[0] === 'w').map(e => e[1]), ['one', 'two', 'three']);
  assert.deepEqual(pane.log.filter(e => e[0] === 'k').map(e => e[1]), ['alt+enter', 'alt+enter']);
  // Never two sends back to back without reading the pane in between.
  assert.doesNotMatch(kinds(pane.log), /[wk][wk]/);
});

test('a slow pane is waited for, not raced', async () => {
  const pane = fakePane({ lag: 3 });
  const r = await typeInto('workspace:1', 'one\ntwo', pane.io);
  assert.equal(r.ok, true);
  // The newline comes only after the reads that finally showed the first line.
  assert.match(kinds(pane.log), /^(r|s)+w(r|s){3,}k/);
});

// Right after a turn ends the composer redraws on its own: a hint comes and goes,
// the box empties. Any change is not evidence; the line itself showing up is.
test('a redraw that does not show the line is not taken as the line landing', async () => {
  const pane = fakePane({ lag: 2 });
  let n = 0;
  const read = pane.io.read;
  pane.io.read = async (...a) => {
    const r = await read(...a);
    return { ok: true, stdout: r.stdout.replace('❯ ', `❯ redraw ${n++} `) };
  };
  await typeInto('workspace:1', 'one\ntwo', pane.io);
  assert.match(kinds(pane.log), /^(r|s)+w(r|s){3,}k/);
});

test('a line too long to type goes as its own paste, its newline still its own key', async () => {
  const pane = fakePane();
  const long = 'y'.repeat(500);
  await typeInto('workspace:1', `short\n${long}\nafter`, pane.io);
  assert.deepEqual(pane.log.filter(e => e[0] === 'w').map(e => e[1]), ['short', long, 'after']);
  assert.equal(pane.typed(), `short\n${long}\nafter`);
});

test('a pane that folds the line into a paste marker still counts as having taken it', async () => {
  const pane = fakePane({ paste: true });
  const r = await typeInto('workspace:1', 'one\ntwo', pane.io);
  assert.equal(r.ok, true);
  assert.equal(pane.typed(), 'one\ntwo');
});

test('a blank line is a newline and nothing else', async () => {
  const pane = fakePane();
  await typeInto('workspace:1', 'one\n\ntwo', pane.io);
  assert.deepEqual(pane.log.filter(e => e[0] === 'w').map(e => e[1]), ['one', 'two']);
  assert.equal(pane.typed(), 'one\n\ntwo');
});

// Typing on regardless would land the next line on top of the unread one and turn
// the whole message into a paste. Stopping is the honest move: the caller reports
// it, and the draft gate quotes whatever did land on the retry.
test('a pane that never shows the line fails the send instead of typing on', async () => {
  let reads = 0, writes = 0;
  const io = { async write() { writes++; return { ok: true }; }, async key() { return { ok: true }; },
    async read() { reads++; return { ok: true, stdout: '❯ ' }; }, async sleep() {} };
  const r = await typeInto('workspace:1', 'one\ntwo', io);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /line 1/);
  assert.equal(writes, 1);
  assert.ok(reads < 700, `read ${reads} times`);
});

// A read that fails is not evidence the line landed.
test('a pane that cannot be read for a moment is read again, not skipped', async () => {
  let n = 0, written = false;
  const io = {
    async write() { written = true; return { ok: true }; }, async key() { return { ok: true }; },
    async read() { n++; return n < 3 ? { ok: false, stdout: '' } : { ok: true, stdout: written ? '❯ one' : '❯ ' }; },
    async sleep() {},
  };
  const r = await typeInto('workspace:1', 'one', io);
  assert.equal(r.ok, true);
  assert.ok(n >= 3);
});

test('a write cmux refuses stops the typing and says so', async () => {
  const io = { async write() { return { ok: false, stderr: 'no such surface' }; }, async key() { return { ok: true }; },
    async read() { return { ok: true, stdout: '❯ ' }; }, async sleep() {} };
  const r = await typeInto('workspace:1', 'one\ntwo', io);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /no such surface/);
});

test('typing nothing sends nothing', async () => {
  const pane = fakePane();
  const r = await typeInto('workspace:1', '', pane.io);
  assert.equal(r.ok, true);
  assert.equal(pane.log.length, 0);
});

test('an image attachment marker confirms the path was accepted', async () => {
 let attached = false;
 const io = { sleep: async()=>{}, write: async()=>{ attached=true;return {ok:true}; }, key: async()=>({ok:true}),
 read: async()=>({ok:true,stdout:`› ${attached ? '[Image #1]' : ''}\n\n  tab to queue message    67% context left`}) };
 assert.equal((await typeInto('workspace:1','/tmp/image.png',io)).ok,true);
});
