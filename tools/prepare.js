// Everything a fresh clone needs before it can run or be tested: a config to read and
// the field layouts built from it. Both are per-machine, so neither is in git.
// Runs as `npm run pretest`, and the server does the same work on boot.
import path from 'node:path';
import url from 'node:url';
import { ensureRepoConfig } from '../src/server/config.js';
import { buildStaleTowns } from '../src/server/towns.js';

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const cfg = ensureRepoConfig(root);
const built = await buildStaleTowns(root);
console.log(`prepare: ${cfg.repos.length} repos, ${built.length ? `built ${built.join(', ')}` : 'layouts current'}`);
