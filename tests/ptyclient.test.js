// Talking to the pty relay that holds an agent.
//
// The relay (tools/pty-agent.py) outlives the server on purpose: run-server.sh is a
// restart loop and pkill is the deploy, so a server that held the ptys would kill every
// agent every time it restarted. The server attaches over a unix socket instead.
//
// The framing is length-prefixed and never newline-delimited, because terminal output
// is binary and full of newlines. Everything below about split reads is the same
// lesson as vt.js: the kernel chunks by size, not by meaning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frame, parseFrames, OUT, IN, CTL, control } from '../src/server/ptyclient.js';

test('a frame carries its length and its kind, and round-trips', () => {
  const f = frame(OUT, Buffer.from('hello'));
  assert.equal(f.readUInt32BE(0), 6, 'length counts the kind byte');
  assert.equal(f[4], OUT);
  const { frames, rest } = parseFrames(f);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, OUT);
  assert.equal(frames[0].payload.toString(), 'hello');
  assert.equal(rest.length, 0);
});

test('several frames in one read all come out, in order', () => {
  const buf = Buffer.concat([
    frame(OUT, Buffer.from('one')),
    frame(CTL, Buffer.from('{"a":1}')),
    frame(OUT, Buffer.from('two')),
  ]);
  const { frames, rest } = parseFrames(buf);
  assert.deepEqual(frames.map(f => f.payload.toString()), ['one', '{"a":1}', 'two']);
  assert.deepEqual(frames.map(f => f.kind), [OUT, CTL, OUT]);
  assert.equal(rest.length, 0);
});

// The whole reason for a length prefix.
test('a frame split across two reads is held until it is whole', () => {
  const f = frame(OUT, Buffer.from('abcdefghij'));
  for (const cut of [1, 2, 4, 5, 9, f.length - 1]) {
    const a = parseFrames(f.subarray(0, cut));
    assert.equal(a.frames.length, 0, `a ${cut}-byte read is not yet a frame`);
    const b = parseFrames(Buffer.concat([a.rest, f.subarray(cut)]));
    assert.equal(b.frames.length, 1);
    assert.equal(b.frames[0].payload.toString(), 'abcdefghij');
  }
});

test('terminal output full of newlines and nulls survives the framing', () => {
  const nasty = Buffer.from('\n\r\n\x00\x1b[2J\n\n\xff\xfe', 'binary');
  const { frames } = parseFrames(frame(OUT, nasty));
  assert.deepEqual([...frames[0].payload], [...nasty]);
});

test('an empty payload is a legal frame, not the end of the stream', () => {
  const { frames, rest } = parseFrames(frame(IN, Buffer.alloc(0)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 0);
  assert.equal(rest.length, 0);
});

test('control frames are JSON and say what they are', () => {
  const { frames } = parseFrames(control({ since: 42 }));
  assert.equal(frames[0].kind, CTL);
  assert.deepEqual(JSON.parse(frames[0].payload.toString()), { since: 42 });
});

// A pen runs `zsh -lc`, which reads .zprofile but never .zshrc, and its PATH is the
// server's. pm2 resurrected at boot hands the server launchd's bare PATH, so `claude`
// in ~/.local/bin was "command not found" (exit 127) for every pen after a reboot.
test('a pen PATH always carries the user install dirs, without duplicates', async () => {
  const { penPath } = await import('../src/server/ptyclient.js');
  const bare = '/opt/homebrew/bin:/usr/bin:/bin';
  const p = penPath(bare, '/Users/x').split(':');
  assert.equal(p[0], '/Users/x/.local/bin', 'the user install wins');
  assert.ok(p.includes('/usr/local/bin'));
  assert.equal(p.filter(d => d === '/opt/homebrew/bin').length, 1, 'no duplicates');
  assert.deepEqual(p.slice(-3), ['/opt/homebrew/bin', '/usr/bin', '/bin'], 'the rest keeps its order');
  assert.equal(penPath(penPath(bare, '/Users/x'), '/Users/x'), penPath(bare, '/Users/x'), 'idempotent');
  assert.ok(penPath('', '/Users/x').startsWith('/Users/x/.local/bin'));
});

// A pen that dies before the server attaches never sends us its exit frame, so the
// relay's file is the only witness. Restore reads this to give a dead resume back to
// the lost list instead of dropping the conversation.
test('the exit code of a finished relay comes from its file', async () => {
  const { exitFromMeta } = await import('../src/server/ptyclient.js');
  assert.equal(exitFromMeta({ alive: false, exitCode: 127 }), 127);
  assert.equal(exitFromMeta({ alive: true, exitCode: null }), undefined);
  assert.equal(exitFromMeta({ alive: false }), undefined, 'no code written, no guess');
  assert.equal(exitFromMeta(null), undefined);
});
