// A terminal emulator: bytes in, a screen grid out.
//
// PokeClaude reads terminals as text. cmux renders that today, so every look costs a
// round trip, and typeInto's settle loop is a poll over a network call. Owning the pty
// means nobody else renders it, so this does - and then reading the screen is reading
// an object, which is what makes the poll go away.
//
// The scope is measured, not guessed. Both CLIs were captured under a real pty and
// every escape sequence counted: Claude Code uses 18 distinct CSI kinds, Codex 13, and
// neither needs scrollback because PokeClaude only ever reads the visible rows. What it
// does need is the parts a naive parser skips: sequences and UTF-8 characters split
// across reads (the kernel chunks by size, not by meaning), correct column widths for
// wide characters, and REPLIES - Codex asks XTVERSION 108 times in sixteen seconds and
// waits for an answer.
//
// Styles are kept, unlike read-screen, and that is a feature rather than completeness:
// Claude Code paints its next-prompt suggestion into the empty composer in DIM text, so
// probeDraft had to type a letter and look to tell a suggestion from a draft.
import { charWidth } from './widths.js';

const DEFAULT = -1;
const TRUECOLOR = 0x1000000;              // above the 256 indexed colours
export const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, BLINK = 16,
             INVERSE = 32, HIDDEN = 64, STRIKE = 128;

const BLANK = 32;                          // a cell holding a space

function makeBuffer(cols, rows) {
  const n = cols * rows;
  return {
    ch: new Uint32Array(n).fill(BLANK),
    fg: new Int32Array(n).fill(DEFAULT),
    bg: new Int32Array(n).fill(DEFAULT),
    attr: new Uint16Array(n),
    // Only the cells that actually carry combining marks, which is almost none of them.
    marks: new Map(),
  };
}

export function createScreen(cols = 200, rows = 50) {
  const s = {
    cols, rows,
    main: makeBuffer(cols, rows),
    alt: null,
    onAlt: false,
    x: 0, y: 0, wrapNext: false,
    saved: null,
    scrollTop: 0, scrollBottom: rows - 1,
    fg: DEFAULT, bg: DEFAULT, attr: 0,
    title: '', cursorVisible: true, bracketedPaste: false, wrap: true,
    mouse: false, syncing: false, frame: 0,
    // parser
    state: 'ground', params: '', inter: '', prefix: '', str: [], strKind: '',
    u8: [], u8need: 0,
    replies: [],
  };
  s.buf = s.main;
  return s;
}

export const cursorRowCol = (s) => ({ row: s.y, col: Math.min(s.x + (s.wrapNext ? 1 : 0), s.cols) });

// ---- grid primitives -------------------------------------------------------------

const idx = (s, x, y) => y * s.cols + x;

function clearCells(s, from, to) {
  const b = s.buf;
  for (let i = from; i < to; i++) {
    b.ch[i] = BLANK; b.fg[i] = DEFAULT; b.bg[i] = s.bg; b.attr[i] = 0;
    if (b.marks.size) b.marks.delete(i);
  }
}

// A wide character owns two cells: the codepoint sits in the left one and the right is
// a marker. Writing over either half must take the other with it, or the row keeps a
// dangling half that shifts every column after it.
const WIDE_TAIL = 0xffffffff;
function clearPair(s, i) {
  const b = s.buf, x = i % s.cols;
  if (b.ch[i] === WIDE_TAIL && x > 0) { b.ch[i - 1] = BLANK; b.marks.delete(i - 1); }
  if (x + 1 < s.cols && b.ch[i + 1] === WIDE_TAIL) { b.ch[i + 1] = BLANK; }
}

function scrollUp(s, n = 1) {
  const b = s.buf, { cols } = s;
  const top = s.scrollTop * cols, bottom = (s.scrollBottom + 1) * cols, span = n * cols;
  if (span >= bottom - top) { clearCells(s, top, bottom); return; }
  b.ch.copyWithin(top, top + span, bottom);
  b.fg.copyWithin(top, top + span, bottom);
  b.bg.copyWithin(top, top + span, bottom);
  b.attr.copyWithin(top, top + span, bottom);
  b.marks.clear();
  clearCells(s, bottom - span, bottom);
}

