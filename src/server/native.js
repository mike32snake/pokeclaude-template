// Driving a pen whose pty we own, with the same shape cmux.js exposes.
//
// index.js talks to one module about terminals. This is the other implementation of
// that conversation: same function names, same { ok, stdout, stderr } results, backed
// by a pty relay and a vt.js screen instead of another application. Nothing here calls
// out to anything, so a read costs no syscall at all.
//
// Three things get simpler rather than faster, and they are the ones that were wrong.
// A newline in the composer is ESC CR, not a dance with Option+Enter - cmux turned
// every newline it was handed into a carriage return, which Claude Code reads as
// submit. Waiting for a keystroke to land is an event, not a poll. And the dimmed
// suggestion Claude Code paints in the empty composer is visibly dim, so probeDraft's
// type-a-letter-and-look is not needed.
import { cellRows } from './vt.js';
import { PtyAgent, startRelay, listRelays, relayAlive, socketPath, metaPath, exitFromMeta } from './ptyclient.js';
import fs from 'node:fs';
import { listeningPorts } from './ports.js';

// What each named key is on the wire. Claude Code and Codex both read a plain tty, so
// these are the sequences a terminal sends, not an RPC vocabulary.
const KEYS = {
  enter: '\r', escape: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  delete: '\x1b[3~', 'shift+tab': '\x1b[Z',
  // A newline INSIDE the composer. Both TUIs take ESC CR as "new line, do not submit".
  'alt+enter': '\x1b\r', 'shift+enter': '\x1b\r',
};
export const NAMED = Object.keys(KEYS);

export function keyBytes(key) {
  const k = String(key || '').toLowerCase();
  if (KEYS[k] !== undefined) return KEYS[k];
  // ctrl+<letter> is the letter with the top three bits cleared, which is all a
  // terminal has ever meant by it.
  const m = /^ctrl\+([a-z])$/.exec(k);
  return m ? String.fromCharCode(m[1].charCodeAt(0) - 96) : null;
}

// A message as bytes for the composer. The rule that matters: NO BARE CARRIAGE RETURN.
// Each one is a submit, which is how a three-line message went out as three messages.
export function typedBytes(text) {
  return String(text ?? '')
    .replace(/\t/g, '    ')          // Claude Code eats a Tab; spaces are what was meant
    .split(/\r\n?|\n/)
    .join(KEYS['alt+enter']);
}

// ---- the composer, read off the styled grid ---------------------------------------

const PROMPT = /^(\s*)([❯›>])(\s?)(.*)$/;
const RULE = /^\s*[─━-]{8,}\s*$/;
const CODEX_FOOTER = /^\s*(\S+)\s+(default|minimal|low|medium|high|xhigh|max|ultra)(?:\s+fast)?\s+·\s+\S/;
const ENDS_BOX = (t) => RULE.test(t) || CODEX_FOOTER.test(t) || /^\s*tab to queue message\b/i.test(t);

// What is in the composer, and whether it is really there. Claude Code paints a dimmed
// suggestion for the next prompt into the EMPTY box, in the place a draft would be, so
// "there is text here" is not the question. "Is any of it not dim" is.
export function composerDraft(rows) {
  let at = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    // The LAST prompt on screen. Codex draws past turns with the same glyph as its
    // composer, so scanning down would pick a finished turn.
    if (PROMPT.test(rows[i].text) && !ENDS_BOX(rows[i].text)) { at = i; break; }
  }
  if (at < 0) return { found: false, draft: '', ghost: false };

  const lines = [];
  const runs = [];
  const head = PROMPT.exec(rows[at].text);
  lines.push(head[4]);
  // Only the runs past the prompt glyph carry the answer about dimness.
  const from = head[1].length + head[2].length + head[3].length;
  for (const r of rows[at].runs) if (r.start >= from && r.text.trim()) runs.push(r);
  for (let i = at + 1; i < rows.length; i++) {
    if (ENDS_BOX(rows[i].text)) break;
    if (PROMPT.test(rows[i].text)) break;
    lines.push(rows[i].text.replace(/^\s{0,2}/, ''));
    for (const r of rows[i].runs) if (r.text.trim()) runs.push(r);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const draft = lines.join('\n').replace(/\s+$/, '');
  if (!draft.trim()) return { found: true, draft: '', ghost: false };
  // Every visible run dim means nothing here was typed by a person.
  const ghost = runs.length > 0 && runs.every(r => r.dim);
  return { found: true, draft: ghost ? '' : draft, ghost };
}

// ---- the agents this machine is hosting -------------------------------------------

const agents = new Map();                 // id -> PtyAgent
export const agentFor = (id) => agents.get(id) || null;
// How each pen that has gone ended. An exited pen leaves `agents`, so without this a
// caller waiting on it can only see "missing" and keep waiting.
const exits = new Map();                  // id -> exit code
export function exitCode(id) {
  if (exits.has(id)) return exits.get(id);
  try { return exitFromMeta(JSON.parse(fs.readFileSync(metaPath(id), 'utf8'))); }
  catch { return undefined; }
}
const forget = (id) => (code) => { exits.set(id, code); agents.delete(id); };

const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const no = (stderr) => ({ ok: false, stdout: '', stderr });
const missing = (id) => no(`no native agent ${id} is attached`);

