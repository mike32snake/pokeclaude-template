// Which CLI a pen runs, and on which model.
//
// A pen used to be one thing: `claude --dangerously-skip-permissions`. Now the NEW
// AGENT form picks an engine and a model, and the picked model reaches the server as
// a STRING FROM A BROWSER that is about to be spliced into a shell command line. Two
// rules follow from that and both are tested here: only something shaped like a model
// name is ever run, and what is run is quoted. `claude-opus-5[1m]` is a glob to zsh,
// so an unquoted model id dies with "no matches found" and the pen never opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_MODELS, CODEX_FALLBACK, codexModels, catalog, shellQuote, spawnCommand,
         resumeCommand }
  from '../src/server/engines.js';

// The shape of ~/.codex/models_cache.json, trimmed to the fields we read.
const CACHE = {
  models: [
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 7 },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', priority: 8 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
    { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 23 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
  ],
};

test('five Claude models are offered, newest first', () => {
  assert.equal(CLAUDE_MODELS.length, 5);
  assert.equal(CLAUDE_MODELS[0].id, 'claude-opus-5[1m]');
  for (const m of CLAUDE_MODELS) { assert.ok(m.id); assert.ok(m.label); }
});

test('the Codex list comes from the cache the CLI keeps, in its own priority order', () => {
  const got = codexModels(CACHE);
  assert.deepEqual(got.map(m => m.id),
    ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini']);
  assert.equal(got[0].label, 'GPT-5.6-Terra');
});

// "hide" is how Codex marks a model that is not for people to pick: an internal
// reserve pool, the review model behind `codex review`. Offering one would open a pen
// on a model the account may not even be able to run.
test('models Codex hides are not offered', () => {
  assert.ok(!codexModels(CACHE).some(m => /reserve|auto-review/.test(m.id)));
});

test('never more than five, however many the cache lists', () => {
  const many = { models: Array.from({ length: 12 }, (_, i) =>
    ({ slug: `m${i}`, display_name: `M${i}`, visibility: 'list', priority: i })) };
  assert.equal(codexModels(many).length, 5);
});

// The cache is written by the Codex CLI, so it is missing on a fresh install and
// rewritten on every update. A form with an empty model list is a dead end, so a
// cache we cannot read falls back to the models we know shipped.
test('an unreadable cache falls back rather than offering nothing', () => {
  for (const bad of [null, {}, { models: 'nonsense' }, { models: [] }]) {
    assert.deepEqual(codexModels(bad), CODEX_FALLBACK);
  }
});

test('the catalog names a default for each engine, and the default is in the list', () => {
  const c = catalog({ codex: codexModels(CACHE) });
  for (const key of ['claude', 'codex']) {
    const e = c[key];
    assert.ok(e.label);
    assert.ok(e.models.some(m => m.id === e.default), `${key} default is not in its list`);
  }
});

// zsh expands [1m] as a character class and the command dies before Claude starts.
test('a model id with brackets in it is quoted, because zsh globs it otherwise', () => {
  assert.equal(shellQuote('claude-opus-5[1m]'), "'claude-opus-5[1m]'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('a Claude pen runs claude with the model quoted and permissions skipped', () => {
  assert.equal(spawnCommand('claude', 'claude-opus-5[1m]'),
    "claude --model 'claude-opus-5[1m]' --dangerously-skip-permissions");
});

test('a Codex pen runs codex with its own bypass flag', () => {
  assert.equal(spawnCommand('codex', 'gpt-5.5', codexModels(CACHE)),
    "codex --model 'gpt-5.5' --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false");
});

// A new Codex release opens every session on an "Update available!" menu with
// "Update now" preselected. The spawn waited 90s for a composer that never came, and
// pressing Enter through it would run npm install. So the check is switched off.
test('a Codex pen and a Codex resume both skip the startup update menu', () => {
  const id = '01a07b67-ae0e-7df1-befe-c028ac83fd16';
  assert.match(spawnCommand('codex', 'gpt-5.5', []), / -c check_for_update_on_startup=false$/);
  assert.match(resumeCommand('codex', id), / -c check_for_update_on_startup=false$/);
  assert.doesNotMatch(spawnCommand('claude', null), /check_for_update/);
});

test('no model named is the engine default, not an empty flag', () => {
  assert.equal(spawnCommand('claude', null),
    "claude --model 'claude-opus-5[1m]' --dangerously-skip-permissions");
});

// The model reaches the server from a page, which is to say from anywhere, and it is
// about to become part of a shell command line.
test('anything that is not a plain model name is refused, not run', () => {
  for (const bad of ['rm -rf ~; claude', '$(whoami)', 'a b', '../../etc/passwd',
                     '-x', 'x'.repeat(80)]) {
    assert.throws(() => spawnCommand('claude', bad), /not a model/i, `allowed: ${bad}`);
  }
  assert.throws(() => spawnCommand('llama', 'gpt-5.5'), /not an engine/i);
});

// The picker lists what the CLI says the account can run today, and that list is
// always behind something: a model announced this morning, a legacy model Codex hides
// but still serves ("Access legacy models by running codex -m <model_name>", says its
// own model picker). A name that looks like a model is allowed through, so a new one
// is usable the day it ships rather than the day this file is edited.
test('a model name not in the catalog is allowed through, and quoted', () => {
  assert.equal(spawnCommand('codex', 'gpt-5.7-something', []),
    "codex --model 'gpt-5.7-something' --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false");
  assert.equal(spawnCommand('claude', 'claude-opus-6[1m]'),
    "claude --model 'claude-opus-6[1m]' --dangerously-skip-permissions");
});

test('resumeCommand spells resume the way each CLI does, and only for a UUID', () => {
  const id = '01a07b67-ae0e-7df1-befe-c028ac83fd16';
  assert.equal(resumeCommand('claude', id), `claude --resume ${id}`);
  assert.equal(resumeCommand(undefined, id), `claude --resume ${id}`);
  assert.equal(resumeCommand('codex', id), `codex resume ${id} -c check_for_update_on_startup=false`);
  assert.throws(() => resumeCommand('codex', 'abc; rm -rf /'), /not a session id/);
  assert.throws(() => resumeCommand('gemini', id), /not an engine/);
});
