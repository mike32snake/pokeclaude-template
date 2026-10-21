// Which pens are listening on a port.
//
// A workspace running a dev server is a SERVICE, not an agent: state.js draws it
// differently and never tries to talk to it. Ports are the strongest signal, and cmux
// only reported them now and then, so a server-ish title had to stand in.
//
// Owning the pty means we know each pen's process, so we can ask properly. The port is
// rarely opened by the pen's own process though - `npm run dev` forks node, which forks
// the bundler - so the answer is a walk up the parent chain rather than a lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListeners, parseProcessTree, portsByRoot } from '../src/server/ports.js';

// `lsof -nP -iTCP -sTCP:LISTEN -FpPn`, which prints one field per line: p<pid>, then
// n<address> for each file that pid holds.
const LSOF = [
  'p4120', 'n127.0.0.1:5180',
  'p4180', 'n*:3000', 'n[::1]:3000',
  'p4200', 'n127.0.0.1:8080',
].join('\n');

test('lsof output becomes pid to ports', () => {
  const m = parseListeners(LSOF);
  assert.deepEqual(m.get(4120), [5180]);
  assert.deepEqual(m.get(4180), [3000], 'the same port on two addresses is one port');
  assert.deepEqual(m.get(4200), [8080]);
  assert.equal(m.size, 3);
});

test('nothing listening is an empty map, not a throw', () => {
  assert.equal(parseListeners('').size, 0);
  assert.equal(parseListeners(null).size, 0);
  assert.equal(parseListeners('garbage\nlines').size, 0);
});

test('a pid with no address is not a listener', () => {
  assert.equal(parseListeners('p999').size, 0);
});

// `ps -axo pid,ppid`
const PS = ['  PID  PPID', ' 4100     1', ' 4120  4100', ' 4180  4120', ' 4200  4180',
            ' 5000     1', ' 5001  5000'].join('\n');

test('ps output becomes child to parent', () => {
  const t = parseProcessTree(PS);
  assert.equal(t.get(4120), 4100);
  assert.equal(t.get(4200), 4180);
  assert.equal(t.get(4100), 1);
  assert.ok(!t.has(0), 'the header is not a process');
});

// The one that matters: `npm run dev` forks node, which forks the bundler, and the
// bundler is what binds the port. The pen's own pid holds nothing.
test('a port opened by a grandchild counts for the pen that started it', () => {
  const ports = portsByRoot([4100], parseListeners(LSOF), parseProcessTree(PS));
  assert.deepEqual(ports.get(4100).sort((a, b) => a - b), [3000, 5180, 8080]);
});

test('two pens keep their own ports', () => {
  const lsof = parseListeners(['p4180', 'n*:3000', 'p5001', 'n*:4000'].join('\n'));
  const ports = portsByRoot([4100, 5000], lsof, parseProcessTree(PS));
  assert.deepEqual(ports.get(4100), [3000]);
  assert.deepEqual(ports.get(5000), [4000]);
});

test('a pen listening on nothing gets an empty list, not a missing one', () => {
  const ports = portsByRoot([4100, 9999], parseListeners(''), parseProcessTree(PS));
  assert.deepEqual(ports.get(4100), []);
  assert.deepEqual(ports.get(9999), []);
});

// A process table is a snapshot and a pid can be reaped between lsof and ps. A cycle
// should be impossible, but an infinite walk would hang the poll, so it is bounded.
test('a broken or looping parent chain cannot hang the walk', () => {
  const loop = new Map([[10, 11], [11, 10]]);
  const ports = portsByRoot([10], new Map([[11, [1234]]]), loop);
  assert.deepEqual(ports.get(10), [1234], 'a loop that does contain the root still counts');
  const orphan = portsByRoot([99], new Map([[11, [1234]]]), loop);
  assert.deepEqual(orphan.get(99), []);
});
