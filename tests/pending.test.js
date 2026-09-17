// What a blocked agent is waiting for exists in exactly one place: the terminal.
//
// Claude Code does not write an AskUserQuestion to the transcript while it is pending.
// Measured, not assumed: a sampler watched the file for the whole fifteen minutes a
// question sat unanswered and recorded no writes, and the tool_use line and its answer
// landed as adjacent lines afterwards. So the panel cannot learn about a question from
// the transcript, however promptly it is told the file changed. It has to read the
// screen, which is what this trims down to something worth showing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingPrompt, parseAsk, stepsTo } from '../src/server/pending.js';

// A real capture: cmux pane, agent finished a turn and is waiting at an empty prompt.
const IDLE = `  Verified in the browser: dragged pokeclaude to the top and
  its pen moved to the top-left slot; hide and unhide still
  work. Committed as f7b8dff.

✻ Baked for 7m 45s

※ recap: Goal was drag-and-drop reordering in the FILTER
  menu. That is built, tested (202 passing) and committed.

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  Opus 5 (1M context) | gh:octocat | ▲user@work.…
  5h ●○○○○○○○○○  19% ⟳ 9:00pm  │  7d ●●●●●○○○○○  52% ⟳ au…
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for a…`;

// The same pane with a question on it. The box is what the panel has to show.
const ASKING = `⏺ I can take either route here.

╭─────────────────────────────────────────────────────────╮
│ Which grid size should the field default to?            │
│                                                          │
│ ❯ 1. 3×3  Bigger pens, fewer repos on screen            │
│   2. 5×5  Every repo at once, smaller pens              │
│   3. Other                                               │
╰─────────────────────────────────────────────────────────╯

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  Opus 5 (1M context) | gh:octocat | ▲user@work.…
  5h ●○○○○○○○○○  19% ⟳ 9:00pm  │  7d ●●●●●○○○○○  52% ⟳ au…
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for a…`;

test('the footer is not part of what the agent is asking', () => {
  const p = pendingPrompt(ASKING);
  const text = p.join('\n');
  assert.ok(!text.includes('bypass permissions'), 'the mode line is chrome');
  assert.ok(!text.includes('Opus 5'), 'the model line is chrome');
  assert.ok(!/5h ●/.test(text), 'the usage meters are chrome');
});

test('the question and every option survive, in the order they are shown', () => {
  const p = pendingPrompt(ASKING).join('\n');
  assert.ok(p.includes('Which grid size should the field default to?'));
  assert.ok(p.includes('3×3'), 'option 1');
  assert.ok(p.includes('5×5'), 'option 2');
  assert.ok(p.indexOf('3×3') < p.indexOf('5×5'), 'in the order the terminal shows them');
});

test('the empty input line and its rules are dropped, not shown as an answer', () => {
  const p = pendingPrompt(ASKING);
  assert.ok(!p.some(l => /^[─]+$/.test(l.trim())), 'the rules around the prompt are chrome');
  assert.ok(!p.some(l => l.trim() === '❯'), 'an empty prompt is not content');
});

test('an agent simply waiting at a prompt has nothing to ask, so nothing is shown', () => {
  assert.equal(pendingPrompt(IDLE), null,
    'without this the panel would show the last recap as though it were a question');
});

test('a screen with nothing on it cannot produce a prompt', () => {
  assert.equal(pendingPrompt(''), null);
  assert.equal(pendingPrompt(null), null);
  assert.equal(pendingPrompt('   \n  \n'), null);
});

test('what comes back is bounded: a notification-sized read, not the whole scrollback', () => {
  const huge = Array.from({ length: 400 }, (_, i) => `│ line ${i} of a very long question box │`).join('\n');
  const p = pendingPrompt(`╭───╮\n${huge}\n│ ❯ 1. yes │\n│   2. no │\n╰───╯\n────\n❯\n────\n  Opus 5 (1M context) | gh:x`);
  assert.ok(p.length <= 40, `got ${p.length} lines`);
  assert.ok(p.join('\n').includes('2. no'), 'and it keeps the end, where the options are');
});

// Not every prompt is drawn with a border. The one thing every picker in Claude Code
// has is the selection marker against a numbered option, so that counts as a question
// on its own: keying off the box art alone would show nothing the day the box changes.
const UNBOXED = `⏺ Two ways to go about it.

  Which grid size should the field default to?

❯ 1. 3×3 — bigger pens
  2. 5×5 — every repo at once
  3. Other

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  Opus 5 (1M context) | gh:octocat | ▲user@work.…`;

test('a picker with no box around it is still a question', () => {
  const p = pendingPrompt(UNBOXED);
  assert.ok(p, 'this is the case that would leave the panel blank again');
  const text = p.join('\n');
  assert.ok(text.includes('Which grid size should the field default to?'));
  assert.ok(text.includes('3×3') && text.includes('5×5'));
});