function scrollDown(s, n = 1) {
  const b = s.buf, { cols } = s;
  const top = s.scrollTop * cols, bottom = (s.scrollBottom + 1) * cols, span = n * cols;
  if (span >= bottom - top) { clearCells(s, top, bottom); return; }
  b.ch.copyWithin(top + span, top, bottom - span);
  b.fg.copyWithin(top + span, top, bottom - span);
  b.bg.copyWithin(top + span, top, bottom - span);
  b.attr.copyWithin(top + span, top, bottom - span);
  b.marks.clear();
  clearCells(s, top, top + span);
}

const lineFeed = (s) => {
  if (s.y === s.scrollBottom) scrollUp(s, 1);
  else if (s.y < s.rows - 1) s.y++;
};
const reverseIndex = (s) => {
  if (s.y === s.scrollTop) scrollDown(s, 1);
  else if (s.y > 0) s.y--;
};

// ---- printing --------------------------------------------------------------------

function putChar(s, cp) {
  const w = charWidth(cp);
  if (w === 0) {
    // A combining mark belongs to the cell before the cursor, not to one of its own.
    const px = s.x - 1;
    if (px >= 0) {
      const i = idx(s, px, s.y);
      s.buf.marks.set(i, (s.buf.marks.get(i) || '') + String.fromCodePoint(cp));
    }
    return;
  }
  if (s.wrapNext) { s.x = 0; lineFeed(s); s.wrapNext = false; }
  if (s.x + w > s.cols) {
    if (!s.wrap) return;
    s.x = 0; lineFeed(s);
  }
  const i = idx(s, s.x, s.y);
  clearPair(s, i);
  const b = s.buf;
  b.ch[i] = cp; b.fg[i] = s.fg; b.bg[i] = s.bg; b.attr[i] = s.attr;
  b.marks.delete(i);
  if (w === 2) {
    clearPair(s, i + 1);
    b.ch[i + 1] = WIDE_TAIL; b.fg[i + 1] = s.fg; b.bg[i + 1] = s.bg; b.attr[i + 1] = s.attr;
  }
  s.x += w;
  // The cursor sits ON the last column until one more character arrives, which is how
  // a terminal avoids scrolling on a line that exactly fills the width.
  if (s.x >= s.cols) { s.x = s.cols - 1; s.wrapNext = true; }
}

// ---- SGR -------------------------------------------------------------------------

function sgr(s, parts) {
  if (!parts.length) parts = [0];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 0) { s.fg = DEFAULT; s.bg = DEFAULT; s.attr = 0; }
    else if (p === 1) s.attr |= BOLD;
    else if (p === 2) s.attr |= DIM;
    else if (p === 3) s.attr |= ITALIC;
    else if (p === 4) s.attr |= UNDERLINE;
    else if (p === 5) s.attr |= BLINK;
    else if (p === 7) s.attr |= INVERSE;
    else if (p === 8) s.attr |= HIDDEN;
    else if (p === 9) s.attr |= STRIKE;
    else if (p === 21 || p === 22) s.attr &= ~(BOLD | DIM);
    else if (p === 23) s.attr &= ~ITALIC;
    else if (p === 24) s.attr &= ~UNDERLINE;
    else if (p === 25) s.attr &= ~BLINK;
    else if (p === 27) s.attr &= ~INVERSE;
    else if (p === 28) s.attr &= ~HIDDEN;
    else if (p === 29) s.attr &= ~STRIKE;
    else if (p >= 30 && p <= 37) s.fg = p - 30;
    else if (p >= 40 && p <= 47) s.bg = p - 40;
    else if (p >= 90 && p <= 97) s.fg = p - 90 + 8;
    else if (p >= 100 && p <= 107) s.bg = p - 100 + 8;
    else if (p === 39) s.fg = DEFAULT;
    else if (p === 49) s.bg = DEFAULT;
    else if (p === 38 || p === 48) {
      const mode = parts[i + 1];
      let v = DEFAULT;
      if (mode === 5) { v = parts[i + 2] | 0; i += 2; }
      else if (mode === 2) {
        v = TRUECOLOR + (((parts[i + 2] | 0) << 16) | ((parts[i + 3] | 0) << 8) | (parts[i + 4] | 0));
        i += 4;
      } else { i += 1; }
      if (p === 38) s.fg = v; else s.bg = v;
    }
  }
}

// ---- modes -----------------------------------------------------------------------

