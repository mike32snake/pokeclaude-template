// Whether the conversation pane needs redrawing, and where the scroll goes when it
// does. Pure, because the bug it exists for is a timing bug and timing bugs are only
// pinned down by tests that do not need a browser.
//
// The pane refreshes on every transcript write and every two seconds while a question
// is pending. It used to rebuild itself each time and pin the scroll to the newest
// turn, so scrolling up to read something lasted about two seconds. The older path
// sent you to the very top instead, which is no better: the reader was in the middle.

// How close to the end still counts as following the conversation. A line and a half:
// enough that resting just short of the end keeps following, not so much that reading
// the last paragraph counts as having scrolled away.
export const FOLLOW_SLACK = 80;

// A signature of what the thread actually SHOWS. Anything not in here can change
// without the pane being rebuilt under the reader, which is the point: the context
// percentage and the model tick over on their own and are not worth a redraw.
export function threadKey(d) {
  if (!d) return '';
  const msgs = d.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const pending = d.pending
    ? (d.pending.screen || []).join('\n')          // the cursor moving IS a change
    : '';
  return [
    msgs.length,
    last.uuid || '',
    (last.text || '').length,                      // a streaming turn grows in place
    (last.tools || []).length,
    d.ambiguous ? 1 : 0,
    pending,
    JSON.stringify(d.outbox || []),
  ].join(' ');
}

// Is the reader following the newest turn, or reading back through the thread?
export function atBottom({ scrollHeight, scrollTop, clientHeight }) {
  return scrollHeight - scrollTop - clientHeight < FOLLOW_SLACK;
}

// Where to put the scroll after a redraw. Following the end keeps following it;
// anywhere else is left exactly where the reader put it, clamped so a thread that got
// shorter cannot leave the view hanging past its own end.
export function nextTop({ wasAtBottom, prevTop, scrollHeight, clientHeight }) {
  const end = Math.max(0, scrollHeight - clientHeight);
  return wasAtBottom ? end : Math.min(prevTop, end);
}

// Where the scroll goes when an agent is OPENED. Normally the newest turn, which is
// the end of the thread. But when the agent is asking something, the end of the thread
// is the bottom of the question box, and the box is routinely taller than the pane: it
// carries a badge, a header, the question and its answers. Landing on the end hides the
// question and leaves four unlabelled answers on screen. So the top of the box wins,
// clamped like any other scroll so it can never run past the end of the content.
export function openTop({ askTop, scrollHeight, clientHeight }) {
  const end = Math.max(0, scrollHeight - clientHeight);
  return askTop == null ? end : Math.max(0, Math.min(askTop, end));
}