// A numbered list in ordinary output is not a question. Without the marker there is
// nothing to answer, and dressing the last paragraph up as a question is worse than
// showing nothing.
const LIST_OUTPUT = `⏺ Done. Three things changed:

  1. the drop path now reads items
  2. the watcher books a trailing call
  3. the town files grew a column

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  Opus 5 (1M context) | gh:octocat | ▲user@work.…`;

test('a numbered list the agent wrote is not mistaken for a picker', () => {
  assert.equal(pendingPrompt(LIST_OUTPUT), null);
});

// Showing the pane as a block of terminal text proves the question exists but leaves
// you reading a screenshot and answering somewhere else. The options are structured
// information, so they are parsed back into options and rendered as the picker they
// are, which the panel can already answer through `action: choose`.
const ASK_WITH_DESCRIPTIONS = [
  '  Notifications',
  '',
  '  Once the Mac app exists, where should notifications',
  '  come from?',
  '',
  '❯ 1. From the Mac app',
  '     The app raises them itself, so clicking a notification',
  '     brings the window forward and opens that agent.',
  '  2. Keep the applet',
  '     Alerts arrive whether or not the app is open.',
  '  3. Other',
  '',
  '  ↑↓ to move · Enter to select',
].join('\n');

test('every option comes back with its number, its label and its description', () => {
  const { options } = parseAsk(ASK_WITH_DESCRIPTIONS.split('\n'));
  assert.equal(options.length, 3);
  assert.deepEqual(options.map(o => o.n), [1, 2, 3]);
  assert.deepEqual(options.map(o => o.label),
    ['From the Mac app', 'Keep the applet', 'Other']);
  assert.match(options[0].description, /^The app raises them itself/);
  // A description wrapped over two terminal lines is one sentence, not two lines.
  assert.match(options[0].description, /clicking a notification brings the window/);
  assert.equal(options[2].description, '');
});

test('the question is kept whole, and the header is not glued onto it', () => {
  const ask = parseAsk(ASK_WITH_DESCRIPTIONS.split('\n'));
  assert.equal(ask.header, 'Notifications');
  assert.equal(ask.question, 'Once the Mac app exists, where should notifications come from?');
});

test('the option the terminal has selected is known, so the panel can show it too', () => {
  const { options } = parseAsk(ASK_WITH_DESCRIPTIONS.split('\n'));
  assert.equal(options[0].selected, true);
  assert.equal(options[1].selected, false);
});

test('the keyboard hint belongs to the terminal, not to the panel', () => {
  const ask = parseAsk(ASK_WITH_DESCRIPTIONS.split('\n'));
  assert.ok(!ask.question.includes('↑↓'));
  assert.ok(!ask.options.some(o => o.description.includes('Enter to select')));
});

// Captured from a live pane: a permission prompt has no header and no descriptions,
// and it has to work exactly as well, because it is the prompt you get most often.
const PERMISSION = ['  Bash command', '  rm -rf build', '',
  '  Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently'].join('\n');

test('a permission prompt is a picker too', () => {
  const ask = parseAsk(PERMISSION.split('\n'));
  assert.equal(ask.options.length, 2);
  assert.equal(ask.options[0].label, 'Yes');
  assert.match(ask.question, /Do you want to proceed\?/);
});

test('anything that is not a picker parses to nothing, and the raw pane is shown', () => {
  assert.equal(parseAsk(['⏺ Done. Committed as f7b8dff.', '', '  Nothing pending.']), null);
  assert.equal(parseAsk(['  1. only one option and no marker']), null);
  assert.equal(parseAsk([]), null);
  assert.equal(parseAsk(null), null);
});

// Captured off a live cmux pane, character for character. Everything above was written
// from my idea of what Claude Code draws; this is what it actually draws, and it broke
// both halves: the question swallowed the narration printed above the box, and the
// header sits behind a checkbox glyph.
const REAL = [
  '⏺ The watcher is quiet now (no false positives). I need real',
  '  picker box art, and the only way to produce it is to ask',
  '  you something real.',
  '────────────────────────────────────────────────────────────',
  ' ☐ Perms ',
  '',
  '│ When an agent is blocked on a permission prompt ("Do you ',
  '│ want to proceed?"), should the panel let you approve it ',
  '│ with a click from the ranch?',
  '     ',
  '❯ 1. Yes, click to approve',
  '     Permission prompts render as clickable options like any',
  '     other question. Fastest, and it is the question you ',
  '     get most often.',
  '  2. Show, but do not arm',
  '     The panel shows the prompt but the options are not',
  '     clickable.',
  '  4. Type something.',
  '────────────────────────────────────────────────────────────',
  '  5. Chat about this',
  '  ',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '────────────────────────────────────────────────────────────',
  '  Opus 5 (1M context) | gh:octocat | ▲user@work.…',
].join('\n');

