import { pendingPrompt } from './pending.js';

// Reading a cmux pane to decide whether the panel may type into it.
//
// Sending text to the wrong terminal is the one mistake here that is expensive: prose
// typed at a shell runs as a command, and prose typed at a picker picks nothing. So
// the panel asks first. What it must NOT do is refuse a terminal that is perfectly
// ready, which is what the first version of this guard did: it read 8 lines and
// insisted on seeing "❯". A Claude Code pane spends 7 of those 8 lines on the composer
// border and the footer, so a single unsent line of draft scrolled the "❯" out of the
// window and every send came back "no input box visible".
//
// The fix is to read a real window (READ_LINES) and to accept more than one kind of
// evidence. Claude Code's footer - the mode hint, the shortcut hint, the 5h/7d usage
// bars - only prints while Claude Code is drawing the screen, so it proves the session
// is live even when the composer itself is scrolled past.

// How many lines /api/act reads before deciding. Deep enough that a draft of a
// paragraph or two still shows its "❯", and cheap: cmux returns the visible pane.
export const READ_LINES = 40;

// A modal that swallows keystrokes. Answering these is what `action: choose` is for.
const QUESTION = /↑↓\s*to move|Enter to select|Do you want to (proceed|make this edit|create)/i;

// Claude Code is on screen. Any one of these is enough.
const CLAUDE_UI = [
  /shift\+tab to cycle/i,
  /\?\s*for shortcuts/i,
  /esc to interrupt/i,
  /\/clear to save/i,
  /(bypass permissions|accept edits|plan mode) on\b/i,
  /\b5h\b\s*[●○]/,                     // the usage bars, present in every footer
];

// Codex is on screen. Its footer is the model, the reasoning level and the working
// directory; the placeholder is what its empty box holds.
export const CODEX_FOOTER = /^\s*(\S+)\s+(default|minimal|low|medium|high|xhigh|max|ultra)(?:\s+fast)?\s+·\s+\S/m;
const CODEX_UI = [CODEX_FOOTER, /Ask Codex to do anything/];

// The composer prompt, at the start of its own line. Anchoring matters: ordinary
// output is full of ">" mid-line (git diffs, quoted mail, "2 > 1").
const PROMPT = /^\s*[❯>›]\s*$|^\s*[❯>›]\s/m;

// The composer's own prompt glyph. In Claude Code past turns print as "> text" above
// it and only "❯" marks the box we would type into; Codex draws both with "›", which
// is safe because the box is always found by scanning UP from the bottom.
const COMPOSER = /^\s*[❯›](.*)$/;
// Where the box ends. Claude Code closes it with a rule; Codex draws no rule under
// the box at all, so without its footer the reader ran past the composer and pulled
// the model and the working directory into the draft.
const RULE = /^\s*─{8,}/;
const BOX_END = (line) => RULE.test(line) || CODEX_FOOTER.test(line) || /^\s*tab to queue message\b/i.test(line);

// Whatever is already sitting in the composer, or '' when it is empty or off-screen.
// The box runs from the last "❯" line down to the rule above the footer; a pasted or
// multi-line draft continues on the lines under the prompt, so all of them count.
export function draftOnScreen(screen) {
  const draft = boxText(screen);
  // Two hints print in the empty box, in the place a draft would be: a fresh Claude
  // Code's "Try ..." suggestion, and the note that a message is queued. Neither is
  // text anyone typed.
  return PLACEHOLDER.test(draft) || QUEUED.test(draft) ? '' : draft;
}
function boxText(screen) {
  const lines = (screen || '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER.test(lines[i])) { at = i; break; }
  if (at < 0) return '';
  const out = [lines[at].match(COMPOSER)[1]];
  // Continuation lines are indented two spaces by Claude Code: layout, not text.
  for (let i = at + 1; i < lines.length && !BOX_END(lines[i]); i++) out.push(lines[i].replace(/^  /, ''));
  return out.map(l => l.replace(/\s+$/, '')).join('\n').trim();
}
// The hint each engine paints in its own empty box. Neither is text anyone typed.
const PLACEHOLDER = /^(Try "[^"\n]*"|Ask Codex to do anything)$/;
// Claude Code queues a message typed while it is working and prints this in the box
// until the turn ends, when the queue goes out as the next prompt. It was being read
// as a draft, so every message to a busy agent came back "still sitting in that tab"
// after it had queued fine, and the next one was refused for "unsent text". Pressing
// Up in that pane, as the hint says, moves the queued message INTO the box, and from
// there Claude Code never sends it: that is where the stuck drafts come from.
const QUEUED = /^Press up to edit queued messages?$/;
export const queuedOnScreen = (screen) => QUEUED.test(boxText(screen));

// After a spawn types the task in, has it landed in the box, ready for Enter? The
// literal first characters of the prompt are NOT reliable evidence: Claude Code folds
// a paste past a few lines into a "[Pasted text #N]" marker and hides the words, and
// Codex replaces image paths with "[Image #N]". send() has already verified line
// by line that what it typed reached the box, so a non-empty draft is the real signal;
// the marker and the head text are both just confirmation the right thing is there.
const CONTENT_MARK = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]/;
const flat = (t) => String(t || '').replace(/\s+/g, ' ').trim();
export function promptLanded(screen, prompt) {
  const draft = draftOnScreen(screen);
  if (!draft) return false;                        // empty, swallowed, or a suggestion
  if (CONTENT_MARK.test(draft)) return true;      // accepted content: words/path hidden, marker shown
  const head = flat(prompt).slice(0, 18);
  return head ? flat(draft).includes(head) : true;
}

