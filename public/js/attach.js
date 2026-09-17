// Files staged for one message. Attachments are uploaded to disk and sent to the
// agent as absolute PATHS, because a path is what Claude Code can actually open.
//
// There are two staging trays: the composer, and the NEW AGENT form. They must build
// the message body the same way, so the body lives here and not in either view. A
// tray only ever holds uploads the server accepted; an upload without a path would
// become a path the agent cannot read.
export function makeAttachments({ store = null, key = null } = {}) {
  let files = [];
  const storageKey = key ? `pc.attachments:${key}` : null;
  try {
    const saved = storageKey ? JSON.parse(store?.getItem(storageKey) || '[]') : [];
    if (Array.isArray(saved)) files = saved.filter(f => typeof f?.path === 'string' && f.path.startsWith('/'))
      .map(f => ({ path: f.path, name: typeof f.name === 'string' ? f.name : f.path, preview: null }));
  } catch { /* An unavailable store must not break the composer. */ }
  const persist = () => {
    if (!storageKey || !store) return;
    try {
      if (!files.length) store.removeItem(storageKey);
      else store.setItem(storageKey, JSON.stringify(files.map(({ path, name }) => ({ path, name }))));
    } catch { /* Keep the in-memory tray usable if storage is full or disabled. */ }
  };
  return {
    add(f) {
      if (!f || !f.path) return false;
      files.push({ path: f.path, name: f.name || f.path, preview: f.preview || null });
      persist();
      return true;
    },
    remove(i) {
      if (!Number.isInteger(i) || i < 0 || i >= files.length) return;
      files.splice(i, 1);
      persist();
    },
    clear() { files = []; persist(); },
    list: () => files.slice(),
    count: () => files.length,
    empty: () => files.length === 0,
    // Paths first: the agent sees the file before the instruction about it. Blank
    // text is nothing typed, so it must not leave a trailing empty line behind.
    compose(text) {
      const t = String(text ?? '').trim() ? String(text) : '';
      if (!files.length) return t;
      return files.map(f => f.path).join('\n') + (t ? '\n' + t : '');
    },
  };
}

// What a drop actually carried. `dataTransfer.files` is empty for a macOS PROMISE
// drag: the screenshot thumbnail in the corner of the screen, an image dragged out of
// another app. `types` still says Files, so the drop zone lights up and the drop then
// staged nothing at all, silently. `items` is where the promised file lives, so it is
// the fallback rather than a second code path.
export function filesFromDrop(dt) {
  const direct = [...(dt?.files || [])].filter(Boolean);
  if (direct.length) return direct;
  return [...(dt?.items || [])]
    .filter(i => i?.kind === 'file')
    .map(i => i.getAsFile?.())
    .filter(Boolean);
}

// The filename rides in a request header, and a header can only carry ISO-8859-1.
// macOS names every screenshot with a NARROW NO-BREAK SPACE (U+202F) before AM/PM, so
// `fetch` threw on the header before the request was sent: every screenshot failed to
// attach, every ASCII-named file worked, and the failure looked random. Percent-
// encoding makes any name safe to carry; the server decodes it.
export function uploadHeaderName(name) {
  return encodeURIComponent(String(name || '') || 'paste.png');
}
