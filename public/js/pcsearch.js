// The PC search box. Titles already on screen filter at once, before the server has
// searched the conversations, and the words that matched are marked in the results.

const termsOf = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function titleMatches(rows, q) {
  const terms = termsOf(q);
  return rows.filter(r => {
    const t = String(r.title || '').toLowerCase();
    return terms.every(term => t.includes(term));
  });
}

// Mark on the raw text, then escape each piece. Escaping first and matching after
// would let a term like "amp" match inside "&amp;" and split the entity.
export function highlight(text, q) {
  const s = String(text || '');
  const terms = termsOf(q);
  const low = s.toLowerCase();
  const hit = new Uint8Array(s.length);
  for (const t of terms) {
    for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) hit.fill(1, i, i + t.length);
  }
  let out = '', i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && hit[j] === hit[i]) j++;
    out += hit[i] ? `<mark>${esc(s.slice(i, j))}</mark>` : esc(s.slice(i, j));
    i = j;
  }
  return out;
}
