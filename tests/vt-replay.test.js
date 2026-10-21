// The emulator against the real thing.
//
// The unit tests in vt.test.js say each sequence does what it should. This says the
// whole of it renders a screen the REST OF POKECLAUDE ALREADY KNOWS HOW TO READ, which
// is the only claim that matters for a migration: parseFooter, composerRegion and
// inputBoxState were written against cmux's read-screen, and they must not be able to
// tell the difference.
//
// The fixtures are raw pty captures of both CLIs, taken with tools/pty-agent.py. They
// include the startup queries, the first paint and a redraw after typing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createScreen, write, toText, cellRows } from '../src/server/vt.js';
import { parseFooter } from '../src/server/cmux.js';
import { composerRegion, draftOnScreen, inputBoxState } from '../src/server/screen.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
// Seven bytes at a time, which is nothing like how a pty chunks - and that is the
// point. Every sequence and every multi-byte character is split somewhere.
function replay(name, cols = 200, rows = 50, step = 7) {
  const s = createScreen(cols, rows);
  const data = fs.readFileSync(path.join(FIX, name));
  const replies = [];
  for (let i = 0; i < data.length; i += step) {
    const r = write(s, data.subarray(i, i + step));
    if (r.length) replies.push(r.toString());
  }
  return { screen: s, replies: replies.join('') };
}

test('a Claude Code session renders a screen parseFooter can read', () => {
  const { screen } = replay('claude-tui.raw');
  const f = parseFooter(toText(screen));
  assert.equal(f.model, 'Haiku 4.5');
  assert.equal(f.engine, 'claude');
  assert.equal(screen.title, '✳ Claude Code');
});

test('and a composer the composer readers find, with the typed line in it', () => {
  const { screen } = replay('claude-tui.raw');
  const text = toText(screen);
  assert.ok(composerRegion(text), 'composerRegion must find the box');
  assert.equal(draftOnScreen(text), 'hello there this is a test line');
  // ok:false is the RIGHT answer here: the capture typed a line and never sent it, and
  // refusing to type over someone's unsent draft is what inputBoxState is for.
  const gate = inputBoxState(text);
  assert.equal(gate.ok, false);
  assert.equal(gate.draft, 'hello there this is a test line');
  assert.match(gate.reason, /unsent text/i);
});

test('a Codex session renders its own composer and footer', () => {
  const { screen } = replay('codex-tui.raw');
  const text = toText(screen);
  assert.match(text, /OpenAI Codex/);
  assert.equal(parseFooter(text).engine, 'codex');
  assert.equal(draftOnScreen(text), 'hello there this is a test line');
});

// The TUIs block on these. If nothing answers, Codex waits: it asks XTVERSION over a
// hundred times in sixteen seconds.
test('the startup queries in the capture all get answered', () => {
  const claude = replay('claude-tui.raw').replies;
  assert.match(claude, /\x1b\[\?62;4c/, 'DA1');
  assert.match(claude, /\x1bP>\|/, 'XTVERSION');
  assert.match(claude, /\x1b\[\?0u/, 'kitty keyboard, declined');
  // Codex asks different things. It sends `CSI 0 SP q` - set cursor style, which wants
  // no answer - 108 times, which is easy to misread as XTVERSION because both end in
  // 'q'. What it actually waits on is the cursor position and the palette.
  const codex = replay('codex-tui.raw').replies;
  assert.match(codex, /\x1b\[\d+;\d+R/, 'Codex asks where the cursor is');
  assert.match(codex, /\x1b\]10;rgb:/, 'and what the foreground colour is');
  assert.match(codex, /\x1b\]11;rgb:/, 'and the background');
});

// A pty hands over whatever the kernel had ready. If the answer depends on where the
// reads happened to split, the emulator is wrong somewhere.
test('the rendered screen is the same however the bytes are chunked', () => {
  const sizes = [1, 3, 7, 64, 1024, 1 << 20];
  for (const name of ['claude-tui.raw', 'codex-tui.raw']) {
    const want = toText(replay(name, 200, 50, 1 << 20).screen);
    for (const step of sizes) {
      assert.equal(toText(replay(name, 200, 50, step).screen), want,
        `${name} rendered differently at ${step} bytes per read`);
    }
  }
});

// Styles are the reason to own the stream. Claude Code paints its suggestion into the
// empty composer in dim text, and read-screen threw that away.
test('the capture carries styling that read-screen could not have shown', () => {
  const { screen } = replay('claude-tui.raw');
  const runs = cellRows(screen).flatMap(r => r.runs);
  assert.ok(runs.some(r => r.fg !== null), 'truecolor foregrounds survive');
  assert.ok(runs.some(r => r.bold), 'bold survives');
});

test('no line is ever wider than the screen, whatever the capture contains', () => {
  for (const name of ['claude-tui.raw', 'codex-tui.raw']) {
    const s = replay(name, 120, 40).screen;
    for (const row of cellRows(s)) {
      assert.ok(row.text.length <= 120 + 40,
        `${name}: a row rendered wider than the grid, so a width is wrong`);
    }
  }
});
