// Drawing an owned terminal.
//
// cmux handed us text with every style stripped, so the panel could only ever show grey
// text on grey. Owning the byte stream means we have the colours, the bold and - the
// one that carries meaning - the DIM that Claude Code paints its composer suggestion
// in. A renderer that dropped that would make the panel lie about whether there is a
// draft in the box.
//
// Terminal output is input, not markup. It is escaped BEFORE anything is wrapped around
// it, in that order, the same rule markdown.js follows for transcripts.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const hex = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

// The xterm 256-colour palette, worked out rather than listed: 16 system colours, a
// 6x6x6 cube, then a 24-step grey ramp.
const SYSTEM = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
  0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];
const STEPS = [0, 95, 135, 175, 215, 255];
export function xterm256(i) {
  const n = Math.max(0, Math.min(255, i | 0));
  if (n < 16) return hex(SYSTEM[n]);
  if (n < 232) {
    const c = n - 16;
    return hex((STEPS[Math.floor(c / 36) % 6] << 16) | (STEPS[Math.floor(c / 6) % 6] << 8) | STEPS[c % 6]);
  }
  const g = 8 + (n - 232) * 10;
  return hex((g << 16) | (g << 8) | g);
}

const colour = (rgb, idx) => (rgb !== null && rgb !== undefined ? hex(rgb)
  : idx !== null && idx !== undefined ? xterm256(idx) : null);

export function renderRun(run) {
  if (!run) return '';
  const text = escapeHtml(run.text);
  let fg = colour(run.fg, run.fg256), bg = colour(run.bg, run.bg256);
  // Inverse is how a terminal draws a cursor and a selection: the two colours trade
  // places, including when one of them is the default.
  if (run.inverse) [fg, bg] = [bg || '#0b0d10', fg || '#c5c5c5'];
  const css = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (run.bold) css.push('font-weight:700');
  if (run.dim) css.push('opacity:.55');
  if (run.italic) css.push('font-style:italic');
  if (run.underline && run.strike) css.push('text-decoration:underline line-through');
  else if (run.underline) css.push('text-decoration:underline');
  else if (run.strike) css.push('text-decoration:line-through');
  // The common case by a wide margin. A span per run of plain text would triple the
  // size of a screen for nothing.
  return css.length ? `<span style="${css.join(';')}">${text}</span>` : text;
}

// One line per row, so the whole screen is a single <pre>. Blank rows stay blank rather
// than collapsing, or every redraw would shift the lines under it.
export function renderRows(rows) {
  if (!Array.isArray(rows)) return '';
  return rows.map(r => (r.runs || []).map(renderRun).join('')).join('\n');
}

// The screen as TEXT, from the same rows the page is drawing.
//
// Every terminal action is checked against the screen it was decided on: the server
// refuses a keystroke if the screen moved underneath it (terminal.js, sameInput). The
// page therefore needs the exact string the server would have produced, and deriving it
// from the rows it already has beats shipping the text alongside every frame - which
// would undo the whole point of sending only the rows that changed.
//
// This mirrors vt.js toText, and a test holds the two together against real captures.
export function rowsText(rows, lines = Infinity) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const text = rows.map(r => (r.runs || []).map(x => x.text).join('').replace(/\s+$/, ''));
  let last = text.length - 1;
  while (last > 0 && !text[last].trim()) last--;
  const from = Math.max(0, last + 1 - lines);
  return text.slice(from, last + 1).join('\n');
}
