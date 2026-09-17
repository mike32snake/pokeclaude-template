// Which sessions were running, kept on disk so a cmux crash does not lose them.
//
// When cmux dies it takes every agent with it, and the server too, since the server
// runs in a cmux tab. cmux restores the tabs on relaunch but with no terminal in them
// (see state.isHollow), so the Claude and Codex processes are simply gone. Nothing in
// the ranch remembered which conversations they were, and finding sixteen of them
// again in the PC one repo at a time is the job this file removes.
//
// `running` is every session the poll saw attached to a live process. A session that
// stops running is one of two things, and WHEN it stopped tells them apart:
//   - while the server was watching a healthy cmux: someone closed it on purpose, so
//     it is forgotten.
//   - across a gap (the first observation after the server started, or after a poll
//     cmux refused): it died with cmux, so it moves to `lost` and the panel offers it
//     back as a checklist.
// A lost session that turns up running again leaves the list by itself.
import fs from 'node:fs';
import path from 'node:path';

const WEEK = 7 * 24 * 3600_000;
const SAVE_EVERY = 60_000;          // lastSeen alone is not worth a write every poll

// The agents worth remembering: a real agent whose PROCESS names its session. A hook
// link is not enough, because it outlives the process it came from.
export function rosterEntries(agents) {
  const out = [];
  for (const a of agents) {
    if (a.hollow || a.kind === 'service' || a.status === 'FAINTED') continue;
    const codex = a.engine === 'codex';
    const sessionId = codex ? a.codexSessionId : a.procSessionId;
    if (!sessionId || !a.rawDir) continue;
    // cmux names most tabs "new agent"; the conversation's own title says which one.
    out.push({ sessionId, engine: codex ? 'codex' : 'claude', dir: a.rawDir,
               title: a.sessionTitle || a.title || '', status: a.status || null });
  }
  return out;
}

export function createRoster(file, { now = Date.now } = {}) {
  let running = {}, lost = {};
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    running = d.running || {}; lost = d.lost || {};
  } catch { /* missing or corrupt: start empty rather than refuse to start */ }
  let savedAt = 0;
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ running, lost }), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    savedAt = now();
  };
  const shape = (e) => `${e.dir}|${e.title}|${e.status}|${e.engine}`;

  return {
    // `live` is rosterEntries() of this poll. `fresh` is true when the server did not
    // see the moments before this one. True when the lost list changed.
    observe(live, { fresh }) {
      const t = now();
      let dirty = false, changed = false;
      const seen = new Set();
      for (const e of live) {
        seen.add(e.sessionId);
        const was = running[e.sessionId];
        if (!was || shape(was) !== shape(e)) dirty = true;
        running[e.sessionId] = { ...e, firstSeen: was?.firstSeen ?? t, lastSeen: t };
        if (lost[e.sessionId]) { delete lost[e.sessionId]; changed = true; }
      }
      for (const id of Object.keys(running)) {
        if (seen.has(id)) continue;
        if (fresh) { lost[id] = { ...running[id], lostAt: t }; changed = true; }
        delete running[id];
        dirty = true;
      }
      for (const [id, e] of Object.entries(lost)) {
        if (t - e.lostAt > WEEK) { delete lost[id]; changed = true; }
      }
      if (dirty || changed || t - savedAt > SAVE_EVERY) save();
      return changed;
    },
    lost() {
      return Object.values(lost).sort((x, y) =>
        x.dir.localeCompare(y.dir) || x.firstSeen - y.firstSeen
        || x.title.localeCompare(y.title) || x.sessionId.localeCompare(y.sessionId));
    },
    // Removes and returns the ones still lost. A second click finds nothing to take,
    // so it cannot start a second process on the same conversation.
    take(ids) {
      const out = [];
      for (const id of ids || []) if (lost[id]) { out.push(lost[id]); delete lost[id]; }
      if (out.length) save();
      return out;
    },
    dismiss(ids) { return this.take(ids).length; },
    // A resume cmux refused is still lost, and still worth offering.
    giveBack(entries) {
      for (const e of entries || []) lost[e.sessionId] = e;
      if (entries?.length) save();
    },
  };
}
