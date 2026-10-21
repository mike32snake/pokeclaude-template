// The server's end of a pty relay.
//
// One relay process holds one agent's pty and outlives this server (tools/pty-agent.py
// says why). This attaches to it over a unix socket, feeds everything it reads into a
// vt.js screen, and writes keystrokes back. Reading the screen is then reading an
// object rather than asking another program, which is the whole point: cmux's fastest
// path is 1.6ms and this is zero.
//
// Frames are length-prefixed, never newline-delimited. Terminal output is binary and
// full of newlines, and a pty hands over whatever the kernel had ready, so a frame is
// routinely split across reads and two frames routinely arrive in one.
//
//     <4-byte big-endian length><1-byte type><payload>
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createScreen, write as vtWrite, toText, cellRows, resize as vtResize } from './vt.js';
import { BILLING_ENV } from './subscriptions.js';

export const OUT = 1, IN = 2, CTL = 3;
// Overridable so the tests can run relays in a temp directory rather than beside the
// real agents. Nothing else sets it.
export const ROOT = process.env.POKECLAUDE_PTY_ROOT
  || path.join(os.homedir(), '.pokeclaude', 'pty');
const AGENT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..',
                        'tools', 'pty-agent.py');

export function frame(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1, 0);     // the length counts the kind byte
  head[4] = kind;
  return Buffer.concat([head, body]);
}

export const control = (obj) => frame(CTL, Buffer.from(JSON.stringify(obj)));

// Everything whole in `buf`, plus whatever is left over to prepend to the next read.
export function parseFrames(buf) {
  const frames = [];
  let at = 0;
  while (buf.length - at >= 5) {
    const n = buf.readUInt32BE(at);
    if (buf.length - at < 4 + n) break;
    frames.push({ kind: buf[at + 4], payload: buf.subarray(at + 5, at + 4 + n) });
    at += 4 + n;
  }
  return { frames, rest: buf.subarray(at) };
}

export const socketPath = (id) => path.join(ROOT, `${id}.sock`);
export const metaPath = (id) => path.join(ROOT, `${id}.json`);

// Every relay this machine has, alive or finished. This is how the server rediscovers
// its agents after a restart: the ptys never went anywhere, only we did.
export function listRelays(root = ROOT) {
  try {
    return fs.readdirSync(root)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return null; } })
      .filter(m => m && m.id)
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  } catch { return []; }
}

// A relay whose process is gone is not a live agent, whatever its file says: the file
// is only rewritten on a clean exit, and a killed relay never gets to.
export function relayAlive(meta) {
  if (!meta || meta.alive === false) return false;
  try { process.kill(meta.relayPid, 0); return true; } catch { return false; }
}

// Where your CLIs usually live, whatever PATH this server was born with. A pen runs
// `zsh -lc`, which never reads .zshrc, and inherits our PATH. pm2 resurrected at boot
// has launchd's bare one, so `claude` in ~/.local/bin was "command not found" (exit
// 127) for every pen after a reboot. Missing dirs go first; the rest keeps its order.
export function penPath(current, home = os.homedir()) {
  const have = String(current || '').split(':').filter(Boolean);
  const want = [path.join(home, '.local/bin'), path.join(home, '.claude/local'),
                '/opt/homebrew/bin', '/usr/local/bin'];
  return [...want.filter(d => !have.includes(d)), ...have].join(':');
}

// A relay that finished writes its exit code into its file. A pen that dies before we
// attach never sends us the exit frame, so this is the only place that code survives.
export function exitFromMeta(meta) {
  if (!meta || meta.alive !== false) return undefined;
  return Number.isInteger(meta.exitCode) ? meta.exitCode : undefined;
}

export function startRelay(id, cwd, command, { cols = 200, rows = 50 } = {}) {
  // A pen spends from the SUBSCRIPTION. It runs under a login shell, so a stray
  // ANTHROPIC_API_KEY in a profile - or one `source ~/.claude/bedrock.env` - would
  // quietly move every pen onto metered billing with nothing on screen to show it.
  const child = spawn('python3', [AGENT, '--id', id, '--cwd', cwd, '--command', command,
                                  '--cols', String(cols), '--rows', String(rows),
                                  '--scrub', BILLING_ENV.join(',')],
                      { stdio: 'ignore', detached: true,
                        env: { ...process.env, PATH: penPath(process.env.PATH) } });
  child.unref();
  return new Promise((resolve) => {
    // The relay daemonizes, so the process we spawned exits immediately. What says it
    // is ready is the socket appearing.
    const started = Date.now();
    const look = () => {
      if (fs.existsSync(socketPath(id))) return resolve({ ok: true, id });
      if (Date.now() - started > 10_000) return resolve({ ok: false, id, error: 'the relay did not come up' });
      setTimeout(look, 25);
    };
    look();
  });
}

