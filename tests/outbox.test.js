import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutbox } from '../src/server/outbox.js';
test('replies survive restart, wait safely and deliver once in order', async () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'outbox-')); const file=path.join(dir,'q.json');
 try {
 let ready=false; const delivered=[];
 const deliver=async r => { if(!ready)return {status:409,body:{error:'not ready'}};delivered.push(r.text);return {status:200,body:{ok:true}}; };
 let q=createOutbox(file,deliver);q.add('w','first','1');q.add('w','second','2');q.add('w','first','1');
 await q.tick();assert.equal(q.list('w').length,2);assert.equal(delivered.length,0);
 q=createOutbox(file,deliver);ready=true;await q.tick();await q.tick();await q.tick();assert.deepEqual(delivered,['first','second']);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('uncertain delivery is never automatically repeated', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'outbox-'));let calls=0;
 try {const q=createOutbox(path.join(dir,'q.json'),async()=>{calls++;return {status:502,body:{error:'uncertain'}}});q.add('w','text');await q.tick();await q.tick();assert.equal(calls,1);assert.equal(q.list('w')[0].status,'review');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

// kick() is the queue being told there is a reason to look: a reply was just added, or a
// pen just changed state. The 2s timer stays as the fallback, not the only trigger.
const tmpOutbox = (deliver) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  return { q: createOutbox(path.join(dir, 'q.json'), deliver), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('a kick during a delivery is not dropped: a second pass runs as soon as the first ends', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const delivered = [];
  const { q, done } = tmpOutbox(async r => { if (r.text === 'slow') await gate; delivered.push(r.text); return { status: 200, body: { ok: true } }; });
  try {
    q.add('a', 'slow');
    const first = q.kick();
    await new Promise(r => setImmediate(r));          // the first pass is now inside deliver
    q.add('b', 'fast');
    const second = q.kick();
    release();
    await first; await second;
    assert.deepEqual(delivered, ['slow', 'fast'], 'the reply added mid-delivery waited for the timer');
  } finally { done(); }
});

test('one kick delivers every queued reply to a pen, in order, not one per timer tick', async () => {
  const delivered = [];
  const { q, done } = tmpOutbox(async r => { delivered.push(r.text); return { status: 200, body: { ok: true } }; });
  try {
    q.add('w', 'one'); q.add('w', 'two'); q.add('w', 'three');
    await q.kick();
    assert.deepEqual(delivered, ['one', 'two', 'three']);
  } finally { done(); }
});

test('a pen that is not ready is asked once per kick, never in a spin', async () => {
  let calls = 0;
  const { q, done } = tmpOutbox(async () => { calls++; return { status: 409, body: { error: 'busy' } }; });
  try {
    q.add('w', 'hello');
    await q.kick();
    assert.equal(calls, 1);
    assert.equal(q.list('w')[0].status, 'queued', 'a 409 keeps the reply waiting');
  } finally { done(); }
});

// A reply is addressed to a pen, but it is for a conversation. After the reboot on
// 2026-09-30 the multiselect session came back as a new pen, and "you good?" sat
// queued forever for the pen id that had died with the Mac.
test('a reply for a pen that is gone follows its conversation to the pen running it now', async () => {
  const delivered = [];
  const { q, done } = tmpOutbox(async r => { delivered.push([r.ws, r.text]); return { status: 200, body: { ok: true } }; });
  try {
    q.add('old-pen', 'you good?', 'r1', 'sess-1');
    q.add('other-pen', 'stay put', 'r2', 'sess-2');
    q.add('gone-pen', 'no home yet', 'r3', 'sess-3');
    const moved = q.follow({ 'new-pen': 'sess-1', 'other-pen': 'sess-2' });
    assert.equal(moved, 1);
    assert.deepEqual(q.list('new-pen').map(r => r.text), ['you good?']);
    assert.equal(q.list('old-pen').length, 0);
    assert.deepEqual(q.list('other-pen').map(r => r.text), ['stay put']);
    assert.deepEqual(q.list('gone-pen').map(r => r.text), ['no home yet'], 'a reply with nowhere to go stays where it was');
    assert.equal(q.follow({ 'new-pen': 'sess-1', 'other-pen': 'sess-2' }), 0, 'a second look moves nothing');
  } finally { done(); }
});

test('a reply never moves off a pen that is still alive, even if its session changed', () => {
  const { q, done } = tmpOutbox(async () => ({ status: 409, body: {} }));
  try {
    q.add('pen-a', 'hi', 'r1', 'sess-1');
    assert.equal(q.follow({ 'pen-a': 'sess-9', 'pen-b': 'sess-1' }), 0);
    assert.equal(q.list('pen-a').length, 1);
  } finally { done(); }
});