function decMode(s, n, on) {
  switch (n) {
    case 7: s.wrap = on; break;
    case 25: s.cursorVisible = on; break;
    case 1000: case 1002: case 1003: case 1006: case 1015: s.mouse = on; break;
    case 2004: s.bracketedPaste = on; break;
    case 2026:
      // Synchronized output: the TUI is saying "this redraw is one frame". The closing
      // half is an exact "the screen is now worth reading", which is what replaces the
      // settle poll that cost a round trip per look.
      if (on) s.syncing = true;
      else if (s.syncing) { s.syncing = false; s.frame++; }
      break;
    case 1047: case 1049: case 47: {
      if (on && !s.onAlt) {
        if (n === 1049) s.saved = { x: s.x, y: s.y, fg: s.fg, bg: s.bg, attr: s.attr };
        s.alt = makeBuffer(s.cols, s.rows);
        s.buf = s.alt; s.onAlt = true; s.x = 0; s.y = 0; s.wrapNext = false;
      } else if (!on && s.onAlt) {
        s.buf = s.main; s.onAlt = false; s.alt = null;
        if (n === 1049 && s.saved) {
          s.x = s.saved.x; s.y = s.saved.y; s.fg = s.saved.fg; s.bg = s.saved.bg; s.attr = s.saved.attr;
        }
        s.wrapNext = false;
      }
      break;
    }
    default: break;                        // focus, colour-scheme and kitty flags: noted, not modelled
  }
}

// ---- CSI dispatch ----------------------------------------------------------------

const VERSION = '\x1bP>|pokeclaude(1)\x1b\\';

function csi(s, final) {
  const raw = s.params;
  // ':' sub-parameters appear in SGR (38:2:r:g:b). Flattening them is right for every
  // sequence these two TUIs send.
  const parts = raw === '' ? [] : raw.split(/[;:]/).map(v => (v === '' ? 0 : parseInt(v, 10) || 0));
  const p = (i, d = 1) => (parts[i] === undefined || parts[i] === 0 ? d : parts[i]);
  const pre = s.prefix;
  const clampX = () => { s.x = Math.max(0, Math.min(s.x, s.cols - 1)); s.wrapNext = false; };
  const clampY = () => { s.y = Math.max(0, Math.min(s.y, s.rows - 1)); };

  switch (final) {
    case 'A': s.y = Math.max(s.y - p(0), s.y >= s.scrollTop ? s.scrollTop : 0); clampY(); s.wrapNext = false; break;
    case 'B': s.y = Math.min(s.y + p(0), s.y <= s.scrollBottom ? s.scrollBottom : s.rows - 1); clampY(); s.wrapNext = false; break;
    case 'C': s.x += p(0); clampX(); break;
    case 'D': s.x -= p(0); clampX(); break;
    case 'E': s.y += p(0); s.x = 0; clampY(); s.wrapNext = false; break;
    case 'F': s.y -= p(0); s.x = 0; clampY(); s.wrapNext = false; break;
    case 'G': case '`': s.x = p(0) - 1; clampX(); break;
    case 'd': s.y = p(0) - 1; clampY(); s.wrapNext = false; break;
    case 'H': case 'f': s.y = p(0) - 1; s.x = p(1) - 1; clampY(); clampX(); break;
    case 'J': {
      const m = parts[0] || 0, here = idx(s, s.x, s.y), end = s.cols * s.rows;
      if (m === 0) clearCells(s, here, end);
      else if (m === 1) clearCells(s, 0, here + 1);
      else clearCells(s, 0, end);
      break;
    }
    case 'K': {
      const m = parts[0] || 0, row = s.y * s.cols;
      if (m === 0) clearCells(s, row + s.x, row + s.cols);
      else if (m === 1) clearCells(s, row, row + s.x + 1);
      else clearCells(s, row, row + s.cols);
      break;
    }
    case 'L': if (s.y >= s.scrollTop && s.y <= s.scrollBottom) {
      const save = s.scrollTop; s.scrollTop = s.y; scrollDown(s, Math.min(p(0), s.rows)); s.scrollTop = save;
    } break;
    case 'M': if (s.y >= s.scrollTop && s.y <= s.scrollBottom) {
      const save = s.scrollTop; s.scrollTop = s.y; scrollUp(s, Math.min(p(0), s.rows)); s.scrollTop = save;
    } break;
    case 'S': scrollUp(s, p(0)); break;
    case 'T': scrollDown(s, p(0)); break;
    case 'P': {                                        // DCH: pull the rest of the line left
      const n = Math.min(p(0), s.cols - s.x), row = s.y * s.cols, b = s.buf;
      for (const a of [b.ch, b.fg, b.bg, b.attr]) a.copyWithin(row + s.x, row + s.x + n, row + s.cols);
      clearCells(s, row + s.cols - n, row + s.cols);
      break;
    }
    case '@': {                                        // ICH: push the rest of the line right
      const n = Math.min(p(0), s.cols - s.x), row = s.y * s.cols, b = s.buf;
      for (const a of [b.ch, b.fg, b.bg, b.attr]) a.copyWithin(row + s.x + n, row + s.x, row + s.cols - n);
      clearCells(s, row + s.x, row + s.x + n);
      break;
    }
    case 'X': {                                        // ECH: blank in place, no shifting
      const row = s.y * s.cols;
      clearCells(s, row + s.x, Math.min(row + s.x + p(0), row + s.cols));
      break;
    }
    // Only UNPREFIXED 'm' is SGR. Claude Code sends `CSI >4;2m` to ask for
    // modifyOtherKeys and `CSI >4m` to turn it off, and reading those as SGR set
    // underline and dim on the whole screen - which the tests did not catch and one
    // look at the rendered page did.
    case 'm': if (!pre) sgr(s, parts); break;
    case 'r': {
      const top = p(0) - 1, bot = p(1, s.rows) - 1;
      if (top < bot && bot < s.rows) { s.scrollTop = Math.max(0, top); s.scrollBottom = bot; }
      else { s.scrollTop = 0; s.scrollBottom = s.rows - 1; }
      s.x = 0; s.y = s.scrollTop; s.wrapNext = false;
      break;
    }
    case 'h': case 'l': {
      const on = final === 'h';
      for (const n of (parts.length ? parts : [0])) {
        if (pre === '?') decMode(s, n, on);
        else if (n === 4) s.insertMode = on;
      }
      break;
    }
    case 'c':
      // A real terminal answers this. Claude Code sends it at startup and waits.
      s.replies.push(pre === '>' ? '\x1b[>0;280;0c' : '\x1b[?62;4c');
      break;
    case 'n':
      if (parts[0] === 6) s.replies.push(`\x1b[${s.y + 1};${Math.min(s.x, s.cols - 1) + 1}R`);
      else if (parts[0] === 5) s.replies.push('\x1b[0n');
      break;
    case 'q': if (pre === '>') s.replies.push(VERSION); break;
    case 'u':
      // The kitty keyboard protocol. Declining it is deliberate: the TUIs fall back to
      // legacy key encoding, which is what we already know how to send.
      if (pre === '?') s.replies.push('\x1b[?0u');
      break;
    case 't': break;                                   // window ops: nothing to report
    case 'p': if (s.inter === '!') softReset(s); break;
    default: break;
  }
}

