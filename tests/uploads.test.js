import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUpload, saveUpload } from '../src/server/uploads.js';

test('same-name uploads never overwrite one another', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-uploads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = saveUpload(dir, 'screenshot.png', Buffer.from('first'));
  const b = saveUpload(dir, 'screenshot.png', Buffer.from('second'));
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'first');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'second');
  assert.equal(a.name, 'screenshot.png');
});
test('upload names cannot escape the owned directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-uploads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = saveUpload(dir, '../../outside.txt', Buffer.from('hello'));
  assert.equal(path.dirname(a.path), dir);
});
test('oversize uploads reject with 413 without waiting for an end that might never arrive', async () => {
  const req = new EventEmitter();
  const result = readUpload(req, 4);
  const rejected = assert.rejects(result, e => e.status === 413);
  req.emit('data', Buffer.from('12345'));
  await rejected;
  req.emit('data', Buffer.from('more data'));
  req.emit('end');
});
test('an interrupted upload settles instead of hanging forever', async () => {
  const req = new EventEmitter();
  const result = readUpload(req);
  const rejected = assert.rejects(result, /interrupted/);
  req.emit('data', Buffer.from('partial'));
  req.emit('aborted');
  await rejected;
});
test('empty uploads fail and complete uploads retain every byte', async () => {
  const empty = new EventEmitter();
  const rejected = assert.rejects(readUpload(empty), /empty/);
  empty.emit('end'); await rejected;
  const req = new EventEmitter();
  const result = readUpload(req);
  req.emit('data', Buffer.from('hello '));req.emit('data', Buffer.from('world'));req.emit('end');
  assert.equal((await result).toString(), 'hello world');
});
