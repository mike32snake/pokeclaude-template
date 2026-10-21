// Which pens are listening on a port.
//
// A workspace running a dev server is a SERVICE, not an agent: state.js draws it
// differently and never tries to talk to it. Ports are the strongest signal for that,
// and cmux only reported them intermittently, so a server-ish title had to stand in and
// a dev server called something else was talked to like an agent.
//
// Owning the pty means we know each pen's own process, so the question can be asked
// properly. It is not a lookup though: `npm run dev` forks node, which forks the
// bundler, and the bundler is what binds the port. So it is a walk up the parent chain
// from each listener to see which pen, if any, it belongs to.
import { execFile } from 'node:child_process';

// `lsof -nP -iTCP -sTCP:LISTEN -Fpn` prints one field per line: p<pid>, then n<address>
// for each socket that pid holds. Addresses look like "*:3000", "127.0.0.1:5180" or
// "[::1]:3000", and the same port on two addresses is still one port.
export function parseListeners(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)) || null; continue; }
    if (line[0] !== 'n' || !pid) continue;
    const port = Number(line.slice(1).split(':').pop());
    if (!port) continue;
    const have = out.get(pid);
    if (!have) out.set(pid, [port]);
    else if (!have.includes(port)) have.push(port);
  }
  return out;
}

// `ps -axo pid,ppid` -> child to parent.
export function parseProcessTree(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

// A snapshot of a process table can be inconsistent - a pid reaped between the two
// commands, in principle a cycle - and an unbounded walk would hang the poll.
const MAX_DEPTH = 64;

export function portsByRoot(roots, listeners, tree) {
  const want = new Set(roots);
  const out = new Map(roots.map(r => [r, []]));
  for (const [pid, ports] of listeners) {
    let at = pid;
    for (let depth = 0; at && at > 1 && depth < MAX_DEPTH; depth++) {
      if (want.has(at)) {
        const have = out.get(at);
        for (const p of ports) if (!have.includes(p)) have.push(p);
        break;
      }
      at = tree.get(at);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

const run = (cmd, args, timeout = 5000) => new Promise((done) =>
  execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => done(err && !stdout ? '' : String(stdout || ''))));

// lsof is the slow one here, so the answer is cached: a port that opened a few seconds
// ago is not urgent, and this runs on every poll tick.
const TTL = 8000;
let cache = { at: 0, ports: new Map() };

export async function listeningPorts(roots, { now = Date.now() } = {}) {
  if (!roots.length) return new Map();
  if (now - cache.at < TTL) return cache.ports;
  const [lsof, ps] = await Promise.all([
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']),
    run('ps', ['-axo', 'pid,ppid']),
  ]);
  // A failed lsof keeps the last good answer rather than reporting that everything
  // stopped listening, which would turn every service back into an agent.
  if (!lsof) return cache.ports;
  cache = { at: now, ports: portsByRoot(roots, parseListeners(lsof), parseProcessTree(ps)) };
  return cache.ports;
}
