// Search in the PC. A repo can hold hundreds of past sessions and a hundred MB of
// transcript, so the index reads each file once and keeps what it found until the
// file changes. A search then only scans text already in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSessionIndex, searchTerms } from '../src/server/sessionindex.js';

const turns = (...texts) => texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text }));

function fixture() {
  const files = {
    a: { row: { path: 'a', sessionId: 'a', mtime: 30, title: 'Fix the login bug' },
         turns: turns('the login page throws', 'fixed the token refresh') },
    b: { row: { path: 'b', sessionId: 'b', mtime: 20, title: 'Banner drafts' },
         turns: turns('make a banner for the booth', 'the login link is on it') },
    c: { row: { path: 'c', sessionId: 'c', mtime: 10, title: 'Pricing sheet' },
         turns: turns('update the pricing', 'done') },
  };
  const reads = [];
  const index = makeSessionIndex({
    list: () => Object.values(files).map(f => ({ ...f.row })),
    read: (p) => { reads.push(p); return files[p].turns; },
    listTtl: 0,
  });
  return { files, reads, index };
}

test('a query is split into lower-case terms', () => {
  assert.deepEqual(searchTerms('  Login   BUG '), ['login', 'bug']);
  assert.deepEqual(searchTerms(''), []);
});

test('every term must appear in the title or the conversation', async () => {
  const { index } = fixture();
  assert.deepEqual((await index.search('/r', 'login')).results.map(r => r.path), ['a', 'b']);
  assert.deepEqual((await index.search('/r', 'login banner')).results.map(r => r.path), ['b']);
  assert.deepEqual((await index.search('/r', 'nothing here')).results, []);
});

test('a title hit ranks above a newer session that only mentions the words', async () => {
  const { files, index } = fixture();
  files.b.row.mtime = 99;
  assert.deepEqual((await index.search('/r', 'login')).results.map(r => r.path), ['a', 'b']);
});

test('a hit carries a snippet from the turn that matched', async () => {
  const { index } = fixture();
  const b = (await index.search('/r', 'login')).results.find(r => r.path === 'b');
  assert.match(b.snippet, /login link/);
  assert.equal(b.titleHit, false);
});

test('a file is read once and read again only after it changes', async () => {
  const { files, reads, index } = fixture();
  await index.search('/r', 'login');
  await index.search('/r', 'pricing');
  assert.deepEqual(reads.sort(), ['a', 'b', 'c']);
  files.c.row.mtime = 11;
  files.c.turns = turns('the pricing moved to login');
  assert.deepEqual((await index.search('/r', 'login')).results.map(r => r.path), ['a', 'b', 'c']);
  assert.deepEqual(reads.filter(p => p === 'c'), ['c', 'c']);
});

test('results stop at the limit and report how many matched', async () => {
  const { index } = fixture();
  const r = await index.search('/r', 'the', { limit: 1 });
  assert.equal(r.results.length, 1);
  assert.equal(r.total, 3);
});

test('warm reads every file ahead of the first search, without blocking', async () => {
  const { reads, index } = fixture();
  await index.warm('/r');
  assert.deepEqual(reads.sort(), ['a', 'b', 'c']);
  await index.search('/r', 'login');
  assert.equal(reads.length, 3);
});

test('a search in a cold repo waits for the warm-up and lets other work run', async () => {
  const { index } = fixture();
  let ran = false;
  setImmediate(() => { ran = true; });
  const r = await index.search('/r', 'login');
  assert.equal(r.total, 2);
  assert.ok(ran, 'the search yielded while it read the files');
});

test('a row is described once, when the index first reads it', async () => {
  const described = [];
  const index = makeSessionIndex({
    list: () => [{ path: 'a', mtime: 1 }],
    describe: (r) => { described.push(r.path); return { ...r, title: 'Deploy the site', msgs: 4 }; },
    read: () => turns('ship it'),
  });
  const r = await index.search('/r', 'deploy');
  assert.equal(r.results[0].title, 'Deploy the site');
  assert.equal(r.results[0].msgs, 4);
  await index.search('/r', 'ship');
  assert.deepEqual(described, ['a']);
});

test('the file listing is reused between quick keystrokes', async () => {
  let lists = 0;
  const index = makeSessionIndex({
    list: () => { lists++; return [{ path: 'a', mtime: 1, title: 'x' }]; },
    read: () => turns('hello there'),
  });
  await index.search('/r', 'h');
  await index.search('/r', 'he');
  await index.search('/r', 'hel');
  assert.equal(lists, 1);
});

test('a title hit with no word in the conversation shows the opening ask', async () => {
  const index = makeSessionIndex({
    list: () => [{ path: 'a', mtime: 1, title: 'Pricing sheet' }],
    read: () => turns('update the numbers', 'done'),
  });
  assert.equal((await index.search('/r', 'pricing')).results[0].snippet, 'update the numbers');
});
