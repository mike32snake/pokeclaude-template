import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSlug } from './paths.js';
import { listCodexSessions, isCodexTranscriptPath, parseCodexConversation } from './codexlog.js';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function realCaseDir(dir) {
  try { return fs.realpathSync(dir); } catch { return dir; }
}

// newest transcript for a cwd (fallback link when no hook has fired yet)
export function findNewestTranscript(rawDir) {
  const slug = projectSlug(realCaseDir(rawDir));
  const d = path.join(PROJECTS, slug);
  try {
    const files = fs.readdirSync(d).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, m: fs.statSync(path.join(d, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? path.join(d, files[0].f) : null;
  } catch { return null; }
}

const MAIN_ARG = ['command', 'file_path', 'prompt', 'pattern', 'url', 'query', 'skill', 'description'];

// Parse the tail of a transcript: recent tool calls + the last assistant text.
// The permission mode is written camelCase ("bypassPermissions"); the panel and the
// status bar say it the way Claude Code says it out loud.
const spaced = (m) => String(m).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

export function parseTail(transcriptPath, maxBytes = 262144) {
  const out = { recentTools: [], lastQuestion: null, title: null, sessionId: null,
                model: null, contextTokens: null, permissionMode: null };
  let text;
  try {
    const st = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) out.title = d.aiTitle;
    if (d.sessionId) out.sessionId = d.sessionId;
    // Written on every prompt, so it survives a footer too narrow to print it.
    if (d.permissionMode) out.permissionMode = spaced(d.permissionMode);
    if (d.type === 'assistant') {
      // How much of the context window is gone, measured rather than scraped: the
      // tokens the request actually carried. Cached tokens count - the model still
      // reads them - and the newest turn wins, because context only grows.
      const u = d.message?.usage;
      if (u) {
        out.contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
                          + (u.cache_read_input_tokens || 0);
        out.model = d.message?.model || out.model;
      }
      const blocks = d.message?.content || [];
      for (const b of blocks) {
        if (b?.type === 'tool_use') {
          const input = b.input || {};
          let arg = '';
          for (const k of MAIN_ARG) if (typeof input[k] === 'string') { arg = input[k]; break; }
          out.recentTools.push({ at: Date.parse(d.timestamp || '') || null, tool: b.name, arg: arg.slice(0, 90) });
        }
        if (b?.type === 'text' && b.text?.trim()) out.lastQuestion = b.text.trim().slice(0, 1200);
      }
    }
  }
  out.recentTools = out.recentTools.slice(-8);
  return out;
}

// Ordered conversation for the chat pane: user turns, assistant turns, and the tool
// calls each assistant turn made. Tool RESULTS are skipped; they are huge and the
// chat only needs to show what was asked, said, and run.
//
// The file is read through WINDOWS, never whole: a transcript with pasted images runs
// to tens of MB. The opening ask is pinned out of the head window and the recent turns
// come from the tail, because a conversation that starts in the middle is unreadable -
// the one turn that says what the agent was told to do is the first one.
const HEAD_BYTES = 131072;

function readWindow(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// A window cuts lines in half at both ends. Drop the halves, never parse them.
const dropHead = (t) => { const i = t.indexOf('\n'); return i < 0 ? '' : t.slice(i + 1); };
const dropTail = (t) => { const i = t.lastIndexOf('\n'); return i < 0 ? '' : t.slice(0, i + 1); };

function parseTurns(text) {
  const out = [];
  const answers = new Map();                          // tool_use_id -> raw result text
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    // A message typed while the agent was working. Claude Code queues it and hands it
    // over mid-turn as an attachment, never as a user turn, so without this the thread
    // showed no trace of a message the panel had just said was queued.
    if (d.type === 'attachment' && d.attachment?.type === 'queued_command') {
      const text = String(d.attachment.prompt || '').trim();
      if (text) out.push({ uuid: d.uuid || null, role: 'user', text: text.slice(0, 4000), tools: [], asks: [],
                           at: Date.parse(d.timestamp || '') || null, queued: true });
      continue;
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const raw = d.message?.content;
    const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw }] : (raw || []);
    let body = '';
    const tools = [];
    const asks = [];
    for (const b of blocks) {
      if (b?.type === 'text' && b.text?.trim()) body += (body ? '\n' : '') + b.text.trim();
      if (b?.type === 'tool_result' && b.tool_use_id) {
        const c = b.content;
        answers.set(b.tool_use_id, typeof c === 'string' ? c
          : Array.isArray(c) ? c.map(x => x?.text || '').join('\n') : '');
      }
      if (b?.type === 'tool_use') {
        // AskUserQuestion IS the conversation, not tool noise: keep its questions.
        if (b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) {
          asks.push({ id: b.id, questions: b.input.questions });
          continue;
        }
        const input = b.input || {};
        let arg = '';
        for (const k of MAIN_ARG) if (typeof input[k] === 'string') { arg = input[k]; break; }
        tools.push({ tool: b.name, arg: arg.slice(0, 120) });
      }
    }
    if (!body && !tools.length && !asks.length) continue;   // pure tool_result turn
    const at = Date.parse(d.timestamp || '') || null;
    out.push({ uuid: d.uuid || null, role: d.type, text: body.slice(0, 4000), tools, asks, at });
  }

  // Attach the answers. The result reads: The user answered: "Q"="A", "Q2"="A2"
  for (const m of out) {
    for (const a of m.asks || []) {
      const rawAns = answers.get(a.id);
      a.picked = {};
      if (rawAns) {
        for (const m2 of rawAns.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)) a.picked[m2[1]] = m2[2];
      }
      // Three distinct states, and the pending one is the whole point: it is what
      // the agent is blocked on right now.
      a.answered = Object.keys(a.picked).length > 0;
      a.rejected = Boolean(rawAns) && !a.answered &&
        /doesn't want to proceed|was rejected/i.test(rawAns);
      a.pending = !rawAns;
    }
  }
  return out;
}

