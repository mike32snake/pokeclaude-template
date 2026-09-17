// What the NEW AGENT form should show when it opens.
//
// The engine and model are remembered between visits, which is the whole point of a
// picker you use every day. What is remembered goes stale on its own: Codex publishes
// a new list and drops the model that was chosen last week, and a stale name is not a
// harmless default - the server refuses it and the pen never opens. So the remembered
// pair is checked against the catalog every time and quietly falls back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePick, modelsFor } from '../public/js/engines.js';

const CAT = {
  claude: { label: 'Claude Code', default: 'claude-opus-5[1m]',
            models: [{ id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
                     { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }] },
  codex: { label: 'Codex', default: 'gpt-5.6-terra',
           models: [{ id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
                    { id: 'gpt-5.5', label: 'GPT-5.5' }] },
};

test('nothing remembered opens on the first engine and its default model', () => {
  assert.deepEqual(resolvePick(CAT, null),
    { engine: 'claude', model: 'claude-opus-5[1m]', custom: false });
});

test('a remembered pair comes back', () => {
  assert.deepEqual(resolvePick(CAT, { engine: 'codex', model: 'gpt-5.5' }),
    { engine: 'codex', model: 'gpt-5.5', custom: false });
});

test('a model the engine no longer offers falls back to that engine default', () => {
  assert.deepEqual(resolvePick(CAT, { engine: 'codex', model: 'gpt-4o' }),
    { engine: 'codex', model: 'gpt-5.6-terra', custom: false });
});

// Choosing Codex and then choosing Claude must not leave a Codex model selected: the
// server refuses it, and the message it refuses with is about a model, not a mistake
// anyone would recognise as "you switched engine".
test('a model belonging to the other engine is dropped, not carried across', () => {
  assert.deepEqual(resolvePick(CAT, { engine: 'claude', model: 'gpt-5.5' }),
    { engine: 'claude', model: 'claude-opus-5[1m]', custom: false });
});

// A name typed into OTHER is not in the catalog on purpose - that is the whole point
// of typing it - so the "not in the list, drop it" rule above would throw it away
// every time the form was reopened. The choice records that it was typed.
test('a model typed by hand comes back the next time the form opens', () => {
  assert.deepEqual(resolvePick(CAT, { engine: 'codex', model: 'gpt-5.7-astra', custom: true }),
    { engine: 'codex', model: 'gpt-5.7-astra', custom: true });
});

test('a typed model that is empty still falls back to the default', () => {
  assert.deepEqual(resolvePick(CAT, { engine: 'codex', model: '  ', custom: true }),
    { engine: 'codex', model: 'gpt-5.6-terra', custom: false });
});

test('an engine that is no longer in the catalog falls back to the first one', () => {
  assert.deepEqual(resolvePick(CAT, { engine: 'llama', model: 'whatever' }),
    { engine: 'claude', model: 'claude-opus-5[1m]', custom: false });
});

test('an empty catalog cannot crash the form', () => {
  assert.deepEqual(resolvePick({}, { engine: 'codex', model: 'gpt-5.5' }),
    { engine: null, model: null, custom: false });
  assert.deepEqual(modelsFor({}, 'codex'), []);
});

test('the model list is the engine own list', () => {
  assert.deepEqual(modelsFor(CAT, 'codex').map(m => m.id), ['gpt-5.6-terra', 'gpt-5.5']);
});
