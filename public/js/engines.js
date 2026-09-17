// The engine/model choice in the NEW AGENT form, as pure functions.
//
// The catalog comes from the server (/api/engines) and the last choice comes from
// localStorage, so the two can disagree: Codex publishes a new model list and drops
// the one chosen last week. A stale name is not a harmless default - the server
// refuses anything outside the catalog and the pen never opens - so every remembered
// pair is resolved against the catalog before it reaches a <select>.
export const KEY = 'pc.engine';

export const modelsFor = (catalog, engine) => (catalog?.[engine]?.models || []);

export function resolvePick(catalog, saved) {
  const keys = Object.keys(catalog || {});
  if (!keys.length) return { engine: null, model: null, custom: false };
  const engine = keys.includes(saved?.engine) ? saved.engine : keys[0];
  const models = modelsFor(catalog, engine);
  const fallback = catalog[engine].default || models[0]?.id || null;
  if (saved?.engine === engine) {
    // A name typed into OTHER is not in the catalog on purpose, so the staleness rule
    // below would throw it away every time. Only a choice that WAS a list choice is
    // checked against the list.
    if (saved.custom && String(saved.model || '').trim()) {
      return { engine, model: saved.model.trim(), custom: true };
    }
    if (models.some(m => m.id === saved.model)) {
      return { engine, model: saved.model, custom: false };
    }
  }
  return { engine, model: fallback, custom: false };
}

export function remember(pick) {
  try { localStorage.setItem(KEY, JSON.stringify(pick)); } catch {}
}
export function remembered() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
