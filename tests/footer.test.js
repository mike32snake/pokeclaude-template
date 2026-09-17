// What the status bar shows about a running agent: which model, how much of its
// context window is gone, and which permission mode it is in.
//
// All three were blank. parseFooter was written when Claude Code printed
// "model | 22% | bypass permissions" on one pipe-separated line, and it demanded that
// percentage before it would believe any of it. The footer has moved on: the model now
// shares its line with the GitHub account and the email, the mode is on its own line,
// and in a narrow pane Claude Code truncates the line with an ellipsis so the
// percentage is not on screen at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFooter, contextWindow } from '../src/server/cmux.js';

// Captured from a live 60-column cmux pane, ellipsis and all.
const NARROW = [
  '❯ ',
  '────────────────────────────────────────────────────────────',
  '  Opus 5 (1M context) | gh:octocat | ▲user@work.…',
  '  5h ●○○○○○○○○○  12% ⟳ 9:00pm  │  7d ●●●●●○○○○○  51% ⟳ au…',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for a…',
].join('\n');

test('a narrow pane still tells us the model and the mode', () => {
  const f = parseFooter(NARROW);
  assert.equal(f.model, 'Opus 5 (1M context)');
  assert.equal(f.permissionMode, 'bypass permissions');
});

test('a truncated footer reports no context rather than a wrong one', () => {
  // The percentage was cut off by the ellipsis. Guessing would be worse than a dash.
  assert.equal(parseFooter(NARROW).contextPct, null);
});

test('the account usage line is not mistaken for the context window', () => {
  // "5h ... 12% ... 7d ... 51%" is how much of the SUBSCRIPTION is spent. Reading it
  // as this agent's context would put a number in the bar that means nothing.
  assert.equal(parseFooter(NARROW).contextPct, null);
});

test('a wide pane that still prints the percentage is read as before', () => {
  const wide = [
    '  Opus 5 (1M context) | 22% (220k/1000k) | bypass permissions',
  ].join('\n');
  const f = parseFooter(wide);
  assert.equal(f.model, 'Opus 5 (1M context)');
  assert.equal(f.contextPct, 22);
  assert.equal(f.permissionMode, 'bypass permissions');
});

test('every permission mode is recognised, wherever it is printed', () => {
  assert.equal(parseFooter('  ⏵⏵ accept edits on (shift+tab to cycle)').permissionMode, 'accept edits');
  assert.equal(parseFooter('  ⏸ plan mode on (shift+tab to cycle)').permissionMode, 'plan');
  assert.equal(parseFooter('nothing to see here').permissionMode, null);
});

test('a pipe in ordinary output is not read as a footer', () => {
  // Transcript text and shell commands are full of pipes. Only a line whose first
  // segment reads like a model name counts.
  const noise = 'grep -n foo | head -3\n  cat x | wc -l\n';
  const f = parseFooter(noise);
  assert.equal(f.model, null);
  assert.equal(f.contextPct, null);
});

test('the model name survives the parentheses that used to break naive regexes', () => {
  assert.equal(parseFooter('  Sonnet 4.5 | gh:someone | x@y.z').model, 'Sonnet 4.5');
  assert.equal(parseFooter('  Opus 4.8 (1M context) | 5% | plan mode').model, 'Opus 4.8 (1M context)');
});

// The window is the denominator for the percentage we work out from the transcript.
// Claude Code writes no context-window field anywhere, so the model label is the only
// thing that says whether this session is the 1M variant.
test('a 1M model label means a million tokens of context', () => {
  assert.equal(contextWindow('Opus 5 (1M context)'), 1_000_000);
  assert.equal(contextWindow('Opus 4.8 (1m context)'), 1_000_000);
});

test('anything else is the standard window, including an unknown model', () => {
  assert.equal(contextWindow('Opus 5'), 200_000);
  assert.equal(contextWindow('Sonnet 4.5'), 200_000);
  assert.equal(contextWindow(null), 200_000);
});

// Fable has no 200k variant: the million IS its default, so Claude Code prints no
// "(1M context)" next to it and there is no [1m] on the model id either. Reading the
// label alone put a 388k session against a 200k window and pinned the bar at 100%.
test('Fable is a million tokens with nothing in the label to say so', () => {
  assert.equal(contextWindow('Fable 5'), 1_000_000);
  assert.equal(contextWindow('claude-fable-5'), 1_000_000);
  assert.equal(contextWindow('Mythos 5'), 1_000_000);
});

