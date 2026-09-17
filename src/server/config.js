// Per-machine configuration.
//
// config/repos.json is one person's list of absolute folder paths. It is gitignored
// for the same reason .env is: it is true on exactly one machine. The committed
// config/repos.example.json is the shape, and a fresh clone is seeded from it on the
// first read so the server boots into a real town instead of crashing on ENOENT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repoConfigPath = root => path.join(root, 'config/repos.json');
export const repoExamplePath = root => path.join(root, 'config/repos.example.json');

// ~ is expanded on read, never on write. The file keeps the tilde so it stays legible
// and portable; the server always works with absolute paths.
export const expandHome = (dir, env = process.env) =>
  dir.replace(/^~(?=\/|$)/, env.HOME || os.homedir());

export function ensureRepoConfig(root, env = process.env, { expand = true } = {}) {
  const file = repoConfigPath(root);
  if (!fs.existsSync(file)) {
    const example = repoExamplePath(root);
    if (!fs.existsSync(example)) {
      throw new Error(`no config/repos.json and no config/repos.example.json under ${root}`);
    }
    fs.copyFileSync(example, file);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Callers that write the file back ask for expand:false, otherwise the round trip
  // would bake one machine's HOME into a file that is meant to stay portable.
  cfg.repos = (cfg.repos || []).map(r => (expand ? { ...r, dir: expandHome(r.dir, env) } : { ...r }));
  return cfg;
}

// Ash's ask box shells out to the Claude Code CLI. execFile does not use a shell, so
// it cannot see a `claude` shell function; it needs a real binary. Honour an explicit
// override first, then the usual user install, then let PATH decide.
export function claudeBin(env = process.env) {
  if (env.POKECLAUDE_CLAUDE_BIN) return env.POKECLAUDE_CLAUDE_BIN;
  const home = env.HOME || os.homedir();
  const local = path.join(home, '.local/bin/claude');
  if (fs.existsSync(local)) return local;
  return 'claude';
}
