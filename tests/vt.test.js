// A terminal emulator, because owning the pty means nobody else renders the screen.
//
// Today cmux does this and PokeClaude asks it for text, which costs a round trip per
// look. With our own pty the bytes arrive here and the grid IS the screen: reading it
// is reading an object, so typeInto's settle loop stops being a poll.
//
// Scope is not guesswork. Both TUIs were captured under a real pty (tools/pty-agent.py)
// and every escape sequence counted: Claude Code uses 18 distinct CSI kinds, Codex 13.
// Neither uses scrollback, because PokeClaude only ever reads the visible rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreen, write, toText, cellRows, resize, cursorRowCol } from '../src/server/vt.js';

const S = (cols = 20, rows = 5) => createScreen(cols, rows);
const put = (s, ...parts) => write(s, Buffer.from(parts.join(''), 'utf8'));
const line = (s, y) => toText(s).split('\n')[y] ?? '';
const ESC = '\x1b';

test('plain text lands in the grid and the cursor advances', () => {
  const s = S();
  put(s, 'hello');
  assert.equal(line(s, 0), 'hello');
  assert.deepEqual(cursorRowCol(s), { row: 0, col: 5 });
});

test('carriage return and newline move the way a terminal moves', () => {
  const s = S();
  put(s, 'one\r\ntwo\r\nthree');
  assert.equal(line(s, 0), 'one');
  assert.equal(line(s, 1), 'two');
  assert.equal(line(s, 2), 'three');
  // A bare \n keeps the column, which is why TUIs always send \r with it.
  const b = S();
  put(b, 'ab\ncd');
  assert.equal(line(b, 1), '  cd');
});

test('text wraps at the right edge instead of piling up in the last cell', () => {
  const s = S(5, 4);
  put(s, 'abcdefgh');
  assert.equal(line(s, 0), 'abcde');
  assert.equal(line(s, 1), 'fgh');
});

test('the cursor moves where CUP, CHA, VPA and the arrows say', () => {
  const s = S();
  put(s, `${ESC}[3;7H`);                 // CUP is 1-based
  assert.deepEqual(cursorRowCol(s), { row: 2, col: 6 });
  put(s, `${ESC}[12G`);                  // CHA: absolute column
  assert.deepEqual(cursorRowCol(s), { row: 2, col: 11 });
  put(s, `${ESC}[2d`);                   // VPA: absolute row
  assert.deepEqual(cursorRowCol(s), { row: 1, col: 11 });
  put(s, `${ESC}[A${ESC}[3C${ESC}[2D${ESC}[B`);
  assert.deepEqual(cursorRowCol(s), { row: 1, col: 12 });
  // Moves clamp at the edges rather than running off the grid.
  put(s, `${ESC}[99;99H`);
  assert.deepEqual(cursorRowCol(s), { row: 4, col: 19 });
});

test('erase in line and erase in display clear the parts they name', () => {
  const s = S(10, 3);
  put(s, 'abcdefghij', `${ESC}[1;4H`, `${ESC}[K`);        // EL 0: to end of line
  assert.equal(line(s, 0), 'abc');
  put(s, `${ESC}[2;1H`, 'xxxxxxxxxx', `${ESC}[2;6H`, `${ESC}[1K`);   // EL 1: to start
  assert.equal(line(s, 1), '      xxxx', 'EL 1 erases up to AND INCLUDING the cursor');
  put(s, `${ESC}[3;1H`, 'zzzz', `${ESC}[2J`);             // ED 2: everything
  assert.equal(toText(s).trim(), '');
});

// The reads off a pty are chunked by the kernel, not by meaning. A sequence split
// across two reads that is not reassembled is a sequence printed as text.
test('a sequence split across two writes is still one sequence', () => {
  const s = S();
  write(s, Buffer.from(`${ESC}[3;`, 'utf8'));
  write(s, Buffer.from('7Hx', 'utf8'));
  assert.deepEqual(cursorRowCol(s), { row: 2, col: 7 });
  assert.equal(line(s, 2), '      x');
});

