// Find in a conversation: Cmd+F in the panel.
//
// The matching is pure so a test can hold it. The marking works on TEXT NODES of a
// thread that markdown.js already escaped and rendered, and it builds elements, never
// markup, so a search for "<b>" highlights the characters and nothing else.

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cut a text into the runs that match and the runs between them. A regex rather than
// toLowerCase().indexOf(): lowercasing can change a string's length, and then every
// offset after that character points at the wrong place.
export function segments(text, query) {
  const s = String(text ?? '');
  if (!query) return [{ text: s, hit: false }];
  const out = [];
  let at = 0;
  for (const m of s.matchAll(new RegExp(reEsc(query), 'gi'))) {
    if (m.index > at) out.push({ text: s.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < s.length || !out.length) out.push({ text: s.slice(at), hit: false });
  return out;
}

export const step = (i, n, dir) => (n ? ((i + dir) % n + n) % n : 0);

export function countLabel(i, n, query) {
  if (!query) return '';
  return n ? `${i + 1} of ${n}` : 'no matches';
}

// While find is open the pane holds the WHOLE conversation, and the live refresh still
// brings only the opening ask and the newest turns. Fold those into the whole: a turn
// already there is replaced in place (it may have grown), a new one goes on the end,
// and the gap marker stays out. Codex turns can have no id, so those are matched by
// role, time and the start of their text.
const keyOf = (m) => m.uuid || `${m.role}|${m.at}|${(m.text || '').slice(0, 40)}`;
export function mergeTail(whole, recent) {
  const out = whole.slice();
  const at = new Map(out.map((m, i) => [keyOf(m), i]));
  for (const m of recent || []) {
    if (m.role === 'gap') continue;
    const k = keyOf(m);
    if (at.has(k)) out[at.get(k)] = m;
    else { at.set(k, out.length); out.push(m); }
  }
  return out;
}

export function clearMarks(root) {
  const old = root.querySelectorAll('mark.find-hit');
  for (const m of old) m.replaceWith(root.ownerDocument.createTextNode(m.textContent));
  if (old.length) root.normalize();
}

// Wrap every match under `root` in a <mark> and return them in document order. `skip`
// is a selector for what is not conversation: the live terminal is patched row by row
// from a stream, and a mark planted in it is gone on the next frame.
export function markAll(root, query, skip = null) {
  clearMarks(root);
  if (!query) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4);          // NodeFilter.SHOW_TEXT
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const node of nodes) {
    if (skip && node.parentElement?.closest(skip)) continue;
    const parts = segments(node.nodeValue, query);
    if (!parts.some(p => p.hit)) continue;
    const frag = doc.createDocumentFragment();
    for (const p of parts) {
      if (!p.hit) { frag.append(p.text); continue; }
      const mark = doc.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = p.text;
      marks.push(mark);
      frag.append(mark);
    }
    node.replaceWith(frag);
  }
  return marks;
}
