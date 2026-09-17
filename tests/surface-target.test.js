import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalSurface } from '../src/server/cmux.js';
test('browser focus never redirects agent replies', () => {
  assert.equal(terminalSurface([{ id: 'browser', type: 'browser', focused: true }, { id: 'agent', type: 'terminal' }]), 'agent');
  assert.equal(terminalSurface([{ id: 'browser', type: 'browser' }]), null);
  assert.equal(terminalSurface([{ id: 'a', type: 'terminal' }, { id: 'b', type: 'terminal' }]), null);
});
