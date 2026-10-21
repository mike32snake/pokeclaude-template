// What a native pen is doing, without cmux to ask.
//
// cmux wrote a `claude_code` status entry per workspace and state.js mapped it. Nothing
// writes one now, so status comes from the two sources that were always the better
// ones: the HOOKS, which fire on the event itself and therefore know before any screen
// can show it, and the pen's OWN SCREEN, which costs nothing to read once we own the
// pty. cmux never wrote status entries for a Codex pen either, so sampleCodex was
// already doing this; it turns out to be the right rule for both engines.
import { pendingPrompt } from './pending.js';
import { parseFooter } from './cmux.js';

// How long a hook stays fresher than the screen. Long enough to cover the gap between
// a turn starting and the pen painting "esc to interrupt", short enough that a missed
// Stop hook cannot strand a Pokemon in the wrong state.
export const HOOK_FRESH_MS = 10_000;

// The pen's own account of itself. Null means the screen said nothing either way,
// which is not the same as "idle".
export function screenStatus(screen) {
  const text = String(screen || '');
  if (!text.trim()) return null;
  // A question first. A pen can print a spinner while it waits for an answer, and a
  // Pokemon that looks busy when it is really blocked is the one nobody goes to.
  if (pendingPrompt(text)) return 'BLOCKED';
  return parseFooter(text).busy ? 'WORKING' : 'ASLEEP';
}

// One answer from everything known about a pen.
export function statusFrom({ hook = null, hookAt = 0, screen = '', was = null, now = Date.now() } = {}) {
  const seen = screenStatus(screen);
  if (seen === 'BLOCKED') return 'BLOCKED';
  if (hook && now - hookAt <= HOOK_FRESH_MS) return hook;
  return seen || was || 'ASLEEP';
}
