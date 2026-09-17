// Reading a Codex conversation, in the shape the panel already draws.
//
// Codex keeps its sessions under ~/.codex/sessions as JSONL, one file per session,
// and it records the same conversation twice at two different altitudes. The raw
// `response_item` rows are the model's wire format and are full of things nobody
// said: a `role: "user"` row there is a page of `<recommended_plugins>` the harness
// injected. The `event_msg` / `item_completed` rows are the finished conversation -
// UserMessage, AgentMessage, CommandExecution, FileChange, Reasoning - so those are
// what this reads. Everything it returns matches transcripts.js's message shape
// ({ role, text, tools, asks, at }), because public/js/ui.js draws both.
//
// Codex has no AskUserQuestion, so `asks` is always empty. It does record the size of
// its own context window, which the Claude side has to guess from the model's name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sessionsDir = (home = os.homedir()) => path.join(home, '.codex', 'sessions');

// Codex runs every command through a login shell. The panel's bashLabel() reads the
// first word to say what happened, so left wrapped, every command in the ranch reads
// as "Ran a script: /bin/zsh".
export function shellCommand(argv) {
  const a = Array.isArray(argv) ? argv.map(String) : [String(argv ?? '')];
  const i = a.findIndex(x => x === '-lc' || x === '-c');
  const rest = i >= 0 && /(^|\/)(ba|z|k)?sh$/.test(a[0] || '') ? a.slice(i + 1) : a;
  return rest.join(' ').trim();
}

const ARG_MAX = 120;
const text = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .map(b => b?.text || '').filter(Boolean).join('\n').trim();

// One item from the finished conversation, as a tool call the panel can label. A
// FileChange carries every path it touched; "add" is a Write and anything else is an
// Edit, which is the same distinction Claude Code's own two tools make.
function toolsFor(item) {
  if (item.type === 'CommandExecution') {
    return [{ tool: 'Bash', arg: shellCommand(item.command).slice(0, ARG_MAX) }];
  }
  if (item.type === 'FileChange') {
    return Object.entries(item.changes || {}).map(([file, ch]) =>
      ({ tool: ch?.type === 'add' ? 'Write' : 'Edit', arg: String(file).slice(0, ARG_MAX) }));
  }
  return [];
}

export function parseCodexTurns(body) {
  const out = [];
  // Tools belong to the turn that ran them, so they are attached to the assistant
  // message that is open. A command with no commentary before it still has to land
  // somewhere, or the work vanishes from the thread.
  let open = null;
  const assistant = (at) => {
    if (open) return open;
    open = { uuid: null, role: 'assistant', text: '', tools: [], asks: [], at };
    out.push(open);
    return open;
  };
  for (const line of String(body || '').split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (p.type !== 'item_completed') continue;
    const item = p.item || {};
    const at = Date.parse(d.timestamp || '') || null;
    if (item.type === 'UserMessage') {
      const t = text(item.content);
      if (!t) continue;
      open = null;
      out.push({ uuid: item.id || null, role: 'user', text: t.slice(0, 4000),
                 tools: [], asks: [], at });
      continue;
    }
    if (item.type === 'AgentMessage') {
      const t = text(item.content);
      if (!t) continue;
      // A turn that has already run tools keeps them and takes this as its words;
      // a second block of prose after that starts a new turn, the way it reads.
      if (open && !open.text) { open.text = t.slice(0, 4000); open.at = open.at || at; continue; }
      open = { uuid: item.id || null, role: 'assistant', text: t.slice(0, 4000),
               tools: [], asks: [], at };
      out.push(open);
      continue;
    }
    const tools = toolsFor(item);
    if (tools.length) assistant(at).tools.push(...tools);
    // Reasoning arrives with an empty summary unless the model was asked to show it.
    // An empty one is not a turn; a filled one is what the agent was thinking.
    if (item.type === 'Reasoning') {
      const t = (item.summary_text || []).join('\n').trim();
      if (t) assistant(at).text ||= t.slice(0, 4000);
    }
  }
  return out.filter(m => m.text || m.tools.length);
}

