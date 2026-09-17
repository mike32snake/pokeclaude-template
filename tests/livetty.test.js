// A pen's tty is how its process is found: `--session-id` for Claude, the rollout lock
// for Codex. It used to come only from cmux's session file, which cmux saves now and
// then. A tab opened after the last save had no row, so a Codex pen spawned at 12:10
// against a file saved at 12:00 had no tty, never linked, and every reply to it was
// refused with "Still identifying this conversation". Stale rows are worse: the file
// still held ttys06 for a closed tab. The live tree is the truth.
import test from 'node:test';
import assert from 'node:assert';
import { ttysFromTree } from '../src/server/cmux.js';
import { createState, applyCmux } from '../src/server/state.js';

const TREE = { windows: [{ workspaces: [
  { ref: 'workspace:22', panes: [{ surfaces: [{ type: 'terminal', tty: 'ttys006' }] }] },
  { ref: 'workspace:23', panes: [{ surfaces: [{ type: 'browser', tty: null }] },
                                 { surfaces: [{ type: 'terminal', tty: 'ttys011' }] }] },
  { ref: 'workspace:24', panes: [] },
] }] };

test('the live cmux tree gives each workspace its terminal tty', () => {
  const m = ttysFromTree(TREE);
  assert.equal(m.get('workspace:22'), 'ttys006');
  assert.equal(m.get('workspace:23'), 'ttys011');
  assert.equal(m.has('workspace:24'), false);
  assert.equal(ttysFromTree(null).size, 0);
  assert.equal(ttysFromTree({ windows: 'nope' }).size, 0);
});

const WS = (id, ref, dir, title, tty) => ({ id, ref, current_directory: dir, title, tty });

test('a tab the session file has not saved yet still gets its tty', () => {
  const st = createState();
  applyCmux(st, [WS('K', 'workspace:22', '/x/sandbox', 'new codex', 'ttys006')], [], 1000);
  assert.equal(st.agents.get('K').tty, 'ttys006');
});

test('the live tty beats a stale one in the session file', () => {
  const st = createState();
  applyCmux(st, [WS('K', 'workspace:22', '/x/a', 't', 'ttys006')],
    [{ dir: '/x/a', processTitle: 't', tty: 'ttys009', status: 'Idle', statusAt: 1 }], 1000);
  assert.equal(st.agents.get('K').tty, 'ttys006');
});

test('with no live tty the session file row is still used', () => {
  const st = createState();
  applyCmux(st, [WS('K', 'workspace:22', '/x/a', 't', undefined)],
    [{ dir: '/x/a', processTitle: 't', tty: 'ttys009', status: 'Idle', statusAt: 1 }], 1000);
  assert.equal(st.agents.get('K').tty, 'ttys009');
});
