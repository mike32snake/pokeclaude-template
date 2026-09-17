import test from 'node:test';
import assert from 'node:assert';
import { createState, applyCmux, applyHook, mapCmuxStatus, snapshot } from '../src/server/state.js';

const WS = (id, ref, dir, title) => ({ id, ref, current_directory: dir, title });

test('cmux status mapping', () => {
  assert.equal(mapCmuxStatus('Running'), 'WORKING');
  assert.equal(mapCmuxStatus('Needs input'), 'BLOCKED');
  assert.equal(mapCmuxStatus('Idle'), 'ASLEEP');
});
test('poll creates agents and matches session rows by dir+title', () => {
  const st = createState();
  applyCmux(st,
    [WS('U1', 'workspace:1', '/tmp/a', 'task one'), WS('U2', 'workspace:2', '/tmp/a', 'task two')],
    [{ dir: '/tmp/a', processTitle: 'task two', customTitle: null, branch: 'main', status: 'Needs input', statusAt: 5 },
     { dir: '/tmp/a', processTitle: 'task one', customTitle: null, branch: null, status: 'Running', statusAt: 6 }],
    1000);
  const a = snapshot(st).agents;
  assert.equal(a.find(x => x.workspaceId === 'U1').status, 'WORKING');
  assert.equal(a.find(x => x.workspaceId === 'U2').status, 'BLOCKED');
  assert.equal(a.find(x => x.workspaceId === 'U2').branch, 'main');
});
test('hooks beat the poll for 10s', () => {
  const st = createState();
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', 't')], [{ dir: '/tmp/a', processTitle: 't', status: 'Idle', statusAt: 1 }], 1000);
  applyHook(st, { cmuxWorkspaceId: 'U1', event: { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'S1' } }, 2000);
  assert.equal(st.agents.get('U1').status, 'WORKING');
  // poll 3s later says Idle, but the hook is fresh -> stays WORKING
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', 't')], [{ dir: '/tmp/a', processTitle: 't', status: 'Idle', statusAt: 1 }], 5000);
  assert.equal(st.agents.get('U1').status, 'WORKING');
  // 20s later the poll wins
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', 't')], [{ dir: '/tmp/a', processTitle: 't', status: 'Idle', statusAt: 1 }], 22000);
  assert.equal(st.agents.get('U1').status, 'ASLEEP');
});
test('followers count Task spawns and SubagentStop', () => {
  const st = createState();
  applyHook(st, { cmuxWorkspaceId: 'U1', event: { hook_event_name: 'PreToolUse', tool_name: 'Task' } });
  applyHook(st, { cmuxWorkspaceId: 'U1', event: { hook_event_name: 'PreToolUse', tool_name: 'Task' } });
  assert.equal(st.agents.get('U1').followers, 2);
  applyHook(st, { cmuxWorkspaceId: 'U1', event: { hook_event_name: 'SubagentStop' } });
  assert.equal(st.agents.get('U1').followers, 1);
  applyHook(st, { cmuxWorkspaceId: 'U1', event: { hook_event_name: 'Stop' } });
  assert.equal(st.agents.get('U1').followers, 0);
});
test('vanished workspace faints', () => {
  const st = createState();
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', 't')], [], 1000);
  applyCmux(st, [], [], 2000);
  assert.equal(st.agents.get('U1').status, 'FAINTED');
});

test('a workspace listening on a port with no Claude session is a service', () => {
  const st = createState();
  const ws = { id: 'S1', ref: 'workspace:9', current_directory: '/tmp/app',
               title: 'dev server', listening_ports: [5173] };
  applyCmux(st, [ws], [{ dir: '/tmp/app', processTitle: 'dev server', status: 'Idle', statusAt: 1 }], 1000);
  const a = st.agents.get('S1');
  assert.equal(a.kind, 'service');
  assert.deepEqual(a.ports, [5173]);
  assert.equal(a.status, 'SERVING');
});
test('an agent that also serves a port stays an agent', () => {
  const st = createState();
  applyHook(st, { cmuxWorkspaceId: 'A1', event: { hook_event_name: 'SessionStart', session_id: 'X' } }, 900);
  applyCmux(st, [{ id: 'A1', ref: 'workspace:2', current_directory: '/tmp/app', title: 'building',
                   listening_ports: [3000] }], [], 1000);
  assert.equal(st.agents.get('A1').kind, 'agent');
});