// Attach to every relay still running, which is how a restarted server finds the pens
// it left behind. The ptys never went anywhere; only we did.
// Never throws. This runs at startup and on every poll tick, and a bad relay file must
// cost one pen, not the server.
export async function attachAll({ cols = 200, rows = 50 } = {}) {
  const found = [];
  // Never throws. This runs on every poll tick and at startup, and a bad relay file
  // must cost one pen, not the server.
  for (const meta of listRelays()) {
    if (!relayAlive(meta) || !fs.existsSync(socketPath(meta.id))) continue;
    if (agents.has(meta.id)) { found.push(meta.id); continue; }
    const a = new PtyAgent(meta.id, { cols: meta.cols || cols, rows: meta.rows || rows });
    const r = await a.attach();
    if (!r.ok) {
      // Nothing is listening on it, so it is a leftover rather than a pen. Clearing it
      // stops every future tick retrying the same dead file.
      try { fs.unlinkSync(socketPath(meta.id)); } catch {}
      continue;
    }
    a.meta = { ...meta, ...(a.meta || {}) };
    a.on('exit', forget(meta.id));
    agents.set(meta.id, a);
    found.push(meta.id);
  }
  return found;
}

// What each pen is listening on, refreshed off the critical path. state.js uses this to
// tell a dev server from an agent, and cmux only ever reported it intermittently.
let ports = new Map();
export async function refreshPorts() {
  const roots = [...agents.values()].map(a => a.meta?.pid).filter(Boolean);
  try { ports = await listeningPorts(roots); } catch { /* keep the last answer */ }
}

export function listWorkspaces() {
  return [...agents.values()].map((a, i) => ({
    id: a.id, ref: a.id, index: i,
    current_directory: a.meta?.cwd || null,
    title: a.title || a.meta?.command || '',
    listening_ports: ports.get(a.meta?.pid) || [],
    // The pen's own pty. linkSessions (sessions.js) ties a workspace to the Claude
    // session running in it by matching this, and a pen with no tty does not link -
    // it falls back to guessing the newest transcript in the directory, which is
    // another agent's conversation.
    tty: a.meta?.tty || null,
    native: true,
  }));
}

// cmux kept a status entry per workspace; nothing writes one here. Status comes from
// the hooks, which are fresher anyway, and from the screen for a Codex pen.
export const readSessionJson = () => [];
export const sessionJsonPath = null;
export const socketReachable = async () => true;

// The line the whole rewrite is for: no call, no socket, no process.
export function readScreen(id, lines = 40) {
  const a = agents.get(id);
  return a ? ok(a.text(lines)) : missing(id);
}
export const readText = readScreen;

export function rowsOf(id) {
  const a = agents.get(id);
  return a ? cellRows(a.screen) : null;
}

export async function send(id, text) {
  const a = agents.get(id);
  if (!a) return missing(id);
  if (!a.input(typedBytes(text))) return no('the agent is not attached');
  // Evidence, not a sleep - but the evidence is an event now rather than a poll.
  await a.settled({ timeout: 5000 });
  return ok();
}

export async function tap(id, key) {
  const a = agents.get(id);
  if (!a) return missing(id);
  const bytes = keyBytes(key);
  if (bytes === null) return no(`${key} is not a key PokeClaude can send`);
  if (!a.input(bytes)) return no('the agent is not attached');
  await a.settled({ timeout: 3000 });
  return ok();
}
export const press = tap;
export const sendKey = tap;

export async function sendLiteral(id, text) {
  const a = agents.get(id);
  if (!a) return missing(id);
  if (!a.input(String(text ?? ''))) return no('the agent is not attached');
  await a.settled({ timeout: 3000 });
  return ok();
}

// No probing: the styles say it outright.
export function probeDraft(id) {
  const rows = rowsOf(id);
  if (!rows) return missing(id);
  const d = composerDraft(rows);
  return { ok: true, ghost: d.ghost, draft: d.draft };
}

export async function newWorkspace(name, cwd, command, { cols = 200, rows = 50 } = {}) {
  const id = `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const started = await startRelay(id, cwd, command, { cols, rows });
  if (!started.ok) return { ...no(started.error || 'the relay did not start'), ref: null };
  const a = new PtyAgent(id, { cols, rows });
  const at = await a.attach();
  if (!at.ok) return { ...no(at.error || 'could not attach to the new agent'), ref: null };
  a.meta = { ...(a.meta || {}), id, cwd, command, cols, rows, name };
  a.on('exit', forget(id));
  agents.set(id, a);
  return { ...ok(id), ref: id };
}

export async function closeWorkspace(id) {
  const a = agents.get(id);
  if (!a) return missing(id);
  a.signal('TERM');
  a.detach();
  agents.delete(id);
  return ok();
}

// There is no window to bring forward, which is the point of not having one.
export const selectWorkspace = async () => ok();
// OPEN TAB has nowhere to go but our own terminal, so the panel is told to open that.
export const showWorkspace = async () => ({ ok: false, useTerminal: true, stdout: '', stderr: '' });

// Wait for the next redraw to end, or for `ms`, whichever is first. A pen that is not
// attached has nothing to wait for; the read after this says so.
export function settle(id, ms) {
  const a = agents.get(id);
  return a ? a.settled({ timeout: ms }) : Promise.resolve('missing');
}

export function resizeAgent(id, cols, rows) {
  const a = agents.get(id);
  return a ? (a.resize(cols, rows), ok()) : missing(id);
}

// Screen parsing is engine business, not transport business, so the readers stay where
// they are and both backends share them.
export { parseFooter, agentFacts, parseUsage, contextWindow, typedLines } from './cmux.js';
