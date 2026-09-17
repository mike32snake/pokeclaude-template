import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function createOutbox(file, deliver, changed = () => {}) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const row of rows) if (row.status === 'sending') { row.status = 'review'; row.reason = 'Delivery was interrupted. Check the conversation before retrying.'; }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(rows), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  let busy = false;
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
    async tick() {
      if (busy) return; busy = true;
      try {
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
          save(); changed(row.ws);
        }
      } finally { busy = false; }
    },
  };
}
