import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftOnScreen, inputBoxState, agentReady, boxAction } from '../src/server/screen.js';
import { parseFooter } from '../src/server/cmux.js';
import { pendingPrompt, parseAsk } from '../src/server/pending.js';

const fast = text => `────────────────────\n› ${text}\n \n  gpt-6-astra default fast · ~/Desktop/sandbox`;
test('live Codex fast footer never becomes input text', () => {
  assert.equal(draftOnScreen(fast('Ask Codex to do anything')), '');
  assert.equal(draftOnScreen(fast('xxx')), 'xxx');
  assert.equal(agentReady(fast('Ask Codex to do anything')), true);
  assert.equal(parseFooter(fast('')).model, 'gpt-6-astra');
});
const approval = 'Would you like to run this command?\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel';
test('Codex approval is a question, never a draft to probe', () => {
  const gate = inputBoxState(approval);
  assert.equal(gate.ok, false);
  assert.equal(gate.draft, undefined);
  const ask = parseAsk(pendingPrompt(approval));
  assert.equal(ask.options[0].selected, true);
  assert.equal(ask.options.length, 2);
});
test('transport errors are not proof that the terminal is frozen', () => {
  const action = boxAction({ ok: false, draft: 'hello' }, { ok: false, stderr: 'socket denied' });
  assert.equal(action.frozen, false);
  assert.match(action.reason, /socket denied/);
});
