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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The five Claude models worth starting an agent on, newest first. These are the
// strings Claude Code's own --model flag takes; the "[1m]" ones ask for the million
// token window, which is what cmux.contextWindow() then measures the context bar
// against. Haiku has no 1M variant.
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
  { id: 'claude-sonnet-5[1m]', label: 'Sonnet 5 (1M context)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

// Codex publishes its own list and the CLI caches it, so the picker reads that rather
// than hard-coding names that go stale on the next release. This is only what to show
// when the cache is not there to read: a fresh install has not written it yet.
export const CODEX_FALLBACK = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
];

const MAX_MODELS = 5;

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
export function catalog({ codex = readCodexModels() } = {}) {
  return {
    claude: { label: 'Claude Code', models: CLAUDE_MODELS, default: CLAUDE_MODELS[0].id },
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

export function spawnCommand(engine, model, codex = readCodexModels()) {
  const cli = CLI[engine];
  if (!cli) throw new Error(`${engine} is not an engine PokeClaude can start`);
  const models = engine === 'codex' ? codex : CLAUDE_MODELS;
  const want = model || models[0]?.id;
  if (!MODEL_SLUG.test(want || '')) {
    throw new Error(`"${want}" is not a model name`);
  }
  return `${cli.bin} --model ${shellQuote(want)} ${cli.bypass}${cli.extra}`;
}

// Resuming a past session, from the PC or the archive. Each CLI spells it differently
// and the id comes from a browser, so only a UUID is ever spliced in.
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function resumeCommand(engine, sessionId) {
  const eng = engine || 'claude';
  if (!CLI[eng]) throw new Error(`${eng} is not an engine PokeClaude can resume`);
  if (!UUID.test(String(sessionId || ''))) throw new Error(`"${sessionId}" is not a session id`);
  return eng === 'codex' ? `codex resume ${sessionId}${CLI.codex.extra}` : `claude --resume ${sessionId}`;
}
