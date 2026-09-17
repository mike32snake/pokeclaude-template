// Attachments are staged in two places now: the composer, and the NEW AGENT form.
// Both send the same thing to the same terminal, so the staging and the body they
// build live in one module. A file that is staged but not put in the body is a file
// the agent never sees, which is the whole bug this guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAttachments, filesFromDrop, uploadHeaderName } from '../public/js/attach.js';

test('files are listed in the order they were staged', () => {
  const a = makeAttachments();
  a.add({ path: '/uploads/one.png', name: 'one.png' });
  a.add({ path: '/uploads/two.pdf', name: 'two.pdf' });
  assert.deepEqual(a.list().map(x => x.name), ['one.png', 'two.pdf']);
  assert.equal(a.count(), 2);
});

test('paths go first, so the agent sees the file before the instruction about it', () => {
  const a = makeAttachments();
  a.add({ path: '/uploads/shot.png', name: 'shot.png' });
  assert.equal(a.compose('fix this layout'), '/uploads/shot.png\nfix this layout');
});

test('every staged path is on its own line, in order', () => {
  const a = makeAttachments();
  a.add({ path: '/uploads/a.png', name: 'a.png' });
  a.add({ path: '/uploads/b.png', name: 'b.png' });
  assert.equal(a.compose('compare them'), '/uploads/a.png\n/uploads/b.png\ncompare them');
});

test('an attachment with no text sends just the path, never a trailing blank line', () => {
  const a = makeAttachments();
  a.add({ path: '/uploads/only.png', name: 'only.png' });
  assert.equal(a.compose(''), '/uploads/only.png');
  assert.equal(a.compose('   '), '/uploads/only.png');
});

test('text with nothing staged is sent exactly as typed', () => {
  const a = makeAttachments();
  assert.equal(a.compose('just a message'), 'just a message');
  // Indentation inside a real message is the user's, and is kept.
  assert.equal(a.compose('line one\n  indented'), 'line one\n  indented');
});

test('nothing typed and nothing staged composes to nothing, so there is nothing to send', () => {
  const a = makeAttachments();
  assert.equal(a.compose(''), '');
  assert.equal(a.empty(), true);
  a.add({ path: '/uploads/x.png', name: 'x.png' });
  assert.equal(a.empty(), false);
});

test('removing a chip drops that file and keeps the rest in order', () => {
  const a = makeAttachments();
  a.add({ path: '/1', name: 'a' });
  a.add({ path: '/2', name: 'b' });
  a.add({ path: '/3', name: 'c' });
  a.remove(1);
  assert.deepEqual(a.list().map(x => x.name), ['a', 'c']);
});

test('removing an index that is not there changes nothing', () => {
  const a = makeAttachments();
  a.add({ path: '/1', name: 'a' });
  a.remove(7);
  a.remove(-1);
  a.remove(null);
  assert.equal(a.count(), 1);
});

test('clearing after a send leaves nothing staged for the next message', () => {
  const a = makeAttachments();
  a.add({ path: '/1', name: 'a' });
  a.clear();
  assert.equal(a.count(), 0);
  assert.equal(a.compose('next message'), 'next message');
});

test('the composer and the new-agent form stage into separate trays', () => {
  const composer = makeAttachments();
  const spawn = makeAttachments();
  composer.add({ path: '/chat.png', name: 'chat.png' });
  assert.equal(spawn.count(), 0);
  assert.equal(spawn.compose('launch it'), 'launch it');
});

test('a file the server rejected is never staged, so no path is invented', () => {
  const a = makeAttachments();
  a.add({ error: 'empty upload' });
  a.add({ name: 'no-path.png' });
  a.add(null);
  assert.equal(a.count(), 0);
});

// A drop that turns the panel blue and then does nothing is the worst kind of bug:
// the UI promised it took the file. macOS hands over a PROMISE for drags that did not
// start in Finder (the screenshot thumbnail, images dragged out of another app):
// `types` says Files, so the drop zone lights up, but `files` is empty and the file
// is only reachable through `items`.
test('a plain Finder drag comes through files', () => {
  const dt = { types: ['Files'], files: [{ name: 'shot.png' }], items: [] };
  assert.deepEqual(filesFromDrop(dt).map(f => f.name), ['shot.png']);
});

test('a promise drag with an empty file list is read off items instead', () => {
  const png = { name: 'thumb.png' };
  const dt = { types: ['Files'], files: [],
    items: [{ kind: 'file', getAsFile: () => png }, { kind: 'string', getAsFile: () => null }] };
  assert.deepEqual(filesFromDrop(dt), [png]);
});

test('an item that promises a file and then hands over nothing is dropped, not staged', () => {
  const dt = { types: ['Files'], files: [], items: [{ kind: 'file', getAsFile: () => null }] };
  assert.deepEqual(filesFromDrop(dt), []);
});

test('a drag with no file in it at all comes back empty, so the caller can say so', () => {
  assert.deepEqual(filesFromDrop({ types: ['text/uri-list'], files: [], items: [] }), []);
  assert.deepEqual(filesFromDrop(null), []);
  assert.deepEqual(filesFromDrop({}), []);
});

// The filename travels in a header, and a header can only carry ISO-8859-1. macOS
// names every screenshot with a NARROW NO-BREAK SPACE (U+202F) before AM/PM, so
// `fetch` threw before the request was ever sent and every screenshot failed to
// attach while ordinary ASCII names went through. Percent-encoding is what makes the
// name header-safe; the server decodes it back.
test('a macOS screenshot name survives the trip to the server', () => {
  const mac = 'Screenshot 2026-08-22 at 6.50.47 PM.png';
  const header = uploadHeaderName(mac);
  assert.ok(!/[^\x00-\xFF]/.test(header), 'a header value cannot hold a non-Latin-1 character');
  assert.equal(decodeURIComponent(header), mac, 'and it has to come back as what it was');
});

test('emoji and accents in a name are carried, not dropped', () => {
  for (const n of ['ünïcödé.png', '🔥 hot take.png', 'Bildschirmfoto 2026-08-22 um 18.50.47.png']) {
    const h = uploadHeaderName(n);
    assert.ok(!/[^\x00-\xFF]/.test(h), n);
    assert.equal(decodeURIComponent(h), n);
  }
});

test('a nameless paste still gets a name', () => {
  assert.equal(decodeURIComponent(uploadHeaderName('')), 'paste.png');
  assert.equal(decodeURIComponent(uploadHeaderName(null)), 'paste.png');
});

test('accepted attachments survive reload without persisting temporary blob URLs', () => {
  const data = new Map();
  const store = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  const first = makeAttachments({ store, key: 'workspace:a' });
  first.add({ path: '/uploads/one.png', name: 'one.png', preview: 'blob:temporary' });
  const reloaded = makeAttachments({ store, key: 'workspace:a' });
  assert.equal(reloaded.compose('inspect'), '/uploads/one.png\ninspect');
  assert.equal(reloaded.list()[0].preview, null);
  assert.equal(makeAttachments({ store, key: 'workspace:b' }).count(), 0);
  reloaded.clear();
  assert.equal(makeAttachments({ store, key: 'workspace:a' }).count(), 0);
});
test('malformed stored attachments do not break the composer', () => {
  const store = { getItem: () => '{invalid' };
  assert.equal(makeAttachments({ store, key: 'w' }).count(), 0);
});