const HEAD_BYTES = 131072;
function readWindow(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, len));
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
const dropHead = (t) => t.slice(t.indexOf('\n') + 1);
const dropTail = (t) => t.slice(0, t.lastIndexOf('\n') + 1);
const GAP = () => ({ role: 'gap', text: '', tools: [], asks: [], at: null });
const opening = (turns) => turns.find(t => t.role === 'user' && t.text.trim()) || null;

// The same windowing rule as transcripts.js: never read the file whole (one pasted
// image is megabytes), and never lose the OPENING ASK, because a conversation that
// starts in the middle with no sign that anything came before is unreadable.
export function parseCodexConversation(file, limit = 40, maxBytes = 900000) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  if (size <= maxBytes + HEAD_BYTES) {
    try { return parseCodexTurns(readWindow(file, 0, size)).slice(-limit); } catch { return []; }
  }
  let head, tail;
  try {
    head = dropTail(readWindow(file, 0, HEAD_BYTES));
    tail = dropHead(readWindow(file, size - maxBytes, maxBytes));
  } catch { return []; }
  const tailTurns = parseCodexTurns(tail);
  const open = opening(parseCodexTurns(head));
  if (!open) return tailTurns.slice(-limit);
  return [open, GAP(), ...tailTurns.slice(-(limit - 2))];
}

// "danger-full-access" -> "danger full access", to read like Claude Code's modes.
const spaced = (s) => String(s || '').replace(/[-_]/g, ' ');

// What the status bar needs: the model, how much context is gone, and the mode. Codex
// records the window it is measuring against, so unlike the Claude side nothing here
// is inferred from the model's name.
export function parseCodexTail(file, maxBytes = 262144) {
  const out = { recentTools: [], lastQuestion: null, title: null, sessionId: null,
                model: null, contextTokens: null, contextWindow: null, permissionMode: null };
  let body;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    body = readWindow(file, start, size - start);
    if (start > 0) body = dropHead(body);
  } catch { return out; }
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') out.sessionId = p.session_id || out.sessionId;
    if (d.type === 'turn_context') {
      out.model = p.model || out.model;
      if (p.sandbox_policy?.type) out.permissionMode = spaced(p.sandbox_policy.type);
    }
    if (p.type === 'token_count' && p.info) {
      // The newest turn is the current context, and its INPUT is what the model read.
      out.contextTokens = p.info.last_token_usage?.input_tokens ?? out.contextTokens;
      out.contextWindow = p.info.model_context_window ?? out.contextWindow;
    }
  }
  const turns = parseCodexTurns(body);
  for (const t of turns) out.recentTools.push(...t.tools);
  out.recentTools = out.recentTools.slice(-12);
  // Codex names its own threads (session_index.jsonl), but not until the turn ends and
  // never in this file. The opening ask is the title the panel would show anyway.
  out.title = opening(turns)?.text?.slice(0, 80) || null;
  return out;
}