// The ask that started the session: the first user turn with words in it.
const openingOf = (turns) => turns.find(t => t.role === 'user' && t.text) || null;
const GAP = () => ({ role: 'gap', text: '', tools: [], asks: [], at: null });

// Pin the opening ask, drop the MIDDLE, keep the end. The gap is marked so the panel
// never implies the conversation began where the visible turns begin.
function keepOpening(turns, limit) {
  if (turns.length <= limit) return turns;
  const open = openingOf(turns);
  // The gap marker takes one of the rows the caller asked for: `limit` is what the
  // panel gets back, so the opening plus the marker plus the tail must add up to it.
  const tail = turns.slice(-(limit - 2));
  if (!open || tail.includes(open)) return turns.slice(-limit);
  return [open, GAP(), ...tail];
}

export function parseConversation(transcriptPath, limit = 40, maxBytes = 900000) {
  let size;
  try { size = fs.statSync(transcriptPath).size; } catch { return []; }

  // Small enough to read whole: no window, so no gap can exist that we did not choose.
  if (size <= maxBytes + HEAD_BYTES) {
    let text;
    try { text = readWindow(transcriptPath, 0, size); } catch { return []; }
    return keepOpening(parseTurns(text), limit);
  }

  let head, tail;
  try {
    head = dropTail(readWindow(transcriptPath, 0, HEAD_BYTES));
    tail = dropHead(readWindow(transcriptPath, size - maxBytes, maxBytes));
  } catch { return []; }

  const tailTurns = parseTurns(tail);
  const open = openingOf(parseTurns(head));
  if (!open) return keepOpening(tailTurns, limit);
  // The windows are disjoint by construction, so the opening is never in the tail.
  return [open, GAP(), ...tailTurns.slice(-(limit - 2))];
}

