// Moving the pens you are working in from cmux onto our own pty.
//
// The switch is only worth throwing if the conversations come with it. A cmux pen is a
// claude or codex process, in a directory, with a session id; a native pen running
// `claude --resume <id>` in that same directory is the SAME conversation - its history,
// its context, its transcript, appended to rather than restarted.
//
// So the migration is a PLAN first and an action second, and you read the plan. Three
// rules, all of them about not losing work: never resume one session into two pens,
// because both would then append to one transcript; never drop a pen without saying
// why; and never touch the pen the server itself is running in.
import fs from 'node:fs';

const isMovable = (a) => a && a.kind !== 'service' && !a.hollow && a.status !== 'FAINTED';

export function migrationPlan(agents, { exclude = [], includeWorking = false } = {}) {
  const move = [], skip = [], seen = new Set();
  const skipIt = (a, reason) => skip.push({ ref: a.ref || a.workspaceId, dir: a.dir || null,
                                            title: a.title || '', reason });
  for (const a of agents || []) {
    if (exclude.includes(a.ref) || exclude.includes(a.workspaceId)) {
      skipIt(a, 'this is the pen the server itself runs in');
      continue;
    }
    if (a.kind === 'service') { skipIt(a, 'a service, not a conversation'); continue; }
    if (a.hollow) { skipIt(a, 'a restored tab with no terminal in it'); continue; }
    if (a.status === 'FAINTED') { skipIt(a, 'already gone'); continue; }
    // Mid-turn means a process is producing an answer right now. Resuming it elsewhere
    // kills that process, and the transcript keeps completed turns, not half-written
    // ones - so the turn in flight is simply lost.
    if (a.status === 'WORKING' && !includeWorking) {
      skipIt(a, 'mid-turn; moving it now would lose the answer being written');
      continue;
    }
    if (!isMovable(a)) { skipIt(a, 'not a conversation'); continue; }

    const engine = a.engine === 'codex' ? 'codex' : 'claude';
    // Two places name the conversation and they are not equally good.
    //
    // procSessionId (or codexSessionId) is read from the LIVE PROCESS TABLE, so it is
    // the session that tab is actually running. a.sessionId can also come from a hook,
    // and a hook outlives the process that sent it - fine for a pen that is still
    // running, which is all this moves, but worth saying which is which, because
    // resuming the wrong id opens the wrong conversation rather than failing.
    //
    // The API snapshot only carries sessionId, so a plan built from /api/state has
    // nothing else to go on. Both are accepted; the plan records which it used.
    const verified = engine === 'codex' ? a.codexSessionId : a.procSessionId;
    const sessionId = verified || a.sessionId;
    if (!sessionId) {
      // Nothing names the conversation, so nothing can reopen it. This is the case that
      // --session-id on every spawn was added to stop happening again.
      skipIt(a, 'no session id on its process, so there is nothing to resume');
      continue;
    }
    if (seen.has(sessionId)) { skipIt(a, 'that session is already being moved'); continue; }
    const dir = a.rawDir || a.dir;
    if (!dir) { skipIt(a, 'no directory recorded, so there is nowhere to resume it'); continue; }
    if (!dirExists(dir)) { skipIt(a, `${dir} no longer exists`); continue; }

    seen.add(sessionId);
    move.push({ ref: a.ref, sessionId, dir, engine, title: a.title || '',
                model: a.model || null,
                // "process" means read from the live process table; "hook" means the
                // session told us itself and nothing has re-checked it since.
                source: verified ? 'process' : 'hook',
                engineKnown: a.engine === 'codex' || a.engine === 'claude' });
  }
  return { move, skip };
}

// Separate so a test can plan without a filesystem.
let dirExists = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
export function useDirCheck(fn) { dirExists = fn; }

export function describePlan(plan) {
  const lines = [`${plan.move.length} pen${plan.move.length === 1 ? '' : 's'} to move:`];
  for (const m of plan.move) {
    const notes = [m.source === 'hook' ? 'id from a hook, not the process table' : null,
                   m.engineKnown ? null : `engine unknown, assuming ${m.engine}`]
      .filter(Boolean);
    lines.push(`  ${m.engine.padEnd(6)} ${m.sessionId}  ${m.dir}${m.title ? `  (${m.title})` : ''}`
      + (notes.length ? `\n         ${notes.join('; ')}` : ''));
  }
  if (plan.skip.length) {
    lines.push(`${plan.skip.length} left where they are:`);
    for (const s of plan.skip) lines.push(`  ${String(s.ref).padEnd(14)} ${s.reason}`);
  }
  return lines.join('\n');
}
