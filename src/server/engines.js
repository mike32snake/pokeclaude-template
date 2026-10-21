// Which CLI a pen runs, and on which model.
//
// A pen used to be one thing: `claude --dangerously-skip-permissions`. The NEW AGENT
// form now picks an engine and a model, so this file is the one place that knows what
// each engine is called, which models it will take, and how the command line is put
// together. Nothing else builds that string.
//
// Two rules matter more than the lists. The model arrives from a page, which is to say
// from anywhere, and it is about to be spliced into a shell command: so only something
// SHAPED LIKE A MODEL NAME is ever run, and what is run is quoted. `claude-opus-5[1m]`
// is a glob to zsh - unquoted it dies with "no matches found" and the pen never opens,
// which looks exactly like cmux failing.
//
// The shape test rather than catalog membership, because the catalog is always behind
// something. Codex's own model picker says "Access legacy models by running codex -m
// <model_name>", and a model announced this morning is not in yesterday's cache. A
// typed name that looks like a model is therefore allowed through, so a new one is
// usable the day it ships rather than the day this file is edited.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atLeast, claudeVersion, readCatalog } from './models.js';

// Neither list is written here. Both CLIs cache the models their own picker offers, so
// a model either vendor ships reaches the NEW AGENT form on the next launch of that
// CLI, and this file only decides how many to show and in which order. The two arrays
// below are what to show when the cache is not there to read, which is a fresh install.
//
// The "[1m]" on the Claude fallbacks asks for the million token window explicitly. The
// live list does not need it: models.js reads which models have a 1M window from Claude
// Code's changelog, so the window is known from the name rather than forced by a suffix.
export const CLAUDE_FALLBACK = [
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
  { id: 'claude-sonnet-5[1m]', label: 'Sonnet 5 (1M context)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const CODEX_FALLBACK = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
];

const MAX_MODELS = 5;

// Anthropic's own split: "main" is the four models /model puts up front, "overflow" is
// everything behind "more models". Taking main first and topping up from overflow gives
// the same five a person would pick from, in the order Anthropic ranked them, and the
// first one becomes the form's default - so the default moves on its own when a new
// flagship ships. A model whose version floor is above the installed CLI is dropped:
// `claude --model` refuses the name, the pen opens and dies, and that looks exactly
// like cmux failing.
export function claudeModels(rows, version = claudeVersion()) {
  const usable = (Array.isArray(rows) ? rows : [])
    .filter(m => m && m.id && atLeast(version, m.minVersion));
  const out = [...usable.filter(m => m.section === 'main'),
               ...usable.filter(m => m.section !== 'main')]
    .slice(0, MAX_MODELS)
    .map(m => ({ id: m.id, label: m.name || m.id }));
  return out.length ? out : CLAUDE_FALLBACK;
}

export function readClaudeModels(home = os.homedir(), version = claudeVersion()) {
  return claudeModels(readCatalog(home), version);
}

// ~/.codex/models_cache.json, as the Codex CLI writes it. `visibility` is how Codex
// marks a model that is not for people to pick - an internal reserve pool, the model
// behind `codex review` - and `priority` is its own ordering, lowest first.
export function codexModels(cache) {
  const rows = Array.isArray(cache?.models) ? cache.models : [];
  const out = rows
    .filter(m => m && m.slug && m.visibility === 'list')
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .slice(0, MAX_MODELS)
    .map(m => ({ id: m.slug, label: m.display_name || m.slug }));
  return out.length ? out : CODEX_FALLBACK;
}

export function readCodexModels(home = os.homedir()) {
  try {
    return codexModels(JSON.parse(
      fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8')));
  } catch { return CODEX_FALLBACK; }
}

// What the NEW AGENT form draws. The default is the first model in each list, so the
// two orderings above are the only place the default is decided.
export function catalog({ claude = readClaudeModels(), codex = readCodexModels() } = {}) {
  return {
    claude: { label: 'Claude Code', models: claude, default: claude[0].id },
    codex: { label: 'Codex', models: codex, default: codex[0].id },
  };
}

// Single quotes, the way a shell wants them: everything inside is literal, and a
// quote of its own ends the string, escapes itself and starts a new one.
export const shellQuote = (s) => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

// Claude Code and Codex each have one flag that means "stop asking me". They are not
// spelled alike and the wrong one is a hard error at startup, not a warning.
const CLI = {
  claude: { bin: 'claude', bypass: '--dangerously-skip-permissions', extra: '' },
  // The morning a Codex release ships, every new session opens on "Update available!"
  // with "Update now" already selected. No composer is drawn under it, so a spawn waits
  // out its whole budget and fails, and Enter would run npm install. Off at the source.
  codex: { bin: 'codex', bypass: '--dangerously-bypass-approvals-and-sandbox',
           extra: ' -c check_for_update_on_startup=false' },
};

// A model name: letters, digits and the punctuation the two vendors actually use,
// plus Claude Code's "[1m]" window suffix. No spaces, no leading dash (which would be
// read as another flag), nothing a shell would look at twice.
export const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\[1m\])?$/;

// A session id, for starting a pen and for resuming one. It reaches the server from a
// browser in the resume case, so only a UUID is ever spliced into a command line.
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function spawnCommand(engine, model, models = null, { sessionId = null } = {}) {
  const cli = CLI[engine];
  if (!cli) throw new Error(`${engine} is not an engine PokeClaude can start`);
  // Only read a list when there is no model to run, which is the form's default.
  const list = models
    || (model ? [] : engine === 'codex' ? readCodexModels() : readClaudeModels());
  const want = model || list[0]?.id;
  if (!MODEL_SLUG.test(want || '')) {
    throw new Error(`"${want}" is not a model name`);
  }
  // A Claude pen is GIVEN its session id rather than asked for it afterwards.
  // linkSessions (sessions.js) ties a pen to its conversation by reading the id off
  // the claude process's command line, and a pen started without one has no link but
  // the hooks - which live in memory, so a server restart loses them, and a blocked
  // agent never fires another one to rebuild it. Codex keeps its own rollout files and
  // is found through those (codexlog.js), so it is not given one.
  let session = '';
  if (engine === 'claude') {
    const id = sessionId || randomUUID();
    if (!UUID.test(id)) throw new Error(`"${sessionId}" is not a session id`);
    session = ` --session-id ${id}`;
  }
  return `${cli.bin} --model ${shellQuote(want)}${session} ${cli.bypass}${cli.extra}`;
}

export function resumeCommand(engine, sessionId) {
  const eng = engine || 'claude';
  if (!CLI[eng]) throw new Error(`${eng} is not an engine PokeClaude can resume`);
  if (!UUID.test(String(sessionId || ''))) throw new Error(`"${sessionId}" is not a session id`);
  // Resumed with the same "stop asking me" flag as a new pen. Without it the CLI picks
  // its own mode, and a restored pen came back asking where it never asked before.
  const cli = CLI[eng];
  return eng === 'codex' ? `codex resume ${sessionId} ${cli.bypass}${cli.extra}`
                         : `claude --resume ${sessionId} ${cli.bypass}`;
}