// The footer label is the first thing a narrow pane truncates, and "(1M context)" is
// at the end of it. The transcript carries the exact model id, suffix included.
test('the raw model id from the transcript can carry the 1M the footer dropped', () => {
  assert.equal(contextWindow('Opus 5', 'claude-opus-5[1m]'), 1_000_000);
  assert.equal(contextWindow(null, 'claude-opus-5[1m]'), 1_000_000);
  assert.equal(contextWindow('Opus 5', 'claude-opus-5'), 200_000);
});

// Two sources, one answer. The footer knows the model's display name and, in a wide
// pane, the percentage. The transcript knows the token count and the mode exactly.
// Whichever has a value wins; a null from one must never erase the other. That erasure
// is the bug that left the bar reading "model – ctx –" while both were known.
import { agentFacts } from '../src/server/cmux.js';

const noFooter = { model: null, contextPct: null, permissionMode: null };
const noTail = { model: null, contextTokens: null, permissionMode: null };

test('a truncated footer still gets its context from the transcript', () => {
  const f = agentFacts({ ...noTail, contextTokens: 107_003 },
                       { ...noFooter, model: 'Opus 5 (1M context)', permissionMode: 'bypass permissions' });
  assert.equal(f.model, 'Opus 5 (1M context)');
  assert.equal(f.contextPct, 11);            // 107,003 of 1,000,000
  assert.equal(f.contextTokens, 107_003);
  assert.equal(f.permissionMode, 'bypass permissions');
});

test('the same token count is a much bigger share of a standard window', () => {
  const f = agentFacts({ ...noTail, contextTokens: 107_003 }, { ...noFooter, model: 'Opus 5' });
  assert.equal(f.contextPct, 54);            // 107,003 of 200,000
});

test('a percentage the footer printed itself is trusted over our arithmetic', () => {
  const f = agentFacts({ ...noTail, contextTokens: 10_000 },
                       { ...noFooter, model: 'Opus 5', contextPct: 22 });
  assert.equal(f.contextPct, 22);
});

test('the mode falls back to the transcript when the footer never showed it', () => {
  const f = agentFacts({ ...noTail, permissionMode: 'accept edits' }, noFooter);
  assert.equal(f.permissionMode, 'accept edits');
});

test('a screen we could not read leaves what the transcript knows intact', () => {
  const f = agentFacts({ model: 'claude-opus-5', contextTokens: 4000, permissionMode: 'plan' }, noFooter);
  assert.equal(f.model, 'claude-opus-5');    // the id, until the footer offers a nicer name
  assert.equal(f.permissionMode, 'plan');
  assert.equal(f.contextPct, 2);
});

test('nothing known reports nothing, so the bar shows a dash rather than a zero', () => {
  const f = agentFacts(noTail, noFooter);
  assert.equal(f.model, null);
  assert.equal(f.contextPct, null);
  assert.equal(f.contextTokens, null);
  assert.equal(f.permissionMode, null);
});

// Claude Code compacts before a session reaches its window, so a count past the window
// is not a full session: it is proof the window we assumed is the wrong one. Clamping
// it to 100% is how a Fable agent with 388k of a million spare read as "about to die".
test('a count past the assumed window means the window was assumed wrong', () => {
  const f = agentFacts({ ...noTail, contextTokens: 236_000 }, { ...noFooter, model: 'Opus 5' });
  assert.equal(f.contextPct, 24);            // 236,000 of 1,000,000, not 118% clamped to 100
});

test('the Fable agent that started this: 388k is a third of its window, not all of it', () => {
  const f = agentFacts({ ...noTail, contextTokens: 388_005 }, { ...noFooter, model: 'Fable 5' });
  assert.equal(f.contextPct, 39);
});

test('past even the largest window we know, say nothing rather than lie', () => {
  const f = agentFacts({ ...noTail, contextTokens: 1_400_000 }, { ...noFooter, model: 'Opus 5' });
  assert.equal(f.contextPct, null, 'a dash is honest; 100% is a warning that is not true');
  assert.equal(f.contextTokens, 1_400_000, 'the measurement itself is still worth showing');
});