function softReset(s) {
  s.fg = DEFAULT; s.bg = DEFAULT; s.attr = 0;
  s.scrollTop = 0; s.scrollBottom = s.rows - 1;
  s.wrap = true; s.cursorVisible = true; s.insertMode = false;
}

function osc(s) {
  // Decoded as UTF-8 at the end, not byte by byte: Claude Code's own title is
  // "\u2733 Claude Code", and charCode-per-byte turned it into mojibake.
  const text = Buffer.from(s.str).toString('utf8');
  const semi = text.indexOf(';');
  const code = parseInt(semi < 0 ? text : text.slice(0, semi), 10);
  const body = semi < 0 ? '' : text.slice(semi + 1);
  if (code === 0 || code === 1 || code === 2) s.title = body;
  // Colour queries: "?" means the TUI wants an answer, and Codex asks for both.
  else if ((code === 10 || code === 11) && body.startsWith('?')) {
    const c = code === 10 ? 'rgb:c5c5/c5c5/c5c5' : 'rgb:0000/0000/0000';
    s.replies.push(`\x1b]${code};${c}\x07`);
  }
}

// ---- the byte-level parser -------------------------------------------------------

export function write(screen, bytes) {
  const s = screen;
  s.replies.length = 0;
  for (let k = 0; k < bytes.length; k++) {
    const c = bytes[k];
    switch (s.state) {
      case 'ground': {
        if (s.u8need) {
          if ((c & 0xc0) === 0x80) {
            s.u8.push(c);
            if (--s.u8need === 0) { putChar(s, decodeU8(s.u8)); s.u8.length = 0; }
            continue;
          }
          s.u8.length = 0; s.u8need = 0;   // a truncated sequence: drop it, take this byte fresh
        }
        if (c === 0x1b) { s.state = 'esc'; s.params = ''; s.inter = ''; s.prefix = ''; }
        else if (c === 0x0a || c === 0x0b || c === 0x0c) { s.wrapNext = false; lineFeed(s); }
        else if (c === 0x0d) { s.x = 0; s.wrapNext = false; }
        else if (c === 0x08) { if (s.wrapNext) s.wrapNext = false; else if (s.x > 0) s.x--; }
        else if (c === 0x09) { s.x = Math.min(s.cols - 1, (s.x - s.x % 8) + 8); s.wrapNext = false; }
        else if (c === 0x07) { /* bell */ }
        else if (c < 0x20 || c === 0x7f) { /* other C0: ignored */ }
        else if (c < 0x80) putChar(s, c);
        else if ((c & 0xe0) === 0xc0) { s.u8 = [c]; s.u8need = 1; }
        else if ((c & 0xf0) === 0xe0) { s.u8 = [c]; s.u8need = 2; }
        else if ((c & 0xf8) === 0xf0) { s.u8 = [c]; s.u8need = 3; }
        break;
      }
      case 'esc': {
        const ch = String.fromCharCode(c);
        if (ch === '[') { s.state = 'csi'; }
        else if (ch === ']') { s.state = 'str'; s.strKind = 'osc'; s.str = []; }
        else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {
          s.state = 'str'; s.strKind = 'skip'; s.str = [];
        }
        else if (ch === '7') { s.saved = { x: s.x, y: s.y, fg: s.fg, bg: s.bg, attr: s.attr }; s.state = 'ground'; }
        else if (ch === '8') {
          if (s.saved) { s.x = s.saved.x; s.y = s.saved.y; s.fg = s.saved.fg; s.bg = s.saved.bg; s.attr = s.saved.attr; }
          s.state = 'ground';
        }
        else if (ch === 'M') { reverseIndex(s); s.state = 'ground'; }
        else if (ch === 'D') { lineFeed(s); s.state = 'ground'; }
        else if (ch === 'E') { s.x = 0; lineFeed(s); s.state = 'ground'; }
        else if (ch === 'c') { hardReset(s); s.state = 'ground'; }
        else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '%' || ch === '#') {
          s.state = 'charset';                       // one more byte names the set
        }
        else s.state = 'ground';                     // ESC =, ESC >, ESC \ and friends
        break;
      }
      case 'charset': s.state = 'ground'; break;
      case 'csi': {
        if (c >= 0x30 && c <= 0x3f) {
          // '?', '>' and '<' only count as a prefix in the first position.
          if (s.params === '' && (c === 0x3f || c === 0x3e || c === 0x3c)) s.prefix = String.fromCharCode(c);
          else s.params += String.fromCharCode(c);
        } else if (c >= 0x20 && c <= 0x2f) s.inter += String.fromCharCode(c);
        else if (c >= 0x40 && c <= 0x7e) { csi(s, String.fromCharCode(c)); s.state = 'ground'; }
        else if (c === 0x1b) { s.state = 'esc'; s.params = ''; s.inter = ''; s.prefix = ''; }
        else s.state = 'ground';
        break;
      }
      case 'str': {
        // OSC and the private strings end at BEL or at ST (ESC \).
        if (c === 0x07) { if (s.strKind === 'osc') osc(s); s.state = 'ground'; }
        else if (c === 0x1b) s.state = 'str-esc';
        else s.str.push(c);
        break;
      }
      case 'str-esc': {
        if (c === 0x5c) { if (s.strKind === 'osc') osc(s); s.state = 'ground'; }
        else { s.str.push(0x1b, c); s.state = 'str'; }
        break;
      }
      default: s.state = 'ground';
    }
  }
  return s.replies.length ? Buffer.from(s.replies.join(''), 'utf8') : Buffer.alloc(0);
}

