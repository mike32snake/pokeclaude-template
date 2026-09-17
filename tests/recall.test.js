// Pikachu's recall: the local, token-free step that reads the live sessions and the
// archive for whatever bears on a question, before Ash writes the answer.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryTerms, pickTurns, excerpt, recallLive, rankSessions,
         groundingText, dedupeSessions } from '../src/server/recall.js';

const tmp = (name, lines) => {
  const p = path.join(os.tmpdir(), `pc-recall-${process.pid}-${name}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const user = (text, ts) => ({ type: 'user', timestamp: ts, message: { content: text } });
const asst = (text, ts) => ({ type: 'assistant', timestamp: ts,
  message: { content: [{ type: 'text', text }] } });

test('queryTerms keeps the words that carry the question and drops the rest', () => {
  // "agent" is in every question about this field, so it is noise too.
  assert.deepEqual(queryTerms('What is the agent in pokeclaude doing with the Stripe webhook?'),
                   ['pokeclaude', 'stripe', 'webhook']);
  // Punctuation and case do not matter, and a word is counted once.
  assert.deepEqual(queryTerms('Webhook, webhook... WEBHOOK!'), ['webhook']);
  // A question made only of small words still searches for something.
  assert.deepEqual(queryTerms('what did it do'), ['what']);
  assert.deepEqual(queryTerms(''), []);
});

test('excerpt centres on the first term it finds and marks what it cut', () => {
  const text = 'a'.repeat(300) + ' the stripe webhook failed ' + 'b'.repeat(300);
  const e = excerpt(text, ['webhook'], 80);
  assert.ok(e.includes('webhook'));
  assert.ok(e.startsWith('…') && e.endsWith('…'));
  assert.ok(e.length <= 84);
  // No match: the start of the text, so a turn is never shown as empty.
  assert.equal(excerpt('short answer', ['zzz'], 80), 'short answer');
});

test('pickTurns scores by distinct terms and returns the best in order', () => {
  const turns = [
    { role: 'user', text: 'fix the stripe webhook', at: 1 },
    { role: 'assistant', text: 'looking at the webhook now', at: 2 },
    { role: 'assistant', text: 'nothing relevant here', at: 3 },
    { role: 'user', text: 'the stripe webhook signature is wrong', at: 4 },
    { role: 'gap', text: '', at: null },
  ];
  const picked = pickTurns(turns, ['stripe', 'webhook', 'signature'], 2);
  // Two best turns, chronological, each carrying its score.
  assert.deepEqual(picked.map(t => t.at), [1, 4]);
  assert.equal(picked[1].score, 3);
  assert.equal(picked[0].score, 2);
  // Tool-only and gap rows never make it in.
  assert.ok(pickTurns(turns, ['zzz'], 2).length === 0);
  // A user turn the harness wrote (a task notification, a system reminder) is not
  // something the user said, and quoting it as them misleads Ash.
  const noisy = [
    { role: 'user', text: '<task-notification>the webhook job finished</task-notification>', at: 1 },
    { role: 'user', text: 'is the webhook done?', at: 2 },
  ];
  assert.deepEqual(pickTurns(noisy, ['webhook'], 5).map(t => t.at), [2]);
});

test('dedupeSessions keeps one row per transcript, credited to the deepest repo', () => {
  // The scratch repo contains pokeclaude, so listSessions for scratch lists the
  // pokeclaude transcripts too and the same session came back under both signs.
  const rows = [
    { path: '/p/a.jsonl', sign: 'scratch', dir: '/Users/m/scratch' },
    { path: '/p/a.jsonl', sign: 'pokeclaude', dir: '/Users/m/scratch/pokeclaude' },
    { path: '/p/b.jsonl', sign: 'scratch', dir: '/Users/m/scratch' },
  ];
  const d = dedupeSessions(rows);
  assert.deepEqual(d.map(r => `${r.sign}:${r.path}`), ['pokeclaude:/p/a.jsonl', 'scratch:/p/b.jsonl']);
});

test('rankSessions needs only SOME of the terms, ranks by how many, and skips live ones', () => {
  const a = tmp('a', [
    { type: 'ai-title', aiTitle: 'Stripe webhook retry' },
    user('the stripe webhook fails on retry', '2026-08-01T10:00:00Z'),
    asst('The signature check rejects the retry.', '2026-08-01T10:01:00Z'),
  ]);
  const b = tmp('b', [
    { type: 'ai-title', aiTitle: 'Only webhooks' },
    user('list every webhook we have', '2026-08-02T10:00:00Z'),
  ]);
  const c = tmp('c', [
    { type: 'ai-title', aiTitle: 'Unrelated' },
    user('rename the button', '2026-08-03T10:00:00Z'),
  ]);
  const sessions = [
    { path: a, sessionId: 'A', title: 'Stripe webhook retry', mtime: 1, sign: 'shop', dir: '/r' },
    { path: b, sessionId: 'B', title: 'Only webhooks', mtime: 2, sign: 'shop', dir: '/r' },
    { path: c, sessionId: 'C', title: 'Unrelated', mtime: 3, sign: 'shop', dir: '/r' },
  ];
  const terms = ['stripe', 'webhook', 'signature'];
  const ranked = rankSessions(sessions, terms, { turnsPerSession: 2 });
  assert.deepEqual(ranked.map(r => r.sessionId), ['A', 'B']);   // C matches nothing
  assert.equal(ranked[0].distinct, 3);
  assert.equal(ranked[1].distinct, 1);
  assert.ok(ranked[0].excerpts.length >= 1 && ranked[0].excerpts.length <= 2);
  assert.equal(ranked[0].excerpts[0].role, 'user');
  assert.ok(ranked[0].excerpts[0].text.includes('stripe'));
  // A session that is on the field right now is covered by the live half, not here.
  const without = rankSessions(sessions, terms, { turnsPerSession: 2, exclude: new Set([a]) });
  assert.deepEqual(without.map(r => r.sessionId), ['B']);
  for (const p of [a, b, c]) fs.unlinkSync(p);
});

test('recallLive reads each agent: the opening ask, the newest turns, and any matching turn', () => {
  const p = tmp('live', [
    user('build the stripe webhook handler', '2026-09-01T10:00:00Z'),
    asst('Starting with the route.', '2026-09-01T10:01:00Z'),
    user('the signature header is x-stripe-signature', '2026-09-01T10:02:00Z'),
    asst('Noted.', '2026-09-01T10:03:00Z'),
    asst('Route done.', '2026-09-01T10:04:00Z'),
    asst('Tests pass.', '2026-09-01T10:05:00Z'),
    asst('Ready for review.', '2026-09-01T10:06:00Z'),
  ]);
  const agents = [
    { workspaceId: 'w1', title: 'webhook', rawDir: '/r/shop', status: 'WORKING',
      since: Date.now() - 60e3, kind: 'agent', branch: 'feat/hook' },
    { workspaceId: 'w2', title: 'dev', rawDir: '/r/shop', status: 'WORKING', kind: 'service',
      ports: [3000] },
    { workspaceId: 'w3', title: 'ghost', rawDir: '/r/shop', status: 'ASLEEP', kind: 'agent' },
  ];
  const transcriptFor = (a) => a.workspaceId === 'w1' ? p : null;
  const live = recallLive(agents, transcriptFor, ['signature'], { recent: 3 });
  assert.equal(live.length, 3);
  const [w1, w2, w3] = live;
  assert.equal(w1.opening, 'build the stripe webhook handler');
  assert.deepEqual(w1.recent.map(t => t.text), ['Route done.', 'Tests pass.', 'Ready for review.']);
  // The matching turn is older than the recent window, so it rides along separately.
  assert.deepEqual(w1.matched.map(t => t.text), ['the signature header is x-stripe-signature']);
  assert.equal(w1.transcript, p);
  assert.equal(w2.kind, 'service');
  assert.deepEqual(w2.ports, [3000]);
  assert.equal(w3.opening, null);
  assert.deepEqual(w3.recent, []);
  fs.unlinkSync(p);
});

test('groundingText puts live agents first, names sessions, and stays under budget', () => {
  const live = [
    { workspaceId: 'w1', title: 'webhook', rawDir: '/r/shop', status: 'WORKING', kind: 'agent',
      branch: 'feat/hook', opening: 'build the stripe webhook handler',
      recent: [{ role: 'assistant', text: 'Tests pass.', at: 1 }], matched: [] },
    { workspaceId: 'w2', title: 'dev', rawDir: '/r/shop', status: 'WORKING', kind: 'service',
      ports: [3000], opening: null, recent: [], matched: [] },
  ];
  const history = [
    { sign: 'shop', title: 'Stripe webhook retry', sessionId: 'A', mtime: new Date(2026, 7, 1).getTime(),
      distinct: 2, excerpts: [{ role: 'user', text: 'the stripe webhook fails on retry', at: 1 }] },
  ];
  const t = groundingText({ live, history });
  assert.ok(t.indexOf('LIVE') < t.indexOf('PAST'));
  assert.ok(t.includes('webhook | /r/shop | WORKING | branch feat/hook'));
  assert.ok(t.includes('opening ask: build the stripe webhook handler'));
  assert.ok(t.includes('service on 3000'));
  assert.ok(t.includes('"Stripe webhook retry"'));
  assert.ok(t.includes('Aug 1'));
  // A long history is cut at the budget, whole sessions at a time, most relevant kept.
  const many = Array.from({ length: 50 }, (_, i) => ({
    sign: 'shop', title: `S${i}`, sessionId: `S${i}`, mtime: 0, distinct: 1,
    excerpts: [{ role: 'user', text: 'x'.repeat(400), at: 1 }] }));
  const small = groundingText({ live, history: many }, 3000);
  assert.ok(small.length <= 3200, `got ${small.length}`);
  assert.ok(small.includes('"S0"') && !small.includes('"S49"'));
  assert.ok(/\d+ more matching sessions not shown/.test(small));
});

test('a big fleet cannot crowd the past sessions out of the grounding', () => {
  // 24 live agents with long conversations, and 8 matching sessions. The live half
  // is trimmed to fit its share; the history half always gets room.
  const turn = (i) => ({ role: 'assistant', text: `turn ${i} ` + 'w'.repeat(280), at: i });
  const live = Array.from({ length: 24 }, (_, i) => ({
    workspaceId: `w${i}`, title: `agent ${i}`, rawDir: '/r', status: 'WORKING', kind: 'agent',
    opening: 'o'.repeat(300), recent: [1, 2, 3, 4, 5, 6].map(turn),
    matched: [turn(90), turn(91)] }));
  const history = Array.from({ length: 8 }, (_, i) => ({
    sign: 'r', title: `past ${i}`, sessionId: `p${i}`, mtime: 1, distinct: 2, matches: 3,
    excerpts: [1, 2, 3].map(turn) }));
  const t = groundingText({ live, history }, 24000);
  assert.ok(t.length <= 24500, `got ${t.length}`);
  for (let i = 0; i < 24; i++) assert.ok(t.includes(`agent ${i} | /r | WORKING`), `agent ${i} missing`);
  assert.ok(t.includes('"past 0"'));
  assert.ok(t.includes('"past 4"'), 'history got no room');
  assert.ok(!/more matching sessions not shown/.test(t) || t.includes('"past 2"'));
  // With room to spare nothing is trimmed: every recent turn of a small fleet shows.
  const roomy = groundingText({ live: live.slice(0, 2), history: history.slice(0, 1) }, 24000);
  assert.ok(roomy.includes('turn 6 '));
});