test('a UTF-8 character split across two writes is still one character', () => {
  const s = S();
  const bytes = Buffer.from('é界', 'utf8');
  write(s, bytes.subarray(0, 3));        // cuts é whole and 界 in half
  write(s, bytes.subarray(3));
  assert.equal(line(s, 0), 'é界');
});

test('a wide character takes two cells and half of one cannot survive', () => {
  const s = S(10, 2);
  put(s, '界a');
  assert.deepEqual(cursorRowCol(s), { row: 0, col: 3 });
  assert.equal(line(s, 0), '界a');
  // Overwriting the left half must not leave the orphaned right half behind.
  put(s, `${ESC}[1;1H`, 'x');
  assert.equal(line(s, 0), 'x a');
});

test('a combining mark joins the cell before it rather than taking its own', () => {
  const s = S();
  put(s, 'éx');
  assert.deepEqual(cursorRowCol(s), { row: 0, col: 2 });
  assert.equal(line(s, 0), 'éx');
});

test('SGR is remembered per cell, in 256 colour and in truecolor', () => {
  const s = S();
  put(s, `${ESC}[1m${ESC}[38;2;215;119;87mA${ESC}[0mB${ESC}[38;5;42mC`);
  const runs = cellRows(s)[0].runs;
  assert.equal(runs[0].bold, true);
  assert.equal(runs[0].fg, 0xd77757);
  assert.equal(runs[1].bold, false, 'SGR 0 resets');
  assert.equal(runs[1].fg, null, 'default foreground is not a colour');
  assert.equal(runs[2].fg256, 42);
});

// The whole reason to keep styles: Claude Code paints its next-prompt suggestion into
// the EMPTY composer in dim text. read-screen threw styles away, so on paper it was a
// draft, and probeDraft had to type a letter and look to tell them apart.
test('a dim run is distinguishable from a normal one, which is what probeDraft was for', () => {
  const s = S();
  put(s, `${ESC}[2mtry "fix the bug"${ESC}[0m`);
  const runs = cellRows(s)[0].runs.filter(r => r.text.trim());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].dim, true);
});

// Found by looking at a rendered screen, not by a test: `CSI >4;2m` is the
// modifyOtherKeys request, not "underline and dim", and Claude Code sends it at
// startup. Reading it as SGR styled the entire session.
test('a private-prefixed m is a mode request, not SGR', () => {
  const s = S();
  put(s, `${ESC}[>4;2m`, 'plain');
  const r = cellRows(s)[0].runs[0];
  assert.equal(r.underline, false);
  assert.equal(r.dim, false);
  put(s, `${ESC}[>4m`, `${ESC}[?4m`);
  assert.equal(cellRows(s)[0].runs[0].underline, false);
  // and an ordinary SGR still works
  put(s, `${ESC}[2;1H`, `${ESC}[4mreal`);
  assert.equal(cellRows(s)[1].runs[0].underline, true);
});

test('the alternate screen is a separate grid and the first one comes back intact', () => {
  const s = S();
  put(s, 'main screen');
  put(s, `${ESC}[?1049h`);
  assert.equal(toText(s).trim(), '', 'the alt screen starts empty');
  put(s, 'alt screen');
  assert.equal(line(s, 0), 'alt screen');
  put(s, `${ESC}[?1049l`);
  assert.equal(line(s, 0), 'main screen');
});

test('a scroll region scrolls only its own rows', () => {
  const s = S(6, 5);
  put(s, 'r0\r\nr1\r\nr2\r\nr3\r\nr4');
  put(s, `${ESC}[2;4r`);                 // rows 2..4 (1-based) scroll, 1 and 5 do not
  put(s, `${ESC}[4;1H`, '\n');           // newline at the bottom of the region
  assert.equal(line(s, 0), 'r0', 'above the region is untouched');
  assert.equal(line(s, 1), 'r2');
  assert.equal(line(s, 2), 'r3');
  assert.equal(line(s, 3), '');
  assert.equal(line(s, 4), 'r4', 'below the region is untouched');
});

