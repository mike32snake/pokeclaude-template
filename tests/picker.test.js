// The native folder chooser behind "NEW REPO". Typing an absolute path is the thing
// nobody does correctly the first time, so the panel asks macOS for the real Finder
// dialog. A browser cannot: neither <input webkitdirectory> nor showDirectoryPicker
// hands back an absolute path, and an absolute path is exactly what config/repos.json
// needs. The server is on the same Mac as the browser, so it can ask osascript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseScript, parsePick, makePicker } from '../src/server/picker.js';

test('the script asks Finder, so the dialog comes up in front of the browser', () => {
  const s = chooseScript('/Users/dev/Desktop');
  assert.match(s, /choose folder/);
  assert.match(s, /activate/, 'without activate the dialog opens behind whatever is focused');
  assert.match(s, /POSIX path/, 'an alias is useless to config/repos.json');
  assert.match(s, /\/Users\/dev\/Desktop/, 'it should open where the repos live');
});

test('a start folder with a quote in it cannot end the AppleScript string', () => {
  const s = chooseScript('/tmp/we"ird\\dir');
  assert.match(s, /we\\"ird\\\\dir/);
});

test('no start folder is fine: the dialog just opens wherever macOS last was', () => {
  const s = chooseScript(null);
  assert.match(s, /choose folder/);
  assert.doesNotMatch(s, /default location/);
});

test('a chosen folder comes back as an absolute path with no trailing slash', () => {
  const r = parsePick(null, '/Users/dev/Desktop/scratch/pokeclaude/\n', '');
  assert.deepEqual(r, { dir: '/Users/dev/Desktop/scratch/pokeclaude' });
});

test('a root pick keeps its one slash', () => {
  assert.deepEqual(parsePick(null, '/\n', ''), { dir: '/' });
});

test('cancelling is not an error: the panel must not show a red line for it', () => {
  const err = Object.assign(new Error('Command failed'), { code: 1 });
  const r = parsePick(err, '', 'execution error: User canceled. (-128)');
  assert.deepEqual(r, { cancelled: true });
});

test('a real failure keeps its message so the typed path stays the way out', () => {
  const err = Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' });
  const r = parsePick(err, '', '');
  assert.equal(r.cancelled, undefined);
  assert.match(r.error, /osascript/);
});

test('an empty answer is a failure, never a folder named ""', () => {
  const r = parsePick(null, '\n', '');
  assert.equal(r.dir, undefined);
  assert.ok(r.error, 'an empty dir would sail into /api/repo and add a plot for nothing');
});

test('the picker runs osascript with the script on stdin-free argv', async () => {
  const calls = [];
  const pick = makePicker({ run: (cmd, args) => { calls.push([cmd, args]); return { stdout: '/tmp/x\n' }; } });
  const r = await pick('/tmp');
  assert.deepEqual(r, { dir: '/tmp/x' });
  assert.equal(calls[0][0], 'osascript');
  assert.equal(calls[0][1][0], '-e');
  assert.match(calls[0][1][1], /choose folder/);
});

test('a picker that throws answers with an error instead of taking the server down', async () => {
  const pick = makePicker({ run: () => { throw Object.assign(new Error('nope'), { code: 2 }); } });
  const r = await pick(null);
  assert.match(r.error, /nope/);
});
