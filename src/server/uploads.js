import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { uploadName } from './paths.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
// Keep draining an oversize request so the browser can receive a useful 413.
// An aborted request must settle too: it will never emit end.
export function readUpload(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true; chunks = []; reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) return fail(failure(413, 'File is too large (maximum 25 MB).'));
      chunks.push(chunk);
    });
    req.once('aborted', () => fail(failure(400, 'Upload interrupted; attach the file again.')));
    req.once('error', () => fail(failure(400, 'Upload interrupted; attach the file again.')));
    req.once('end', () => {
      if (settled) return;
      if (!bytes) return fail(failure(400, 'empty upload'));
      settled = true; resolve(Buffer.concat(chunks)); chunks = [];
    });
  });
}
export function saveUpload(dir, rawName, contents) {
  const name = uploadName(rawName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${randomUUID()}_${name}`);
  fs.writeFileSync(file, contents, { flag: 'wx' });
  return { path: file, name, bytes: contents.length };
}