test('reverse index scrolls the other way, which is how Codex redraws', () => {
  const s = S(6, 3);
  put(s, 'a\r\nb\r\nc');
  put(s, `${ESC}[1;1H`, `${ESC}M`);
  assert.equal(line(s, 0), '');
  assert.equal(line(s, 1), 'a');
  assert.equal(line(s, 2), 'b');
});

test('insert and delete move lines and characters', () => {
  const s = S(8, 4);
  put(s, 'aaa\r\nbbb\r\nccc');
  put(s, `${ESC}[2;1H${ESC}[L`);          // insert a line at row 2
  assert.equal(line(s, 1), '');
  assert.equal(line(s, 2), 'bbb');
  put(s, `${ESC}[2;1H${ESC}[M`);          // and take it back out
  assert.equal(line(s, 1), 'bbb');
  put(s, `${ESC}[1;2H${ESC}[P`);          // delete one char
  assert.equal(line(s, 0), 'aa');
  put(s, `${ESC}[1;1H${ESC}[2@`);         // insert two blanks
  assert.equal(line(s, 0), '  aa');
  put(s, `${ESC}[1;1H${ESC}[3X`);         // erase three in place, no shifting
  assert.equal(line(s, 0), '   a');
});

test('save and restore cursor, which Claude Code sends on startup', () => {
  const s = S();
  put(s, `${ESC}[3;5H`, `${ESC}7`, `${ESC}[1;1H`, `${ESC}8`);
  assert.deepEqual(cursorRowCol(s), { row: 2, col: 4 });
});

