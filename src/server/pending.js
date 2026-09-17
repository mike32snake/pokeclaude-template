// What a blocked agent is actually waiting for, taken off the terminal screen.
//
// It has to come from the screen. Claude Code does not write an AskUserQuestion to the
// transcript while it is pending: a sampler watched the file through the whole fifteen
// minutes a question sat unanswered and saw no writes, and the tool_use line and its
// answer arrived together afterwards. Making the transcript watcher more responsive
// cannot fix that, because the question is not in the file yet. The pane has it.
//
// This deliberately does not try to understand the box. Claude Code draws questions,
// permission prompts and plan approvals differently, and a parser that knows about
// each one is a parser that shows nothing the day one of them changes. Cutting the
// chrome away and showing the rest is right for all of them, and stays right.

// Everything the terminal draws around whatever is being asked.
const CHROME = [
  /^[─━—\-]{6,}$/,                       // the rules above and below the input box
  /^\s*(Opus|Sonnet|Haiku|Claude)\s.*\|/,// the model line
  /^\s*\d+h\s*[●○]/,                     // the 5h usage meter
  /^\s*\d+d\s*[●○]/,                     // the 7d usage meter
  /bypass permissions|shift\+tab to cycle|for automatic/,
  /^\s*[⏵▸>]{2}/,                        // the permission-mode line
  /^\s*✻\s+\w+ed for /,                  // "Baked for 7m 45s"
  /\(disable recaps/,
];
const isChrome = (line) => CHROME.some(re => re.test(line));

// The composer prompt at the start of a line. What is below it is the footer, and what
// is ON it is whatever you have typed: both are yours, not the agent's question.
// Anchoring on an EMPTY prompt was wrong. Leave a half-written message sitting there
// and there is no empty prompt to find, so the whole screen was kept and your own
// draft came back inside the question box.
//
// An option is written "❯ 1. …" and must not be mistaken for the composer, which is
// what the lookahead is for.
const isComposer = (line) => /^\s*[❯>›](?!\s*\d+[.)]\s)/.test(line);

const MAX_LINES = 40;

// The marker every picker has: a numbered option, usually with the cursor against it.
const OPTION_LINE = /^(\s*)([❯▶>›]?)\s*(\d+)[.)]\s+(\S.*)$/;

export function pendingPrompt(screen) {
  const raw = String(screen ?? '').split('\n');
  if (!raw.length) return null;

  // Work down to the composer: what is being asked sits above it.
  let end = raw.length;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (isComposer(raw[i])) { end = i; break; }
  }
  const above = raw.slice(0, end);

  // Is anything being ASKED? Only two things prove it: the cursor sitting against a
  // numbered option, or the terminal printing its own "Enter to select" hint. A box
  // corner is NOT proof, though it was treated as one — ordinary output is full of
  // them. A markdown table in a reply was enough to put "waiting on you" around it.
  // The cursor may sit inside the box, so allow the rule in front of it — but never
  // drop the marker itself, which is the only thing separating a picker from prose.
  const at = above.findIndex(l => /^\s*[│┃]?\s*[❯▶›]\s*\d+[.)]\s*\S/.test(l));
  const hinted = above.findIndex(l => HINT.test(l));
  if (at < 0 && hinted < 0) return null;
  // With only the hint to go on, start from the first numbered option above it.
  const from0 = at >= 0 ? at
    : above.findIndex(l => OPTION_LINE.test(l));
  if (from0 < 0) return null;

  // Walk back to where the box begins. This runs on the RAW lines, before the chrome
  // is stripped, because the rule Claude Code draws above the header IS the boundary:
  // filtering it out first left nothing to stop at, and the walk ran on into whatever
  // the agent had been saying, which then read as part of the question.
  let from = 0;
  for (let i = from0 - 1; i >= 0; i--) {
    if (BOX_EDGE.test(raw[i])) { from = i + 1; break; }     // the rule above the header
    if (/^\s*[⏺✻※]/.test(raw[i])) { from = i + 1; break; }  // or the agent's own last line
  }

  const lines = above.slice(from)
    .filter(l => !isChrome(l))
    // The rule down the side of the box is drawing. Only the box characters, never an
    // ASCII pipe: a permission prompt can be quoting a shell command full of them.
    .map(l => l.replace(/^(\s*)[│┃]\s?/, '$1').replace(/\s*[│┃]\s*$/, '').replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
}

// The picker, read back out of the pane as options.
//
// Showing the terminal text proves a question exists, but it leaves you reading a
// screenshot and answering somewhere else. These are structured choices, and the panel
// already knows how to answer one: `action: choose` presses the number after checking
// that the option is still the option it says it is. All that was missing was turning
// the drawn picker back into the list it was drawn from.

// "❯ 2. rewrite it" — the marker is optional, the number and the label are not.
const OPTION = /^(\s*)([❯▶>›]?)\s*(\d+)[.)]\s+(\S.*)$/;
// The terminal's own keyboard hint, and the footer it sits in.
const HINT = /↑\/?↓\s*to (move|navigate)|Enter to (select|confirm)|Press enter to (continue|confirm)|Esc to (cancel|interrupt)/i;
// The rule Claude Code draws above a question box, and again between the answers and
// its own two extras ("Type something.", "Chat about this").
const BOX_EDGE = /^\s*[─━—]{6,}\s*$/;
// The inside of the box: the vertical rule beside the question, the header's checkbox.
const BOX_BODY = /^\s*[│┃|╭╰]|^\s*[☐☑✔✓]\s/;

