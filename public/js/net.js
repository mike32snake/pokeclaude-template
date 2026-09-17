import { uploadHeaderName } from './attach.js';
export const state = { agents: [], version: 0, usage: null, crons: [], restore: [] };
const listeners = new Set();
const threadListeners = new Set();
export function onState(fn) { listeners.add(fn); }
// Fires the instant an agent's transcript changes on disk.
export function onThread(fn) { threadListeners.add(fn); }
export function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const s = JSON.parse(e.data);
    if (s.type === 'thread') { for (const fn of threadListeners) fn(s.ws); return; }
    state.agents = s.agents; state.version = s.version; state.usage = s.usage || state.usage;
    if (s.crons) state.crons = s.crons;
    if (s.auth) state.auth = s.auth;
    if (s.restore) state.restore = s.restore;
    for (const fn of listeners) fn(state);
  };
  es.onerror = () => setTimeout(() => { es.close(); connect(); }, 3000);
}
export const api = {
  agent: (ws) => fetch(`/api/agent?ws=${encodeURIComponent(ws)}`).then(r => r.json()),
  screen: (ws) => fetch(`/api/screen?ws=${encodeURIComponent(ws)}`).then(r => r.json()),
  sessions: (dir) => fetch(`/api/sessions?dir=${encodeURIComponent(dir)}`).then(r => r.json()),
  archive: (dir) => fetch('/api/archive' + (dir ? `?dir=${encodeURIComponent(dir)}` : '')).then(r => r.json()),
  search: (q, dir) => fetch(`/api/search?q=${encodeURIComponent(q)}` +
    (dir ? `&dir=${encodeURIComponent(dir)}` : '')).then(r => r.json()),
  ash: (limit) => fetch('/api/ash' + (limit ? `?limit=${limit}` : '')).then(r => r.json()),
  cronLog: (label) => fetch(`/api/cronlog?label=${encodeURIComponent(label)}`).then(r => r.json()),
  cron: (body) => fetch('/api/cron', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  transcript: (p) => fetch(`/api/transcript?path=${encodeURIComponent(p)}`).then(r => r.json()),
  upload: (file) => fetch('/api/upload', {
    method: 'POST', headers: { 'x-filename': uploadHeaderName(file.name) }, body: file,
  }).then(r => r.json()),
  ask: (question, dirs) => fetch('/api/ask', { method: 'POST',
    body: JSON.stringify({ question, dirs }) }).then(r => r.json()),
  // Opens the macOS folder dialog on the server's screen, which is this screen. The
  // promise stays pending for as long as the dialog is open.
  pickFolder: () => fetch('/api/pick', { method: 'POST' }).then(r => r.json()),
  addRepo: (dir, archetype) => fetch('/api/repo', { method: 'POST',
    body: JSON.stringify({ dir, archetype }) }).then(r => r.json()),
  act: (body) => fetch('/api/act', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  auth: (refresh) => fetch('/api/auth' + (refresh ? '?refresh=1' : '')).then(r => r.json()),
  authLogin: (id) => fetch('/api/auth', { method: 'POST',
    body: JSON.stringify({ action: 'login', id }) }).then(r => r.json()),
  // Which CLIs this machine can start an agent with, and the models each one takes.
  engines: () => fetch('/api/engines').then(r => r.json()),
  spawn: (body) => fetch('/api/spawn', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  // The sessions that died with cmux: resume the ticked ones, or forget them.
  restore: (action, ids) => fetch('/api/restore', { method: 'POST',
    body: JSON.stringify({ action, ids }) }).then(r => r.json()),
};
