import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { deleteCron } from '../src/server/crons.js';

// Exercise the real delete path without ever invoking the machine's crontab.
function fakeCrontab(t, contents) {
  const writes = [];
  t.mock.method(childProcess, 'execFile', (cmd, args, opts, callback) => {
    assert.equal(cmd, 'crontab');
    if (args[0] === '-l') {
      queueMicrotask(() => callback(null, contents, ''));
      return {};
    }
    assert.deepEqual(args, ['-']);
    return { stdin: { end(text) {
      writes.push(text);
      queueMicrotask(() => callback(null, '', ''));
    } } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return writes;
}

test('deleting a cron preserves similar commands, other schedules and comments', async t => {
  const other = [
    '# 0 9 * * * echo report',
    'MAILTO="echo report"',
    '0 10 * * * echo report',
    '0 9 * * * echo report-extra',
    '0 9 * * * echo report && echo done',
  ];
  const writes = fakeCrontab(t, [...other, '0\t9 * * * echo report', ''].join('\n'));
  assert.deepEqual(await deleteCron({ isCrontab: true, command: 'echo report', schedule: '0 9 * * *' }), { ok: true });
  assert.deepEqual(writes, [other.join('\n') + '\n']);
});

test('a stale cron selection refuses to write when only similar jobs remain', async t => {
  const writes = fakeCrontab(t, '0 9 * * * echo report-extra\n');
  const result = await deleteCron({ isCrontab: true, command: 'echo report', schedule: '0 9 * * *' });
  assert.match(result.error, /no longer/);
  assert.deepEqual(writes, []);
});

test('deleting one identical cron row removes only one occurrence', async t => {
  const row = '0 9 * * * echo report\n';
  const writes = fakeCrontab(t, row + row);
  await deleteCron({ isCrontab: true, command: 'echo report', schedule: '0 9 * * *' });
  assert.deepEqual(writes, [row]);
});

test('cron identities distinguish long shared command prefixes, schedules and duplicates', async () => {
  const { crontabId } = await import('../src/server/crons.js');
  const prefix = 'cd "' + 'long project folder/'.repeat(4) + '" && node send.js --step ';
  const first = crontabId('0 10 8 3 *', prefix + '2');
  assert.notEqual(first, crontabId('0 10 8 3 *', prefix + '3'));
  assert.notEqual(first, crontabId('0 10 12 3 *', prefix + '2'));
  assert.notEqual(first, crontabId('0 10 8 3 *', prefix + '2', 1));
  assert.equal(first, crontabId('0\t10 8 3 *', prefix + '2'));
});
