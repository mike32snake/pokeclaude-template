// Where the field is being looked at. The stage is a scroll box around a canvas drawn
// at full map size, so panning IS scrolling and needs no camera in the render code.
// Zooming, though, changes the canvas under the scroll box: without this the view
// jumps somewhere else entirely, which is what made moving around feel unmoored.

// The canvas is centred while it is smaller than the window, so the window's middle
// is not simply scroll + half a window.
const pad = (client, canvas) => Math.max(0, (client - canvas) / 2);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Map coordinate (in unscaled map pixels) under the middle of the window.
export function worldAt(v, scale) {
  return {
    x: (v.scrollLeft + v.clientWidth / 2 - pad(v.clientWidth, v.canvasW)) / scale,
    y: (v.scrollTop + v.clientHeight / 2 - pad(v.clientHeight, v.canvasH)) / scale,
  };
}

// Scroll offsets that put the same map point back under the middle after a zoom.
export function keepCenter(v, oldScale, newScale) {
  const w = worldAt(v, oldScale);
  const canvasW = v.canvasW / oldScale * newScale;
  const canvasH = v.canvasH / oldScale * newScale;
  return {
    left: clamp(w.x * newScale + pad(v.clientWidth, canvasW) - v.clientWidth / 2,
                0, Math.max(0, canvasW - v.clientWidth)),
    top: clamp(w.y * newScale + pad(v.clientHeight, canvasH) - v.clientHeight / 2,
               0, Math.max(0, canvasH - v.clientHeight)),
  };
}

// How wide the left panel is allowed to be. The drag handler could clamp inline, but
// the cases that matter are the ones a mouse cannot produce: a width restored from
// yesterday's wider screen, a window too narrow to satisfy both halves, and a stored
// value that has gone bad. Those are worth a test, so they live here.
//
// The field gives way first, down to FIELD_MIN. Below that the panel yields instead:
// a panel under PANEL_MIN cannot show a transcript, and a field can always be zoomed.
export const PANEL_MIN = 300, PANEL_MAX = 900, FIELD_MIN = 420;
export function panelWidth(px, winW) {
  const want = Number(px);
  if (!Number.isFinite(want)) return PANEL_MIN;
  const room = Math.min(PANEL_MAX, winW - FIELD_MIN);
  return Math.max(PANEL_MIN, Math.min(room, want));
}