test('what the agent said before asking is not part of the question', () => {
  const ask = parseAsk(pendingPrompt(REAL));
  assert.ok(!ask.question.includes('picker box art'),
    'the narration above the box is the agent talking, not the question');
  assert.ok(!ask.question.includes('watcher is quiet'));
  assert.equal(ask.question,
    'When an agent is blocked on a permission prompt ("Do you want to proceed?"), ' +
    'should the panel let you approve it with a click from the ranch?');
});

test('the vertical rule down the side of the box is not part of the words', () => {
  const ask = parseAsk(pendingPrompt(REAL));
  assert.ok(!ask.question.includes('│'));
});

test('the header comes out of its checkbox', () => {
  assert.equal(parseAsk(pendingPrompt(REAL)).header, 'Perms');
});

test('the real options, their numbers and their unwrapped descriptions', () => {
  const { options } = parseAsk(pendingPrompt(REAL));
  assert.deepEqual(options.map(o => o.n), [1, 2, 4, 5]);
  assert.equal(options[0].label, 'Yes, click to approve');
  assert.equal(options[0].selected, true);
  assert.match(options[0].description, /^Permission prompts render as clickable options/);
  assert.match(options[0].description, /like any other question\./, 'unwrapped across lines');
  // Claude Code rules a line between the answers and its own two extras. The rule is
  // chrome, and "Chat about this" is still an option you can pick.
  assert.equal(options[3].label, 'Chat about this');
});

test('the terminal keyboard hint is not shown as an option or a question', () => {
  const ask = parseAsk(pendingPrompt(REAL));
  assert.ok(!ask.question.includes('Esc to cancel'));
  assert.ok(!ask.options.some(o => /Enter to select|navigate/.test(o.label + o.description)));
});

// Reported from a live pane: the panel put "WAITING ON YOU" around an ordinary reply.
// Two things went wrong at once and each is enough on its own.
//
// A markdown table in the agent's own message is drawn with box-drawing characters,
// and a box corner was being read as the top of a question box. Ordinary output is
// full of them: tables, `tree`, ASCII art, a diff of a boxed comment.
const TABLE_IN_A_REPLY = [
  '⏺ Yes. Local master and origin/master are both at 5c19caf.',
  '',
  '  ┌─────────┬───────────────────────────────┐',
  '  │ 5c19caf │ scroll fix                    │',
  '  │ b0ff0de │ front desk corner (earlier)   │',
  '  └─────────┴───────────────────────────────┘',
  '',
  '  Four files are uncommitted, none of them code.',
  '────────────────────────────────────────────────────────────',
  '❯ now build the mac app',
  '────────────────────────────────────────────────────────────',
  '  Opus 5 (1M context) | gh:octocat | ▲user@work.…',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for a…',
].join('\n');

test('a table in an ordinary reply is not a question', () => {
  assert.equal(pendingPrompt(TABLE_IN_A_REPLY), null,
    'box-drawing characters are drawing, not evidence that anything is being asked');
});

// And the composer had a half-typed message in it. The cut was made at an EMPTY "❯",
// so with a draft sitting there it found none, kept the whole screen including the
// footer, and showed the draft back as though the agent had asked it.
test('a draft in the composer is not part of what the agent is asking', () => {
  const asking = [
    '⏺ Two ways to go about it.',
    '',
    '  Which grid size should the field default to?',
    '',
    '❯ 1. 3×3 — bigger pens',
    '  2. 5×5 — every repo at once',
    '',
    '  ↑↓ to move · Enter to select',
    '────────────────────────────────────────────────────────────',
    '❯ now build the mac app',
    '────────────────────────────────────────────────────────────',
    '  Opus 5 (1M context) | gh:octocat | ▲user@work.…',
  ].join('\n');
  const p = pendingPrompt(asking);
  assert.ok(p, 'the question is still found');
  const text = p.join('\n');
  assert.ok(!text.includes('now build the mac app'), 'what you were typing is yours');
  assert.ok(!text.includes('Opus 5'), 'and the footer below it is chrome');
  assert.ok(text.includes('3×3') && text.includes('5×5'));
});

test('an agent waiting with a draft typed at it is still not asking anything', () => {
  const idle = ['⏺ Done. Committed as f7b8dff.', '',
    '────────────────────────────────────────────────────────────',
    '❯ now build the mac app',
    '────────────────────────────────────────────────────────────',
    '  Opus 5 (1M context) | gh:octocat | ▲user@work.…'].join('\n');
  assert.equal(pendingPrompt(idle), null);
});

