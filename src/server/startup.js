import { agentReady, trustGate, promptLanded, inputBoxState, composerRegion,
  queuedOnScreen, READ_LINES } from './screen.js';

const fail = error => ({ ok: false, error });

// Readiness, typing and submission are separate phases. Once typing starts, never
// go back to waiting for an EMPTY composer or retry the task: a partial draft would
// either sit there forever or get duplicated. The caller keeps the form on failure.
export async function startAgent(ws, prompt, io) {
  let trusted = false, ready = false;
  for (let n = 0; n < 90; n++) {
    const scr = await io.read(ws, READ_LINES);
    if (scr.ok) {
      const gate = trustGate(scr.stdout);
      if (gate && !trusted) {
        for (const key of gate.keys) {
          const r = await io.key(ws, key);
          if (!r.ok) return fail(`Could not clear the folder trust dialog: ${r.stderr || 'terminal unavailable'}.`);
        }
        trusted = true;
      } else if (!gate && agentReady(scr.stdout)) {
        ready = true;
        break;
      }
    }
    await io.sleep(1000);
  }
  if (!ready) return fail('The agent did not become ready for its task.');

  const typed = await io.type(ws, prompt);
  if (!typed.ok) return fail(`The task may be partly typed: ${typed.stderr || 'terminal write failed'}.`);

  let landed = false;
  for (let n = 0; n < 30; n++) {
    await io.sleep(100);
    const scr = await io.read(ws, READ_LINES);
    if (!scr.ok) continue;
    const gate = inputBoxState(scr.stdout);
    if (!gate.ok && !gate.draft) return fail('The terminal changed before the task could be submitted.');
    if (promptLanded(scr.stdout, prompt)) { landed = true; break; }
  }
  if (!landed) return fail('Could not verify the task in the input box.');

  // One Enter only. An uncertain submission must not accidentally confirm a dialog
  // or submit the task twice. A successful cmux write alone is not proof it was sent.
  const hit = await io.key(ws, 'enter');
  if (!hit.ok) return fail(`The task was typed, but Enter failed: ${hit.stderr || 'terminal unavailable'}.`);
  for (let n = 0; n < 30; n++) {
    await io.sleep(100);
    const scr = await io.read(ws, READ_LINES);
    if (scr.ok && composerRegion(scr.stdout) && inputBoxState(scr.stdout).ok) {
      return { ok: true, queued: queuedOnScreen(scr.stdout) };
    }
  }
  return fail('Task submission could not be verified.');
}
