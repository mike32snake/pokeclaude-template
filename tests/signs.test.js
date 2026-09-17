import test from 'node:test';
import assert from 'node:assert';
import { signNames } from '../src/server/signs.js';

// Invented names, chosen for their SHAPE: a bare acronym, two that fit the 16-char cap,
// a shared brand prefix on one name over the cap and one under it, a hyphenated name
// whose words are all in the ABBREV map, and one long enough to need truncating.
const FOLDERS = ['scratch','notes','website','API','Photo Tools','Task Manager','sandbox',
 'Sprite Workshop','Lakeshore Data Viz','Lakeshore Sales','infrastructure-management-application',
 'Robot Team Analysis & Review'];

test('names that fit are untouched', () => {
  const s = signNames(FOLDERS);
  assert.equal(s[FOLDERS.indexOf('Task Manager')], 'Task Manager');
  assert.equal(s[FOLDERS.indexOf('Photo Tools')], 'Photo Tools');
  assert.equal(s[FOLDERS.indexOf('API')], 'API');
});
test('shared brand prefix drops only when over cap', () => {
  const s = signNames(FOLDERS);
  assert.equal(s[FOLDERS.indexOf('Lakeshore Data Viz')], 'Data Viz');
  assert.equal(s[FOLDERS.indexOf('Lakeshore Sales')], 'Lakeshore Sales');
});
test('abbreviations fire', () => {
  const s = signNames(FOLDERS);
  assert.equal(s[FOLDERS.indexOf('infrastructure-management-application')], 'Infra Mgmt App');
});
test('every sign fits the cap', () => {
  for (const s of signNames(FOLDERS)) assert.ok(s.length <= 16, s);
});
