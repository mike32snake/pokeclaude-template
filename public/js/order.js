// The order of the repos: what the filter menu lists top to bottom is what the field
// lays out slot by slot. Pure list arithmetic, no storage and no DOM, so a test can
// check the one thing that is easy to get wrong: where a dropped row lands.

// Move `fromId` to where `toId` sits now. Dropping a row on one below it puts it
// after that row, on one above it puts it before, which is what the hand expects.
export function move(ids, fromId, toId) {
  const at = ids.indexOf(toId);
  if (fromId === toId || at < 0 || !ids.includes(fromId)) return ids.slice();
  const out = ids.filter(id => id !== fromId);
  out.splice(at, 0, fromId);
  return out;
}

// Sort repos by a saved order. Anything the order has never heard of keeps its
// config position at the end: a repo added to config/repos.json later still shows up,
// and it does not disturb the ones that were placed by hand.
export function applyOrder(repos, order = []) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return repos
    .map((r, i) => ({ r, k: rank.has(r.id) ? rank.get(r.id) : order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map(x => x.r);
}

// Which row the pointer is over. The rows drag with pointer events, so this is the
// whole hit test: boxes in list order, from getBoundingClientRect. A drag that runs
// off either end lands on the row at that end instead of nowhere.
export function dropTarget(rows, y) {
  if (!rows.length) return null;
  for (const r of rows) if (y < r.top + r.height) return r.id;
  return rows[rows.length - 1].id;
}
