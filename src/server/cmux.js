import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { composerRegion, draftOnScreen, CODEX_FOOTER, inputBoxState } from './screen.js';

const CLI = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const SESSION_JSON = `${os.homedir()}/Library/Application Support/cmux/session-com.cmuxterm.app.json`;

// cmux's socket is "cmuxOnly": it only accepts control from processes inside the
// cmux session. A password (set in cmux Settings) lifts that for outside processes
// such as a pm2-supervised server. Read it from env or a gitignored .env.
function socketPassword() {
  if (process.env.CMUX_SOCKET_PASSWORD) return process.env.CMUX_SOCKET_PASSWORD;
  try {
    const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
    const m = fs.readFileSync(path.join(root, '.env'), 'utf8')
      .match(/^\s*CMUX_SOCKET_PASSWORD\s*=\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}
const PASSWORD = socketPassword();

export function cmux(args, { timeout = 8000 } = {}) {
  const full = PASSWORD ? ['--password', PASSWORD, ...args] : args;
  return new Promise((resolve) => {
    execFile(CLI, full, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// True when the cmux control socket is reachable from this process.
export async function socketReachable() {
  const r = await cmux(['ping'], { timeout: 4000 });
  return r.ok && /PONG/.test(r.stdout);
}

// workspace.list carries no tty, and the session file that does is only saved now and
// then: a tab opened since the last save has no row, and a closed tab's row lingers with
// its old tty. The live tree has the terminal's tty for every tab, so each workspace
// gets it from there. A pen with no tty never links to its process (sessions.js,
// linkCodex), and a Codex pen with no link refuses every reply.
export function ttysFromTree(tree) {
  const out = new Map();
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const w of list(tree?.windows)) {
    for (const ws of list(w?.workspaces)) {
      const tty = list(ws?.panes).flatMap(p => list(p?.surfaces))
        .find(s => s?.type === 'terminal' && s.tty)?.tty;
      if (ws?.ref && tty) out.set(ws.ref, tty);
    }
  }
  return out;
}

export async function listWorkspaces() {
  const [r, t] = await Promise.all([
    cmux(['rpc', 'workspace.list', '{}']),
    cmux(['tree', '--all', '--json']),
  ]);
  if (!r.ok) return [];
  let ws;
  try { ws = JSON.parse(r.stdout).workspaces || []; } catch { return []; }
  let ttys = new Map();
  try { if (t.ok) ttys = ttysFromTree(JSON.parse(t.stdout)); } catch {}
  for (const w of ws) if (ttys.has(w.ref)) w.tty = ttys.get(w.ref);
  return ws;
}

export const DEV_TITLE = /\b(server|dev|watch|pm2|vite|next|webpack|tunnel|ngrok|daemon)\b/i;

export function readSessionJson() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSION_JSON, 'utf8'));
    const out = [];
    for (const w of d.windows || []) {
      for (const ws of w.tabManager?.workspaces || []) {
        const st = (ws.statusEntries || []).find(s => s.key === 'claude_code');
        // The panel's ttyName is how a workspace is tied to the actual Claude process,
        // which is the only link that survives a server restart. See sessions.js.
        const tty = (ws.panels || []).map(pn => pn?.ttyName).find(Boolean) || null;
        out.push({
          dir: ws.currentDirectory,
          tty,
          processTitle: ws.processTitle || null,
          customTitle: ws.customTitle || null,
          branch: ws.gitBranch?.branch || null,
          status: st ? st.value : null,           // "Running" | "Needs input" | "Idle"
          statusAt: st ? st.timestamp * 1000 : null,
        });
      }
    }
    return out;
  } catch { return []; }
}

export const sessionJsonPath = SESSION_JSON;

// The lines of a message as they will be typed. Two keys are not what they look
// like: a Tab is a key Claude Code eats, so it becomes spaces; and a backslash right
// before a newline is eaten too (Claude Code's own continuation rule), so it gets a
// space after it.
export function typedLines(text) {
  const t = String(text ?? '');
  if (!t) return [];
  const lines = t.replace(/\t/g, '    ').split(/\r\n?|\n/);
  return lines.map((line, i) => i < lines.length - 1 && line.endsWith('\\') ? line + ' ' : line);
}
// The CLI costs ~200ms per exec, which for a pasted 40-line report is eight seconds
// of typing. The socket takes the same JSON-RPC call in a millisecond. The CLI stays
// for the password case, which it knows how to present and this does not, and as
// the fallback when the socket itself cannot be reached.
const SOCK = `${os.homedir()}/Library/Application Support/cmux/cmux.sock`;
export function rpcSocket(method, params, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let done = false, buf = '';
    const sock = net.createConnection(SOCK);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, stdout: '', stderr: 'cmux socket timed out', transport: true }), timeout);
    sock.on('connect', () => sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const r = JSON.parse(line);
        finish({ ok: r.ok === true, stdout: line, stderr: r.ok ? '' : (r.error?.message || line) });
      } catch { finish({ ok: false, stdout: line, stderr: 'unreadable reply from cmux', transport: true }); }
    });
    sock.on('error', (e) => finish({ ok: false, stdout: '', stderr: String(e), transport: true }));
  });
}
// Always address the terminal explicitly: browser focus must not redirect chat.
export function terminalSurface(surfaces) {
  const terminals = (surfaces || []).filter(s => s.type === 'terminal');
  return terminals.length === 1 ? (terminals[0].id || terminals[0].ref) : null;
}
async function terminalTarget(ws) {
  const r = await cmux(['rpc', 'surface.list', JSON.stringify({ workspace_id: ws })]);
  if (!r.ok) return null;
  try { return terminalSurface(JSON.parse(r.stdout).surfaces); } catch { return null; }
}
const targetFailure = () => ({ ok: false, stdout: '', stderr: 'Could not identify a unique terminal for this workspace.' });
async function sendText(ws, text) {
  const surface = await terminalTarget(ws);
  if (!surface) return targetFailure();
  const params = { workspace_id: ws, surface_id: surface, text };
  if (!PASSWORD) {
    const r = await rpcSocket('surface.send_text', params);
    if (r.ok || !r.transport) return r;
  }
  return cmux(['rpc', 'surface.send_text', JSON.stringify(params)]);
}
async function sendKeyFast(ws, key) {
  const surface = await terminalTarget(ws);
  if (!surface) return targetFailure();
  const params = { workspace_id: ws, surface_id: surface, key };
  if (!PASSWORD) {
    const r = await rpcSocket('surface.send_key', params);
    if (r.ok || !r.transport) return r;
  }
  return sendKey(ws, key);
}
// The pane's text over the socket, in the same { ok, stdout } shape as readScreen.
export async function readText(ws, lines = 40) {
  const surface = await terminalTarget(ws);
  if (!surface) return targetFailure();
  if (!PASSWORD) {
    const r = await rpcSocket('surface.read_text', { workspace_id: ws, surface_id: surface, lines });
    if (r.ok) {
      try {
        const b64 = JSON.parse(r.stdout).result?.base64 || '';
        return { ok: true, stdout: Buffer.from(b64, 'base64').toString('utf8'), stderr: '' };
      } catch {}
    } else if (!r.transport) return r;
  }
  return readScreen(ws, lines);
}