// Captured off a live cmux pane while a real multi-select question was on screen, and
// pasted here character for character. Everything this fixture broke was invisible
// until someone tried to answer one from the panel: the tab bar was read as part of
// the question, every description was thrown away, and the checkbox ended up inside
// the answer's own label.
const REAL_MULTI = [
  '←  ☐ Multiselect  ☐ Delay  ✔ Submit  →',
  '',
  'What is actually wrong with the multiselect in the panel?',
  'Pick everything that bites.',
  '',
  '❯ 1. [ ] Can\'t pick several and submit',
  '  Clicking an option presses Enter on it, which in a',
  '  multiselect toggles rather than answers. There is no way',
  '  to choose three and then submit from the panel.',
  '  2. [x] No sign of how many questions',
  '  An AskUserQuestion can hold up to four questions as tabs.',
  '  3. [ ] Checkbox state is invisible',
  '  The panel does not show which options are already ticked,',
  '  so you cannot tell what your answer currently is.',
  '  4. [ ] The click does nothing visible',
  '  5. [ ] Type something',
  '     Next',
  '  6. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

const multi = () => parseAsk(pendingPrompt(REAL_MULTI));

test('the tab bar across the top is not part of the question', () => {
  const ask = multi();
  assert.equal(ask.question, 'What is actually wrong with the multiselect in the panel? ' +
    'Pick everything that bites.');
  assert.ok(!ask.question.includes('Submit'), 'the tab bar is navigation, not words');
  assert.ok(!ask.question.includes('☐'));
});

test('the tabs come out as tabs, so the panel can say which of how many', () => {
  const ask = multi();
  assert.deepEqual(ask.tabs, [
    { label: 'Multiselect', done: false },
    { label: 'Delay', done: false },
  ], 'Submit is an action, not a question');
  assert.equal(ask.submit, true);
});

test('a checkbox is state, not part of the answer it sits next to', () => {
  const ask = multi();
  assert.equal(ask.multi, true, 'checkboxes are what make this a multi-select');
  assert.deepEqual(ask.options.slice(0, 3).map(o => [o.label, o.checked]), [
    ["Can't pick several and submit", false],
    ['No sign of how many questions', true],
    ['Checkbox state is invisible', false],
  ]);
});

test('a description survives being wrapped to the same indent as its option', () => {
  const ask = multi();
  assert.equal(ask.options[0].description,
    'Clicking an option presses Enter on it, which in a multiselect toggles rather ' +
    'than answers. There is no way to choose three and then submit from the panel.');
  assert.equal(ask.options[3].description, '', 'an option with no description gets none');
});

test('the terminal\'s own two extras are marked, not offered as answers', () => {
  const ask = multi();
  assert.equal(ask.options[4].kind, 'text', 'Type something opens an input, it is not a choice');
  assert.equal(ask.options[5].kind, 'chat');
  assert.equal(ask.options[0].kind, 'option');
});

test('a single-select picker reports itself as one', () => {
  const ask = parseAsk(pendingPrompt(REAL));
  assert.equal(ask.multi, false);
  assert.equal(ask.options[0].checked, undefined, 'nothing to tick, so no tick state');
});

// Landing on an option. The old code pressed "up" twelve times to reach the top and
// then counted down, which assumes the list does not wrap. Claude Code's picker DOES
// wrap, so on a six-option question twelve ups is exactly zero moves, the cursor never
// reached the top, and the count down landed somewhere else entirely. That is the
// "could not land on that option" error, and the twenty-odd keystrokes are the delay.
const opts = (cursorAt) => [1, 2, 3, 4, 5, 6].map(n => ({ n, selected: n === cursorAt }));

test('moving to an option below the cursor walks down, and only that far', () => {
  assert.deepEqual(stepsTo(opts(1), 3), { key: 'down', count: 2 });
});

test('moving to an option above the cursor walks up, rather than around', () => {
  assert.deepEqual(stepsTo(opts(5), 2), { key: 'up', count: 3 });
});

test('the cursor already on the answer presses nothing', () => {
  assert.deepEqual(stepsTo(opts(4), 4), { key: 'down', count: 0 });
});

test('never more moves than there are options, whatever it is asked', () => {
  const s = stepsTo(opts(1), 6);
  assert.ok(s.count < 6, 'six options can never need six moves');
});

test('with no cursor on screen it refuses rather than guessing', () => {
  assert.equal(stepsTo(opts(0), 3), null, 'not knowing where we are is not a reason to press keys');
  assert.equal(stepsTo([], 1), null);
  assert.equal(stepsTo(opts(1), 99), null, 'an option that is not there cannot be reached');
});
