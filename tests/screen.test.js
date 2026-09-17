// Can the panel type into this terminal?
//
// The old guard read the last 8 lines and demanded a "❯" among them. A Claude Code
// pane spends 7 of those 8 lines on the composer border and the three footer lines,
// so ONE unsent line of draft text pushes the "❯" out of the window and the send is
// refused with "no input box visible" while the input box is plainly on screen. That
// is the bug this file exists for: the window was too small and the only evidence it
// accepted was the one glyph most likely to scroll away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputBoxState, draftOnScreen, queuedOnScreen, promptLanded } from '../src/server/screen.js';

const FOOTER = [
  '────────────────────────────────────────────────────────────',
  '  Opus 5 (1M context) | gh:octocat | ▲user@work.…',
  '  5h ○○○○○○○○○○   2% ⟳ 1:10pm  │  7d ●●●●●○○○○○  53% ⟳ au…',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for a…',
];

const IDLE = ['✻ Baked for 7m 45s', '', '────────────────────────────────────────────────────────────',
  '❯ ', ...FOOTER].join('\n');

// Captured live from a cmux pane holding an unsent multi-line draft.
const LONG_DRAFT = ['', '                    ✔ Update installed · Restart to update',
  '────────────────────────────────────────────────────────────',
  '❯ ',
  '  for the premier law site - push the preview we had',
  '  previously made to share with him before making edits to',
  '  the live site.  also make these additional changes',
  '',
  '  Home',
  '  * scroll issue - bottom of the middle of the hero has',
  '  the scroll animation telling you do go down. I dont want',
  '  it',
  '  * Spread out two boxes since we got rid of estate',
  '  About Us',
  '  * make sure it keeps law school and updates we made',
  '  Purchase sale',
  '  * no title insight in FAQ',
  '', '  ',
  '  estate site is fine as is',
  ...FOOTER].join('\n');

test('an idle Claude pane accepts a message', () => {
  assert.equal(inputBoxState(IDLE).ok, true);
});

test('a working Claude pane accepts a message: it queues', () => {
  const working = ['✽ Booping… (19m 41s · ↓ 56.5k tokens)',
    '────────────────────────────────────────────────────────────', '❯ ', ...FOOTER].join('\n');
  assert.equal(inputBoxState(working).ok, true);
});

// The regression. The composer is right there; only the "❯" is above the fold. It is
// refused all the same, but for the reason that is true: the box already holds text,
// and typing more would submit both together as one message nobody wrote.
test('a long unsent draft is seen for what it is, not as a missing input box', () => {
  const r = inputBoxState(LONG_DRAFT);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /no input box/i);
  assert.match(r.reason, /unsent/i);
  assert.match(r.reason, /premier law site/);
});

test('a one-line draft is refused and quoted', () => {
  const s = ['────────────────────────────────────────────────────────────',
    '❯ B', ...FOOTER].join('\n');
  const r = inputBoxState(s);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsent/i);
  assert.match(r.reason, /"B"/);
});

test('draftOnScreen reads what sits in the composer', () => {
  assert.equal(draftOnScreen(IDLE), '');
  assert.equal(draftOnScreen(FOOTER.join('\n')), '');
  assert.equal(draftOnScreen(['────────', '❯ hello there', ...FOOTER].join('\n')), 'hello there');
  assert.match(draftOnScreen(LONG_DRAFT), /^for the premier law site/);
  assert.match(draftOnScreen(LONG_DRAFT), /estate site is fine as is$/);
});

// A past turn is printed as "> text" above the composer. That is history, not a draft.
test('an earlier prompt in the transcript is not a draft', () => {
  const s = ['> fix the tests', '', '⏺ Done.', '', '────────', '❯ ', ...FOOTER].join('\n');
  assert.equal(draftOnScreen(s), '');
  assert.equal(inputBoxState(s).ok, true);
});

// The long-draft window matters: the draft is longer than anything we read, the "❯"
// is off-screen for real, and only the footer shows. Nothing to quote, so it passes.
test('a draft too long to see its prompt still passes on the footer', () => {
  assert.equal(inputBoxState(FOOTER.join('\n')).ok, true);
});

// Worse: the draft is longer than anything we read, so the "❯" is off-screen for real.
// The footer is still there, and the footer only prints while Claude Code is running.
test('the footer alone is proof enough that Claude is running', () => {
  assert.equal(inputBoxState(FOOTER.join('\n')).ok, true);
});

test('a plain shell is refused, and says so in plain words', () => {
  const shell = ['$ ls', 'AGENTS.md  README.md  src  tests', '$ '].join('\n');
  const r = inputBoxState(shell);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Claude/i);
});

test('a blank screen is refused', () => {
  assert.equal(inputBoxState('').ok, false);
  assert.equal(inputBoxState('   \n\n ').ok, false);
});

// Typing prose at a picker inserts nothing and picks nothing. Refuse, and name the
// reason, because "no input box" was never what was wrong here.
test('an open question is refused with its own reason', () => {
  const asking = ['  Which one?', '  1. keep it', '❯ 2. rewrite it', '',
    '  ↑↓ to move · Enter to select', ...FOOTER].join('\n');
  const r = inputBoxState(asking);
  assert.equal(r.ok, false);
  assert.match(r.reason, /question/i);
});

test('a permission prompt is refused with its own reason', () => {
  const perm = ['  Bash command', '  rm -rf build', '',
    '  Do you want to proceed?', '  1. Yes', '  2. No', ...FOOTER].join('\n');
  const r = inputBoxState(perm);
  assert.equal(r.ok, false);
  assert.match(r.reason, /question|permission/i);
});

