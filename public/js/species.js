// Which Pokemon each agent is. The hash alone gave two agents in one pen the same
// Pokemon often enough to lose track of which was doing what, so the hash now only
// says where an agent STARTS looking: it takes the first species from there that
// nobody on the field has. Pure, so the server (which names the Pokemon in a
// notification) and the field draw from the same answer.
import { DEX } from './dex.js';

export function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

export const PLAYER_DEX = 25;                    // Pikachu is the player, never an agent

// ids: everyone on the field. prev: id -> DEX index from the last call, so an agent
// keeps its Pokemon when a newcomer would have wanted it. Returns id -> DEX index.
export function assignSpecies(ids, prev = new Map(), reserved = [PLAYER_DEX]) {
  const N = DEX.length;
  const out = new Map();
  const used = new Set(DEX.map((d, i) => reserved.includes(d[0]) ? i : -1).filter(i => i >= 0));
  const live = [...new Set(ids)].sort();
  for (const id of live) {                       // the ones already on the field stay put
    const v = prev.get(id);
    if (v != null && !used.has(v)) { out.set(id, v); used.add(v); }
  }
  for (const id of live) {
    if (out.has(id)) continue;
    const start = hash(id + 'v2') % N;
    let v = start;
    for (let k = 0; k < N && used.has(v); k++) v = (start + k + 1) % N;
    out.set(id, v);                               // only a 150+ field repeats a Pokemon
    used.add(v);
  }
  return out;
}
