// Which Claude session is running in which terminal.
//
// This is the ground truth for "what conversation is this Pokemon having", and it
// needs no hooks: cmux records a ttyName for every workspace panel, and the claude
// process sitting on that tty carries its own session id on its command line
// (--session-id, or --resume when the session was resumed into). From the session id
// and the workspace's directory the transcript path follows directly.
//
// Hook events remain useful for freshness, but they are in-memory only and a blocked
// agent never fires another one, so the hook link decays to nothing after a restart.
// This does not decay: it is recomputed from the live process table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { projectSlug } from './paths.js';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const UUID = '[0-9a-fA-F-]{36}';
const TTL = 5000;             // ps costs ~400ms; a 5s-old process table is still true

let cache = { at: 0, byTty: new Map() };

export function parsePs(text) {
  const byTty = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, tty, cmd] = m;
    if (tty === '??' || tty === '-' || !/\/claude(\s|$)/.test(cmd)) continue;
    // --session-id is the session it created; --resume is the one it continued into,
    // and Claude Code appends to that same transcript, so both name the right file.
    const sid = (cmd.match(new RegExp(`--session-id\\s+(${UUID})`)) ||
                 cmd.match(new RegExp(`--resume\\s+(${UUID})`)) || [])[1];
    if (!sid) continue;
    byTty.set(normalizeTty(tty), { pid: Number(pid), sessionId: sid.toLowerCase(),
                                   resumed: !/--session-id/.test(cmd) });
  }
  return byTty;
}

// ps prints "ttys004"; cmux records "ttys004". Accept "/dev/ttys004" from either side.
export function normalizeTty(t) {
  return String(t || '').replace(/^\/dev\//, '');
}

export function claudeByTty({ force = false, now = Date.now() } = {}) {
  if (!force && now - cache.at < TTL) return Promise.resolve(cache.byTty);
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid,tty,command'], { timeout: 8000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(cache.byTty);      // keep the last good table
        cache = { at: Date.now(), byTty: parsePs(stdout) };
        resolve(cache.byTty);
      });
  });
}

// The transcript a session writes to, if it is on disk yet.
export function transcriptForSession(rawDir, sessionId) {
  if (!rawDir || !sessionId) return null;
  let real = rawDir;
  try { real = fs.realpathSync(rawDir); } catch { /* a deleted dir is not fatal */ }
  const file = path.join(PROJECTS, projectSlug(real), sessionId + '.jsonl');
  return fs.existsSync(file) ? file : null;
}

// Attach sessionId/transcriptPath to every agent whose terminal is running Claude.
// Returns how many were linked, for the log.
// `byTty` can be handed in for a test; otherwise it is the live process table.
export async function linkSessions(state, { force = false, byTty = null } = {}) {
  byTty = byTty || await claudeByTty({ force });
  let linked = 0;
  for (const a of state.agents.values()) {
    // A tab with no terminal in it (see state.isHollow) has no process to link. Its
    // recorded tty is from before cmux relaunched, and that number now belongs to
    // whichever tab opened next, so matching on it hands it someone else's session.
    const hit = a.tty && !a.hollow ? byTty.get(normalizeTty(a.tty)) : null;
    if (!hit) { a.procSessionId = null; a.procTranscript = null; continue; }
    a.procSessionId = hit.sessionId;
    a.procPid = hit.pid;
    a.procTranscript = transcriptForSession(a.rawDir, hit.sessionId);
    // A workspace running Claude is an agent, whatever its title looks like.
    if (a.procTranscript) linked++;
    a.sessionId = a.sessionId || hit.sessionId;
  }
  return linked;
}