// The strip across the top of a multi-question ask: one tab per question, ticked as
// each is answered, with a Submit at the end. It is navigation, and it was being read
// as the first sentence of the question.
const TAB = /[☐☑⊠□✔✓]\s*([^☐☑⊠□✔✓←→]+)/g;
const isTabBar = (line) => {
  const glyphs = (line.match(/[☐☑⊠□✔✓]/g) || []).length;
  return glyphs >= 2 || (glyphs >= 1 && /[←→]/.test(line));
};
function readTabs(line) {
  const tabs = [];
  let submit = false;
  for (const m of line.matchAll(TAB)) {
    const label = m[1].replace(/\s+/g, ' ').trim();
    if (!label) continue;
    // Submit is the button you press when every question is answered, not a question.
    if (/^submit$/i.test(label)) { submit = true; continue; }
    tabs.push({ label, done: /[☑⊠✓]/.test(m[0][0]) });
  }
  return { tabs, submit };
}

// A multi-select draws its state in front of the answer: "[ ]" or "[x]". That is the
// tick, not the first three characters of what you are choosing.
const CHECK = /^\[([ xX])\]\s*/;
// The terminal adds two rows of its own to every picker. Neither is an answer: one
// opens a text input, the other drops out of the question into ordinary chat, and
// clicking them from the panel has to do something different.
const EXTRA = [[/^type\s+something/i, 'text'], [/^chat about this/i, 'chat']];
const extraKind = (label) => (EXTRA.find(([re]) => re.test(label)) || [null, 'option'])[1];

export function parseAsk(lines) {
  const rows = (lines || []).filter(l => typeof l === 'string');
  if (!rows.length) return null;

  const opts = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(OPTION);
    if (!m) continue;
    const n = Number(m[3]);
    // Ascending, but NOT necessarily 1, 2, 3: a real picker skips numbers, and
    // insisting on a run dropped the last options off every question.
    if (opts.length && n <= opts[opts.length - 1].n) continue;
    opts.push({ n, selected: !!m[2], label: m[4].trim(), at: i, indent: m[1].length + 3 });
  }
  // One option is a sentence that happens to start with "1."; a picker has a choice.
  if (opts.length < 2) return null;
  // And a picker says so: the cursor is against one of the options, or the terminal is
  // printing its own "Enter to select" hint underneath. Numbered prose has neither,
  // and this is what keeps an ordinary list from being offered as a set of answers.
  if (!opts.some(o => o.selected) && !rows.some(l => HINT.test(l))) return null;

  // A description is whatever sits between one option and the next, unwrapped back
  // into the sentence the terminal broke to fit its width.
  //
  // It used to demand an indent past the option's number, which is true only in a wide
  // pane. Claude Code wraps a description to the SAME column as the option in anything
  // narrower, so that rule quietly threw away every description in the panel and left
  // a list of bare labels to choose between. What separates a description from the
  // next option is that the next option is numbered, not that it is further left.
  for (let k = 0; k < opts.length; k++) {
    const from = opts[k].at + 1, to = k + 1 < opts.length ? opts[k + 1].at : rows.length;
    opts[k].description = rows.slice(from, to)
      .filter(l => l.trim() && !HINT.test(l) && !BOX_EDGE.test(l) && !isTabBar(l))
      .map(l => l.trim()).join(' ');
  }

  // Everything above the first option is what is being asked, once the box art is off
  // it: a vertical rule down the left of the question, and a checkbox in front of the
  // header. Both are drawing, not words.
  const aboveRaw = rows.slice(0, opts[0].at)
    .filter(l => l.trim() && !HINT.test(l) && !BOX_EDGE.test(l));
  const bar = aboveRaw.find(isTabBar);
  const { tabs, submit } = bar ? readTabs(bar) : { tabs: [], submit: false };
  const above = aboveRaw.filter(l => l !== bar)
    .map(l => l.replace(/^\s*[│┃|]\s?/, '').trim());
  let header = null;
  if (above.length > 1 && above[0].length <= 28 && !above[0].includes('?')) {
    header = above.shift().replace(/^[☐☑✔✓•]\s*/, '').trim();
  }
  const question = above.join(' ');

  // The tick comes off the label and becomes state the panel can draw itself.
  let multi = false;
  for (const o of opts) {
    const m = o.label.match(CHECK);
    if (m) { multi = true; o.checked = m[1] !== ' '; o.label = o.label.replace(CHECK, '').trim(); }
    o.kind = extraKind(o.label);
  }
  // Only the real answers carry a tick. The terminal's own two rows never do, and
  // marking them as unchecked would invite the panel to try to toggle them.
  if (!multi) for (const o of opts) delete o.checked;

  return { header, question, tabs, submit, multi,
           options: opts.map(({ at, indent, ...o }) => o) };
}

// How to get the cursor from where it is to the option you clicked.
//
// The old approach pressed "up" a dozen times to force the cursor to the top and then
// counted down from there. Claude Code's picker WRAPS, so twelve ups on a six-option
// question is exactly zero net moves: the cursor never reached the top, the count down
// started from wherever it already was, and the confirm step then found the wrong line
// and gave up with "could not land on that option". Twenty-odd round trips to cmux for
// that is also where the lag came from.
//
// Read where the cursor actually is and walk the difference. No wrap is assumed in
// either direction, so this stays right whether the list wraps or not, and the worst
// case is one move per option instead of twelve plus.
export function stepsTo(options, targetN) {
  const list = options || [];
  const from = list.findIndex(o => o.selected);
  const to = list.findIndex(o => o.n === Number(targetN));
  // Not knowing where the cursor is, or what is being aimed at, is a reason to refuse.
  // Pressing keys into a picker on a guess is how the wrong answer gets chosen.
  if (from < 0 || to < 0) return null;
  return to >= from ? { key: 'down', count: to - from } : { key: 'up', count: from - to };
}
