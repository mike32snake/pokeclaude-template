// Search a repo's past sessions from the PC. Each transcript is read once and its
// conversation kept in memory until the file changes, so a keystroke only scans text
// that is already here. `warm` fills the index in the background when the PC opens,
// yielding between files so the server keeps answering.

const SEP = '\u0001';                                  // between turns, never typed

export const searchTerms = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);

// `list` stats the repo's sessions; `describe` reads one for its title and count, and
// `read` for what was said, as a list of strings. Both happen once per file version.
export function makeSessionIndex({ list, read, describe = (r) => r, listTtl = 2000 }) {
  const docs = new Map();                              // path -> { mtime, row, text, hay }
  const warming = new Map();                           // rawDir -> promise
  // Each keystroke is a search; the repo's file listing is reused for a moment rather
  // than stat-ing every transcript again.
  const listed = new Map();                            // rawDir -> { at, rows }
  const listOf = (rawDir) => {
    const hit = listed.get(rawDir);
    if (hit && Date.now() - hit.at < listTtl) return hit.rows;
    const rows = list(rawDir);
    listed.set(rawDir, { at: Date.now(), rows });
    return rows;
  };

  function doc(row) {
    const hit = docs.get(row.path);
    if (hit && hit.mtime === row.mtime) return hit;
    let text = '', full = row;
    try { full = describe(row); } catch {}
    try { text = (read(row.path) || []).map(t => typeof t === 'string' ? t : t.text || '').filter(Boolean).join(SEP); } catch {}
    const out = { mtime: row.mtime, row: full, text, hay: text.toLowerCase() };
    docs.set(row.path, out);
    return out;
  }

  // A cold repo is read by warm(), which yields between files, so a first search in a
  // big repo waits for it without stopping the server from answering anything else.
  async function search(rawDir, q, { limit = 50 } = {}) {
    const terms = searchTerms(q);
    if (!terms.length) return { results: [], total: 0 };
    await warm(rawDir);
    const hits = [];
    for (const r of listOf(rawDir)) {
      const d = doc(r), row = d.row;
      const title = String(row.title || '').toLowerCase();
      const titleHit = terms.every(t => title.includes(t));
      if (!titleHit && !terms.every(t => title.includes(t) || d.hay.includes(t))) continue;
      hits.push({ row, d, titleHit });
    }
    hits.sort((a, b) => (b.titleHit - a.titleHit) || (b.row.mtime - a.row.mtime));
    return {
      total: hits.length,
      results: hits.slice(0, limit).map(h => ({ ...h.row, titleHit: h.titleHit, snippet: snippet(h.d, terms) })),
    };
  }

  // Yields only after a file it had to read, so a warm index costs one pass of stats.
  function warm(rawDir) {
    if (warming.has(rawDir)) return warming.get(rawDir);
    const p = (async () => {
      const tick = () => new Promise(r => setImmediate(r));
      await tick();                                    // let the PC's own reply go first
      for (const row of listOf(rawDir)) {
        if (docs.get(row.path)?.mtime === row.mtime) continue;
        doc(row);
        await tick();
      }
    })().finally(() => warming.delete(rawDir));
    warming.set(rawDir, p);
    return p;
  }

  return { search, warm };
}

// Cut around the newest place the first term was said, inside the turn that said it.
// A title hit with no word in the conversation shows the opening ask instead.
function snippet(d, terms, span = 140) {
  const i = d.hay.lastIndexOf(terms[0]);
  if (i < 0) return d.text.split(SEP, 1)[0].slice(0, span).replace(/\s+/g, ' ');
  const from = d.hay.lastIndexOf(SEP, i) + 1;
  const to = d.hay.indexOf(SEP, i);
  const turn = d.text.slice(from, to < 0 ? undefined : to);
  const at = i - from, start = Math.max(0, at - Math.floor(span / 3));
  return ((start > 0 ? '…' : '') + turn.slice(start, start + span) + (start + span < turn.length ? '…' : ''))
    .replace(/\s+/g, ' ');
}
