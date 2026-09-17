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
