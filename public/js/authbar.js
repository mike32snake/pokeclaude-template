// The auth strip along the bottom of the field: one chip per login on this machine,
// grouped by tool, coloured by whether it still works. Pure functions here so a test
// can read the strip; the DOM is mounted in main.js.

const GROUPS = [
  ['google', 'Google'], ['github', 'GitHub'], ['gcloud', 'gcloud'],
  ['slack', 'Slack'], ['claude', 'Claude'],
];

const cls = (ok) => ok === true ? 'ok' : ok === false ? 'bad' : 'unknown';

// `compact` is for a narrow field: two or more healthy logins in a group fold into
// one "N ok" chip (their names in its tooltip), and every red or grey one stays named,
// because a lapsed login is the thing the strip exists to name.
export function authChips(auth, { compact = false } = {}) {
  const rows = auth?.rows || [];
  const out = [];
  for (const [key, label] of GROUPS) {
    const mine = rows.filter(r => r.group === key);
    if (!mine.length) continue;
    // One chip whose name already says which tool it is needs no label in front.
    const solo = mine.length === 1 && mine[0].name.toLowerCase().startsWith(label.toLowerCase());
    const good = mine.filter(r => r.ok === true);
    const folded = compact && good.length >= 2
      ? [{ id: null, label: `${good.length} ok`, cls: 'ok', fixable: false,
           title: `${label} · ${good.length} logins ok:\n${good.map(r => r.name).join(', ')}` }]
      : null;
    const shown = folded ? mine.filter(r => r.ok !== true) : mine;
    out.push({ key, label, solo, chips: [...(folded || []), ...shown.map(r => {
      const facts = [];
      if (r.isDefault) facts.push('default');
      if (r.active) facts.push('active');
      const title = [`${label} · ${r.name}` + (facts.length ? ` (${facts.join(', ')})` : ''),
                     r.note || '',
                     r.ok === false && r.fix ? `click to run: ${r.fix}` : '',
                     r.ok === false && !r.fix ? 'no CLI for this one: update the token file' : '']
        .filter(Boolean).join('\n');
      return { id: r.id, label: r.name, cls: cls(r.ok), title, fixable: r.ok === false && !!r.fix };
    })] });
  }
  return out;
}

const ago = (at, now) => {
  const m = Math.round((now - at) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};

export function authHeadline(auth, now = Date.now()) {
  if (!auth?.rows) return 'checking logins…';
  let ok = 0, bad = 0, unknown = 0;
  for (const r of auth.rows) { if (r.ok === true) ok++; else if (r.ok === false) bad++; else unknown++; }
  const when = ago(auth.at, now);
  if (bad) return `${bad} need${bad === 1 ? 's' : ''} sign-in · ${when}`;
  if (unknown) return `${ok} ok · ${unknown} unknown · ${when}`;
  return `${ok} login${ok === 1 ? '' : 's'} ok · ${when}`;
}

// Mount the strip into `el`. `onFix(id)` runs when a red chip is clicked; `onRefresh`
// when the headline is. Re-render with the returned function on every state tick.
export function mountAuthBar(el, { onFix, onRefresh } = {}) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const opening = new Set();
  const ONE_ROW = 30;      // px: 22 of strip plus its padding and border
  return function render(auth, now = Date.now()) {
    paint(auth, now, false);
    // Full names first; if that needs a second row, fold the healthy ones.
    if (el.getBoundingClientRect().height > ONE_ROW) paint(auth, now, true);
  };
  function paint(auth, now, compact) {
    const groups = authChips(auth, { compact });
    const bad = (auth?.rows || []).some(r => r.ok === false);
    el.classList.toggle('bad', bad);
    el.innerHTML =
      `<span class="ab-head" title="Click to check again">${esc(authHeadline(auth, now))}</span>` +
      groups.map(g => `<span class="ab-group">${g.solo ? '' : `<span class="ab-lbl">${esc(g.label)}</span>`}` +
        g.chips.map(c => `<${c.fixable ? 'button type="button"' : 'span'} class="ab-chip ${c.cls}${c.fixable ? ' fix' : ''}" data-id="${esc(c.id)}"` +
          ` title="${esc(c.title)}"${opening.has(c.id) ? ' disabled' : ''}><i></i>${opening.has(c.id) ? 'opening…' : esc(c.label)}</${c.fixable ? 'button' : 'span'}>`).join('') + '</span>').join('');
    el.querySelector('.ab-head').onclick = () => onRefresh?.();
    el.querySelectorAll('.ab-chip.fix').forEach(c => { c.onclick = async () => {
      const id = c.dataset.id;
      if (opening.has(id)) return;
      opening.add(id); c.disabled = true;
      try { await onFix?.(id); } finally { opening.delete(id); paint(auth, Date.now(), compact); }
    }; });
  }
}
