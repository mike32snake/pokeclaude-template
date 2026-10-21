// What Claude Code itself says about Claude models on this machine.
//
// The five Claude names used to be typed into engines.js, on the grounds that Claude
// Code published no list to read. It does: the CLI caches the catalog it draws /model
// from under ~/.claude/cache/model-catalog/, and it names the window of every model it
// ships in ~/.claude/cache/changelog.md. Both are written by the CLI and refreshed by
// it, so reading them is how a model Anthropic shipped this morning reaches the NEW
// AGENT form with no edit here - which is already how the Codex list works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalogModels, readCatalog, atLeast, largeWindowIds, largeWindowNames,
         readLargeWindowNames } from '../src/server/models.js';

// The shape of <userId>-<hash>-cc.json, trimmed to the fields we read. "main" is the
// picker's own short list and "overflow" is everything behind "more models".
const CC = {
  version: 2,
  catalog: { surface: 'cc', config: { id: 'cc', models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', min_claude_code_version: '2.1.280' },
    { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main', min_claude_code_version: '2.1.251' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', section: 'main' },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'main' },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', section: 'overflow' },
    { id: 'claude-opus-5', name: 'Opus 5', section: 'overflow' },
    { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'overflow' },
  ] } },
};

test('the catalog reader keeps the id, the display name, the section and the floor', () => {
  const rows = catalogModels(CC);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main',
                              minVersion: '2.1.280' });
  assert.equal(rows[2].minVersion, null);
  assert.equal(rows[4].section, 'overflow');
});

test('a catalog we cannot make sense of reads as no models, not as a throw', () => {
  for (const bad of [null, {}, { catalog: {} }, { catalog: { config: { models: 'no' } } },
                     { catalog: { config: { models: [null, {}, { name: 'no id' }] } } }]) {
    assert.deepEqual(catalogModels(bad), []);
  }
});

// The directory holds one file per surface: "cc" is Claude Code, and the others belong
// to the desktop and web apps, whose lists include models this CLI will not take.
test('only the cc surface is read, and the newest file of it wins', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-models-'));
  const dir = path.join(home, '.claude', 'cache', 'model-catalog');
  fs.mkdirSync(dir, { recursive: true });
  const other = { catalog: { config: { models: [
    { id: 'claude-desktop-only', name: 'Desktop Only', section: 'main' }] } } };
  fs.writeFileSync(path.join(dir, 'u-h-desktop.json'), JSON.stringify(other));
  fs.writeFileSync(path.join(dir, 'u-h-cc.json'), JSON.stringify(CC));
  const rows = readCatalog(home);
  assert.equal(rows[0].id, 'claude-opus-5-5');
  assert.ok(!rows.some(m => m.id === 'claude-desktop-only'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('no catalog on disk reads as no models', () => {
  assert.deepEqual(readCatalog(path.join(os.tmpdir(), 'pc-no-such-home')), []);
});

// A model whose floor is above the installed CLI is one `claude --model` refuses, so
// offering it opens a pen that dies at startup.
test('a version floor is compared field by field, not as a string', () => {
  assert.ok(atLeast('2.1.284', '2.1.280'));
  assert.ok(atLeast('2.1.284', '2.1.284'));
  assert.ok(!atLeast('2.1.9', '2.1.280'));     // string order would say 2.1.9 wins
  assert.ok(!atLeast('2.1.279', '2.1.280'));
  assert.ok(atLeast('2.2.0', '2.1.999'));
  assert.ok(!atLeast('1.9.9', '2.0.0'));
});

// Hiding a model we could have run is the worse of the two mistakes, so an unknown
// version and an absent floor both gate nothing.
test('an unknown version and an absent floor both allow the model', () => {
  assert.ok(atLeast(null, '2.1.280'));
  assert.ok(atLeast('2.1.284', null));
  assert.ok(atLeast(null, null));
});

// The catalog says nothing about the context window. The changelog does: every model
// ships with a line naming its id and its window.
const CHANGELOG = [
  '# Changelog',
  '- Added Claude Sonnet 5.5 (`claude-sonnet-5-5`), now the default Sonnet model on the'
    + ' Anthropic API - 1M context, $2/$10 per Mtok with $0.20/Mtok cache reads',
  '- Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model - 1M context,'
    + ' $4/$20 per Mtok',
  '- Added Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) - 200K context, $1/$5 per Mtok',
  '- Fixed `/model opusplan[1m]` being rejected with "Model not found"',
].join('\n');

test('the 1M models are read off the changelog, by id', () => {
  const ids = largeWindowIds(CHANGELOG);
  assert.ok(ids.has('claude-opus-5-5'));
  assert.ok(ids.has('claude-sonnet-5-5'));
  assert.ok(!ids.has('claude-haiku-4-5-20251001'), 'Haiku 4.5 is a 200K model');
});

// The context bar is measured against what Claude Code PRINTS in its footer, which is
// a display name ("Opus 5.5"), not an id. The catalog is what joins the two.
test('the catalog turns those ids into the display names the footer prints', () => {
  const names = largeWindowNames(CHANGELOG, catalogModels(CC));
  assert.ok(names.has('opus 5.5'));
  assert.ok(names.has('sonnet 5.5'));
  assert.ok(names.has('claude-opus-5-5'));
  assert.ok(!names.has('haiku 4.5'));
  assert.ok(!names.has('sonnet 5'), 'Sonnet 5 and Sonnet 5.5 are different models');
});

test('no changelog and no catalog name nothing large, rather than throwing', () => {
  assert.equal(largeWindowNames('', []).size, 0);
  assert.equal(largeWindowNames(null, null).size, 0);
  assert.ok(readLargeWindowNames(path.join(os.tmpdir(), 'pc-no-such-home')) instanceof Set);
});
