// Reading a Codex pane.
//
// Codex draws the same shape as Claude Code and none of the same details. Its
// composer prompt is "›", not "❯"; its empty box holds the placeholder "Ask Codex to
// do anything" where Claude Code holds a `Try "..."` hint; and there is no rule under
// the box, so the reader that stops at "────" ran on past the composer and swallowed
// the footer line into the draft. Every screen below was captured from a live pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftOnScreen, inputBoxState, agentReady, trustGate, promptLanded } from '../src/server/screen.js';
import { parseFooter } from '../src/server/cmux.js';

const CWD = '/Users/dev/Desktop/scratch/pokeclaude';
const RULE = '─'.repeat(120);
const FOOT = `  gpt-5.5 default · ${CWD}`;

const IDLE = [RULE, ' ', ' ', '› Ask Codex to do anything', ' ', FOOT].join('\n');

const DRAFT = [RULE, ' ', ' ', '› a half written line', '  and a second one', ' ', FOOT].join('\n');

const WORKING = ['• Working (7s • esc to interrupt)', ' ', ' ',
  '› Ask Codex to do anything', ' ', FOOT].join('\n');

// A fresh pane stops here, and the option list starts with "›" just as the composer
// does. Typing the task now types it into the dialog and the agent never starts.
const TRUST = ['> You are in ' + CWD, '',
  '  Do you trust the contents of this directory? Working with untrusted contents',
  '  comes with higher risk of prompt injection.', '',
  '› 1. Yes, continue', '  2. No, quit', '', '  Press enter to continue'].join('\n');

const CLAUDE_TRUST = ['  Do you trust this folder?', '', '  ❯ 1. Yes, proceed',
  '    2. No, exit', '', '  Enter to confirm · Esc to exit'].join('\n');

const CLAUDE_IDLE = ['✻ Baked for 7m 45s', '', RULE, '❯ ', RULE,
  '  Opus 5 (1M context) | gh:octocat',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

test('the placeholder in an empty Codex box is not a draft', () => {
  assert.equal(draftOnScreen(IDLE), '');
});

// This is the bug the footer terminator exists for: without it the draft came back as
// "a half written line\nand a second one\ngpt-5.5 default · /Users/…", so every send
// to a Codex pen was refused and quoted a path back at the user.
test('a Codex draft stops at the footer instead of eating it', () => {
  assert.equal(draftOnScreen(DRAFT), 'a half written line\nand a second one');
});

test('an idle Codex pane accepts a message', () => {
  assert.equal(inputBoxState(IDLE).ok, true);
});

test('a Codex pane with unsent text is refused and quoted', () => {
  const s = inputBoxState(DRAFT);
  assert.equal(s.ok, false);
  assert.match(s.reason, /a half written line/);
});

test('an idle Codex pane is ready for a task to be typed into it', () => {
  assert.equal(agentReady(IDLE), true);
  assert.equal(agentReady(CLAUDE_IDLE), true);
});

test('a startup image path replaced by an attachment marker has landed', () => {
  const screen = ['› [Image #1]', '  can you fix this issue on the website?', '', FOOT].join('\n');
  assert.equal(promptLanded(screen, '/tmp/screenshot.png\ncan you fix this issue on the website?'), true);
});

test('an image-only startup prompt has landed', () => {
  assert.equal(promptLanded(['› [Image #1]', '', FOOT].join('\n'), '/tmp/screenshot.png'), true);
});

test('an image in a past turn does not confirm a startup prompt', () => {
  assert.equal(promptLanded('› [Image #1]\n' + IDLE, '/tmp/screenshot.png'), false);
});

// The option list's "›" reads as a composer, so only the missing footer keeps this
// from looking ready. Both halves of the check earn their place.
test('a pane still on the trust dialog is not ready', () => {
  assert.equal(agentReady(TRUST), false);
});

test('a pane that has not drawn its agent yet is not ready', () => {
  assert.equal(agentReady(''), false);
  assert.equal(agentReady('dev@laptop pokeclaude % '), false);
});

test('a working Codex pane is still ready: the box is empty and takes a message', () => {
  assert.equal(agentReady(WORKING), true);
});

// Both engines gate on trust, ask it differently, and take a different answer: Claude
// Code wants the digit then Enter, Codex has option 1 already selected.
test('each trust dialog is answered the way that dialog wants', () => {
  assert.deepEqual(trustGate(TRUST), { keys: ['enter'] });
  assert.deepEqual(trustGate(CLAUDE_TRUST), { keys: ['1', 'enter'] });
  assert.equal(trustGate(IDLE), null);
  assert.equal(trustGate(CLAUDE_IDLE), null);
});

test('the Codex footer names the engine and the model', () => {
  const f = parseFooter(IDLE);
  assert.equal(f.engine, 'codex');
  assert.equal(f.model, 'gpt-5.5');
  assert.equal(f.busy, false);
});

test('a Codex pane says when it is working, since cmux never reports its status', () => {
  assert.equal(parseFooter(WORKING).busy, true);
});

// The pens are mixed, so the footer reader must not decide "codex" from a Claude pane
// and blank the model it reads perfectly well.
test('a Claude pane is still read as Claude', () => {
  const f = parseFooter(CLAUDE_IDLE);
  assert.equal(f.engine, 'claude');
  assert.equal(f.model, 'Opus 5 (1M context)');
  assert.equal(f.permissionMode, 'bypass permissions');
});