// Archive: recent sessions across every configured repo, newest first. This is what
// you reach for after killing an agent, since the transcript outlives the workspace.
export function listArchive(repoDirs, limit = 60) {
  const rows = [];
  for (const { dir, sign } of repoDirs) {
    for (const r of listSessions(dir, 12)) rows.push({ ...r, sign, dir });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

// Search recent sessions for text. Every term must appear somewhere in the session
// (AND), and we return the turns that actually matched so the hit is verifiable.
export function searchSessions(repoDirs, query, { perRepo = 14, maxHits = 60 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const { dir, sign } of repoDirs) {
    for (const sess of listSessions(dir, perRepo)) {
      let text;
      try { text = fs.readFileSync(sess.path, 'utf8'); } catch { continue; }
      const hay = text.toLowerCase();
      if (!terms.every(t => hay.includes(t))) continue;      // cheap reject first
      const turns = readConversation(sess.path, 400);
      const matched = turns.filter(m => {
        const t = (m.text || '').toLowerCase();
        return terms.some(term => t.includes(term));
      });
      if (!matched.length) continue;                          // matched only tool noise
      const best = matched[matched.length - 1];
      hits.push({
        ...sess, sign, dir,
        matches: matched.length,
        snippet: snippetAround(best.text, terms[0]),
        role: best.role,
      });
    }
  }
  hits.sort((a, b) => b.matches - a.matches || b.mtime - a.mtime);
  return hits.slice(0, maxHits);
}

function snippetAround(text, term, span = 130) {
  const t = text || '';
  const i = t.toLowerCase().indexOf(term);
  if (i < 0) return t.slice(0, span);
  const start = Math.max(0, i - Math.floor(span / 3));
  return (start > 0 ? '…' : '') + t.slice(start, start + span).replace(/\s+/g, ' ') +
    (start + span < t.length ? '…' : '');
}

// Guard: only ever read transcripts from under ~/.claude/projects, or Codex rollouts
// from under ~/.codex/sessions. Nothing else on disk is a conversation.
export function isTranscriptPath(p) {
  try {
    return (path.resolve(p).startsWith(PROJECTS + path.sep) && p.endsWith('.jsonl'))
      || isCodexTranscriptPath(p);
  } catch { return false; }
}

// A past session is read by the parser of the CLI that wrote it. The two logs share
// a row shape and nothing else, and the path says which one this is: a Codex rollout
// lives under ~/.codex/sessions, everything else is a Claude transcript. Every reader
// of a session row (the archive, search, Ash's recall, /api/transcript) goes through
// here, so a Codex session opens as its conversation and never as an empty thread.
//
// `whole` is for find: every turn, no window and no gap. The pane's trim is right for
// reading and wrong for searching, because a word in the dropped middle is reported as
// not there. It reads the file whole, so it is only ever asked for on demand.
export function readConversation(p, limit = 40, { home, whole = false } = {}) {
  const parse = isCodexTranscriptPath(p, home) ? parseCodexConversation : parseConversation;
  return whole ? parse(p, Infinity, Infinity) : parse(p, limit);
}

// The PC's list is BOTH engines, newest first, cut to what was asked for.
export function mergeSessions(claude, codex, limit) {
  return [...claude, ...codex].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// The PC pages through a repo's sessions. It lists one row past the page, so `more`
// says whether an older page exists without counting every transcript on disk.
export function pageSessions(rows, limit) {
  return { sessions: rows.slice(0, limit), more: rows.length > limit };
}
export function sessionLimit(raw) {
  const n = Math.floor(Number(raw));
  return n > 0 ? Math.min(1000, n) : 12;
}

// What was said in a session, by either side, for the PC search. Tool calls and their
// output are most of a transcript's bytes and none of what anyone searches for, so a
// line is only parsed when a cheap look says it can hold a message.
export function searchText(p) {
  if (isCodexTranscriptPath(p)) return readConversation(p, Infinity, { whole: true }).map(t => t.text).filter(Boolean);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (line.includes('"queued_command"')) {
      try { const d = JSON.parse(line); const q = String(d.attachment?.prompt || '').trim(); if (q) out.push(q); } catch {}
      continue;
    }
    if (line.includes('"tool_result"')) continue;
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const raw = d.message?.content;
    if (typeof raw === 'string') { if (raw.trim()) out.push(raw.trim()); continue; }
    for (const b of raw || []) if (b?.type === 'text' && b.text?.trim()) out.push(b.text.trim());
  }
  return out;
}

// PC listing: sessions for a repo dir, including nested project dirs (nested per-room projects).
export function listSessions(rawDir, limit = 12) {
  const top = claudeFiles(rawDir).slice(0, limit).map(describeSession);
  return mergeSessions(top, listCodexSessions(rawDir, { limit }), limit);
}

// Every session in a repo, newest first, from a stat of each file. A Claude row has no
// title or count yet: describeSession() reads the file for those, and the PC search
// calls it one file at a time so a big repo never stalls the server.
export function sessionFiles(rawDir) {
  return mergeSessions(claudeFiles(rawDir), listCodexSessions(rawDir, { limit: Infinity }), Infinity);
}

function claudeFiles(rawDir) {
  const slug = projectSlug(realCaseDir(rawDir));
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS).filter(d => d === slug || d.startsWith(slug + '-')); } catch { return []; }
  const rows = [];
  for (const d of dirs) {
    const full = path.join(PROJECTS, d);
    let files = [];
    try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = path.join(full, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size < 200) continue;
      rows.push({ path: p, sessionId: f.replace('.jsonl', ''), mtime: st.mtimeMs, size: st.size, project: d, engine: 'claude' });
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime);
}

// A Codex row is described when it is listed; a Claude row is described here.
export function describeSession(r) {
  if (r.engine === 'codex') return r;
  const { title, lines } = titleOf(r);
  const { size, ...out } = r;
  return { ...out, title: title || r.sessionId.slice(0, 8), msgs: lines };
}

// Reading a transcript for its title means reading all of it, for the line count. The
// PC search lists every session in a repo on each keystroke, so the answer is kept
// until the file changes.
const titles = new Map();                              // path -> { mtime, size, title, lines }
function titleOf(r) {
  const hit = titles.get(r.path);
  if (hit && hit.mtime === r.mtime && hit.size === r.size) return hit;
  let title = null, lines = 0;
  try {
    // Count newlines on the bytes and decode only the first 400 lines: a transcript
    // can be 40MB, and turning all of it into a string is most of the cost.
    const buf = fs.readFileSync(r.path);
    let headEnd = buf.length;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) {
      if (++lines === 400) headEnd = i;
    }
    for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
      if (line.includes('"ai-title"')) {
        try { const d = JSON.parse(line); if (d.type === 'ai-title' && d.aiTitle) { title = d.aiTitle; break; } } catch {}
      }
    }
  } catch {}
  const out = { mtime: r.mtime, size: r.size, title, lines };
  titles.set(r.path, out);
  return out;
}