// Given the box read (inputBoxState) and, when it refused, a probe of the pane
// (cmux.probeDraft), decide what the send and discard paths should do. Pure, so the
// three call sites agree and it is testable without a terminal.
//   { send: true }                       the box is free: empty, or a suggestion to type over
//   { send: false, frozen: false, ... }  a real draft, or Claude not running: refuse with the reason
//   { send: false, uncertain: true }  transport, parsing, timeout, or cleanup failed.
// A plain-text frame cannot prove that the terminal is frozen.
export function boxAction(gate, probe) {
  if (gate.ok) return { send: true };
  if (gate.draft && probe && probe.ghost) return { send: true };
  if (probe && probe.ok === false) {
    return { send: false, frozen: false, uncertain: true,
      reason: `Could not verify the terminal input: ${probe.stderr || 'the screen did not respond'}. Your message is saved. Refresh Terminal controls below before trying again.` };
  }
  return { send: false, frozen: false, reason: gate.reason, draft: gate.draft };
}

// { ok: true } or { ok: false, reason } - the reason is shown to the user verbatim,
// so it says what is actually wrong and what to do about it.
export function inputBoxState(screen) {
  const s = screen || '';
  if (!s.trim()) return { ok: false, reason: 'that terminal came back blank — open the tab' };
  if (QUESTION.test(s) || pendingPrompt(s) || trustGate(s)) {
    return { ok: false,
      reason: 'that agent is waiting on a question — pick an answer above, or open the tab' };
  }
  // Text already in the box would go out glued to ours as one message nobody wrote.
  // This is how a send that half-landed used to resurface inside the next one.
  const draft = draftOnScreen(s);
  if (draft) {
    const quote = draft.length > 60 ? draft.slice(0, 57) + '…' : draft;
    // The draft rides along so the panel can offer to send or discard it, instead of
    // sending the user to the tab to retype a message they already typed once.
    return { ok: false, draft,
      reason: `that tab already has unsent text in its input box ("${quote}") — send or discard it first` };
  }
  if (PROMPT.test(s) || CLAUDE_UI.some(re => re.test(s))) return { ok: true };
  return { ok: false, reason: 'Claude is not running in that tab — open it and start Claude' };
}

// Is this pane an agent that has finished starting up and will take a task?
//
// The spawn used to look for an EMPTY composer line plus Claude Code's mode footer.
// Neither half survives a second engine: Codex fills its empty box with a placeholder,
// and prints a footer of its own. So the test is now the same two facts said engine-
// agnostically - there is a composer, nothing anyone typed is in it, and the agent's
// own furniture is on screen - and both halves still earn their place. The footer
// alone shows up while Claude Code is still painting its startup screen and anything
// typed then is swallowed; the composer alone matches the trust dialog, whose options
// are drawn with the same "›" Codex's composer uses.
export function agentReady(screen) {
  const s = screen || '';
  if (!COMPOSER.test(s.split('\n').find(l => COMPOSER.test(l)) || '')) return false;
  if (pendingPrompt(s) || trustGate(s) || draftOnScreen(s) !== '') return false;
  return CLAUDE_UI.some(re => re.test(s)) || CODEX_UI.some(re => re.test(s));
}

// Both engines refuse to start in a folder until someone says they trust it, and they
// want different answers: Claude Code's list is unselected, so it takes the digit and
// then Enter, while Codex opens with "1. Yes, continue" already chosen. Returns the
// keys to press, or null when no dialog is up.
const TRUST = [
  { re: /do you trust the contents of this directory/i, keys: ['enter'] },
  { re: /do you trust (this folder|the files in this folder)/i, keys: ['1', 'enter'] },
];
export function trustGate(screen) {
  const hit = TRUST.find(t => t.re.test(screen || ''));
  return hit ? { keys: hit.keys } : null;
}

// The composer as it is drawn, untrimmed, so a fresh empty line counts as a change.
// cmux.typeInto watches this to know a keystroke landed, and it kept its own copy of
// the "❯" scan until Codex arrived with a different glyph and no closing rule. One
// definition, so the two readers can never disagree about where the box is.
export function composerRegion(screen) {
  const lines = (screen || '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER.test(lines[i])) { at = i; break; }
  if (at < 0) return '';
  const out = [];
  for (let i = at; i < lines.length && (i === at || !BOX_END(lines[i])); i++) out.push(lines[i]);
  return out.join('\n');
}
