// What a native pen is doing, without cmux to ask.
//
// cmux wrote a `claude_code` status entry per workspace - Running, Needs input, Idle -
// and state.js mapped it to the field. Nothing writes one now, so status comes from the
// two sources that were always better anyway: the hooks, which fire on the event itself,
// and the pen's own screen, which is free to read once we own the pty.
//
// This is the rule sampleCodex already used for Codex pens, because cmux never wrote
// status entries for those either. It turns out to be the right rule for both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenStatus, statusFrom, HOOK_FRESH_MS } from '../src/server/nativestatus.js';

const CLAUDE_IDLE = [
  '❯ ',
  '─'.repeat(40),
  '  Opus 5.5 | gh:octocat | ▲user@example.com | pokeclaude | master',
  '  5h ●○○○○○○○○○  12%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const CLAUDE_WORKING = [
  '✶ Thinking… (12s · esc to interrupt)',
  '❯ ',
  '  Opus 5.5 | gh:octocat | pokeclaude | master',
].join('\n');

const CLAUDE_ASKING = [
  'Do you want to proceed?',
  '  1. Yes',
  '  2. No, tell Claude what to do differently',
  '  ↑↓ to move · Enter to select',
].join('\n');

test('a pen with a quiet composer is asleep', () => {
  assert.equal(screenStatus(CLAUDE_IDLE), 'ASLEEP');
});

test('"esc to interrupt" is the pen telling us it is working', () => {
  assert.equal(screenStatus(CLAUDE_WORKING), 'WORKING');
});

// A question beats working: the pen may still print a spinner while it waits, and a
// Pokemon that looks busy when it is actually blocked is the one you never go to.
test('a question on screen is blocked, even over a working footer', () => {
  assert.equal(screenStatus(CLAUDE_ASKING), 'BLOCKED');
  assert.equal(screenStatus(CLAUDE_ASKING + '\n' + CLAUDE_WORKING), 'BLOCKED');
});

test('a screen we could not read changes nothing', () => {
  assert.equal(screenStatus(''), null);
  assert.equal(screenStatus(null), null);
});

// Codex draws none of Claude Code's furniture, and its own footer is the evidence.
test('a Codex pen is read the same way, by its own footer', () => {
  const idle = '› \n  gpt-6-astra medium · ~/Desktop/scratch/pokeclaude';
  const busy = '• Working (esc to interrupt)\n› \n  gpt-6-astra medium · ~/x';
  assert.equal(screenStatus(idle), 'ASLEEP');
  assert.equal(screenStatus(busy), 'WORKING');
});

// A hook fires on the event itself, so for a moment it knows more than any screen can.
test('a fresh hook beats the screen', () => {
  const now = 1_000_000;
  assert.equal(statusFrom({ hook: 'WORKING', hookAt: now - 500, screen: CLAUDE_IDLE, now }), 'WORKING');
  assert.equal(statusFrom({ hook: 'ASLEEP', hookAt: now - 500, screen: CLAUDE_WORKING, now }), 'ASLEEP');
});

test('a stale hook does not, or a pen stays asleep through its whole next turn', () => {
  const now = 1_000_000;
  const old = now - HOOK_FRESH_MS - 1;
  assert.equal(statusFrom({ hook: 'ASLEEP', hookAt: old, screen: CLAUDE_WORKING, now }), 'WORKING');
  assert.equal(statusFrom({ hook: 'WORKING', hookAt: old, screen: CLAUDE_IDLE, now }), 'ASLEEP');
});

// A hook says a turn ended; the screen says a question is on it. The question is the
// one you have to act on.
test('a question on screen beats even a fresh hook that says idle', () => {
  const now = 1_000_000;
  assert.equal(statusFrom({ hook: 'ASLEEP', hookAt: now - 100, screen: CLAUDE_ASKING, now }), 'BLOCKED');
});

test('with neither a hook nor a readable screen, what we had stands', () => {
  const now = 1_000_000;
  assert.equal(statusFrom({ was: 'WORKING', screen: '', now }), 'WORKING');
  assert.equal(statusFrom({ now }), 'ASLEEP');
});