// Which Codex session is running in which terminal.
//
// The Claude side reads `--session-id` off the process's own command line. Codex puts
// nothing there, so the link is a file it holds open: from the moment a pane opens,
// and before it has written a single turn, the native binary holds
// ~/.codex/thread-writer-locks/<session id>.lock. That process carries the tty, so
// lsof plus ps is the whole join. Matching on the newest file in the directory would
// be the old "newest-in-repo" guess, and two Codex pens in one repo would show each
// other's conversation - the bug AGENTS.md already documents at length.
const LOCK = /thread-writer-locks\/([0-9a-fA-F][0-9a-fA-F-]{7,})\.lock\s*$/;
export function parseLsofLocks(text, metadata = () => null) {
  const out = new Map();
  const candidates = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(LOCK);
    if (!m) continue;
    const pid = Number((line.trim().split(/\s+/)[1] || '').replace(/\D/g, ''));
    if (pid) {
      if (!candidates.has(pid)) candidates.set(pid, new Set());
      candidates.get(pid).add(m[1]);
    }
  }
  for (const [pid, ids] of candidates) {
    if (ids.size === 1) { out.set(pid, [...ids][0]); continue; }
    // The same process holds its helpers' locks too. Never pick by descriptor order
    // or recency: only a uniquely identified main thread belongs to the terminal.
    const roots = [...ids].filter(id => {
      const m = metadata(id);
      return m && !m.parent_thread_id && m.thread_source !== 'subagent'
        && !m.source?.subagent && (!m.agent_path || m.agent_path === '/root')
        && (typeof m.source === 'string' || m.thread_source === 'cli' || m.agent_path === '/root');
    });
    if (roots.length === 1) out.set(pid, roots[0]);
  }
  return out;
}

// `ps -axo pid,tty,command`, keeping only codex processes that are in a terminal. A
// codex with no tty is the ChatGPT app's own copy, not a pen on the field.
export function codexPsTty(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, tty, cmd] = m;
    if (!/^ttys/.test(tty)) continue;
    if (!/(^|\/)codex(\s|$)/.test(cmd)) continue;
    out.set(Number(pid), tty);
  }
  return out;
}

// The live link, cached like the process table: which terminal is running which Codex
// session. Two subprocesses, ~0.2s each, so it is sampled no more often than ps is.
import { execFile } from 'node:child_process';
const TTL = 5000;
let cache = { at: 0, byTty: new Map() };
const run = (cmd, args) => new Promise((done) =>
  execFile(cmd, args, { timeout: 8000, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout) => done(err && !stdout ? null : stdout || '')));

export async function codexByTty({ force = false, now = Date.now(), home = os.homedir() } = {}) {
  if (!force && now - cache.at < TTL) return cache.byTty;
  const [ps, ls] = await Promise.all([
    run('ps', ['-axo', 'pid,tty,command']),
    run('lsof', ['-c', 'codex', '-w']),
  ]);
  if (ps == null && ls == null) return cache.byTty;        // keep the last good table
  const ttys = codexPsTty(ps || '');
  const byTty = new Map();
  for (const [pid, sessionId] of parseLsofLocks(ls || '', id => {
    const file = rolloutPath(id, home);
    if (!file) return null;
    try {
      const head = readWindow(file, 0, Math.min(fs.statSync(file).size, 1048576));
      const row = JSON.parse(head.split('\n')[0]);
      return row.type === 'session_meta' ? row.payload : null;
    } catch { return null; }
  })) {
    const tty = ttys.get(pid);
    if (!tty) continue;
    byTty.set(tty, { pid, sessionId, path: rolloutPath(sessionId, home) });
  }
  cache = { at: Date.now(), byTty };
  return byTty;
}

