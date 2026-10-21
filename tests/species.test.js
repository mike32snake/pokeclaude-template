import test from 'node:test';
import assert from 'node:assert';
import { assignSpecies, PLAYER_DEX } from '../public/js/species.js';
import { DEX } from '../public/js/dex.js';
import { hash } from '../public/js/world.js';
import { createState, applyHook, snapshot } from '../src/server/state.js';

const slot = id => hash(id + 'v2') % DEX.length;
// Two ids the old hash put on the same Pokemon, found rather than hard-coded.
function collide(n = 2, prefix = 'ws-') {
  const by = new Map();
  for (let i = 0; ; i++) {
    const id = prefix + i, s = slot(id);
    if (DEX[s][0] === PLAYER_DEX) continue;
    const list = by.get(s) || []; list.push(id); by.set(s, list);
    if (list.length === n) return list;
  }
}

test('two agents the hash put on the same Pokemon get different ones', () => {
  const [a, b, c] = collide(3);
  const m = assignSpecies([a, b, c]);
  assert.equal(new Set(m.values()).size, 3);
});

test('a full field never repeats a Pokemon', () => {
  const ids = Array.from({ length: 140 }, (_, i) => 'agent-' + i);
  const m = assignSpecies(ids);
  assert.equal(new Set(m.values()).size, ids.length);
});

test('no agent is Pikachu, because Pikachu is the player', () => {
  const ids = Array.from({ length: 300 }, (_, i) => 'p' + i).filter(id => DEX[slot(id)][0] === PLAYER_DEX);
  assert.ok(ids.length, 'need an id that hashes to Pikachu');
  for (const v of assignSpecies(ids).values()) assert.notEqual(DEX[v][0], PLAYER_DEX);
});

test('an agent with no clash keeps the Pokemon it always had', () => {
  const m = assignSpecies(['20151D9B-A5D9']);
  assert.equal(m.get('20151D9B-A5D9'), slot('20151D9B-A5D9'));
});

test('a newcomer never takes the Pokemon an agent already has', () => {
  const [a, b] = collide(2).sort().reverse();          // b sorts first, and arrives second
  const first = assignSpecies([a]);
  const both = assignSpecies([a, b], first);
  assert.equal(both.get(a), first.get(a));
  assert.notEqual(both.get(b), both.get(a));
});

test('the answer does not depend on the order the agents are listed in', () => {
  const ids = collide(3);
  assert.deepEqual([...assignSpecies(ids).entries()].sort(),
                   [...assignSpecies([...ids].reverse()).entries()].sort());
});

test('the server snapshot carries a different Pokemon for each colliding agent', () => {
  const [a, b] = collide(2);
  const st = createState();
  for (const id of [a, b]) applyHook(st, { cmuxWorkspaceId: id, event: { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: id } }, 1000);
  const s1 = snapshot(st).agents;
  assert.notEqual(s1[0].species, s1[1].species);
  assert.deepEqual(snapshot(st).agents.map(x => x.species), s1.map(x => x.species), 'stable across snapshots');
});
