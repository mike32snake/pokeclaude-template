// A look at the native backend, on its own port, wired to nothing.
//
// The point of this file is that it is NOT src/server/index.js. PokeClaude keeps
// running on cmux at 5180 while the pty stack is built; this serves the same agents
// the native backend hosts, on 5181, so the two can be compared side by side and the
// switch can happen when it is boring rather than when it is finished.
//
// Start it with: node tools/native-preview.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import * as native from '../src/server/native.js';
import { diffRows } from '../public/js/rowdiff.js';
import { localRequestAllowed } from '../src/server/local-http.js';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.resolve(path.join(ROOT, 'public'));
const PORT = Number(process.env.PORT || 5181);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};
const readBody = (req) => new Promise((done) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { done(JSON.parse(b || '{}')); } catch { done({}); } });
});

// A <form> can send exactly three content types, and all three are SIMPLE requests: no
// CORS preflight, so no CORS protection. Parsing a text/plain body as JSON is what
// turns "a localhost dev server" into "any website can run a command here", because
// readBody never cared what the body claimed to be.
const JSON_ONLY = /^application\/json\b/i;

export function createPreviewServer() {
  const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const port = server.address()?.port ?? PORT;

  // The same boundary index.js uses (local-http.js). Loopback binding keeps the LAN
  // out; Host and Origin keep other websites from driving this API through your
  // browser, including after a DNS rebind. This server spawns processes and streams
  // the contents of your terminals, so it is not a lesser case than index.js.
  if (!localRequestAllowed(req.headers, port)) {
    return json(res, 403, { error: 'localhost requests from this app only' });
  }
  if (req.method === 'POST' && !JSON_ONLY.test(req.headers['content-type'] || '')) {
    return json(res, 415, { error: 'application/json only' });
  }

  if (p === '/api/agents') return json(res, 200, { agents: native.listWorkspaces() });

  if (p === '/api/spawn' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.command) return json(res, 400, { error: 'command is required' });
    // No cwd: the folder the preview was started from.
    const r = await native.newWorkspace(b.name || 'pen', b.cwd || process.cwd(), b.command,
      { cols: b.cols || 160, rows: b.rows || 45 });
    return json(res, r.ok ? 200 : 500, r);
  }

  if (p === '/api/input' && req.method === 'POST') {
    const b = await readBody(req);
    const r = b.key ? await native.tap(b.id, b.key)
            : b.literal ? await native.sendLiteral(b.id, b.literal)
            : await native.send(b.id, b.text || '');
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/close' && req.method === 'POST') {
    const b = await readBody(req);
    return json(res, 200, await native.closeWorkspace(b.id));
  }

  // The screen, pushed when it changes rather than polled. Reading the grid is free;
  // shipping 200x50 of JSON ten times a second to a page nobody is looking at is not.
  if (p === '/api/screen') {
    const id = u.searchParams.get('id');
    const agent = native.agentFor(id);
    if (!agent) return json(res, 404, { error: 'no such agent' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
                         connection: 'keep-alive' });
    let dirty = true, closed = false, keys = null;
    const onOut = () => { dirty = true; };
    agent.on('output', onOut);
    // Only the rows that moved. Sending the whole grid at twenty frames a second froze
    // the tab as soon as a TUI drew a spinner - 25KB of JSON and a few thousand DOM
    // nodes rebuilt, over and over.
    const push = () => {
      if (closed) return;
      if (dirty) {
        dirty = false;
        const rows = native.rowsOf(id);
        const d = diffRows(keys, rows);
        keys = d.keys;
        if (d.full || d.rows.length || d.removed.length) {
          res.write(`data: ${JSON.stringify({
            full: d.full, rows: d.rows, removed: d.removed,
            title: agent.title, draft: native.composerDraft(rows), frame: agent.frame,
          })}\n\n`);
        }
      }
      setTimeout(push, 50);
    };
    push();
    req.on('close', () => { closed = true; agent.off('output', onOut); });
    return;
  }

  // Static files, and only from public/. Containment is checked against PUBLIC, not
  // the repo root: .env lives at the root and holds CMUX_SOCKET_PASSWORD, so "inside
  // the repo" is not the boundary that matters.
  const file = p === '/' ? path.join(PUBLIC, 'native.html')
    : p.startsWith('/js/') ? path.join(PUBLIC, p.slice(1)) : null;
  if (!file) return json(res, 404, { error: 'not found' });
  const full = path.resolve(file);
  if (full !== PUBLIC && !full.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'not found' });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'text/plain' });
  fs.createReadStream(full).pipe(res);
  });
  return server;
}

// Only when run directly, so the tests can start one on a port of their own.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))) {
  await native.attachAll();
  // A relay started by someone else - another checkout, a previous run - should show
  // up here without a restart.
  setInterval(() => native.attachAll().catch(() => {}), 2000);
  createPreviewServer().listen(PORT, '127.0.0.1', () =>
    console.log(`native preview on http://localhost:${PORT} (PokeClaude itself is untouched on 5180)`));
}
