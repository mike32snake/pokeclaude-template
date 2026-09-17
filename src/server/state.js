import { normalizeDir } from './paths.js';

// cmux status string -> game state
export function mapCmuxStatus(s) {
  if (s === 'Running') return 'WORKING';
  if (s === 'Needs input') return 'BLOCKED';
  if (s === 'Idle') return 'ASLEEP';
  return 'ASLEEP';
}

export function createState() {
  return { agents: new Map(), version: 0 };
}

// Reconcile with cmux: workspace list (ids, dirs, titles) + session JSON (statuses).
export function applyCmux(state, wsList, sessionRows, now = Date.now()) {
  const seen = new Set();
  const rows = [...sessionRows];
  // cmux lists workspaces in the same order in both sources, so position is an exact
  // 1:1 join where matching on (dir, title) is not: three tabs in one repo can all be
  // called "new agent". Position is only trusted when the directory agrees, so a
  // reordering degrades to the old fuzzy match instead of mislinking.
  const ordered = [...wsList].sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
  const positional = new Map();
  ordered.forEach((ws, i) => {
    const r = sessionRows[i];
    if (r && normalizeDir(r.dir) === normalizeDir(ws.current_directory)) positional.set(ws.id, r);
  });
  for (const ws of wsList) {
    seen.add(ws.id);
    // a service with no session-JSON row still counts as up

    let a = state.agents.get(ws.id);
    if (!a) {
      a = { workspaceId: ws.id, ref: ws.ref, sessionId: null, transcriptPath: null,
            status: 'ASLEEP', since: now, followers: 0, lastHookAt: -1e15 };
      state.agents.set(ws.id, a);
    }
    a.ref = ws.ref;
    // A workspace that is listening on a port and has no Claude session is a service
    // (dev server, tunnel), not an agent. Treat it differently everywhere.
    a.ports = ws.listening_ports || [];
    // A service is a workspace running a process, not a Claude session. Ports are the
    // strongest signal but cmux only reports them intermittently, so a server-ish title
    // with no Claude session counts too. Sticky once decided.
    const DEV = /\b(server|dev|watch|pm2|vite|next|webpack|tunnel|ngrok|daemon)\b/i;
    if (a.kind !== 'service') {
      if (a.ports.length && !a.sessionId) a.kind = 'service';
      else if (!a.sessionId && DEV.test(ws.title || '')) a.kind = 'service';
      else a.kind = a.kind || 'agent';
    }
    a.dir = normalizeDir(ws.current_directory);
    a.rawDir = ws.current_directory;
    a.title = ws.title || '';
    // Match a session-JSON row for status/branch. An exact (dir, title) match is the
    // best evidence and wins. Position only breaks TIES: several tabs in one repo can
    // share a title ("new agent"), and title matching then picks one at random, which
    // is what attached the wrong terminal to the wrong Pokemon.
    const dirN = a.dir;
    const titled = rows.filter(x => normalizeDir(x.dir) === dirN &&
      (x.processTitle === ws.title || x.customTitle === ws.title));
    let r = null;
    const pos = positional.get(ws.id) || null;
    if (titled.length === 1) r = titled[0];
    else if (titled.length > 1) r = titled.includes(pos) ? pos : titled[0];
    else {
      const sameDir = rows.filter(x => normalizeDir(x.dir) === dirN);
      if (sameDir.length) r = sameDir.includes(pos) ? pos : sameDir[0];
    }
    if (r) rows.splice(rows.indexOf(r), 1);
    // The live tree's tty (cmux.listWorkspaces) wins. The session file is saved now and
    // then, so it has no row for a new tab and a stale tty for a reused one.
    if (ws.tty) a.tty = ws.tty;
    if (r) {
      a.tty = ws.tty || r.tty || null;
      a.branch = r.branch;
      const st = a.kind === 'service' ? 'SERVING' : mapCmuxStatus(r.status);
      // cmux writes a claude_code status entry for a Claude tab and nothing at all for
      // a Codex one, so a row with no status in it reads as Idle and a Codex agent that
      // was visibly working went back to sleep on the field every three seconds. Its
      // status is read from its own pane instead (index.js sampleFooters); the poll
      // still owns everything else about it.
      const owned = a.engine && a.engine !== 'claude';
      // hooks are fresher than the poll for ~10s after they fire
      if (!owned && now - a.lastHookAt > 10_000 && st !== a.status) { a.status = st; a.since = r.statusAt || now; }
    }
  }
  for (const [id, a] of state.agents) if (!seen.has(id)) {
    if (a.status !== 'FAINTED') { a.status = 'FAINTED'; a.since = now; }
    a.faintedAt = a.faintedAt || now;
    // Short goodbye: the client fades the sprite out over this window, then it is gone.
    if (now - a.faintedAt > 6_000) state.agents.delete(id);
  }
  state.version++;
}

