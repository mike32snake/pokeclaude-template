// Which rows of a terminal screen actually changed.
//
// The preview first pushed the whole grid on every frame: 25KB of JSON at up to twenty
// frames a second, plus a full DOM rebuild of several thousand nodes. An idle agent was
// fine and a TUI drawing a spinner froze the tab. A redraw almost never touches every
// row, so only the ones that moved are sent.
//
// The key is the row's STYLING as well as its text. Claude Code marks its composer
// suggestion by making the same words dim, so a diff on text alone would leave the page
// showing a draft that is not there.
export const rowKey = (row) => (row?.runs || [])
  .map(r => `${r.text}\u0000${r.fg}\u0000${r.bg}\u0000${r.fg256}\u0000${r.bg256}\u0000`
          + `${r.bold ? 1 : 0}${r.dim ? 1 : 0}${r.italic ? 1 : 0}${r.underline ? 1 : 0}`
          + `${r.inverse ? 1 : 0}${r.strike ? 1 : 0}`)
  .join('\u0001');

// `prev` is the keys from the last call, or null for a client that has nothing yet.
// Returns what to send and the keys to remember.
export function diffRows(prev, rows) {
  const next = (rows || []).map(rowKey);
  if (!prev) return { full: true, rows: rows || [], removed: [], keys: next };
  const changed = [];
  for (let y = 0; y < next.length; y++) if (prev[y] !== next[y]) changed.push(rows[y]);
  const removed = [];
  for (let y = next.length; y < prev.length; y++) removed.push(y);
  return { full: false, rows: changed, removed, keys: next };
}
