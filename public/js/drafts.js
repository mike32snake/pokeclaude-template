// Unsent text, kept per agent. The composer is one box for the whole app, so without
// this, clicking another Pokemon threw away whatever you had half-typed at the first
// one. Keyed by workspaceId ('ash' for the front desk), written through to storage so
// a reload does not lose it either.
const KEY = 'pc.drafts';

export function makeDrafts(store) {
  const map = new Map();
  try {
    const raw = JSON.parse(store?.getItem(KEY) || '{}');
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') map.set(k, v);
  } catch { /* a corrupt blob is not worth a broken composer */ }

  const flush = () => {
    try { store?.setItem(KEY, JSON.stringify(Object.fromEntries(map))); } catch {}
  };
  return {
    get: (key) => (key && map.get(key)) || '',
    // Blank is "nothing typed": storing it would keep an empty draft alive forever.
    set(key, text) {
      if (!key) return;
      if (String(text).trim()) map.set(key, text); else map.delete(key);
      flush();
    },
    clear(key) { if (key && map.delete(key)) flush(); },
    count: () => map.size,
  };
}
