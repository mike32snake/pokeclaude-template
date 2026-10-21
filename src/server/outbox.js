import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function createOutbox(file, deliver, changed = () => {}) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const row of rows) if (row.status === 'sending') { row.status = 'review'; row.reason = 'Delivery was interrupted. Check the conversation before retrying.'; }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(rows), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  // One pass hands each pen at most its oldest reply. kick() runs passes until one makes
  // no progress, and a kick that lands mid-pass asks for one more rather than being
  // dropped, so a reply never has to wait for the fallback timer.
  let running = null, again = false;
  async function pass() {
    let sent = false;
    const seen = new Set();
    for (const row of rows) {
      if (row.status === 'sent' || seen.has(row.ws)) continue;
      seen.add(row.ws);
      if (row.status !== 'queued') continue;
      row.status = 'sending'; save();
      let r;
      try { r = await deliver(row); } catch { r = { status: 502, body: { error: 'Delivery could not be verified.' } }; }
      row.status = r.body?.ok ? 'sent' : r.status === 409 ? 'queued' : 'review';
      row.reason = r.body?.error || null;
      if (row.status === 'sent') sent = true;
      save(); changed(row.ws);
    }
    return sent;
  }
  function kick() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        let progressed;
        do { again = false; progressed = await pass(); } while (again || progressed);
      } finally { running = null; }
    })();
    return running;
  }
  return {
    list: ws => rows.filter(r => r.ws === ws && r.status !== 'sent'),
    add(ws, text, id = randomUUID(), session = null) {
      const old = rows.find(r => r.id === id);
      if (old) { if (old.ws !== ws || old.text !== text) throw new Error('Message id already used'); return old; }
      const row = { id, ws, text, session, status: 'queued', at: Date.now() };
      rows.push(row); save(); changed(ws); return row;
    },
    cancel(ws, id) {
      const row = rows.find(r => r.id === id && r.ws === ws);
      if (!row || row.status === 'sending') return false;
      rows = rows.filter(r => r !== row); save(); changed(ws); return true;
    },
    // `live` maps every live pen to the session running in it. A reply whose pen is gone
    // moves to the pen now running its conversation, which is where a restore puts it.
    // A live pen keeps its replies whatever it is running: the send path holds those
    // until the original conversation returns. Returns how many moved.
    follow(live) {
      const home = new Map();
      for (const [ws, session] of Object.entries(live || {})) if (session) home.set(session, ws);
      let moved = 0;
      for (const row of rows) {
        if (row.status === 'sent' || row.status === 'sending' || !row.session) continue;
        if (Object.hasOwn(live, row.ws)) continue;
        const to = home.get(row.session);
        if (!to) continue;
        const from = row.ws;
        row.ws = to; moved++;
        changed(from); changed(to);
      }
      if (moved) save();
      return moved;
    },
    kick,
    tick: kick,
  };
}
