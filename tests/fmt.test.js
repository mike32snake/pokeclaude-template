import test from 'node:test';
import assert from 'node:assert';
import { elapsed } from '../src/shared/fmt.js';

test('elapsed formats minutes, hours, days', () => {
  assert.equal(elapsed(5 * 60e3), '5m');
  assert.equal(elapsed(90 * 60e3), '1h30');
  assert.equal(elapsed(10 * 3600e3), '10h');
  assert.equal(elapsed(71 * 3600e3), '2d');
  assert.equal(elapsed(184 * 3600e3), '7d');
});
