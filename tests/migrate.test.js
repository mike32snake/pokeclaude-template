// Moving the pens you are working in from cmux onto our own pty.
//
// The switch is only worth throwing if the conversations come with it. Each cmux pen is
// a claude or codex process in a directory with a session id; a native pen running
// `claude --resume <id>` in that same directory is the SAME conversation, with its
// history, its context and its transcript. So the migration is a plan, and the plan is
// what this file is about: it must never resume a session twice, never lose one
// silently, and never guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationPlan, describePlan, useDirCheck } from '../src/server/migrate.js';

// The plan is pure apart from one question: does the directory still exist. The tests
// answer it themselves so they do not depend on this machine's filesystem.
useDirCheck((d) => d === '/Users/dev/x');

const agent = (over = {}) => ({
  workspaceId: 'workspace:29', ref: 'workspace:29', dir: '/Users/dev/x', rawDir: '/Users/dev/x',
  title: '◑ new agent', kind: 'agent', status: 'ASLEEP', engine: 'claude',
  procSessionId: '11111111-1111-4111-8111-111111111111', hollow: false, ...over,
});

test('an agent with a session and a directory is movable', () => {
  const p = migrationPlan([agent()]);
  assert.equal(p.move.length, 1);
  assert.equal(p.move[0].sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(p.move[0].dir, '/Users/dev/x');
  assert.equal(p.move[0].engine, 'claude');
  assert.equal(p.skip.length, 0);
});

// Everything that cannot be moved is reported, never dropped: a pen that vanishes
// without being named is the failure you would find out about by missing work.
test('a pen with no session id is skipped with a reason, not silently', () => {
  const p = migrationPlan([agent({ procSessionId: null, codexSessionId: null })]);
  assert.equal(p.move.length, 0);
  assert.equal(p.skip.length, 1);
  assert.match(p.skip[0].reason, /no session/i);
  assert.equal(p.skip[0].ref, 'workspace:29');
});

test('services, hollow tabs and fainted pens are not conversations', () => {
  const p = migrationPlan([
    agent({ kind: 'service', ref: 'w:1' }),
    agent({ hollow: true, ref: 'w:2' }),
    agent({ status: 'FAINTED', ref: 'w:3' }),
  ]);
  assert.equal(p.move.length, 0);
  assert.deepEqual(p.skip.map(s => s.ref).sort(), ['w:1', 'w:2', 'w:3']);
  assert.match(p.skip.find(s => s.ref === 'w:1').reason, /service/i);
});

test('a Codex pen moves on its own session id', () => {
  const p = migrationPlan([agent({ engine: 'codex', procSessionId: null,
    codexSessionId: '22222222-2222-4222-8222-222222222222' })]);
  assert.equal(p.move.length, 1);
  assert.equal(p.move[0].engine, 'codex');
  assert.equal(p.move[0].sessionId, '22222222-2222-4222-8222-222222222222');
});

// Resuming one conversation into two pens would have both appending to one transcript.
test('the same session is never moved twice', () => {
  const same = '33333333-3333-4333-8333-333333333333';
  const p = migrationPlan([
    agent({ ref: 'w:1', procSessionId: same }),
    agent({ ref: 'w:2', procSessionId: same }),
  ]);
  assert.equal(p.move.length, 1);
  assert.equal(p.skip.length, 1);
  assert.match(p.skip[0].reason, /already/i);
});

test('a pen whose directory is gone cannot be resumed into it', () => {
  // The real directory is preferred over the normalised one, so both have to go for
  // "no directory", and a directory that is merely deleted is its own case.
  const none = migrationPlan([agent({ rawDir: null, dir: null })]);
  assert.equal(none.move.length, 0);
  assert.match(none.skip[0].reason, /nowhere to resume/i);

  const gone = migrationPlan([agent({ rawDir: '/Users/dev/deleted', dir: '/Users/dev/deleted' })]);
  assert.equal(gone.move.length, 0);
  assert.match(gone.skip[0].reason, /no longer exists/i);
});

// The server's own pen is in the list and must never be migrated: it is running the
// thing doing the migrating.
test('the pen the server itself lives in is left alone', () => {
  const p = migrationPlan([agent({ ref: 'w:self' })], { exclude: ['w:self'] });
  assert.equal(p.move.length, 0);
  assert.match(p.skip[0].reason, /server/i);
});

test('an empty ranch plans nothing and reports nothing', () => {
  const p = migrationPlan([]);
  assert.deepEqual(p.move, []);
  assert.deepEqual(p.skip, []);
});

// You read this before anything runs, so it has to say what will happen.
test('the plan describes itself in a line per pen', () => {
  const p = migrationPlan([agent({ ref: 'w:1' }), agent({ ref: 'w:2', procSessionId: null })]);
  const text = describePlan(p);
  assert.match(text, /1 pen/);
  assert.match(text, /11111111/);
  assert.match(text, /w:2/);
  assert.match(text, /no session/i);
});

// Two places name a conversation and they are not equally good. procSessionId is read
// from the live process table; a.sessionId can come from a hook, and a hook outlives
// the process that sent it. The API snapshot only carries sessionId, so a plan built
// from /api/state has nothing else - both are accepted, and the plan says which.
test('a session id from the process table is preferred and marked as such', () => {
  const both = migrationPlan([agent({
    procSessionId: '44444444-4444-4444-8444-444444444444',
    sessionId: '55555555-5555-4555-8555-555555555555',
  })]);
  assert.equal(both.move[0].sessionId, '44444444-4444-4444-8444-444444444444');
  assert.equal(both.move[0].source, 'process');
});

test('a pen known only by its hook is still movable, and is labelled', () => {
  const p = migrationPlan([agent({ procSessionId: null,
    sessionId: '55555555-5555-4555-8555-555555555555' })]);
  assert.equal(p.move.length, 1);
  assert.equal(p.move[0].source, 'hook');
  assert.match(describePlan(p), /id from a hook/);
});

// An engine we could not read is a guess, and a guess you should see before it runs.
test('an unidentified engine is assumed to be claude, and says so', () => {
  const p = migrationPlan([agent({ engine: null })]);
  assert.equal(p.move[0].engine, 'claude');
  assert.equal(p.move[0].engineKnown, false);
  assert.match(describePlan(p), /engine unknown/);
  const known = migrationPlan([agent({ engine: 'claude' })]);
  assert.equal(known.move[0].engineKnown, true);
  assert.doesNotMatch(describePlan(known), /engine unknown/);
});

// A pen that is mid-turn is doing work right now. Resuming it elsewhere means killing
// the process that is producing that turn, and the turn is lost - the transcript keeps
// everything up to the last completed one, not the half-written one.
test('a working pen is left alone by default', () => {
  const p = migrationPlan([agent({ status: 'WORKING' })]);
  assert.equal(p.move.length, 0);
  assert.match(p.skip[0].reason, /mid-turn|working/i);
});

test('a working pen can be included deliberately', () => {
  const p = migrationPlan([agent({ status: 'WORKING' })], { includeWorking: true });
  assert.equal(p.move.length, 1);
});

test('blocked and idle pens are not mid-turn', () => {
  for (const status of ['ASLEEP', 'BLOCKED']) {
    assert.equal(migrationPlan([agent({ status })]).move.length, 1, status);
  }
});
