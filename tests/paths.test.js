import test from 'node:test';
import assert from 'node:assert';
import { normalizeDir, projectSlug, uploadName } from '../src/server/paths.js';

test('mixed-case dirs normalize to one key', () => {
  assert.equal(normalizeDir('/Users/dev/desktop/scratch'), normalizeDir('/Users/dev/Desktop/scratch'));
});
test('trailing slash stripped', () => {
  assert.equal(normalizeDir('/tmp/'), normalizeDir('/tmp'));
});
test('project slug replaces /, . and spaces', () => {
  assert.equal(projectSlug('/Users/dev/.local/share/demo-network'), '-Users-dev--local-share-demo-network');
  assert.equal(projectSlug('/Users/dev/Desktop/scratch'), '-Users-dev-Desktop-scratch');
  // folders with spaces are the reason agents in a folder with a space found no transcript
  assert.equal(projectSlug('/Users/dev/Desktop/Task Manager'), '-Users-dev-Desktop-Task-Manager');
  assert.equal(projectSlug('/Users/dev/Desktop/Photo Tools'), '-Users-dev-Desktop-Photo-Tools');
});

// The upload filename arrives percent-encoded, because a header cannot carry the
// narrow no-break space macOS puts in every screenshot name. It is decoded here, and
// then it is untrusted text going into a path, so it is flattened to a bare filename.
test('a macOS screenshot name comes back readable', () => {
  const enc = encodeURIComponent('Screenshot 2026-08-22 at 6.50.47 PM.png');
  const name = uploadName(enc);
  assert.match(name, /^Screenshot_2026-08-22_at_6\.50\.47_PM\.png$/);
});

test('a name that tries to walk out of the uploads folder cannot', () => {
  for (const bad of ['../../etc/passwd', encodeURIComponent('../../etc/passwd'), '/etc/passwd',
                     '..%2F..%2Fsecrets.env']) {
    const name = uploadName(bad);
    assert.ok(!name.includes('/'), `${bad} -> ${name}`);
    assert.ok(!name.includes('..'), `${bad} -> ${name}`);
  }
});

test('an undecodable header is used as-is rather than throwing the upload away', () => {
  assert.equal(uploadName('100%.png'), '100_.png');
});

test('a missing or empty name still produces a file to write', () => {
  assert.ok(uploadName('').length);
  assert.ok(uploadName(undefined).length);
});
