import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoster, rosterEntries } from '../src/server/roster.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const row = (sessionId, extra = {}) => ({ sessionId, engine: 'claude', dir: '/tmp/repo', title: 'task ' + sessionId.slice(0, 1), status: 'WORKING', ...extra });

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  return { file: path.join(dir, 'roster.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('sessions running before a cmux crash are offered after the restart', () => {
  const t = tmp();
  try {
    let r = createRoster(t.file);
    r.observe([row(A), row(B)], { fresh: true });
    assert.deepEqual(r.lost(), []);
    // cmux died and took the server with it. The restart finds neither session running.
    r = createRoster(t.file);
    r.observe([], { fresh: true });
    assert.deepEqual(r.lost().map(x => x.sessionId).sort(), [A, B]);
    assert.equal(r.lost()[0].dir, '/tmp/repo');
    assert.equal(r.lost()[0].engine, 'claude');
  } finally { t.done(); }
});

test('a plain server restart offers nothing, because the agents are still running', () => {
  const t = tmp();
  try {
    createRoster(t.file).observe([row(A)], { fresh: true });
    const r = createRoster(t.file);
    r.observe([row(A)], { fresh: true });
    assert.deepEqual(r.lost(), []);
  } finally { t.done(); }
});

test('a tab closed while the server watches is a choice, not a crash', () => {
  const t = tmp();
  try {
    const r = createRoster(t.file);
    r.observe([row(A), row(B)], { fresh: true });
    r.observe([row(A)], { fresh: false });
    assert.deepEqual(r.lost(), []);
    // Nor does it come back after a later crash.
    const after = createRoster(t.file);
    after.observe([], { fresh: true });
    assert.deepEqual(after.lost().map(x => x.sessionId), [A]);
  } finally { t.done(); }
});

test('a session that comes back by itself leaves the list', () => {
  const t = tmp();
  try {
    const r = createRoster(t.file);
    r.observe([row(A), row(B)], { fresh: true });
    r.observe([], { fresh: true });
    r.observe([row(B)], { fresh: false });
    assert.deepEqual(r.lost().map(x => x.sessionId), [A]);
  } finally { t.done(); }
});

test('take hands each lost session out once, so two clicks cannot resume it twice', () => {
  const t = tmp();
  try {
    const r = createRoster(t.file);
    r.observe([row(A), row(B), row(C)], { fresh: true });
    r.observe([], { fresh: true });
    assert.deepEqual(r.take([A, C, 'not-a-session']).map(x => x.sessionId).sort(), [A, C]);
    assert.deepEqual(r.take([A]), []);
    assert.deepEqual(r.lost().map(x => x.sessionId), [B]);
    // Taken is persisted: a restart does not bring them back.
    assert.deepEqual(createRoster(t.file).lost().map(x => x.sessionId), [B]);
  } finally { t.done(); }
});

test('dismiss drops sessions from the list for good', () => {
  const t = tmp();
  try {
    const r = createRoster(t.file);
    r.observe([row(A), row(B)], { fresh: true });
    r.observe([], { fresh: true });
    r.dismiss([A, B]);
    assert.deepEqual(r.lost(), []);
    assert.deepEqual(createRoster(t.file).lost(), []);
  } finally { t.done(); }
});

test('lost sessions expire after a week', () => {
  const t = tmp();
  try {
    let now = 1_000_000;
    const r = createRoster(t.file, { now: () => now });
    r.observe([row(A)], { fresh: true });
    r.observe([], { fresh: true });
    now += 8 * 24 * 3600_000;
    r.observe([], { fresh: false });
    assert.deepEqual(r.lost(), []);
  } finally { t.done(); }
});

test('observe says when the lost list changed, so the server broadcasts only then', () => {
  const t = tmp();
  try {
    const r = createRoster(t.file);
    assert.equal(r.observe([row(A)], { fresh: true }), false);
    assert.equal(r.observe([row(A)], { fresh: false }), false);
    assert.equal(r.observe([], { fresh: true }), true);
    assert.equal(r.observe([], { fresh: false }), false);
    assert.equal(r.observe([row(A)], { fresh: false }), true);
  } finally { t.done(); }
});

test('the newest title and status win, and the list is by repo, oldest session first', () => {
  const t = tmp();
  try {
    let now = 1_000_000;
    const r = createRoster(t.file, { now: () => now });
    r.observe([row(C, { dir: '/tmp/b' })], { fresh: true });
    now += 1000;
    r.observe([row(C, { dir: '/tmp/b' }), row(A, { dir: '/tmp/b' })], { fresh: false });
    now += 1000;
    r.observe([row(C, { dir: '/tmp/b' }), row(A, { dir: '/tmp/b', title: 'renamed', status: 'BLOCKED' }),
      row(B, { dir: '/tmp/a' })], { fresh: false });
    r.observe([], { fresh: true });
    const lost = r.lost();
    assert.deepEqual(lost.map(x => x.sessionId), [B, C, A]);
    assert.equal(lost[2].title, 'renamed');
    assert.equal(lost[2].status, 'BLOCKED');
  } finally { t.done(); }
});

test('a corrupt roster file starts empty instead of stopping the server', () => {
  const t = tmp();
  try {
    fs.writeFileSync(t.file, '{not json');
    const r = createRoster(t.file);
    assert.deepEqual(r.lost(), []);
    r.observe([row(A)], { fresh: true });
    assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).running[A].sessionId, A);
  } finally { t.done(); }
});

test('rosterEntries keeps only agents tied to a session by their process', () => {
  const agents = [
    { workspaceId: 'w1', procSessionId: A, rawDir: '/r', title: 'claude pen', status: 'WORKING' },
    { workspaceId: 'w2', engine: 'codex', codexSessionId: B, rawDir: '/r', title: 'codex pen', status: 'ASLEEP' },
    // A hook link alone may be stale after a restart; it is not proof the session is running.
    { workspaceId: 'w3', sessionId: C, rawDir: '/r', title: 'hook only', status: 'ASLEEP' },
    { workspaceId: 'w4', kind: 'service', procSessionId: C, rawDir: '/r', status: 'SERVING' },
    { workspaceId: 'w5', hollow: true, procSessionId: C, rawDir: '/r' },
    { workspaceId: 'w6', status: 'FAINTED', procSessionId: C, rawDir: '/r' },
  ];
  assert.deepEqual(rosterEntries(agents), [
    { sessionId: A, engine: 'claude', dir: '/r', title: 'claude pen', status: 'WORKING' },
    { sessionId: B, engine: 'codex', dir: '/r', title: 'codex pen', status: 'ASLEEP' },
  ]);
});

test('a session whose resume failed goes back on the list', () => {
  const t = tmp();
  try {
    const r = createRoster(t.file);
    r.observe([row(A), row(B)], { fresh: true });
    r.observe([], { fresh: true });
    const [taken] = r.take([A]);
    r.giveBack([taken]);
    assert.deepEqual(r.lost().map(x => x.sessionId), [A, B]);
    assert.deepEqual(createRoster(t.file).lost().map(x => x.sessionId), [A, B]);
  } finally { t.done(); }
});

test('the conversation title beats the cmux tab name, which is usually "new agent"', () => {
  const agents = [
    { procSessionId: A, rawDir: '/r', title: '◑ new agent', sessionTitle: 'Fix the restore checklist', status: 'WORKING' },
    { procSessionId: B, rawDir: '/r', title: '◑ resume', status: 'ASLEEP' },
  ];
  assert.deepEqual(rosterEntries(agents).map(e => e.title), ['Fix the restore checklist', '◑ resume']);
});