function decodeU8(b) {
  if (b.length === 2) return ((b[0] & 0x1f) << 6) | (b[1] & 0x3f);
  if (b.length === 3) return ((b[0] & 0x0f) << 12) | ((b[1] & 0x3f) << 6) | (b[2] & 0x3f);
  return ((b[0] & 0x07) << 18) | ((b[1] & 0x3f) << 12) | ((b[2] & 0x3f) << 6) | (b[3] & 0x3f);
}

function hardReset(s) {
  softReset(s);
  s.main = makeBuffer(s.cols, s.rows); s.alt = null; s.onAlt = false; s.buf = s.main;
  s.x = 0; s.y = 0; s.wrapNext = false; s.title = '';
}

// ---- reading the screen ----------------------------------------------------------

function rowText(s, y) {
  const b = s.buf, row = y * s.cols;
  let out = '';
  for (let x = 0; x < s.cols; x++) {
    const i = row + x, cp = b.ch[i];
    if (cp === WIDE_TAIL) continue;                 // the left half already emitted it
    out += String.fromCodePoint(cp === 0 ? 32 : cp);
    const m = b.marks.get(i);
    if (m) out += m;
  }
  return out.replace(/\s+$/, '');
}

// The same shape read-screen returns: the last `lines` rows, newline separated, with
// each row's trailing blanks gone.
//
// "Last" means the last rows OF CONTENT, not the bottom of the grid, and the difference
// is not cosmetic. Claude Code's classic renderer paints at the TOP - logo, composer and
// footer in rows 0 to 10 - and leaves the other forty blank. Counting back from the
// bottom returned one line of footer and thirty-nine empty rows, so agentReady never
// saw a ready agent and every spawned pen reported that it had not come up. A TUI that
// fills the screen has its last content row at the bottom anyway, so nothing changes
// for one of those.
export function toText(s, lines = s.rows) {
  let last = s.rows - 1;
  while (last > 0 && !rowText(s, last).trim()) last--;
  const from = Math.max(0, last + 1 - lines);
  const out = [];
  for (let y = from; y <= last; y++) out.push(rowText(s, y));
  return out.join('\n');
}

