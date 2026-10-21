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
import { CLAUDE_FALLBACK, CODEX_FALLBACK, claudeModels, codexModels, catalog, shellQuote,
         spawnCommand, resumeCommand }
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

// The rows readCatalog (models.js) hands back, which is Claude Code's own /model list:
// "main" is the short list the picker shows, "overflow" is behind "more models".
const CC = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', minVersion: '2.1.280' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main', minVersion: '2.1.251' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main', minVersion: null },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'main', minVersion: null },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'overflow', minVersion: null },
  { id: 'claude-opus-5', name: 'Opus 5', section: 'overflow', minVersion: null },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'overflow', minVersion: null },
];

// The whole point of the change: Opus 5.5 shipped and PokeClaude offered Opus 5, because
// the list was five strings in this file. It now comes from the catalog the CLI caches.
test('the Claude list comes from the catalog Claude Code caches, main models first', () => {
  const got = claudeModels(CC, '2.1.284');
  assert.deepEqual(got.map(m => m.id),
    ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5',
     'claude-haiku-4-5-20251001', 'claude-sonnet-5']);
  assert.equal(got[0].label, 'Opus 5.5');
});

test('never more than five, however many the catalog lists', () => {
  const many = Array.from({ length: 14 }, (_, i) =>
    ({ id: `claude-m-${i}`, name: `M${i}`, section: 'overflow', minVersion: null }));
  assert.equal(claudeModels(many, '2.1.284').length, 5);
});

// A model whose floor is above the installed CLI is one `claude --model` refuses. The
// pen would open and die at startup, which looks exactly like cmux failing.
test('a model the installed CLI is too old for is not offered', () => {
  const got = claudeModels(CC, '2.1.260');
  assert.ok(!got.some(m => m.id === 'claude-opus-5-5'));
  assert.ok(got.some(m => m.id === 'claude-fable-5-1'));
  // Losing the newest one promotes the next, so the form still offers five.
  assert.equal(got.length, 5);
});

test('an unknown CLI version hides nothing, because that is the safer mistake', () => {
  assert.equal(claudeModels(CC, null)[0].id, 'claude-opus-5-5');
});

// The cache is written by the CLI, so it is missing on a fresh install and rewritten on
// every update. A form with an empty model list is a dead end.
test('an unreadable catalog falls back rather than offering nothing', () => {
  for (const bad of [null, [], 'nonsense', [{}, { name: 'no id' }]]) {
    assert.deepEqual(claudeModels(bad, '2.1.284'), CLAUDE_FALLBACK);
  }
  assert.equal(CLAUDE_FALLBACK.length, 5);
  for (const m of CLAUDE_FALLBACK) { assert.ok(m.id); assert.ok(m.label); }
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
  const c = catalog({ claude: claudeModels(CC, '2.1.284'), codex: codexModels(CACHE) });
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
  assert.match(spawnCommand('claude', 'claude-opus-5[1m]'),
    /^claude --model 'claude-opus-5\[1m\]' --session-id [0-9a-f-]{36} --dangerously-skip-permissions$/);
});

// Every Claude pen is given its session id rather than being asked for it afterwards.
//
// linkSessions (sessions.js) ties a pen to its conversation by reading the session id
// off the claude process's own command line, and a pen started without one has no link
// at all except the hooks - which are in memory, so a server restart loses them and a
// blocked agent never fires another to rebuild it. The id is ours to choose, so we
// choose it, and the link then survives anything.
test('every Claude pen carries a session id, and a different one each time', () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    const m = spawnCommand('claude', 'claude-opus-5-5').match(/--session-id (\S+)/);
    assert.ok(m, 'no session id in the command line');
    ids.add(m[1]);
  }
  assert.equal(ids.size, 20, 'two pens were given the same session id');
});

test('a session id can be supplied, and anything not a UUID is refused', () => {
  const id = '01a07b67-ae0e-7df1-befe-c028ac83fd16';
  assert.match(spawnCommand('claude', 'claude-opus-5-5', null, { sessionId: id }),
    new RegExp(`--session-id ${id} `));
  for (const bad of ['; rm -rf /', '$(whoami)', 'not-a-uuid', '../../x']) {
    assert.throws(() => spawnCommand('claude', 'claude-opus-5-5', null, { sessionId: bad }),
      /not a session id/i, `allowed: ${bad}`);
  }
});

// Codex keeps its own rollout files and is found through them (codexlog.js), so it is
// not given one and must not be.
test('a Codex pen is not given a Claude session id', () => {
  assert.doesNotMatch(spawnCommand('codex', 'gpt-5.5', []), /--session-id/);
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

// The default is the first row of the live list, so it moves when Anthropic ships.
test('no model named is the engine default, not an empty flag', () => {
  assert.match(spawnCommand('claude', null, claudeModels(CC, '2.1.284')),
    /^claude --model 'claude-opus-5-5' --session-id /);
  assert.equal(spawnCommand('codex', null, codexModels(CACHE)),
    "codex --model 'gpt-5.6-terra' --dangerously-bypass-approvals-and-sandbox"
    + " -c check_for_update_on_startup=false");
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
  assert.match(spawnCommand('claude', 'claude-opus-6[1m]'), /--model 'claude-opus-6\[1m\]'/);
});

test('resumeCommand spells resume the way each CLI does, and only for a UUID', () => {
  const id = '01a07b67-ae0e-7df1-befe-c028ac83fd16';
  assert.equal(resumeCommand('claude', id), `claude --resume ${id} --dangerously-skip-permissions`);
  assert.equal(resumeCommand(undefined, id), `claude --resume ${id} --dangerously-skip-permissions`);
  assert.equal(resumeCommand('codex', id),
    `codex resume ${id} --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false`);
  // A resumed pen without the flag came back in whatever mode the CLI picked ("auto"),
  // so the same field held pens that asked and pens that did not.
  for (const e of ['claude', 'codex']) {
    const bypass = spawnCommand(e, 'm', []).match(/--dangerously-[a-z-]+/)[0];
    assert.ok(resumeCommand(e, id).includes(bypass), `${e} resumes in the mode it spawns in`);
  }
  assert.throws(() => resumeCommand('codex', 'abc; rm -rf /'), /not a session id/);
  assert.throws(() => resumeCommand('gemini', id), /not an engine/);
});