// A fresh Claude Code prints a hint in its empty box, "Try \"fix lint errors\"", in
// the same place a draft would be. It is not a draft, and refusing it as one broke
// every first send to a new agent.
test('the placeholder hint in an empty box is not a draft', () => {
  const s = ['────────', '❯ Try "write a test for <filepath>"', ...FOOTER].join('\n');
  assert.equal(draftOnScreen(s), '');
  assert.equal(inputBoxState(s).ok, true);
});

// Continuation lines are indented two spaces by Claude Code; that is layout, not text.
test('a multi-line draft is read without the composer indent', () => {
  const s = ['────────', '❯ first', '  second', ...FOOTER].join('\n');
  assert.equal(draftOnScreen(s), 'first\nsecond');
});

// Claude Code queues a message typed while it is working, and prints this hint in the
// empty box until the turn ends. Captured live from a Haiku pane mid-turn. Reading it
// as a draft made every message to a busy agent come back "still sitting in that
// tab" when it had been queued fine, and refused the next one for "unsent text".
const QUEUED = ['✳ Channelling… (22s · ↓ 252 tokens)',
  '  ❯ second message probe',
  '────────────────────────────────────────────────────────────',
  '❯ Press up to edit queued messages', ...FOOTER].join('\n');

test('the queued-messages hint in an empty box is not a draft', () => {
  assert.equal(draftOnScreen(QUEUED), '');
  assert.equal(inputBoxState(QUEUED).ok, true);
});

test('queuedOnScreen sees the hint, and nothing else', () => {
  assert.equal(queuedOnScreen(QUEUED), true);
  assert.equal(queuedOnScreen(IDLE), false);
  assert.equal(queuedOnScreen(LONG_DRAFT), false);
});

// The refusal carries the draft itself, so the panel can offer to send or discard it
// instead of sending the user to the tab for a message they already typed once.
test('a stuck draft comes back with the refusal, whole', () => {
  const s = ['────────', '❯ update PROJECT_STATE.md', ...FOOTER].join('\n');
  const r = inputBoxState(s);
  assert.equal(r.ok, false);
  assert.equal(r.draft, 'update PROJECT_STATE.md');
  assert.equal(inputBoxState(IDLE).draft, undefined);
});


// A spawned agent gets its task typed in, and the spawn presses Enter only once the
// task is visibly sitting in the box. The old check looked for the first characters of
// the prompt, which Claude Code hides the moment a paste is big enough to fold into a
// "[Pasted text #N]" marker. Enter never came, the box kept the task, and the agent
// the user made to do work just sat there. promptLanded() accepts the marker too.
const RULE = '────────────────────────────────────────────────────────────';
const box = (...lines) => [RULE, ...lines, RULE, '  Fable 5 | gh:octocat | scratch | default'].join('\n');

test('a short prompt typed literally into the box has landed', () => {
  assert.equal(promptLanded(box('❯ summarize the repo'), 'summarize the repo'), true);
});
test('a big paste folded into a marker has landed, even though its words are hidden', () => {
  const screen = box('❯ The National Provider Enrollment (NPE) Contractors are', '  accepting applications from DMEPOS suppliers.', '  [Pasted text #1]');
  assert.equal(promptLanded(screen, 'The National Provider Enrollment (NPE) Contractors are accepting applications and a great deal more text besides'), true);
});
test('an empty box has nothing in it, so the prompt has not landed', () => {
  assert.equal(promptLanded(box('❯ '), 'summarize the repo'), false);
});
test('a suggestion painted in the empty box is not the prompt landing', () => {
  assert.equal(promptLanded(box('❯ Try "fix the bug"'), 'summarize the repo'), false);
});

// What the send and discard paths do once the box read and, when it refused, a probe
// of the pane are in hand. A frozen tab (the probe typed a letter and nothing moved)
// must not be offered as a draft to send or discard: no keystroke clears it, so the
// panel would trap the user pressing buttons that can never work. It says so instead.
import { boxAction } from '../src/server/screen.js';

test('a free box sends', () => {
  assert.deepEqual(boxAction({ ok: true }, null), { send: true });
});
test('a suggestion in the box is typed over, so it sends', () => {
  assert.deepEqual(boxAction({ ok: false, draft: 'Try "x"' }, { ghost: true, draft: 'Try "x"' }), { send: true });
});
test('a real draft is offered to send or discard, not called frozen', () => {
  const a = boxAction({ ok: false, draft: 'hello', reason: 'unsent text' }, { ghost: false, draft: 'hello' });
  assert.equal(a.send, false); assert.equal(a.frozen, false); assert.equal(a.draft, 'hello');
});
test('an unverified keystroke is uncertain and is not offered as a clearable draft', () => {
  const a = boxAction({ ok: false, draft: 'ghosty' }, { ok: false, stderr: 'the tab did not take a keystroke' });
  assert.equal(a.send, false); assert.equal(a.frozen, false);
  assert.equal(a.uncertain, true);
  assert.equal(a.draft, undefined);
  assert.match(a.reason, /Refresh Terminal controls/i);
});
test('a box refused for a reason other than a draft passes its reason through', () => {
  const a = boxAction({ ok: false, reason: 'Claude is not running in that tab — open it and start Claude' }, null);
  assert.equal(a.send, false); assert.equal(a.frozen, false);
  assert.match(a.reason, /not running/);
});

test('Codex queue shortcut is outside the composer text', () => {
 assert.equal(draftOnScreen('› hello\n\n  tab to queue message    67% context left'), 'hello');
});
