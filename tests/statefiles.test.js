// Where a backend keeps its own state on disk.
//
// The two backends host DIFFERENT PENS. A cmux workspace and a native relay are not
// the same thing and never will be, so a file that records "which sessions are running"
// or "which replies are still owed" belongs to one of them, not to both.
//
// Running the native server beside the live cmux one proved it: they share
// data/roster.json, the native ranch saw one pen, and it rewrote the file marking all
// ten live cmux sessions as lost. The next thing you would have seen on the
// ranch you actually work in is "CMUX RESTARTED - 10 sessions stopped with it", about
// ten agents that were running perfectly well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateFile } from '../src/server/statefiles.js';

test('cmux keeps the paths it always had, so no existing history moves', () => {
  assert.equal(stateFile('/r', 'roster.json', 'cmux'), '/r/data/roster.json');
  assert.equal(stateFile('/r', 'reply-outbox.json', 'cmux'), '/r/data/reply-outbox.json');
});

test('another backend gets its own file beside it', () => {
  assert.equal(stateFile('/r', 'roster.json', 'native'), '/r/data/roster.native.json');
  assert.equal(stateFile('/r', 'reply-outbox.json', 'native'), '/r/data/reply-outbox.native.json');
});

test('a file with no extension still gets the backend in its name', () => {
  assert.equal(stateFile('/r', 'queue', 'native'), '/r/data/queue.native');
});

// A backend name reaches this from the environment, and the result is a path.
test('a backend name that is not a plain word cannot escape the data directory', () => {
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '..', 'x.y']) {
    assert.throws(() => stateFile('/r', 'roster.json', bad), /backend name/i, `allowed: ${bad}`);
  }
});

test('an unknown but well-formed backend name is fine', () => {
  assert.equal(stateFile('/r', 'roster.json', 'tmux'), '/r/data/roster.tmux.json');
});