// The TUI blocks on these. Codex asks XTVERSION 108 times in sixteen seconds; if
// nothing answers, it waits.
test('the terminal answers the queries the TUIs actually send', () => {
  const s = S();
  const da = write(s, Buffer.from(`${ESC}[c`, 'utf8'));
  assert.match(da.toString(), /^\x1b\[\?6[0-9;]*c$/, 'DA1 must look like a real terminal');
  const ver = write(s, Buffer.from(`${ESC}[>0q`, 'utf8'));
  assert.match(ver.toString(), /^\x1bP>\|.+\x1b\\$/, 'XTVERSION is a DCS string');
  const kitty = write(s, Buffer.from(`${ESC}[?u`, 'utf8'));
  assert.equal(kitty.toString(), `${ESC}[?0u`, 'decline the kitty protocol, take legacy keys');
  put(s, `${ESC}[5;9H`);
  const dsr = write(s, Buffer.from(`${ESC}[6n`, 'utf8'));
  assert.equal(dsr.toString(), `${ESC}[5;9R`, 'DSR reports the cursor 1-based');
});

test('nothing is answered when nothing was asked', () => {
  const s = S();
  assert.equal(write(s, Buffer.from('plain text', 'utf8')).length, 0);
});

test('the window title is read off OSC, ended by BEL or by ST', () => {
  const s = S();
  put(s, `${ESC}]0;✳ Claude Code\x07`);
  assert.equal(s.title, '✳ Claude Code');
  put(s, `${ESC}]2;second${ESC}\\`);
  assert.equal(s.title, 'second');
});

// ?2026 brackets a redraw. Both TUIs use it, Codex 216 times in sixteen seconds, so it
// is an exact "the frame is complete" signal - which is what replaces the settle poll.
test('synchronized output marks frame boundaries, and every frame bumps a counter', () => {
  const s = S();
  const before = s.frame;
  put(s, `${ESC}[?2026h`, 'half a re', `${ESC}[?2026l`);
  assert.equal(s.frame, before + 1, 'one complete frame');
  assert.equal(s.syncing, false);
  put(s, `${ESC}[?2026h`, 'mid-draw');
  assert.equal(s.syncing, true, 'a frame in progress is not worth reading yet');
});

test('APC and DCS strings are swallowed whole, not printed as text', () => {
  const s = S();
  put(s, `${ESC}_somethingprivate${ESC}\\`, 'after');
  assert.equal(line(s, 0), 'after');
  const d = S();
  put(d, `${ESC}Pq#0;2;0;0;0${ESC}\\`, 'ok');
  assert.equal(line(d, 0), 'ok');
});

test('mouse, paste and focus modes are accepted and recorded, not printed', () => {
  const s = S();
  put(s, `${ESC}[?2004h${ESC}[?1002h${ESC}[?25l`, 'x');
  assert.equal(line(s, 0), 'x');
  assert.equal(s.bracketedPaste, true);
  assert.equal(s.cursorVisible, false);
});

// The bug that made every spawned native pen report "did not become ready". Claude
// Code's classic renderer paints at the TOP of the screen and leaves the rest blank, so
// asking for the last 40 lines of a 50-row grid returned one line of footer and 39
// empty rows, and agentReady never saw an agent that had been ready for a minute.
test('the last N lines means the last N lines OF CONTENT, not of the grid', () => {
  const s = S(20, 50);
  put(s, 'header\r\nbody\r\n\r\n\u276f composer\r\n  the footer');
  const got = toText(s, 40).split('\n');
  assert.equal(got[got.length - 1], '  the footer', 'the footer must be the last line');
  assert.ok(got.includes('header'), 'and the top of the screen must still be there');
  assert.ok(got.length <= 40);
  // A TUI that fills the whole screen is unaffected: its content already ends at the
  // bottom row.
  const full = S(20, 6);
  put(full, 'a\r\nb\r\nc\r\nd\r\ne\r\nf');
  assert.equal(toText(full, 3), 'd\ne\nf');
});

test('toText gives the last N lines with trailing blanks trimmed, like read-screen', () => {
  const s = S(10, 6);
  put(s, 'a\r\nb\r\nc\r\nd\r\ne\r\nf');
  assert.equal(toText(s, 3), 'd\ne\nf');
  assert.equal(toText(s).split('\n').length, 6);
});

test('a resize keeps what still fits and does not throw away the cursor', () => {
  const s = S(10, 4);
  put(s, 'hello\r\nworld');
  resize(s, 6, 3);
  assert.equal(s.cols, 6);
  assert.equal(s.rows, 3);
  assert.equal(line(s, 0), 'hello');
  assert.ok(cursorRowCol(s).row < 3);
});

// A pen's output is untrusted. A 4-byte UTF-8 lead can encode past U+10FFFF, and
// String.fromCodePoint throws on that, so one bad sequence used to break every read.
test('a codepoint past U+10FFFF becomes U+FFFD instead of throwing on read', () => {
  const s = createScreen(20, 3);
  write(s, Buffer.from([0x61, 0xf7, 0xbf, 0xbf, 0xbf, 0xf4, 0x90, 0x80, 0x80, 0x62]));
  assert.doesNotThrow(() => toText(s));
  assert.doesNotThrow(() => cellRows(s));
  assert.match(toText(s), /^a��b/);
});

// An OSC with no terminator, or a very long one, must not grow without limit.
test('an unterminated string sequence keeps a bounded payload', () => {
  const s = createScreen(20, 3);
  write(s, Buffer.concat([Buffer.from('\x1b]0;'), Buffer.alloc(1 << 20, 0x41)]));
  assert.ok(s.str.length <= 4096, `str holds ${s.str.length} bytes`);
  write(s, Buffer.from('\x07ok'));
  assert.match(toText(s), /ok/);
});

test('combining marks on one cell are capped', () => {
  const s = createScreen(20, 3);
  write(s, Buffer.from('a' + '́'.repeat(100000), 'utf8'));
  for (const m of s.buf.marks.values()) assert.ok(m.length <= 32, `marks hold ${m.length} units`);
});