// A hook event from a live Claude Code session.
export function applyHook(state, { cmuxWorkspaceId, event }, now = Date.now()) {
  if (!cmuxWorkspaceId) return;
  let a = state.agents.get(cmuxWorkspaceId);
  if (!a) {
    a = { workspaceId: cmuxWorkspaceId, sessionId: null, status: 'WORKING', since: now, followers: 0, lastHookAt: -1e15 };
    state.agents.set(cmuxWorkspaceId, a);
  }
  a.lastHookAt = now;
  if (event.session_id) a.sessionId = event.session_id;
  if (event.transcript_path) a.transcriptPath = event.transcript_path;
  if (event.cwd) { a.rawDir = a.rawDir || event.cwd; a.dir = a.dir || normalizeDir(event.cwd); }
  const set = (s) => { if (a.status !== s) { a.status = s; a.since = now; } };
  switch (event.hook_event_name) {
    case 'UserPromptSubmit': set('WORKING'); break;
    case 'PreToolUse':
      set('WORKING');
      // toolSeq increments on every real tool call; the client animates on the change.
      a.lastTool = event.tool_name || null;
      a.lastToolAt = now;
      a.toolSeq = (a.toolSeq || 0) + 1;
      if (event.tool_name === 'Task' || event.tool_name === 'Agent') a.followers = Math.min(8, a.followers + 1);
      break;
    case 'Notification': set('BLOCKED'); break;
    case 'Stop': set('ASLEEP'); a.followers = 0; break;
    case 'SubagentStop': a.followers = Math.max(0, a.followers - 1); break;
    case 'SessionStart': set('WORKING'); break;
    case 'SessionEnd': set('ASLEEP'); break;
  }
  state.version++;
}

// A tab cmux restored on relaunch has no terminal in it until someone clicks it. It
// is listed like any other workspace, so the ranch drew it as an agent, guessed its
// conversation from the newest transcript in the repo (another agent's), and a message
// to it was refused with "Claude is not running in that tab". workspace.list does not
// say; only a read of the pane does, by failing with "Terminal surface not found". Any
// other failure is a read that did not happen, not evidence about the tab.
export const isHollow = (r) => !r?.ok && /surface not found/i.test(r?.stderr || '');
// Records what a read found. True when what the snapshot shows has changed.
export function markHollow(state, workspaceId, hollow) {
  const a = state.agents.get(workspaceId);
  if (!a) return false;
  const was = !!a.hollow;
  a.hollow = !!hollow;
  a.hollowAt = Date.now();
  if (was === a.hollow) return false;
  state.version++;
  return true;
}

export function snapshot(state) {
  return {
    version: state.version,
    agents: [...state.agents.values()].filter(a => !a.hollow).map(a => ({
      workspaceId: a.workspaceId, ref: a.ref || null, sessionId: a.sessionId,
      tty: a.tty || null,
      dir: a.dir || null, rawDir: a.rawDir || null, title: a.title || '',
      branch: a.branch || null, status: a.status, since: a.since, followers: a.followers,
      lastTool: a.lastTool || null, lastToolAt: a.lastToolAt || 0, toolSeq: a.toolSeq || 0,
      faintedAt: a.faintedAt || 0, kind: a.kind || 'agent', ports: a.ports || [],
      engine: a.engine || null,
      gitDirty: !!a.gitDirty,
      model: a.model || null, contextPct: a.contextPct ?? null,
      // The raw count travels too: a percentage alone cannot say whether 40% is 80k
      // of a standard window or 400k of a 1M one.
      contextTokens: a.contextTokens ?? null,
      permissionMode: a.permissionMode || null, footerAt: a.footerAt || 0,
    })),
  };
}
