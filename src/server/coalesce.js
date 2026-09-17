// One event per burst of writes, INCLUDING the last one.
//
// fs.watch fires several times for what is logically one Claude turn. Announcing
// every fire floods the stream; announcing only the first throws away the write that
// finished the turn. The panel showed that as a reply with the AskUserQuestion block
// missing under it, for as long as the agent sat there waiting for an answer.
//
// So: fire straight away when the last event is old, and otherwise schedule ONE call
// for the end of the window. The clock is injected so a test can drive it.
export function coalesce(fn, ms, clock = globalThis) {
  let last = -Infinity, timer = null;
  return (...args) => {
    const now = clock.now ? clock.now() : Date.now();
    if (now - last >= ms) { last = now; fn(...args); return; }
    if (timer) return;                       // a trailing call is already booked
    timer = clock.setTimeout(() => {
      timer = null;
      last = clock.now ? clock.now() : Date.now();
      fn(...args);
    }, ms - (now - last));
  };
}
