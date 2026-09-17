// Pikachu's recall. Before Ash answers a question about the field, Pikachu reads the
// sessions for anything that bears on it: what every live agent is doing right now
// (its opening ask and newest turns), and the past sessions in the archive that match.
// All of it is local file reading and string matching; the ONE token-spending call
// is Ash's, and it gets what is gathered here as its grounding.
//
// The old grounding was a one-liner per agent ("title | repo | status") and a single
// 130-character snippet per past session, found only when EVERY word of the question
// appeared in the file. "What is the pokeclaude agent working on?" matched nothing:
// "what" and "on" were required, the live line said nothing about the work, and Ash
// answered that it could not tell. This module is the fix.
import fs from 'node:fs';
import { readConversation, listSessions } from './transcripts.js';

// Words that carry no search value. A question is mostly these; the terms that are
// left are what to look for.
const STOP = new Set(('a an the and or but if then than that this these those there here ' +
  'is are was were be been being am do does doing done did have has had having ' +
  'i me my we our you your he she it its they them their who whom whose which what ' +
  'when where why how all any each some no not none very can could should would ' +
  'will shall may might must of in on at to for from by with about into over under ' +
  'up down out off again also just only so as too such ' +
  'agent agents session sessions repo repos field one ones tell show find know ' +
  'anyone anything something currently right now yet still ever last').split(/\s+/));

export function queryTerms(question) {
  const words = String(question || '').toLowerCase()
    .replace(/[^\p{L}\p{N}_\-./]+/gu, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^[-./]+|[-./]+$/g, ''))
    .filter(w => w.length >= 2);
  const uniq = (xs) => [...new Set(xs)];
  const keep = uniq(words.filter(w => !STOP.has(w)));
  if (keep.length) return keep;
  // Nothing but small words: search for the longest of them rather than nothing.
  const longest = Math.max(0, ...words.map(w => w.length));
  return uniq(words.filter(w => w.length === longest));
}

const lower = (t) => String(t || '').toLowerCase();

// How many DISTINCT terms a text mentions. Distinct, not total: a turn that says
// "webhook" ten times knows less about "stripe webhook signature" than one that says
// each once.
export function scoreText(text, terms) {
  const hay = lower(text);
  let n = 0;
  for (const t of terms) if (hay.includes(t)) n++;
  return n;
}

