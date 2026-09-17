// One agent, written down. The clipboard button in the chat header copies this.
//
// Everything here is already on the screen somewhere, but scattered across the header,
// the facts row, the RAW button and the server's state. Debugging an agent by
// describing it is slow and lossy; pasting this is neither. It is plain text on
// purpose: no fences, no markdown, so it survives a paste into a terminal, a chat box
// or a note without turning into something else.

import { elapsed } from './fmt.js';

const TURNS = 12;             // how many of the newest turns to carry
const TURN_CHARS = 400;       // how much of one turn
const SCREEN_LINES = 24;      // the tail of the terminal pane

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+$/, '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// One line, whatever came in. Tool arguments are shell commands and turns are prose;
// both carry newlines, and a newline inside a row breaks every column below it.
const oneLine = (s, n) => clip(String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ '), n);
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// "label  value", aligned, and skipped entirely when there is no value. A row of
// "undefined" is worse than a missing row.
function rows(pairs) {
  const live = pairs.filter(([, v]) => v != null && v !== '');
  const w = Math.max(0, ...live.map(([k]) => k.length));
  return live.map(([k, v]) => `${k.padEnd(w)}  ${v}`);
}

function block(title, lines) {
  const body = (lines || []).filter(l => l != null && String(l).trim() !== '');
  return body.length ? ['', title, ...body.map(l => '  ' + l)] : [];
}

export function sessionReport({ sign, species, agent, detail, screen, now } = {}) {
  const a = agent || {};
  const d = detail || {};
  const t = now ?? Date.now();

  const waiting = a.status === 'BLOCKED' && a.since
    ? `${a.status} · waiting ${elapsed(Math.max(0, t - a.since))}`
    : a.status || null;
  const ctx = a.contextPct != null
    ? `${a.contextPct}%${a.contextTokens != null ? ` · ${commas(a.contextTokens)} tokens` : ''}`
    : (a.contextTokens != null ? `${commas(a.contextTokens)} tokens` : null);
  const ws = [a.ref, a.workspaceId && `(${a.workspaceId})`, a.tty && `tty ${a.tty}`]
    .filter(Boolean).join('  ') || null;
  const linked = d.linked ? `yes${d.linkedBy ? ` (${d.linkedBy})` : ''}`
    : (d.transcriptPath ? 'guessed from the folder' : null);

  const head = [
    `PokeClaude session · ${sign || '?'}${species ? ` · ${species}` : ''}`,
    ...rows([
      ['status', waiting],
      ['title', clip(d.title || a.title, 120)],
      ['workspace', ws],
      ['folder', a.rawDir || a.dir],
      ['branch', a.branch ? `${a.branch}${a.gitDirty ? ' (uncommitted changes)' : ''}` : null],
      ['model', a.model],
      ['context', ctx],
      ['mode', a.permissionMode],
      ['session id', a.sessionId || d.sessionId],
      ['transcript', d.transcriptPath],
      ['linked', linked],
      ['note', d.ambiguous
        ? 'several agents share this folder and none is linked — the transcript above may belong to another one'
        : null],
    ]),
  ];

  const tools = (d.recentTools || []).slice(-6)
    .map(x => `${x.tool || x.name || '?'}${x.arg || x.input ? '  ' + oneLine(x.arg || x.input, 90) : ''}`);

  // A turn that was nothing but tool calls has no text of its own. Its row would read
  // "assistant" and then nothing, which is less use than no row, so it is dropped
  // before the tail is taken - otherwise the empty ones eat the twelve slots.
  const turns = (d.messages || [])
    .filter(m => m && m.role !== 'gap' && String(m.text || '').trim())
    .slice(-TURNS)
    .map(m => `${String(m.role).padEnd(9)} ${oneLine(m.text, TURN_CHARS)}`);

  const pane = String(screen ?? '').split('\n').slice(-SCREEN_LINES);

  return [
    ...head,
    ...block('WAITING ON', d.pending || []),
    ...block('RECENT TOOLS', tools),
    ...block(`LAST ${Math.min(TURNS, turns.length)} TURNS`, turns),
    ...block('TERMINAL', pane),
  ].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
