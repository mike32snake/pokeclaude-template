// The "cmux restarted" checklist, as pure functions.
//
// The server keeps the sessions that died with cmux (src/server/roster.js) and sends
// them as `restore` on every state snapshot. Everything starts ticked, because after a
// crash the usual wish is "put it all back"; `unchecked` holds only what was unticked.
const WAS = { WORKING: 'was working', THINKING: 'was working', BLOCKED: 'was waiting on you', ASLEEP: 'was idle' };

export function restoreModel(lost, unchecked, signFor) {
  const rows = (lost || []).map(s => ({
    id: s.sessionId,
    sign: signFor(s.dir) || s.dir.split('/').filter(Boolean).pop() || s.dir,
    title: s.title || 'untitled session',
    engine: s.engine === 'codex' ? 'CODEX' : 'CLAUDE',
    was: WAS[s.status] || 'was running',
    checked: !unchecked.has(s.sessionId),
  }));
  return { rows, picked: rows.filter(r => r.checked).map(r => r.id) };
}

// Part of the list's render key, or ticking a box silently redraws nothing.
export const restoreKey = (lost, unchecked) => (lost || [])
  .map(s => s.sessionId + (unchecked.has(s.sessionId) ? '-' : '+')).join(',');
