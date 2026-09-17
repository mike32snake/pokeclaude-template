// Explicit terminal interaction: inspect first, then perform exactly the user's action.
import { pendingPrompt, parseAsk, stepsTo } from './pending.js';
import { composerRegion, inputBoxState } from './screen.js';

// Progress output is not an input change. Unknown screens and pickers still
// require the full frame; a known composer may ignore output above its box.
function sameInput(before, after) {
  if (before === after) return true;
  if (pendingPrompt(before) || pendingPrompt(after)) return false;
  const oldGate = inputBoxState(before), newGate = inputBoxState(after);
  if (!(oldGate.ok || oldGate.draft) || !(newGate.ok || newGate.draft)) return false;
  const box = composerRegion(before);
  return !!box && box === composerRegion(after);
}
const fail = error => ({ ok: false, error });
const KEYS = new Set(['up', 'down', 'left', 'right', 'tab', 'shift+tab', 'space', 'enter', 'escape', 'backspace', 'home', 'end', 'ctrl+a', 'ctrl+e', 'ctrl+k', 'ctrl+u']);
export async function terminalAction(ws, request, io) {
  if (!KEYS.has(request.key) && !(request.key == null && typeof request.text === 'string' && request.text.length > 0 && request.text.length <= 1000 && !/[\x00-\x1f\x7f]/.test(request.text))) {
    return fail('Use a listed key or a single line of text. Type does not submit; use Enter separately.');
  }
  const before = await io.read(ws, 50);
  if (!before.ok) return fail('Could not read the terminal. Refresh and try again.');
  if (!request.screen || !sameInput(request.screen, before.stdout)) return { ...fail('The terminal changed. Review the refreshed screen before acting.'), screen: before.stdout };
  const result = request.key ? await io.key(ws, request.key) : await io.write(ws, request.text);
  if (!result.ok) return fail(result.stderr || 'The terminal did not accept that action.');
  const after = await io.read(ws, 50);
  return { ok: true, screen: after.ok ? after.stdout : null };
}
const identity = ask => JSON.stringify([ask.header, ask.question, ask.tabs, ask.multi, ask.options.map(o => [o.n, o.label, o.description, o.kind])]);
const readAsk = async (io, ws) => {
  const r = await io.read(ws, 50);
  return r.ok ? parseAsk(pendingPrompt(r.stdout)) : null;
};
export async function chooseOption(ws, { optionIndex, optionLabel, question }, io) {
  const first = await readAsk(io, ws);
  const target = first?.options.find(o => o.n === optionIndex);
  if (!Number.isInteger(optionIndex) || !target || !optionLabel || target.label !== optionLabel || (question != null && question !== first.question)) return fail('The question or options changed. Review the current question.');
  const id = identity(first);
  let ask = first;
  for (let n = 0; n <= first.options.length; n++) {
    if (!ask || identity(ask) !== id) return fail('The question changed while navigating. Nothing was confirmed.');
    const step = stepsTo(ask.options, optionIndex);
    if (!step) return fail('Cannot see the selected option. Use Terminal controls.');
    if (!step.count) {
      const r = await io.key(ws, 'enter');
      if (!r.ok) return fail(r.stderr || 'The answer did not reach the terminal.');
      return { ok: true, stillAsking: !!await readAsk(io, ws) };
    }
    const from = ask.options.find(o => o.selected)?.n;
    const r = await io.key(ws, step.key);
    if (!r.ok) return fail(r.stderr || 'Could not move the selection.');
    // Wait for the cursor, not a fixed burst of keys into an asynchronously drawn UI.
    for (let poll = 0; poll < 30; poll++) {
      ask = await readAsk(io, ws);
      if (!ask || identity(ask) !== id || ask.options.find(o => o.selected)?.n !== from) break;
      await io.sleep?.(50);
    }
    if (ask?.options.find(o => o.selected)?.n === from) return fail('The selection did not move. Review Terminal controls.');
  }
  return fail('Could not reach that option. Nothing was confirmed.');
}