test('a service does not lose its kind just because a session id appears late', () => {
  const st = createState();
  const ws = { id: 'S2', ref: 'workspace:9', current_directory: '/tmp/app',
               title: 'server', listening_ports: [5180] };
  applyCmux(st, [ws], [], 1000);
  assert.equal(st.agents.get('S2').kind, 'service');
  // a stray hook must not silently demote a bound service back to an agent
  applyHook(st, { cmuxWorkspaceId: 'S2', event: { hook_event_name: 'SessionStart', session_id: 'Z' } }, 1100);
  applyCmux(st, [ws], [], 1200);
  assert.equal(st.agents.get('S2').kind, 'service', 'ports win once a service is bound');
});

test('a server-titled workspace is a service even when cmux reports no ports', () => {
  const st = createState();
  // cmux only samples ports periodically; the classification must survive a gap.
  const ws = { id: 'S3', ref: 'workspace:9', current_directory: '/tmp/app',
               title: 'PokeClaude server', listening_ports: [] };
  applyCmux(st, [ws], [], 1000);
  assert.equal(st.agents.get('S3').kind, 'service');
});

// A tab cmux restored on relaunch has no terminal in it until it is clicked. It is
// listed like any other workspace, so the ranch drew it as an agent, guessed its
// conversation from the newest transcript in the repo, and a message to it was refused
// with "Claude is not running in that tab". Only read-screen can tell: it fails with
// "Terminal surface not found".
test('a read that finds no terminal surface marks the tab hollow', async () => {
  const { isHollow } = await import('../src/server/state.js');
  assert.equal(isHollow({ ok: false, stdout: '', stderr: 'Error: internal_error: ERROR: Terminal surface not found\n' }), true);
  assert.equal(isHollow({ ok: true, stdout: '❯ \n' }), false);
  assert.equal(isHollow({ ok: false, stdout: '', stderr: 'timeout' }), false);   // not evidence
});
test('a hollow tab leaves the snapshot, and comes back once it has a terminal', async () => {
  const { markHollow } = await import('../src/server/state.js');
  const st = createState();
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', 'new agent'), WS('U2', 'workspace:2', '/tmp/a', 'live')], [], 1000);
  const v0 = st.version;
  assert.equal(markHollow(st, 'U1', true), true);
  assert.ok(st.version > v0, 'a change to what is shown bumps the version');
  assert.deepEqual(snapshot(st).agents.map(a => a.workspaceId), ['U2']);
  assert.equal(markHollow(st, 'U1', true), false);                  // nothing changed
  assert.equal(markHollow(st, 'U1', false), true);
  assert.deepEqual(snapshot(st).agents.map(a => a.workspaceId), ['U1', 'U2']);
  assert.equal(markHollow(st, 'nope', true), false);                // unknown agent: no-op
});

// cmux writes a claude_code status entry for every Claude tab and nothing at all for
// a Codex one, so the poll reads "no row, therefore Idle" and a Codex agent that was
// visibly working went back to sleep on the field every three seconds. Its status
// comes from its own pane instead (sampleFooters), and the poll must leave it alone.
test('a Codex agent keeps the status read from its pane', () => {
  const st = createState();
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', '◑ new agent')],
    [{ dir: '/tmp/a', processTitle: '◑ new agent', status: null, statusAt: null }], 1000);
  const a = st.agents.get('U1');
  a.engine = 'codex';                      // what the pane read said
  a.status = 'WORKING';
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', '◑ new agent')],
    [{ dir: '/tmp/a', processTitle: '◑ new agent', status: null, statusAt: null }], 60000);
  assert.equal(st.agents.get('U1').status, 'WORKING');
  assert.equal(st.agents.get('U1').branch, undefined);   // everything else still updates
});

test('the engine travels to the client, so the panel can say what a pen runs', () => {
  const st = createState();
  applyCmux(st, [WS('U1', 'workspace:1', '/tmp/a', 't')], [], 1000);
  st.agents.get('U1').engine = 'codex';
  assert.equal(snapshot(st).agents[0].engine, 'codex');
});