// Typing a message into a Claude Code pane, one line at a time.
//
// A newline is the whole problem. cmux turns every newline in text it is handed into
// a carriage return, and to Claude Code a carriage return is Enter: a three-line
// message was three submits, the first line going out alone and the rest sitting in
// the box until the next Enter sent them glued to whatever came next. Claude Code's
// own continuation (backslash, then Enter) works only when the two arrive as
// separate reads, and whenever the pane is busy for a moment they arrive as one and
// the CR is typed as a literal. Bracketed paste, Ctrl+J and the Shift+Enter escape
// sequences were each tried on a live pane and each typed junk.
//
// What works: Option+Enter, which cmux's send-key emits as ESC CR in one write and
// Claude Code takes as a newline. So text goes out with no CR in it at all, every
// newline is its own keypress, and nothing is sent until the pane has shown that it
// took the previous thing. Evidence, not a sleep: a pane that has just finished a
// turn can sit on its input for a second or more, and a sleep long enough for that
// is too long for everything else. Past roughly 200 characters in one read Claude
// Code treats input as a paste, which for a line with no newline in it is harmless.
const SETTLE_POLL_MS = 10, SETTLE_POLLS = 500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const squash = (s) => (s || '').replace(/\s+/g, '');
// The composer region of the screen, untrimmed, so a fresh empty line counts as a
// change; and the draft as text, for looking up what was typed. Both come from
// screen.js, which is the one place that knows what a composer looks like in each
// engine - Claude Code closes its box with a rule, Codex closes it with nothing.
const snapshot = (screen) => ({ raw: composerRegion(screen), draft: draftOnScreen(screen), gate: inputBoxState(screen) });
// A read that fails is tried again: it is not evidence of anything.
async function look(io, ws) {
  for (let n = 0; n < 5; n++) {
    const r = await io.read(ws, 40);
    if (r.ok) return snapshot(r.stdout);
    await io.sleep(SETTLE_POLL_MS);
  }
  return null;
}
// The composer once it has stopped moving: two reads alike. A render can arrive in
// more than one frame, and a snapshot taken between frames makes the next frame
// look like the next keystroke landing.
async function settled(io, ws) {
  let last = await look(io, ws);
  for (let n = 0; n < 10; n++) {
    await io.sleep(SETTLE_POLL_MS);
    const now = await look(io, ws);
    if (now?.raw === last?.raw) return now;
    last = now;
  }
  return last;
}
// Wait until `test(now)` says the pane shows what was just sent. False after the limit.
async function until(io, ws, test) {
  for (let n = 0; n < SETTLE_POLLS; n++) {
    const now = await look(io, ws);
    if (now && test(now)) return true;
    await io.sleep(SETTLE_POLL_MS);
  }
  return false;
}
const pastes = (s) => (squash(s).match(/\[(?:Pastedtext#|Image#)/g) || []).length;
export async function typeInto(ws, text, io = { write: sendText, key: sendKeyFast, read: readText, sleep }) {
  const lines = typedLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], last = i === lines.length - 1;
    if (line.trim()) {
      const key = squash(line).slice(-16);
      const before = await settled(io, ws);
      if (!before) return { ok: false, stderr: 'could not read the composer before typing' };
      const r = await io.write(ws, line);
      if (!r.ok) return r;
      // Any change is not evidence: the line's own tail showing up at the end of the
      // box is, or, for a line long enough that Claude Code folded it, a new marker.
      const ok = await until(io, ws, (now) => now.raw !== before.raw
        && (squash(now.draft).endsWith(key) || pastes(now.draft) > pastes(before.draft)));
      if (!ok) return { ok: false, stdout: '', stderr: `the tab did not take line ${i + 1} within ${SETTLE_POLL_MS * SETTLE_POLLS / 1000}s` };
    } else if (line) {
      const r = await io.write(ws, line);       // whitespace only: nothing to look for
      if (!r.ok) return r;
      await io.sleep(SETTLE_POLL_MS);
    }
    if (!last) {
      const before = await settled(io, ws);
      if (!before) return { ok: false, stderr: 'could not read the composer before a newline' };
      const r = await io.key(ws, 'alt+enter');
      if (!r.ok) return r;
      const ok = await until(io, ws, (now) => now.raw !== before.raw);
      if (!ok) return { ok: false, stdout: '', stderr: `the tab did not take the newline after line ${i + 1}` };
    }
  }
  return { ok: true, stdout: '', stderr: '' };
}
export const send = (ws, text) => typeInto(ws, text);

// Is the text in the box a draft, or a suggestion Claude Code painted there?
//
// After a turn Claude Code paints a dimmed suggestion for the next prompt in the
// EMPTY composer, and Tab takes it. read-screen has no styles, so on paper it is a
// draft: every send to that pane was refused for "unsent text", and "discard" pressed
// backspace fifty times over a box that held nothing, then reported the text still
// there. Only its behaviour tells the two apart, tested live: backspace does nothing
// to a suggestion, typing replaces it, and emptying the box brings it back.
//
// So the pane is asked. Type one letter and look: a box that shows only the letter
// held nothing. A real draft shows the letter on its end, and the backspace after
// takes it back off, so the draft comes through untouched, trailing space and all.
// Nothing in the box is a plain no. `ok: false` means the pane could not be asked.
function insertionOfX(before, after) {
  // The cursor may be in the middle of a draft, not at its end.
  for (let i = 0; i < after.length; i++) {
    if (after[i] === 'x' && (after.slice(0, i) + after.slice(i + 1)).trim() === before) return true;
  }
  return false;
}
export async function probeDraft(ws, io = { write: sendText, key: sendKeyFast, read: readText, sleep }) {
  const before = await settled(io, ws);
  if (!before) return { ok: false, stderr: 'could not read the terminal' };
  if (!before.gate.ok && !before.gate.draft) return { ok: false, stderr: before.gate.reason };
  if (!before.draft) return { ghost: false, draft: '' };
  const w = await io.write(ws, 'x');
  if (!w.ok) return { ...w, ok: false };
  let seen = null;
  const shown = await until(io, ws, (now) => { seen = now; return now.raw !== before.raw && (now.draft === 'x' || insertionOfX(before.draft, now.draft)); });
  if (!shown) return { ok: false, stdout: '', stderr: 'the tab did not take a keystroke' };
  const ghost = squash(seen.draft) === 'x';
  const k = await io.key(ws, 'backspace');
  if (!k.ok) return { ...k, ok: false };
  // Either way the box changes back: the draft loses the letter, or the suggestion
  // returns to the emptied box.
  const restored = await until(io, ws, (now) => ghost ? now.raw !== seen.raw && now.draft !== 'x' : now.draft === before.draft);
  if (!restored) return { ok: false, stderr: 'the probe could not verify cleanup; refresh the terminal before sending' };
  return { ghost, draft: before.draft };
}
// A named key over the socket, for when there are dozens to press: clearing a draft
// one backspace at a time is 50ms this way and ten seconds through the CLI.
export const sendLiteral = (ws, text) => sendText(ws, text);
export const tap = (ws, key) => sendKeyFast(ws, key);
// cmux's send-key only accepts NAMED keys (enter, up, escape...). Digits and other
// characters must go through `send` as text, or it returns "Unknown key" and the
// keystroke is silently lost.
export const sendKey = async (ws, key) => {
  const surface = await terminalTarget(ws);
  return surface ? cmux(['send-key', '--workspace', ws, '--surface', surface, key]) : targetFailure();
};
export const NAMED_KEY = /^(enter|escape|tab|space|backspace|up|down|left|right|home|end|pageup|pagedown|ctrl\+\w|shift\+\w+)$/i;
export const press = (ws, key) =>
  NAMED_KEY.test(key) ? sendKey(ws, key) : cmux(['send', '--workspace', ws, key]);
export const selectWorkspace = (ws) => cmux(['select-workspace', '--workspace', ws]);
export const closeWorkspace = (ws) => cmux(['close-workspace', '--workspace', ws]);
export const readScreen = async (ws, lines = 40) => {
  const surface = await terminalTarget(ws);
  return surface ? cmux(['read-screen', '--workspace', ws, '--surface', surface, '--lines', String(lines)]) : targetFailure();
};
// Returns the new workspace's ref, parsed from cmux's own output. Never look the new
// workspace up by title: several can share one, and you will drive the wrong terminal.
export async function newWorkspace(name, cwd, command) {
  const r = await cmux(['new-workspace', '--name', name, '--cwd', cwd, '--command', command]);
  const m = (r.stdout || '').match(/workspace:\d+/);
  return { ...r, ref: m ? m[0] : null };
}

// Account-level usage from the Claude Code footer:
//   5h ●●○○○○○○○○  22% ⟳ 4:30pm  │  7d ●●●●○○○○○○  44% ⟳ aug 24, 11:00am
export function parseUsage(screen) {
  const out = { model: null, window5h: null, window7d: null, resets5h: null, resets7d: null };
  for (const line of (screen || '').split('\n')) {
    const m5 = line.match(/\b5h\b[^\d]*?(\d+)%\s*(?:⟳\s*([^\s│|]+(?:\s*[ap]m)?))?/i);
    if (m5) { out.window5h = Number(m5[1]); out.resets5h = (m5[2] || '').trim() || null; }
    const m7 = line.match(/\b7d\b[^\d]*?(\d+)%\s*(?:⟳\s*([^│|]+))?/i);
    if (m7) { out.window7d = Number(m7[1]); out.resets7d = (m7[2] || '').trim() || null; }
    const mm = line.match(/^\s*([A-Za-z][\w.\- ()]{1,24}?)\s*\|/);
    if (mm && /\|.*%/.test(line)) out.model = mm[1].trim();
  }
  return out;
}

// Parse the Claude Code footer: model, context %, permission mode.
//
// The footer is pipe-separated and its contents MOVE. It used to read
// "model | 22% (220k/1000k) | bypass permissions"; it now reads
// "Opus 5 (1M context) | gh:octocat | user@example.com" with the mode on its own
// line, and a narrow pane truncates the line with an ellipsis before the end. So the
// only thing this can rely on is the FIRST segment being the model name. Requiring a
// percentage, as it used to, meant one footer change blanked the model and the mode
// as well.
//
// The model pattern is deliberately strict. Ordinary terminal output is full of pipes
// ("grep -n foo | head -3"), and a loose pattern reads a shell command as a model.
const MODEL_NAME = /^[A-Z][A-Za-z]*(\s+[\d.]+)?(\s*\(\d+[MmKk]\s+context\))?$/;

// Codex's footer is a different sentence in a different alphabet: the model slug, the
// reasoning level, a middle dot and the working directory. It has no pipes in it, so
// the Claude reader below skips every line of it and used to report a Codex pen as
// having no model at all.
const CODEX_LINE = CODEX_FOOTER;
// Both engines print this while a turn is running. For a Claude pen it is redundant -
// cmux reports the status itself - but cmux writes no status entry for a Codex tab,
// so this line is the only evidence the ranch has that a Codex agent is working.
const BUSY = /esc to interrupt/i;

export function parseFooter(screen) {
  const out = { model: null, contextPct: null, permissionMode: null,
                engine: null, busy: BUSY.test(screen || '') };
  for (const line of (screen || '').split('\n')) {
    const cx = line.match(CODEX_LINE);
    if (cx) { out.engine = 'codex'; out.model = cx[1]; continue; }

    if (/bypass permissions/i.test(line)) out.permissionMode = 'bypass permissions';
    else if (/accept edits/i.test(line)) out.permissionMode = 'accept edits';
    else if (/plan mode/i.test(line)) out.permissionMode = 'plan';

    if (!line.includes('|')) continue;
    const parts = line.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2 || !MODEL_NAME.test(parts[0])) continue;
    out.model = parts[0];
    out.engine = 'claude';
    // Still read the percentage when the pane is wide enough to print it. Never take
    // it from the 5h/7d line: that is how much of the SUBSCRIPTION is spent, and it
    // is separated by a box-drawing bar, not a pipe.
    const ctx = parts.find(p => /^\d+%(\s*\(|$)/.test(p));
    out.contextPct = ctx ? Number(ctx.match(/(\d+)%/)[1]) : null;
  }
  return out;
}

// The denominator for a context percentage. Claude Code records no context-window
// field anywhere in the transcript, so what the model is called is all we have.
//
// Two names, because neither is reliable on its own. The footer's display label is the
// first thing a narrow pane truncates and "(1M context)" is at the end of it; the
// transcript's raw model id keeps its [1m] suffix but is missing until the agent has
// answered once. Either one saying a million is enough.
export const STANDARD_WINDOW = 200_000;
export const LARGE_WINDOW = 1_000_000;
// Fable and Mythos have no 200k variant. The million is their default, so nothing in
// the name mentions it, and reading the label alone measured a 388k Fable session
// against 200k and reported a bar at 100%.
const ALWAYS_LARGE = /\b(fable|mythos)\b/i;
export function contextWindow(...names) {
  const s = names.filter(Boolean).join(' ');
  return (/\b1m\b/i.test(s) || ALWAYS_LARGE.test(s)) ? LARGE_WINDOW : STANDARD_WINDOW;
}

// Claude Code compacts a session before it reaches its window, so a count past the
// window is never a full session. It means the window we assumed is the wrong one:
// almost always a 1M session whose name did not say so. Widen the denominator rather
// than clamp, and past even the largest window we know, say nothing. A bar pinned at
// 100% reads as "about to compact", which is a warning nobody can act on when it is
// really "we could not tell".
function share(tokens, window) {
  if (tokens <= window) return Math.round((tokens / window) * 100);
  if (tokens <= LARGE_WINDOW) return Math.round((tokens / LARGE_WINDOW) * 100);
  return null;
}

// One agent's facts from the two places that know them. Neither source is complete:
// the screen has the model's display name and, if the pane is wide, the percentage;
// the transcript has the exact token count and the mode. Merging by "whichever has a
// value" matters more than it sounds - the old code stored the footer only when it
// carried a model or a percentage, so a footer that lost its percentage threw away
// the permission mode it had just read correctly.
export function agentFacts(tail, footer) {
  const t = tail || {}, f = footer || {};
  const model = f.model || t.model || null;
  const measured = t.contextTokens != null
    ? share(t.contextTokens, contextWindow(model, t.model))
    : null;
  return {
    model,
    // A percentage Claude Code printed itself beats one we worked out.
    contextPct: f.contextPct != null ? f.contextPct : measured,
    contextTokens: t.contextTokens ?? null,
    permissionMode: f.permissionMode || t.permissionMode || null,
  };
}