// A window of text around the first term found, whitespace folded, cuts marked.
export function excerpt(text, terms, span = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const hay = t.toLowerCase();
  let i = -1;
  for (const term of terms) { i = hay.indexOf(term); if (i >= 0) break; }
  if (i < 0) return t.length > span ? t.slice(0, span) + '…' : t;
  const start = Math.max(0, i - Math.floor(span / 3));
  const end = Math.min(t.length, start + span);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

// The `max` best-scoring turns of a conversation, put back in the order they were
// said. Ties go to the newer turn, since the newest mention is usually the state.
// A user turn that starts with a tag was written by the harness (a task notification,
// a system reminder, a hook result), not by the person. Quoted as the user it misleads.
const harnessTurn = (t) => t.role === 'user' && /^\s*</.test(t.text || '');

export function pickTurns(turns, terms, max = 3) {
  const scored = [];
  (turns || []).forEach((t, i) => {
    if (t.role !== 'user' && t.role !== 'assistant') return;
    if (!t.text || harnessTurn(t)) return;
    const score = scoreText(t.text, terms);
    if (score > 0) scored.push({ ...t, score, i });
  });
  scored.sort((a, b) => b.score - a.score || b.i - a.i);
  return scored.slice(0, max).sort((a, b) => a.i - b.i)
    .map(({ i, ...t }) => ({ ...t, text: excerpt(t.text, terms) }));
}

const MAX_FILE = 12 * 1024 * 1024;   // a transcript past this is nearly all pasted images

// Rank a list of sessions ({path, sessionId, title, mtime, sign, dir}) against the
// terms. A session needs ONE term, not all of them; it is ranked by how many distinct
// terms it holds, then by how many turns mention any, then newest first. Sessions in
// `exclude` (the live ones) are left out: the live half of the grounding covers them.
export function rankSessions(sessions, terms, { turnsPerSession = 3, exclude = null } = {}) {
  const out = [];
  for (const s of sessions) {
    if (exclude?.has(s.path)) continue;
    let st; try { st = fs.statSync(s.path); } catch { continue; }
    if (st.size > MAX_FILE) continue;
    let text; try { text = fs.readFileSync(s.path, 'utf8'); } catch { continue; }
    const distinct = scoreText(text, terms);            // cheap reject on the raw file
    if (!distinct) continue;
    const turns = readConversation(s.path, 400);
    const excerpts = pickTurns(turns, terms, turnsPerSession);
    if (!excerpts.length) continue;                     // matched only tool noise
    const matches = turns.filter(t => t.text && scoreText(t.text, terms) > 0).length;
    // Distinct terms over the TURNS, not the raw file: a file can hold a term inside a
    // tool result that no turn ever says.
    const said = new Set();
    for (const t of turns) for (const term of terms) if (lower(t.text).includes(term)) said.add(term);
    out.push({ ...s, distinct: said.size, matches, excerpts });
  }
  out.sort((a, b) => b.distinct - a.distinct || b.matches - a.matches || b.mtime - a.mtime);
  return out;
}

// One row per transcript. A repo that contains another repo (scratch holds pokeclaude)
// lists the inner repo's sessions as its own too; the deepest repo is the right owner.
export function dedupeSessions(rows) {
  const best = new Map();
  for (const r of rows) {
    const have = best.get(r.path);
    if (!have || String(r.dir || '').length > String(have.dir || '').length) best.set(r.path, r);
  }
  return [...best.values()];
}

// The archive half: the newest `perRepo` sessions of every repo, ranked.
export function recallHistory(repoDirs, terms, { perRepo = 20, maxSessions = 8,
                                                  turnsPerSession = 3, exclude = null } = {}) {
  if (!terms.length) return [];
  const sessions = [];
  for (const { dir, sign } of repoDirs) {
    for (const s of listSessions(dir, perRepo)) sessions.push({ ...s, sign, dir });
  }
  return rankSessions(dedupeSessions(sessions), terms, { turnsPerSession, exclude })
    .slice(0, maxSessions);
}

// The live half: one row per agent on the field. An agent with a transcript carries
// its opening ask, its newest turns, and any older turn that mentions the question.
// A service is a process, not a conversation, so it is just its ports.
export function recallLive(agents, transcriptFor, terms, { recent = 6, matched = 2 } = {}) {
  const out = [];
  for (const a of agents) {
    const row = { workspaceId: a.workspaceId, title: a.title || '(untitled)',
                  rawDir: a.rawDir || null, status: a.status, since: a.since || null,
                  kind: a.kind || 'agent', branch: a.branch || null, model: a.model || null,
                  ports: a.ports || [], lastTool: a.lastTool || null,
                  transcript: null, opening: null, recent: [], matched: [] };
    if (row.kind !== 'service') {
      const tp = transcriptFor(a);
      if (tp) {
        const turns = readConversation(tp, 60);
        const spoken = turns.filter(t => (t.role === 'user' || t.role === 'assistant') && t.text
                                         && !harnessTurn(t));
        const open = spoken.find(t => t.role === 'user') || null;
        const tail = spoken.slice(-recent);
        const shown = new Set(tail.map(t => t.uuid || t));
        row.transcript = tp;
        row.opening = open ? excerpt(open.text, [], 300) : null;
        row.recent = tail.map(t => ({ role: t.role, at: t.at, text: excerpt(t.text, terms, 300) }));
        row.matched = pickTurns(spoken.filter(t => !shown.has(t.uuid || t)), terms, matched)
          .map(t => ({ role: t.role, at: t.at, text: t.text }));
      }
    }
    out.push(row);
  }
  return out;
}

const day = (ms) => ms
  ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : 'undated';
const ago = (since) => {
  if (!since) return '';
  const m = Math.round((Date.now() - since) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};
const who = (role) => role === 'user' ? 'You' : 'Claude';

// How much of each live agent to show. A fleet of two gets everything; a fleet of
// twenty-four gets trimmed, level by level, until the live half fits its share of the
// budget. The head line always stays: every agent on the field is at least named.
const LEVELS = [
  { opening: 300, recent: Infinity, matched: Infinity, turn: Infinity },
  { opening: 160, recent: 3, matched: 1, turn: 160 },
  { opening: 120, recent: 1, matched: 1, turn: 120 },
  { opening: 100, recent: 0, matched: 0, turn: 0 },
];
const cut = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);

function liveBlock(a, lv = LEVELS[0]) {
  const head = `- ${a.title} | ${a.rawDir || '?'} | ${a.status}` +
    (a.branch ? ` | branch ${a.branch}` : '') +
    (a.model ? ` | ${a.model}` : '') +
    (a.since ? ` | for ${ago(a.since)}` : '');
  if (a.kind === 'service') return `${head} | service on ${(a.ports || []).join(',') || '?'}`;
  const lines = [head];
  if (a.lastTool) lines.push(`    last tool: ${a.lastTool}`);
  if (a.opening) lines.push(`    opening ask: ${cut(a.opening, lv.opening)}`);
  const matched = (a.matched || []).slice(0, lv.matched);
  if (matched.length) {
    lines.push(`    earlier turns that mention the question:`);
    for (const t of matched) lines.push(`      ${who(t.role)}: ${cut(t.text, lv.turn)}`);
  }
  const recent = lv.recent ? (a.recent || []).slice(-lv.recent) : [];
  if (recent.length) {
    lines.push(`    newest turns, oldest first:`);
    for (const t of recent) lines.push(`      ${who(t.role)}: ${cut(t.text, lv.turn)}`);
  } else if (!a.opening) lines.push(`    (no readable conversation)`);
  return lines.join('\n');
}

function historyBlock(s) {
  const lines = [`- [${s.sign}] "${s.title}" (${day(s.mtime)}, ${s.matches || s.excerpts.length} matching turns)`];
  for (const t of s.excerpts) lines.push(`    ${who(t.role)}: ${t.text}`);
  return lines.join('\n');
}

// The grounding as Ash reads it: live agents first and in full, then past sessions
// most relevant first until the budget runs out. Sessions are cut whole, never
// mid-excerpt, and the count of what was left out is stated so Ash can say so.
export function groundingText({ live = [], history = [] }, budget = 40000) {
  const parts = [];
  parts.push(`LIVE AGENTS AND SERVICES ON THE FIELD (${live.length}):`);
  // The live half may take at most this much, so the archive is never crowded out.
  // A real field of 24 working agents did exactly that at full detail.
  const liveShare = history.length ? Math.floor(budget * 0.6) : budget;
  let liveText = '(none)';
  for (const lv of LEVELS) {
    liveText = live.map(a => liveBlock(a, lv)).join('\n') || '(none)';
    if (liveText.length <= liveShare) break;
  }
  parts.push(liveText);
  let used = parts.join('\n').length;
  parts.push('', `PAST SESSIONS THAT MENTION THE QUESTION (${history.length}, most relevant first):`);
  used += 60;
  if (!history.length) parts.push('(none)');
  let shown = 0;
  for (const s of history) {
    const block = historyBlock(s);
    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length + 1;
    shown++;
  }
  if (shown < history.length) parts.push(`(${history.length - shown} more matching sessions not shown)`);
  return parts.join('\n');
}

// Everything Ash needs, in one call: the terms, both halves, the text, and the list
// of sessions consulted so the panel can offer them to open.
export function recall({ question, agents, transcriptFor, repoDirs, budget }) {
  const terms = queryTerms(question);
  const live = recallLive(agents, transcriptFor, terms);
  const exclude = new Set(live.map(a => a.transcript).filter(Boolean));
  const history = recallHistory(repoDirs, terms, { exclude });
  const text = groundingText({ live, history }, budget);
  const sessions = history.map(s => ({ sign: s.sign, title: s.title, sessionId: s.sessionId,
                                       path: s.path, dir: s.dir, mtime: s.mtime,
                                       engine: s.engine || 'claude' }));
  return { terms, live, history, text, sessions };
}
