// Sign naming: never touch a name that fits. Five rules, each fires only while over cap.
const CAP = 16;
const FILLER = new Set(['the', 'and', 'team', 'for', 'with']);
const ABBREV = { marketing: 'Mktg', command: 'Cmd', center: 'Ctr', management: 'Mgmt',
  assessment: 'Assess', development: 'Dev', infrastructure: 'Infra', application: 'App' };

function words(name) { return name.split(/[\s\-_&/]+/).filter(Boolean); }

export function signNames(folderNames, cap = CAP) {
  const tokenLists = folderNames.map(words);
  const freq = new Map();
  for (const ts of tokenLists) for (const t of new Set(ts.map(w => w.toLowerCase())))
    freq.set(t, (freq.get(t) || 0) + 1);
  const shared = t => (freq.get(t.toLowerCase()) || 0) >= 2;

  return tokenLists.map(ts => {
    let keep = [...ts];
    let s = keep.join(' ');
    if (s.length > cap && keep.length > 1 && shared(keep[0])) { keep = keep.slice(1); s = keep.join(' '); }
    if (s.length > cap) { const k = keep.filter(t => !FILLER.has(t.toLowerCase())); if (k.length) { keep = k; s = keep.join(' '); } }
    if (s.length > cap && keep.length > 1 && shared(keep[0])) { keep = keep.slice(1); s = keep.join(' '); }
    if (s.length > cap) { keep = keep.map(t => ABBREV[t.toLowerCase()] || t); s = keep.join(' '); }
    if (s.length > cap) {
      const acc = [];
      for (const t of keep) { if ([...acc, t].join(' ').length <= cap - 1) acc.push(t); else break; }
      s = acc.length ? acc.join(' ') + '…' : keep[0].slice(0, cap - 1) + '…';
    }
    return s;
  });
}