// The file a session id is written to. The name carries the id, so this is a lookup,
// not a guess; the date directories keep it to a handful of readdirs.
export function rolloutPath(sessionId, home = os.homedir()) {
  const id = String(sessionId || '');
  if (!id) return null;
  const root = sessionsDir(home);
  const walk = (dir, depth) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    if (depth === 0) {
      const hit = names.find(n => n.isFile() && n.name.endsWith(`-${id}.jsonl`));
      return hit ? path.join(dir, hit.name) : null;
    }
    // Newest first: a live session is written today, so the first directory usually
    // has it and the rest are never opened.
    for (const n of names.filter(n => n.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const hit = walk(path.join(dir, n.name), depth - 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 3);                    // sessions/YYYY/MM/DD/rollout-*.jsonl
}

// ---------- past sessions ----------
//
// The PC and the archive list Claude sessions from ~/.claude/projects. Codex keeps its
// own under ~/.codex/sessions, so a Codex pen that was killed vanished from the ranch
// as if it never ran. These list them in the same row shape transcripts.js produces
// ({ path, sessionId, mtime, title, msgs }) plus `engine: 'codex'`, so the panel can
// say which CLI a past session was.
//
// The repo a session belongs to is the `cwd` in its first line (session_meta), which
// is why the head of every file is read: the file name carries the id and the date but
// not the directory. A subagent thread is a helper of another session, never a session
// of its own. Titles come from ~/.codex/session_index.jsonl, where Codex writes the
// name it gave the thread once the first turn ended; a session it has not named yet is
// titled by its opening ask, like a Claude session with no ai-title.
const META_BYTES = 262144;

function sessionMeta(file) {
  try {
    const size = fs.statSync(file).size;
    const head = readWindow(file, 0, Math.min(size, META_BYTES));
    const row = JSON.parse(head.split('\n')[0]);
    return row.type === 'session_meta' ? (row.payload || null) : null;
  } catch { return null; }
}

const isHelper = (m) => m.thread_source === 'subagent' || Boolean(m.parent_thread_id)
  || Boolean(m.source && typeof m.source === 'object' && m.source.subagent);

export function codexTitles(home = os.homedir()) {
  const out = new Map();
  let text;
  try { text = fs.readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8'); }
  catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (d.id && d.thread_name) out.set(d.id, d.thread_name); }
    catch {}
  }
  return out;
}

// macOS paths compare case-insensitively, and a repo is configured by one spelling
// while Codex records whatever the shell had. Same rule as paths.normalizeDir.
const canon = (p) => {
  let real = String(p || '');
  try { real = fs.realpathSync(real); } catch {}
  return real.replace(/\/+$/, '').toLowerCase();
};

function rolloutFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const full = path.join(dir, n.name);
      if (depth === 0) {
        if (n.isFile() && n.name.startsWith('rollout-') && n.name.endsWith('.jsonl')) {
          try { out.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
        }
      } else if (n.isDirectory()) walk(full, depth - 1);
    }
  };
  walk(root, 3);                                     // sessions/YYYY/MM/DD/rollout-*.jsonl
  return out;
}

export function listCodexSessions(rawDir, { limit = 12, home = os.homedir() } = {}) {
  const want = canon(rawDir);
  if (!want) return [];
  const files = rolloutFiles(sessionsDir(home)).sort((a, b) => b.mtime - a.mtime);
  const titles = codexTitles(home);
  const rows = [];
  for (const f of files) {
    if (rows.length >= limit) break;
    const m = sessionMeta(f.path);
    if (!m || !m.cwd || isHelper(m)) continue;
    // A repo lists the sessions of the repos inside it too, as the Claude side does
    // with its slug prefix; recall.dedupeSessions credits the deepest owner.
    const cwd = canon(m.cwd);
    if (cwd !== want && !cwd.startsWith(want + '/')) continue;
    const id = m.session_id || m.id || path.basename(f.path).replace(/^.*-([0-9a-f-]{36})\.jsonl$/i, '$1');
    let msgs = 0, opening = null;
    try {
      const text = fs.readFileSync(f.path, 'utf8');
      msgs = (text.match(/"type":"(UserMessage|AgentMessage)"/g) || []).length;
      opening = parseCodexTurns(text.slice(0, HEAD_BYTES)).find(t => t.role === 'user')?.text || null;
    } catch {}
    rows.push({ path: f.path, sessionId: id, mtime: f.mtime, engine: 'codex',
                title: titles.get(id) || (opening ? opening.slice(0, 80) : id.slice(0, 8)),
                msgs });
  }
  return rows;
}

// Guard for /api/transcript: only a rollout file under ~/.codex/sessions is ever read.
export function isCodexTranscriptPath(p, home = os.homedir()) {
  try {
    const r = path.resolve(String(p || ''));
    return r.startsWith(sessionsDir(home) + path.sep) && r.endsWith('.jsonl')
      && path.basename(r).startsWith('rollout-');
  } catch { return false; }
}
