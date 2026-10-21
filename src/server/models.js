// What Claude Code itself says about Claude models on this machine.
//
// PokeClaude used to carry five Claude model names in engines.js, on the grounds that
// Claude Code published no list to read. It does. Two files, both written by the CLI
// and refreshed by it, so a model Anthropic ships appears in the NEW AGENT form on the
// next Claude Code launch with no edit here - which is already how the Codex list
// works, and is the whole reason this module exists. Opus 5.5 shipped and PokeClaude
// went on offering Opus 5.
//
//   ~/.claude/cache/model-catalog/<userId>-<hash>-cc.json
//       the catalog /model draws from: ids, display names, sections, version floors.
//   ~/.claude/cache/changelog.md
//       one "Added Claude X (`id`) - 1M context, ..." line per model ever shipped,
//       which is the only local statement of a model's CONTEXT WINDOW.
//
// Nothing here calls a model or the network, and nothing here is allowed to throw: a
// picker that cannot open is worse than a picker showing yesterday's list.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The directory holds one file per SURFACE, and only "cc" is Claude Code's. The others
// belong to the desktop and web apps, whose lists carry models this CLI will not take.
const CATALOG_DIR = ['.claude', 'cache', 'model-catalog'];
const CHANGELOG = ['.claude', 'cache', 'changelog.md'];

// One catalog file, reduced to the four fields that matter. `section` is how Anthropic
// splits its own picker: "main" is the short list, "overflow" is behind "more models".
// `min_claude_code_version` is the floor - below it, `claude --model` refuses the name.
export function catalogModels(json) {
  const rows = json?.catalog?.config?.models;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(m => m && typeof m.id === 'string' && m.id)
    .map(m => ({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      section: m.section === 'main' ? 'main' : 'overflow',
      minVersion: typeof m.min_claude_code_version === 'string'
        ? m.min_claude_code_version : null,
    }));
}

// The file also carries `staleAt`, and we ignore it: the CLI refetches on its own
// schedule and a list it fetched last week still beats a list typed into a source file
// last month. Newest file wins, because a re-login leaves the old one in place.
export function readCatalog(home = os.homedir()) {
  try {
    const dir = path.join(home, ...CATALOG_DIR);
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('-cc.json'))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files) {
      const rows = catalogModels(JSON.parse(fs.readFileSync(f, 'utf8')));
      if (rows.length) return rows;
    }
  } catch {}
  return [];
}

// "2.1.9" is not below "2.1.280" but a string comparison says it is, so compare field
// by field. An unknown version and an absent floor both gate nothing: hiding a model
// this CLI could have run is the worse of the two mistakes.
export function atLeast(have, want) {
  if (!want || !have) return true;
  const nums = s => String(s).split('.').map(x => parseInt(x, 10) || 0);
  const a = nums(have), b = nums(want);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

// The installed CLI, read once per server run: run-server.sh restarts on every change,
// so once is enough, and a machine without claude on PATH simply gates nothing.
//
// The auto-updater leaves the version it landed on in a file, which costs nothing to
// read. `claude --version` is the fallback, and it is a second of a subprocess - worth
// avoiding on the request that draws the NEW AGENT form.
const VERSION_RE = /(\d+(?:\.\d+)+)/;
let seenVersion;
export function claudeVersion(home = os.homedir()) {
  if (seenVersion !== undefined) return seenVersion;
  seenVersion = null;
  try {
    const f = JSON.parse(fs.readFileSync(
      path.join(home, '.claude', '.last-update-result.json'), 'utf8'));
    if (f?.status === 'success') seenVersion = (String(f.version_to).match(VERSION_RE) || [])[1] || null;
  } catch {}
  if (seenVersion) return seenVersion;
  try {
    const out = execFileSync('claude', ['--version'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    seenVersion = (String(out).match(VERSION_RE) || [])[1] || null;
  } catch {}
  return seenVersion;
}

// Which models have a million tokens of context. The catalog does not say, so the
// changelog does: every model ships with a line naming its id and its window, and the
// ids that line says "1M context" about are exactly the large ones. This replaces a
// regex of model FAMILIES, which is the thing that kept going stale - Opus 5 has a 1M
// window by default, so PokeClaude asked for "claude-opus-5[1m]" to be sure, and the
// suffix is what made the window readable rather than the model.
export function largeWindowIds(changelog) {
  const out = new Set();
  for (const line of String(changelog || '').split('\n')) {
    const m = line.match(/`(claude-[a-z0-9.-]+)`/i);
    if (m && /\b1m context\b/i.test(line)) out.add(m[1].toLowerCase());
  }
  return out;
}

// The context bar is measured against what Claude Code PRINTS in its footer, which is
// a display name ("Opus 5.5"), not an id. The catalog is what joins the two, so every
// large model contributes both spellings and cmux.js can match either.
export function largeWindowNames(changelog, models) {
  const ids = largeWindowIds(changelog);
  const out = new Set(ids);
  for (const m of (Array.isArray(models) ? models : [])) {
    if (m && ids.has(String(m.id).toLowerCase())) out.add(String(m.name).toLowerCase());
  }
  return out;
}

export function readLargeWindowNames(home = os.homedir()) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, ...CHANGELOG), 'utf8'); } catch {}
  return largeWindowNames(text, readCatalog(home));
}