const colourOf = (v) => (v === DEFAULT ? null : v >= TRUECOLOR ? (v - TRUECOLOR) : null);
const indexOf256 = (v) => (v === DEFAULT || v >= TRUECOLOR ? null : v);

// The grid as runs of identical styling, which is what a renderer wants: one span per
// run rather than one per cell. Trailing default blanks are dropped.
export function cellRows(s) {
  const b = s.buf, rows = [];
  for (let y = 0; y < s.rows; y++) {
    const row = y * s.cols;
    let end = s.cols;
    while (end > 0) {
      const i = row + end - 1;
      const blank = (b.ch[i] === BLANK || b.ch[i] === 0) && b.bg[i] === DEFAULT && b.attr[i] === 0;
      if (!blank) break;
      end--;
    }
    const runs = [];
    let cur = null;
    for (let x = 0; x < end; x++) {
      const i = row + x;
      if (b.ch[i] === WIDE_TAIL) continue;
      const key = `${b.fg[i]}|${b.bg[i]}|${b.attr[i]}`;
      if (!cur || cur.key !== key) {
        cur = {
          key, start: x, text: '',
          fg: colourOf(b.fg[i]), bg: colourOf(b.bg[i]),
          fg256: indexOf256(b.fg[i]), bg256: indexOf256(b.bg[i]),
          bold: !!(b.attr[i] & BOLD), dim: !!(b.attr[i] & DIM),
          italic: !!(b.attr[i] & ITALIC), underline: !!(b.attr[i] & UNDERLINE),
          inverse: !!(b.attr[i] & INVERSE), strike: !!(b.attr[i] & STRIKE),
        };
        runs.push(cur);
      }
      cur.text += String.fromCodePoint(b.ch[i] === 0 ? 32 : b.ch[i]);
      const m = b.marks.get(i);
      if (m) cur.text += m;
    }
    for (const r of runs) { r.len = r.text.length; delete r.key; }
    rows.push({ y, text: rowText(s, y), runs });
  }
  return rows;
}

export function resize(s, cols, rows) {
  const keepCols = Math.min(cols, s.cols), keepRows = Math.min(rows, s.rows);
  const next = makeBuffer(cols, rows);
  for (let y = 0; y < keepRows; y++) {
    for (let x = 0; x < keepCols; x++) {
      const from = y * s.cols + x, to = y * cols + x;
      next.ch[to] = s.buf.ch[from]; next.fg[to] = s.buf.fg[from];
      next.bg[to] = s.buf.bg[from]; next.attr[to] = s.buf.attr[from];
      const m = s.buf.marks.get(from);
      if (m) next.marks.set(to, m);
    }
  }
  if (s.onAlt) { s.alt = next; } else { s.main = next; }
  s.buf = next;
  s.cols = cols; s.rows = rows;
  s.scrollTop = 0; s.scrollBottom = rows - 1;
  s.x = Math.min(s.x, cols - 1); s.y = Math.min(s.y, rows - 1); s.wrapNext = false;
  return s;
}
