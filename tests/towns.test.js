import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleTowns, TOWN_SIZES } from '../src/server/towns.js';

// public/art/town-N.json holds each repo's ABSOLUTE directory, because that is what
// the client matches a live agent's cwd against. So the file is only ever true on the
// machine that built it, and committing one means a clone renders someone else's
// folders and matches none of its own. They are built on boot instead.
function sandbox({ towns = [], configAge = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokeclaude-town-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'public/art'), { recursive: true });
  const cfg = path.join(root, 'config/repos.json');
  fs.writeFileSync(cfg, '{"repos":[]}');
  const now = Date.now();
  fs.utimesSync(cfg, new Date(now - configAge), new Date(now - configAge));
  for (const { size, age } of towns) {
    const f = path.join(root, `public/art/town-${size}.json`);
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, new Date(now - age), new Date(now - age));
  }
  return root;
}

test('a clone with no town files builds every size', () => {
  const root = sandbox();
  assert.deepEqual(staleTowns(root), TOWN_SIZES);
});

test('town files newer than the config are left alone', () => {
  const root = sandbox({ configAge: 60_000, towns: TOWN_SIZES.map(size => ({ size, age: 1_000 })) });
  assert.deepEqual(staleTowns(root), []);
});

// Editing config/repos.json by hand is the documented way to add a pen. If that did
// not invalidate the layouts, the new pen simply would not appear and nothing would
// say why.
test('editing the config makes every layout stale', () => {
  const root = sandbox({ configAge: 1_000, towns: TOWN_SIZES.map(size => ({ size, age: 60_000 })) });
  assert.deepEqual(staleTowns(root), TOWN_SIZES);
});

test('only the missing size is rebuilt', () => {
  const root = sandbox({ configAge: 60_000, towns: [{ size: 3, age: 1_000 }, { size: 5, age: 1_000 }] });
  assert.deepEqual(staleTowns(root), [4]);
});
