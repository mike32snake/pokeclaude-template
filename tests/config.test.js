import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRepoConfig, repoConfigPath, claudeBin } from '../src/server/config.js';

// A fresh clone has no config/repos.json: it is per-machine and gitignored, because
// one person's absolute folder paths are noise on anyone else's machine. The server
// must seed it from the committed example rather than crash on a missing file.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pokeclaude-cfg-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/repos.example.json'), JSON.stringify({
    grid: { cols: 4, rows: 3, plotW: 16, plotH: 16, street: 3, border: 2 },
    repos: [{ dir: '~/Projects/example', archetype: 'lab', plot: 0 }],
    fallback: { sign: 'outskirts', archetype: 'tent', plot: 11 },
  }, null, 2));
  return root;
}

test('a fresh clone seeds repos.json from the example', () => {
  const root = sandbox();
  assert.equal(fs.existsSync(repoConfigPath(root)), false, 'precondition: no repos.json yet');
  const cfg = ensureRepoConfig(root);
  assert.ok(fs.existsSync(repoConfigPath(root)), 'repos.json was created');
  assert.equal(cfg.repos.length, 1);
  assert.equal(cfg.grid.cols, 4);
});

// ~ in the example is what makes it portable. It must survive into the seeded file
// unexpanded, so the file stays readable, and be expanded only when a path is used.
test('the seeded file keeps ~ and the loader expands it', () => {
  const root = sandbox();
  const cfg = ensureRepoConfig(root);
  const raw = fs.readFileSync(repoConfigPath(root), 'utf8');
  assert.match(raw, /~\/Projects\/example/, 'the file on disk still reads ~');
  assert.equal(cfg.repos[0].dir, path.join(os.homedir(), 'Projects/example'), 'the loaded value is absolute');
});

// Seeding must never clobber a pen list someone has already built up.
test('an existing repos.json is never overwritten', () => {
  const root = sandbox();
  fs.writeFileSync(repoConfigPath(root), JSON.stringify({
    grid: { cols: 3, rows: 3, plotW: 16, plotH: 16, street: 3, border: 2 },
    repos: [{ dir: '/tmp/mine', archetype: 'lab', plot: 0 }],
    fallback: { sign: 'outskirts', archetype: 'tent', plot: 8 },
  }));
  const cfg = ensureRepoConfig(root);
  assert.equal(cfg.repos[0].dir, '/tmp/mine');
  assert.equal(cfg.grid.cols, 3);
});

// The ask box shells out to the Claude Code CLI. Hardcoding one person's install path
// broke it for everyone else, so the binary is resolved from the environment.
test('the claude binary comes from the environment, not a hardcoded path', () => {
  assert.equal(claudeBin({ POKECLAUDE_CLAUDE_BIN: '/opt/bin/claude' }), '/opt/bin/claude');
  assert.equal(claudeBin({ HOME: '/Users/nobody' }), 'claude', 'falls back to PATH lookup');
});

// /api/repo reads the config, appends a pen and writes the whole file back. If the
// read expanded ~, that write would silently rewrite everyone's portable example into
// one machine's absolute paths on the first repo they add.
test('the unexpanded config round-trips through a write', () => {
  const root = sandbox();
  ensureRepoConfig(root);
  const cfg = ensureRepoConfig(root, process.env, { expand: false });
  assert.equal(cfg.repos[0].dir, '~/Projects/example', 'raw read keeps the tilde');
  cfg.repos.push({ dir: '/tmp/added', archetype: 'lab', plot: 1 });
  fs.writeFileSync(repoConfigPath(root), JSON.stringify(cfg, null, 2));
  assert.match(fs.readFileSync(repoConfigPath(root), 'utf8'), /~\/Projects\/example/);
  assert.equal(ensureRepoConfig(root).repos.length, 2);
});
