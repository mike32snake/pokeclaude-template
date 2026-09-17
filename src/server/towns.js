// The field layouts are built, not committed.
//
// public/art/town-<size>.json stores each repo's ABSOLUTE directory, because that is
// the key the client matches a live agent's cwd against. A layout is therefore true on
// exactly one machine, like config/repos.json itself. Committing one means a fresh
// clone draws someone else's folders and matches none of its own agents to a pen.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { repoConfigPath } from './config.js';

export const TOWN_SIZES = [3, 4, 5];

export const townPath = (root, size) => path.join(root, `public/art/town-${size}.json`);

// Missing, or older than the config it was built from. Editing repos.json by hand is a
// documented way to add a pen; without this the pen just would not appear.
export function staleTowns(root, sizes = TOWN_SIZES) {
  const cfg = repoConfigPath(root);
  const cfgAt = fs.existsSync(cfg) ? fs.statSync(cfg).mtimeMs : 0;
  return sizes.filter(size => {
    const f = townPath(root, size);
    if (!fs.existsSync(f)) return true;
    return fs.statSync(f).mtimeMs < cfgAt;
  });
}

// Build in series: three short node processes, on a path that only runs when something
// actually changed. Failure is logged and not fatal; a stale layout still draws.
export async function buildStaleTowns(root, log = () => {}) {
  const sizes = staleTowns(root);
  for (const size of sizes) {
    await new Promise(done => execFile(process.execPath,
      [path.join(root, 'tools/build-town.js'), String(size)], { cwd: root },
      (err, _out, stderr) => {
        log({ level: err ? 'warn' : 'info', where: 'town.build', size,
              error: err ? (stderr || String(err)).slice(0, 200) : undefined });
        done();
      }));
  }
  return sizes;
}
