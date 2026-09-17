// Linking a workspace to the Claude session running in its terminal. These are the
// pure parts: nothing here shells out or touches the real process table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, normalizeTty } from '../src/server/sessions.js';

const SETTINGS = '--settings {"hooks":{"Stop":[{"matcher":""}]}}';
const line = (pid, tty, cmd) => `${String(pid).padStart(6)} ${tty} ${cmd}`;

test('a session id is read straight off the claude command line', () => {
  const m = parsePs(line(123, 'ttys004',
    `/Users/m/.local/bin/claude --session-id CED22B96-36E0-4FEC-9522-1B5E94E7584F ${SETTINGS}`));
  assert.equal(m.size, 1);
  assert.deepEqual(m.get('ttys004'),
    { pid: 123, sessionId: 'ced22b96-36e0-4fec-9522-1b5e94e7584f', resumed: false });
});

test('a resumed session names the transcript it continued into', () => {
  const m = parsePs(line(9, 'ttys005',
    `/Users/m/.local/bin/claude ${SETTINGS} --resume 93100360-66db-4a26-a942-0ab5f1e957f9`));
  assert.equal(m.get('ttys005').sessionId, '93100360-66db-4a26-a942-0ab5f1e957f9');
  assert.equal(m.get('ttys005').resumed, true);
});

test('a process with no tty cannot belong to a workspace', () => {
  assert.equal(parsePs(line(1, '??',
    `/Users/m/.local/bin/claude --session-id 11111111-2222-3333-4444-555555555555`)).size, 0);
});

test('other processes are ignored, including ones that merely mention claude', () => {
  const text = [
    line(2, 'ttys001', '/bin/bash /Users/m/.claude/statusline-command.sh'),
    line(3, 'ttys002', 'vim claude-notes.md --session-id 11111111-2222-3333-4444-555555555555'),
    line(4, 'ttys003', '/usr/bin/tail -f /tmp/claude.log'),
  ].join('\n');
  assert.equal(parsePs(text).size, 0);
});

test('a claude with no session id on its line is not guessed at', () => {
  assert.equal(parsePs(line(5, 'ttys006', `/Users/m/.local/bin/claude ${SETTINGS}`)).size, 0);
});

test('every terminal gets its own entry, so agents sharing a repo stay separate', () => {
  const text = [
    line(10, 'ttys000', '/Users/m/.local/bin/claude --session-id aaaaaaaa-1111-2222-3333-444444444444'),
    line(11, 'ttys008', '/Users/m/.local/bin/claude --session-id bbbbbbbb-1111-2222-3333-444444444444'),
    line(12, 'ttys018', '/Users/m/.local/bin/claude --session-id cccccccc-1111-2222-3333-444444444444'),
  ].join('\n');
  const m = parsePs(text);
  assert.equal(m.size, 3);
  assert.equal(new Set([...m.values()].map(v => v.sessionId)).size, 3);
});

test('garbage lines do not throw', () => {
  assert.equal(parsePs('').size, 0);
  assert.equal(parsePs(null).size, 0);
  assert.equal(parsePs('not a ps table at all').size, 0);
});

test('a tty is the same whether or not it is written as a device path', () => {
  assert.equal(normalizeTty('/dev/ttys004'), 'ttys004');
  assert.equal(normalizeTty('ttys004'), 'ttys004');
  assert.equal(normalizeTty(null), '');
});

// A restored tab's tty is the one it had before cmux relaunched, and the number is
// reused by whichever tab opens next. Reading a session off it linked an empty tab to
// the Claude in another tab, and the sessionId stuck. A tab with no terminal in it has
// no process to link.
test('a hollow tab is never linked to the claude that now owns its old tty', async () => {
  const { linkSessions } = await import('../src/server/sessions.js');
  const byTty = new Map([['ttys002', { pid: 1, sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', resumed: false }]]);
  const live = { workspaceId: 'L', tty: 'ttys002', rawDir: '/nowhere', sessionId: null };
  const hollow = { workspaceId: 'H', tty: 'ttys002', rawDir: '/nowhere', sessionId: null, hollow: true };
  const state = { agents: new Map([['L', live], ['H', hollow]]) };
  await linkSessions(state, { byTty });
  assert.equal(live.procSessionId, 'aaaaaaaa-0000-0000-0000-000000000000');
  assert.equal(hollow.procSessionId, null);
  assert.equal(hollow.sessionId, null);
});
