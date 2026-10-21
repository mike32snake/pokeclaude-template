// The relay end to end: a real pty, a real child, a real unix socket.
//
// These tests spawn tools/pty-agent.py for real, in a temp directory, because the one
// claim worth proving cannot be faked - that an agent SURVIVES THE SERVER GOING AWAY.
// run-server.sh is a restart loop and `pkill -f "node src/server/index.js"` is the
// deploy, so if the pty died with the server every deploy would kill every pen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pty-'));
process.env.POKECLAUDE_PTY_ROOT = ROOT;
const { PtyAgent, startRelay, listRelays, relayAlive, socketPath } =
  await import('../src/server/ptyclient.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const started = [];
async function relay(id, command, cwd = ROOT) {
  const r = await startRelay(id, cwd, command, { cols: 80, rows: 12 });
  assert.equal(r.ok, true, `the relay for ${id} did not come up`);
  started.push(id);
  return r;
}
// Wait for `test(agent)` rather than sleeping a guessed amount.
async function until(agent, test, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (test(agent)) return true; await sleep(25); }
  return false;
}

// Leave nothing running. A relay that survives its test is the same bug as a relay
// that survives a deploy, only less welcome.
test.after(async () => {
  await Promise.all(started.map(async (id) => {
    if (!fs.existsSync(socketPath(id))) return;      // already exited on its own
    try {
      const a = new PtyAgent(id);
      const r = await a.attach();
      if (r.ok) { a.signal('KILL'); await sleep(50); a.detach(); }
    } catch {}
  }));
  await sleep(400);
  for (const m of listRelays(ROOT)) {
    try { if (relayAlive(m)) process.kill(m.relayPid, 'SIGKILL'); } catch {}
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('a relay runs a command and the screen shows its output', async () => {
  await relay('echo1', 'echo hello-from-the-pty; sleep 30');
  const a = new PtyAgent('echo1', { cols: 80, rows: 12 });
  assert.equal((await a.attach()).ok, true);
  assert.ok(await until(a, x => /hello-from-the-pty/.test(x.text())), a.text());
  a.detach();
});

test('the child really is on a tty, which is what a TUI insists on', async () => {
  await relay('tty1', 'test -t 0 && echo IS-A-TTY || echo NOT-A-TTY; sleep 30');
  const a = new PtyAgent('tty1', { cols: 80, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => /IS-A-TTY/.test(x.text())), a.text());
  assert.ok(!/NOT-A-TTY/.test(a.text()));
  a.detach();
});

test('the window size the relay was given is the size the child sees', async () => {
  await relay('size1', 'stty size; sleep 30');
  const a = new PtyAgent('size1', { cols: 80, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => /12 80/.test(x.text())), a.text());
  a.detach();
});

test('typing goes in and what the shell echoes comes back', async () => {
  await relay('input1', 'cat');
  const a = new PtyAgent('input1', { cols: 80, rows: 12 });
  await a.attach();
  await sleep(300);
  a.input('typed-into-the-pty\n');
  assert.ok(await until(a, x => /typed-into-the-pty/.test(x.text())), a.text());
  a.detach();
});

// The reason the relay is a separate process at all.
test('the agent outlives the client detaching, and the client catches up on reattach', async () => {
  await relay('survive1', 'for i in 1 2 3 4 5 6; do echo tick-$i; sleep 0.4; done; sleep 30');
  const first = new PtyAgent('survive1', { cols: 80, rows: 12 });
  await first.attach();
  assert.ok(await until(first, x => /tick-1/.test(x.text())), first.text());
  first.detach();                       // this is a server restart

  await sleep(1500);                    // the agent keeps working with nobody watching

  const second = new PtyAgent('survive1', { cols: 80, rows: 12 });
  assert.equal((await second.attach()).ok, true);
  assert.ok(await until(second, x => /tick-6/.test(x.text())),
    `a reattached client must see what happened while it was gone:\n${second.text()}`);
  // The replayed history rebuilt the whole screen, not just what arrived after.
  assert.match(second.text(), /tick-1/);
  second.detach();
});

test('two clients can watch one agent at the same time', async () => {
  await relay('shared1', 'echo shared-output; sleep 30');
  const a = new PtyAgent('shared1', { cols: 80, rows: 12 });
  const b = new PtyAgent('shared1', { cols: 80, rows: 12 });
  await a.attach(); await b.attach();
  assert.ok(await until(a, x => /shared-output/.test(x.text())));
  assert.ok(await until(b, x => /shared-output/.test(x.text())));
  a.detach(); b.detach();
});

// The socket appearing is what everything treats as "ready", so everything else must
// already be there. It was not: the socket was bound before the metadata was written,
// so a server attaching in that window saw a pen with no directory and no command.
// This asserts with no wait at all, deliberately.
test('a relay is discoverable on disk, which is how a restarted server finds its pens', async () => {
  await relay('found1', 'sleep 30');
  const rows = listRelays(ROOT);
  const mine = rows.find(r => r.id === 'found1');
  assert.ok(mine, 'the relay must write a metadata file');
  assert.equal(mine.command, 'sleep 30');
  assert.equal(mine.cwd, ROOT);
  assert.ok(mine.pid > 0 && mine.relayPid > 0);
  assert.equal(relayAlive(mine), true);
});

test('when the command exits the agent says so and clears its socket', async () => {
  await relay('exit1', 'echo bye; exit 7');
  const a = new PtyAgent('exit1', { cols: 80, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => x.exitCode !== undefined), 'no exit was reported');
  assert.ok(await until(a, () => !fs.existsSync(socketPath('exit1'))), 'the socket was left behind');
  const meta = listRelays(ROOT).find(r => r.id === 'exit1');
  assert.equal(meta.alive, false);
  assert.equal(relayAlive(meta), false);
});

// The env var replaces cmux's CMUX_WORKSPACE_ID, which is how hooks/pokeclaude-hook.sh
// reports which pen an event came from.
test('the child knows which agent it is, so the hook can say', async () => {
  await relay('envid1', 'echo "id=[$POKECLAUDE_AGENT_ID]"; sleep 30');
  const a = new PtyAgent('envid1', { cols: 80, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => /id=\[envid1\]/.test(x.text())), a.text());
  a.detach();
});

// A pen spends from the subscription, which AGENTS.md has claimed all along and
// nothing enforced. `claude` prefers ANTHROPIC_API_KEY over its Keychain login and
// `codex` prefers OPENAI_API_KEY over the ChatGPT plan, so one variable moves every pen
// onto metered billing with nothing on screen to show it. A pen runs under a LOGIN
// shell, so the profile is read too - and this test is what stops the scrub list in
// subscriptions.js drifting away from what the relay actually strips.
test('a pen never inherits a key that would bill around the subscription', async () => {
  const poison = {
    ANTHROPIC_API_KEY: 'sk-ant-should-not-reach-the-pen',
    OPENAI_API_KEY: 'sk-should-not-reach-the-pen',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_BEARER_TOKEN_BEDROCK: 'should-not-reach-the-pen',
    ANTHROPIC_MODEL: 'some.bedrock.profile',
  };
  Object.assign(process.env, poison);
  try {
    await relay('billing1',
      'echo "A=[$ANTHROPIC_API_KEY] O=[$OPENAI_API_KEY] B=[$CLAUDE_CODE_USE_BEDROCK] '
      + 'T=[$AWS_BEARER_TOKEN_BEDROCK] M=[$ANTHROPIC_MODEL]"; sleep 30');
    const a = new PtyAgent('billing1', { cols: 120, rows: 12 });
    await a.attach();
    assert.ok(await until(a, x => /A=\[/.test(x.text())), a.text());
    const line = a.text().split('\n').find(l => l.includes('A=['));
    assert.match(line, /A=\[\] O=\[\] B=\[\] T=\[\] M=\[\]/,
      `a billing variable reached the pen: ${line}`);
    assert.ok(!/should-not-reach-the-pen/.test(a.text()));
    a.detach();
  } finally {
    for (const k of Object.keys(poison)) delete process.env[k];
  }
});

// The pen still has to be able to sign in, so the scrub must not take the login with it.
test('what the subscription login itself needs is left alone', async () => {
  await relay('home1', 'echo "H=[$HOME] P=[${PATH:0:4}]"; sleep 30');
  const a = new PtyAgent('home1', { cols: 120, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => /H=\[/.test(x.text())), a.text());
  assert.match(a.text(), /H=\[\/Users\//);
  a.detach();
});

// PokeClaude ties a pen to the Claude session running in it by TTY (sessions.js,
// linkSessions). A pen with no tty never links, and transcriptFor then falls back to
// the newest transcript in the directory - which is a different agent's conversation.
// It showed up as a brand new Haiku pen reporting another session's model and context.
test('a pen reports the tty its process is actually on', async () => {
  await relay('tty2', 'tty; sleep 30');
  const a = new PtyAgent('tty2', { cols: 80, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => /\/dev\/ttys\d+/.test(x.text())), a.text());
  const onScreen = a.text().match(/\/dev\/ttys\d+/)[0];
  const meta = listRelays(ROOT).find(r => r.id === 'tty2');
  assert.equal(meta.tty, onScreen, 'the recorded tty is not the one the child is on');
  a.detach();
});

// A socket file left by a relay that was killed is not a relay. Attaching to it fails
// with ECONNREFUSED, and the first version emitted that as an 'error' event - which on
// an EventEmitter with no listener THROWS, so one stale file killed the whole server on
// startup, before it had drawn anything.
test('a stale socket fails the attach without taking the process down', async () => {
  const dead = path.join(ROOT, 'ghost1.sock');
  fs.writeFileSync(dead, '');
  fs.writeFileSync(path.join(ROOT, 'ghost1.json'), JSON.stringify({
    id: 'ghost1', cwd: ROOT, command: 'sleep 1', pid: 1, relayPid: process.pid,
    alive: true, cols: 80, rows: 12, startedAt: Date.now(),
  }));
  const a = new PtyAgent('ghost1', { cols: 80, rows: 12 });
  const r = await a.attach();
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED|ENOTSOCK|ECONNRESET/);
  await sleep(100);                         // an unhandled 'error' would have thrown by now
  fs.rmSync(dead, { force: true });
  fs.rmSync(path.join(ROOT, 'ghost1.json'), { force: true });
});

// The tty has to reach a client that never read the metadata file, because that is how
// newWorkspace attaches. It arrives in the greeting, and the greeting is MERGED into
// whatever the caller already knew rather than replacing it - the two arrive in either
// order, and replacing lost the tty about half the time.
test('an attached client learns the pens tty from the greeting alone', async () => {
  await relay('tty3', 'sleep 30');
  const a = new PtyAgent('tty3', { cols: 80, rows: 12 });
  await a.attach();
  assert.ok(await until(a, x => x.meta?.tty), 'the greeting carried no tty');
  assert.match(a.meta.tty, /^\/dev\/ttys\d+$/);
  assert.equal(a.meta.cwd, ROOT, 'and the rest of the greeting survived');
  a.detach();
});
