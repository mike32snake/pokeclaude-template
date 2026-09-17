// Two-step confirmation for the buttons that end something: click once to arm, click
// again to do it.
//
// These used to call window.confirm. That works in a browser and does nothing in the
// desktop app: a WKWebView whose host implements no WKUIDelegate answers every JS
// dialog as if Cancel was clicked, so KILL, STOP and cron delete were dead in the app
// and silent about it. Nothing in the page may depend on the host having a dialog.
//
// Only one button is ever armed, and an arm goes cold on its own. A button left armed
// while you read the transcript must ask again rather than end a session on a stray
// click minutes later.
export const ARM_WINDOW = 6000;

export function makeArm({ now = () => Date.now(), window: win = ARM_WINDOW } = {}) {
  let key = null, at = 0;
  const live = (k, t) => key === k && (t - at) < win;
  return {
    // true when this press is the one that should act.
    press(k, t = now()) {
      if (live(k, t)) { key = null; return true; }
      key = k; at = t;
      return false;
    },
    armed(k, t = now()) { return live(k, t); },
    // What the button should read right now.
    label(k, base, t = now()) { return live(k, t) ? 'SURE?' : base; },
    reset() { key = null; at = 0; },
  };
}