// One attached agent: a socket, a screen, and the byte offset we have consumed. The
// offset is what makes a reconnect exact - the relay replays only what we missed.
export class PtyAgent extends EventEmitter {
  constructor(id, { cols = 200, rows = 50 } = {}) {
    super();
    this.id = id;
    this.screen = createScreen(cols, rows);
    this.offset = 0;
    this.connected = false;
    this.exitCode = undefined;
    this.buf = Buffer.alloc(0);
    this.sock = null;
  }

  attach() {
    return new Promise((resolve) => {
      const sock = net.createConnection(socketPath(this.id));
      this.sock = sock;
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      sock.on('connect', () => {
        this.connected = true;
        sock.write(control({ since: this.offset }));
        done({ ok: true });
      });
      sock.on('data', (d) => this.#feed(d));
      sock.on('error', (e) => {
        this.connected = false;
        // Never a bare emit('error'). An EventEmitter with no 'error' listener THROWS,
        // so one socket file left behind by a killed relay took the whole server down
        // on startup, before it had drawn anything. The failure is the resolved value.
        this.lastError = String(e);
        if (this.listenerCount('error')) this.emit('error', e);
        done({ ok: false, error: String(e) });
      });
      sock.on('close', () => { this.connected = false; this.emit('detach'); });
    });
  }

  #feed(data) {
    const { frames, rest } = parseFrames(Buffer.concat([this.buf, data]));
    this.buf = Buffer.from(rest);
    for (const f of frames) {
      if (f.kind === OUT) {
        this.offset += f.payload.length;
        // The replies vt.js works out are deliberately dropped: the relay answers the
        // terminal's queries itself, so that an agent whose server is restarting does
        // not stall waiting to be told what kind of terminal it is.
        vtWrite(this.screen, f.payload);
        this.emit('output', f.payload);
      } else if (f.kind === CTL) {
        let msg = null;
        try { msg = JSON.parse(f.payload.toString()); } catch { continue; }
        // Merged, never replaced. The greeting and whatever the caller already knew
        // arrive in either order, and replacing lost the tty about half the time.
        if (msg.offset !== undefined) { this.offset = msg.offset; this.meta = { ...(this.meta || {}), ...msg }; }
        if (msg.exit !== undefined) { this.exitCode = msg.exit; this.emit('exit', msg.exit); }
      }
    }
  }

  #send(buf) {
    if (!this.connected || !this.sock) return false;
    this.sock.write(buf);
    return true;
  }

  input(text) { return this.#send(frame(IN, Buffer.from(text, 'utf8'))); }
  resize(cols, rows) {
    vtResize(this.screen, cols, rows);
    return this.#send(control({ resize: { cols, rows } }));
  }
  signal(name) { return this.#send(control({ signal: name })); }
  detach() { try { this.sock?.end(); } catch {} }

  // The screen, with no call to anyone. This is the line that the whole rewrite is for.
  text(lines) { return toText(this.screen, lines); }
  rows() { return cellRows(this.screen); }
  get frame() { return this.screen.frame; }
  get title() { return this.screen.title; }

  // Wait for the TUI to finish a redraw. Both CLIs bracket their frames with
  // synchronized-output (?2026), so this is an exact signal rather than a poll, which
  // is what typeInto's settle loop was faking at a round trip per look.
  settled({ timeout = 2000, quiet = 60 } = {}) {
    return new Promise((resolve) => {
      const start = this.screen.frame;
      let timer = null, idle = null;
      const finish = (why) => { clearTimeout(timer); clearTimeout(idle); this.off('output', onOut); resolve(why); };
      const onOut = () => {
        clearTimeout(idle);
        // A TUI that never sends ?2026 still stops sending bytes when it is done.
        idle = setTimeout(() => finish('quiet'), quiet);
        if (this.screen.frame > start && !this.screen.syncing) finish('frame');
      };
      this.on('output', onOut);
      idle = setTimeout(() => finish('quiet'), quiet);
      timer = setTimeout(() => finish('timeout'), timeout);
    });
  }
}
