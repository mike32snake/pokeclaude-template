// The native backend's pure parts: what a key is on the wire, and telling a real draft
// from the suggestion Claude Code paints in the empty composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBytes, NAMED, composerDraft, typedBytes } from '../src/server/native.js';
import { createScreen, write, cellRows } from '../src/server/vt.js';

const ESC = '\x1b';
const put = (s, ...p) => write(s, Buffer.from(p.join(''), 'utf8'));

test('named keys are the byte sequences a terminal actually sends', () => {
  assert.equal(keyBytes('enter'), '\r');
  assert.equal(keyBytes('escape'), '\x1b');
  assert.equal(keyBytes('tab'), '\t');
  assert.equal(keyBytes('backspace'), '\x7f');
  assert.equal(keyBytes('up'), '\x1b[A');
  assert.equal(keyBytes('down'), '\x1b[B');
  assert.equal(keyBytes('right'), '\x1b[C');
  assert.equal(keyBytes('left'), '\x1b[D');
  assert.equal(keyBytes('shift+tab'), '\x1b[Z');
  assert.equal(keyBytes('ctrl+c'), '\x03');
  assert.equal(keyBytes('ctrl+u'), '\x15');
  assert.equal(keyBytes('space'), ' ');
});

// The one that cost the most through cmux. A newline inside the composer had to go as
// Option+Enter, because cmux turned every newline in text it was handed into a carriage
// return, which Claude Code reads as submit. Owning the pty, it is just the bytes.
test('a newline inside the composer is ESC CR, and never a bare CR', () => {
  assert.equal(keyBytes('alt+enter'), '\x1b\r');
  assert.ok(!keyBytes('alt+enter').startsWith('\r'));
});

test('an unknown key is refused rather than guessed at', () => {
  assert.equal(keyBytes('f13'), null);
  assert.equal(keyBytes(''), null);
  assert.equal(keyBytes('rm -rf /'), null);
  for (const k of NAMED) assert.ok(keyBytes(k), `${k} is listed but has no bytes`);
});

// Multi-line text must never contain a bare CR: each one would be a separate submit,
// which is how a three-line message used to go out as three messages.
test('typed text turns its newlines into ESC CR and its tabs into spaces', () => {
  const b = typedBytes('one\ntwo');
  assert.equal(b, 'one\x1b\rtwo');
  assert.ok(!/\r(?!$)/.test(b.replace(/\x1b\r/g, '')), 'no bare carriage return survives');
  assert.equal(typedBytes('a\tb'), 'a    b');
  assert.equal(typedBytes('a\r\nb'), 'a\x1b\rb');
  assert.equal(typedBytes(''), '');
});

// Claude Code paints a dimmed suggestion for the next prompt INTO the empty composer.
// read-screen had no styles, so on paper it was a draft: every send to that pane was
// refused for "unsent text", and discard pressed backspace over a box holding nothing.
// probeDraft had to type a letter and look. With the pty we can see the dimness.
test('a dim suggestion in the composer is not a draft', () => {
  const s = createScreen(60, 6);
  put(s, `${ESC}[1;1H`, '─'.repeat(50), '\r\n');
  put(s, `❯ ${ESC}[2mTry "how does main.swift work?"${ESC}[0m\r\n`);
  put(s, '─'.repeat(50));
  const d = composerDraft(cellRows(s));
  assert.equal(d.ghost, true);
  assert.equal(d.draft, '');
});

test('text the user typed is a draft, and comes back exactly', () => {
  const s = createScreen(60, 6);
  put(s, `${ESC}[1;1H`, '─'.repeat(50), '\r\n');
  put(s, '❯ fix the failing test\r\n');
  put(s, '─'.repeat(50));
  const d = composerDraft(cellRows(s));
  assert.equal(d.ghost, false);
  assert.equal(d.draft, 'fix the failing test');
});

test('a draft that runs over several lines keeps all of them', () => {
  const s = createScreen(60, 7);
  put(s, `${ESC}[1;1H`, '─'.repeat(50), '\r\n');
  put(s, '❯ first line\r\n  second line\r\n');
  put(s, '─'.repeat(50));
  assert.equal(composerDraft(cellRows(s)).draft, 'first line\nsecond line');
});

test('an empty composer is empty, not a ghost and not a draft', () => {
  const s = createScreen(60, 6);
  put(s, `${ESC}[1;1H`, '─'.repeat(50), '\r\n', '❯ \r\n', '─'.repeat(50));
  const d = composerDraft(cellRows(s));
  assert.equal(d.draft, '');
  assert.equal(d.ghost, false);
});

test('no composer on screen reports nothing rather than inventing one', () => {
  const s = createScreen(60, 4);
  put(s, 'just some output\r\nand more');
  const d = composerDraft(cellRows(s));
  assert.equal(d.draft, '');
  assert.equal(d.found, false);
});

// Codex draws its composer with the same glyph it uses for past turns, so the box is
// always the LAST one on screen.
test('the composer is the last prompt on screen, not the first', () => {
  const s = createScreen(60, 8);
  put(s, '› an older turn\r\n', 'some output\r\n');
  put(s, '─'.repeat(50), '\r\n', '› the live one\r\n', '─'.repeat(50));
  assert.equal(composerDraft(cellRows(s)).draft, 'the live one');
});
