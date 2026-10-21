// Which terminal surface a workspace's keystrokes and reads are addressed to.
//
// cmux addresses a terminal by (workspace_id, surface_id), and the surface id was
// looked up fresh on EVERY read and every keypress with `cmux rpc surface.list`. That
// is a process spawn, measured at 188ms on this machine against 1ms for the same call
// over cmux's socket, and it made the socket path added for sendText pointless: every
// 1ms socket call sat behind a 188ms spawn that worked out where to send it.
//
// typeInto walks the composer with a poll per line, so a 40-line paste was roughly 320
// spawns in a burst. cmux's CLI helper was aborting inside NSFileHandle writeData: -
// killed mid-write when our own timeout closed its pipe - which is what "cmux falls
// over when there are too many agents" actually was.
//
// The id is stable for the life of a terminal, so it is looked up once and kept. Kept,
// not trusted forever: a tab whose terminal went away must not go on being addressed at
// its old surface. cmux says "Terminal surface not found" for exactly that, and that is
// also the string state.js reads to decide a tab is hollow, so the wording must survive.

export const createSurfaceCache = () => new Map();

// The one failure that means "this id is no longer real". Every other failure is a call
// that did not happen - a timeout, a busy socket - and says nothing about the surface.
// Re-looking-up on those would put the spawn straight back on the hot path.
export const isStaleSurface = (r) =>
  !!r && r.ok !== true && /surface not found/i.test(r.stderr || '');

const noTarget = () =>
  ({ ok: false, stdout: '', stderr: 'Could not identify a unique terminal for this workspace.' });

// Run `use(surfaceId)` against the workspace's terminal, looking the surface up only
// when it is not already known. A stale id is dropped and the call is retried once, so
// a terminal that moved costs one extra lookup rather than every caller a spawn.
export async function withSurface(cache, ws, lookup, use) {
  let surface = cache.get(ws);
  // Only a real answer is remembered. A workspace with no terminal - a tab cmux
  // restored that nobody has clicked - must be asked again next time, or it could
  // never come back to life.
  if (!surface) {
    surface = await lookup(ws);
    if (!surface) return noTarget();
    cache.set(ws, surface);
  }
  const r = await use(surface);
  if (!isStaleSurface(r)) return r;
  cache.delete(ws);
  const fresh = await lookup(ws);
  if (!fresh) return r;            // still nothing: the caller needs the real failure
  cache.set(ws, fresh);
  return use(fresh);
}
