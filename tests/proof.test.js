// What a pen proved about its last turn, from an optional Stop hook (e.g. ~/.claude/hooks/verify-gate.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanVerify, proofLabel } from '../public/js/proof.js';
import { createState, applyHook, snapshot } from '../src/server/state.js';
import { describe, makeWatcher } from '../src/server/notify.js';

const verify = (state, evidence = []) => ({ state, evidence, files: 2, at: 1 });

test('only the shape the gate sends is kept', () => {
  assert.deepEqual(cleanVerify(verify('verified', ['tests', 'browser'])),
    { state: 'verified', evidence: ['tests', 'browser'], files: 2, at: 1 });
  assert.equal(cleanVerify({ state: 'hacked' }), null);
  assert.equal(cleanVerify(null), null);
  assert.deepEqual(cleanVerify({ state: 'verified', evidence: ['<b>x</b>', 3, 'tests'] }).evidence, ['tests']);
});

test('the label says what proved it, or that nothing did', () => {
  assert.equal(proofLabel(verify('verified', ['tests', 'browser'])), 'verified: tests, browser');
  assert.equal(proofLabel(verify('unverified')), 'no proof');
  assert.equal(proofLabel(verify('blocked')), 'checking its work');
  assert.equal(proofLabel(verify('none')), null);
  assert.equal(proofLabel(null), null);
});

test('a verify result is kept on the pen and does not change its status', () => {
  const s = createState();
  applyHook(s, { agentId: 'pc-1', event: { hook_event_name: 'Stop', session_id: 'S' } }, 1000, 'native');
  applyHook(s, { agentId: 'pc-1', event: { hook_event_name: 'VerifyResult', verify: verify('verified', ['tests']) } }, 1100, 'native');
  const a = snapshot(s).agents[0];
  assert.equal(a.status, 'ASLEEP');
  assert.equal(a.verify.state, 'verified');
});

test('a new prompt clears the last turn\'s proof', () => {
  const s = createState();
  applyHook(s, { agentId: 'pc-1', event: { hook_event_name: 'VerifyResult', verify: verify('unverified') } }, 1000, 'native');
  applyHook(s, { agentId: 'pc-1', event: { hook_event_name: 'UserPromptSubmit' } }, 2000, 'native');
  assert.equal(snapshot(s).agents[0].verify, null);
});

test('a finished notification says whether the work was proved', () => {
  const of = (v) => describe({ kind: 'finished', species: { name: 'Eevee' }, pen: 'site', verify: v }).subtitle;
  assert.equal(of(verify('verified', ['browser'])), 'finished · verified: browser');
  assert.equal(of(verify('unverified')), 'finished · no proof');
  assert.equal(of(null), 'finished');
  assert.equal(of(verify('none')), 'finished');
});

test('the watcher hands the pen\'s proof to the finished alert', () => {
  const w = makeWatcher({ settle: 0 });
  const pen = (status, v) => [{ workspaceId: 'pc-1', status, dir: '/x/site', verify: v }];
  w.check(pen('WORKING', null), [], 0);
  w.check(pen('WORKING', null), [], 1);
  const out = w.check(pen('ASLEEP', verify('verified', ['tests'])), [], 2);
  assert.equal(out[0].kind, 'finished');
  assert.equal(out[0].verify.state, 'verified');
});
