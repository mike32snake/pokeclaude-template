// A small markdown renderer for the chat thread. Zero dependencies on purpose.
// Escapes first, then transforms, so nothing in a transcript can inject markup.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Inline: code, bold, italic, strikethrough, links. Code spans are pulled out first
// so their contents are never treated as emphasis.
function inline(text) {
  const tokens = [];
  const stash = (html, literal = '') => {
    tokens.push({ html, literal });
    return '\u0000' + (tokens.length - 1) + '\u0000';
  };
  // Reserve the placeholder delimiter so transcript text cannot forge a token.
  let s = esc(text).replace(/\u0000/g, '&#0;').replace(/`([^`]+)`/g, (_, c) => {
    return stash('<code>' + c + '</code>', '`' + c + '`');
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, href) => {
      // Formatting is for the label only. A code span inside a URL stays literal;
      // generated HTML must never be restored inside an attribute.
      href = href.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)].literal);
      // A URL written as the label is already a link; hide its scheme from the bare pass.
      label = label.replace(/https?:\/\//g, (m) => stash(m, m));
      return stash('<a href="' + href + '" target="_blank" rel="noreferrer">') +
        label + stash('</a>');
    });
  // Bare URLs, which is how most replies write them. Stashed before emphasis so an
  // underscore in a path is not read as italics. Trailing punctuation and emphasis
  // marks stay outside the link, and an escaped < or > ends it.
  s = s.replace(/https?:\/\/(?:(?!&[lg]t;)[^\s\u0000])+/g, (url) => {
    const tail = url.match(/(?:[.,;:!?)\]*_~']|&quot;)+$/)?.[0] || '';
    const href = url.slice(0, url.length - tail.length);
    return stash('<a href="' + href + '" target="_blank" rel="noreferrer">' + href + '</a>') + tail;
  });
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  s = s.replace(/(^|[\s(])([*_])(?=\S)([^*_]*?\S)\2(?=[\s.,;:!?)]|$)/g, '$1<em>$3</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)].html);
}

const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

export function md(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre class="md-code"><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // table: a header row followed by a |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        '<div class="md-tablewrap"><table class="md-table"><thead><tr>' +
        head.map((h) => '<th>' + inline(h) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, c) => '<td>' + inline(r[c] ?? '') + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }

    // heading, rule, quote
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push('<div class="md-h md-h' + h[1].length + '">' + inline(h[2]) + '</div>'); i++; continue; }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push('<blockquote class="md-quote">' + inline(buf.join('\n')) + '</blockquote>');
      continue;
    }

    // lists (one level; nested items flatten rather than disappear)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + ' class="md-list">' +
        items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // paragraph run
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) &&
           !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
           !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
           !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      buf.push(lines[i++]);
    }
    if (buf.length) out.push('<p class="md-p">' + inline(buf.join('\n')) + '</p>');
    else i++;
  }
  return out.join('');
}
