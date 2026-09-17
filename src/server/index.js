import { createOutbox } from './outbox.js';
import { terminalAction, chooseOption } from './terminal.js';
import { startAgent } from './startup.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { localRequestAllowed } from './local-http.js';
import * as cmux from './cmux.js';
import { createState, applyCmux, applyHook, snapshot, isHollow, markHollow } from './state.js';
import { normalizeDir } from './paths.js';
import { readUpload, saveUpload } from './uploads.js';
import { listCrons, createCron, runCron, deleteCron } from './crons.js';
import { appendAsh, readAsh } from './ashlog.js';
import { linkSessions } from './sessions.js';
import { coalesce } from './coalesce.js';
import { pendingPrompt, parseAsk } from './pending.js';
import { chooseFolder } from './picker.js';
import { inputBoxState, READ_LINES, draftOnScreen, queuedOnScreen, boxAction } from './screen.js';
import { makeWatcher, fire, describe, speciesFor, penName, onAppDeliver } from './notify.js';
import { findNewestTranscript, parseTail, parseConversation, listSessions,
         listArchive, searchSessions, isTranscriptPath, readConversation } from './transcripts.js';
import { recall } from './recall.js';
import { probeAuth, startLogin } from './auth.js';
import { catalog, spawnCommand, resumeCommand } from './engines.js';
import { codexByTty, parseCodexConversation, parseCodexTail } from './codexlog.js';
import { createRoster, rosterEntries } from './roster.js';
import { ensureRepoConfig, repoConfigPath, claudeBin, expandHome } from './config.js';
import { buildStaleTowns } from './towns.js';

// 5180 unless told otherwise. A second checkout on the same machine needs its own
// port, and hooks/pokeclaude-hook.sh reads the same variable so events reach the right
// one. Everything the client asks for is a relative URL, so nothing else moves.
const PORT = Number(process.env.POKECLAUDE_PORT) || 5180;
const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(root, 'public');
const state = createState();
const sseClients = new Set();
// The sessions that were running, on disk, so a cmux crash does not lose them. See
// roster.js. `rosterFresh` is true whenever the server missed the moments before the
// next poll: at startup, and after any poll where cmux could not be read.
const roster = createRoster(path.join(root, 'data', 'roster.json'));
let rosterFresh = true;
// The desktop app holds one of these. It posts through UNUserNotificationCenter, which
// is the only API on macOS 26 that will show an alert under our own name and icon; when
// nothing is listening here, notify.js falls back to osascript. See AGENTS.md.
const notifyClients = new Set();
onAppDeliver((note) => {
  if (!notifyClients.size) return false;
  const data = `data: ${JSON.stringify(note)}\n\n`;
  for (const res of notifyClients) res.write(data);
  return true;
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json' };

function log(o) { console.log(JSON.stringify({ t: new Date().toISOString(), ...o })); }

function send(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(data);
}
// Notifications used to ride along with broadcast(), which only runs when the state
// version CHANGED. That was fine while an alert fired on the transition itself, and
// wrong the moment the watcher started making a state hold before announcing it: the
// tick that closes a settle window is usually a tick where nothing changed at all, so
// the alert would sit there forever. notifyTick() is called from the poll every 3s
// regardless, and after a hook, so a window always gets to close. The watcher only
// ever reports a state once, so calling it twice in a tick costs nothing.
const notifier = makeWatcher();
function broadcast() {
  const snap = snapshot(state);
  send({ type: 'state', ...snap, socketOk, usage, crons, auth, restore: roster.lost() });
  notifyTick();
}
function notifyTick() {
  for (const alert of notifier.check(snapshot(state).agents, crons)) {
    const note = describe(alert.workspaceId ? {
      ...alert,
      species: speciesFor(alert.workspaceId),
      pen: penName(alert.dir),
      // What it was doing, read from the transcript at the moment it stopped doing it.
      // Only for the agent that just changed, so the file read costs nothing per poll.
      detail: workDetail(alert),
    } : alert);
    log({ level: 'info', where: 'notify', ...note });
    fire(note);
  }
}

// The line of the notification that says what actually happened. A blocked agent is
// asking you something, so the question is the news; a finished one is best described
// by what it last said. The title cmux gave the tab is the fallback, since it is the
// only thing that is always there.
function workDetail(alert) {
  const a = state.agents.get(alert.workspaceId);
  if (!a) return alert.title || '';
  try {
    const tp = transcriptFor(a);
    const tail = tp ? parseTail(tp) : null;
    if (tail?.lastQuestion) return tail.lastQuestion;
    if (alert.kind === 'finished' && tail?.title) return tail.title;
  } catch { /* a transcript that cannot be read must not cost the notification */ }
  return a.title || '';
}

// Watch the transcript of every agent we know about. A Claude turn lands in that file
// the moment it happens, so this is what makes the chat keep pace with the terminal
// instead of waiting for the next poll or for you to reopen the agent.
const watched = new Map();                       // path -> { watcher, wsIds:Set }
function syncWatchers() {
  const wanted = new Map();
  for (const a of state.agents.values()) {
    const tp = transcriptFor(a);      // same resolution the panel uses, so they agree
    if (!tp) continue;
    if (!wanted.has(tp)) wanted.set(tp, new Set());
    wanted.get(tp).add(a.workspaceId);
  }
  for (const [tp, w] of watched) {
    if (!wanted.has(tp)) { try { w.watcher.close(); } catch {} watched.delete(tp); }
  }
  for (const [tp, wsIds] of wanted) {
    const existing = watched.get(tp);
    if (existing) { existing.wsIds = wsIds; continue; }
    try {
      // Coalesced with a TRAILING call. A leading-edge throttle dropped the second
      // write of every turn, and the second write is where AskUserQuestion lands: the
      // panel showed the reply and never the question under it, until something else
      // wrote the file again minutes later.
      const announce = coalesce(() => {
        for (const id of watched.get(tp)?.wsIds || []) send({ type: 'thread', ws: id });
      }, 200);
      const watcher = fs.watch(tp, { persistent: false }, announce);
      watched.set(tp, { watcher, wsIds });
    } catch { /* file may vanish between check and watch */ }
  }
}

// Account usage is the same for every agent, so sample it from one of them
// occasionally rather than on every poll.
let usage = null, usageAt = 0;
let footerCursor = 0;
async function sampleFooters() {
  const live = [...state.agents.values()].filter(a => a.ref && a.kind !== 'service');
  if (!live.length) return;
  const a = live[footerCursor++ % live.length];
  const scr = await cmux.readScreen(a.ref, 40);   // the footer scrolls off in 10
  markHollow(state, a.workspaceId, isHollow(scr));
  const footer = scr.ok ? cmux.parseFooter(scr.stdout)
                        : { model: null, contextPct: null, permissionMode: null };
  // The screen alone is not enough. In a narrow pane Claude Code truncates the footer
  // before the context percentage, so it is measured from the transcript instead.
  const tp = transcriptFor(a);
  const tail = tp ? parseTail(tp) : {};
  const f = cmux.agentFacts(tail, footer);
  if (f.model !== a.model || f.contextPct !== a.contextPct ||
      f.contextTokens !== a.contextTokens || f.permissionMode !== a.permissionMode) {
    state.version++;
  }
  a.model = f.model; a.contextPct = f.contextPct;
  if (tail.title) a.sessionTitle = tail.title;       // what the roster calls it (roster.js)
  a.contextTokens = f.contextTokens; a.permissionMode = f.permissionMode;
  if (f.model || f.contextPct != null || f.permissionMode) a.footerAt = Date.now();
  // Which CLI is in this pen. cmux does not say, and it matters twice over: the panel
  // labels the agent with it, and cmux writes no status entry for anything but Claude
  // Code, so for a Codex pen this read is the ONLY thing that knows it is working.
  if (footer.engine) a.engine = footer.engine;
  if (a.engine === 'codex' && a.codexTranscript) {
    // Its own log knows more than its pane does, and knows the window the percentage
    // is measured against rather than guessing it from the model's name.
    const ct = parseCodexTail(a.codexTranscript);
    if (ct.title) a.sessionTitle = ct.title;
    if (ct.model) a.model = ct.model;
    if (ct.permissionMode) a.permissionMode = ct.permissionMode;
    a.contextTokens = ct.contextTokens ?? a.contextTokens;
    if (ct.contextTokens != null && ct.contextWindow) {
      a.contextPct = Math.round((ct.contextTokens / ct.contextWindow) * 100);
    }
    a.footerAt = Date.now();
  }
  if (a.engine === 'codex' && scr.ok) {
    const st = footer.busy ? 'WORKING' : 'ASLEEP';
    if (st !== a.status) { a.status = st; a.since = Date.now(); state.version++; }
  }
  await sampleGit(a);
}

// A Codex agent's status, every tick rather than once per round-robin.
//
// Everything else about an agent is sampled one agent per poll, which is fine for
// facts that barely move: a model, a branch, a context percentage. Status is not one
// of those. A Claude pen has cmux reporting it every three seconds and hooks on top;
// a Codex pen has neither, so its status is only as fresh as the last look at its
// pane - and on a field of sixteen agents that was a minute, which is longer than
// most turns. A Codex pen would go from idle to idle having visibly done the work in
// between. The read goes over the socket (readText, ~1ms) rather than the CLI, and is
// capped, so a field full of them still cannot stall the poll.
const CODEX_PER_TICK = 8;
async function sampleCodex() {
  const pens = [...state.agents.values()]
    .filter(a => a.ref && a.engine === 'codex' && !a.hollow).slice(0, CODEX_PER_TICK);
  for (const a of pens) {
    const scr = await cmux.readText(a.ref, READ_LINES);
    if (!scr.ok) continue;
    const st = pendingPrompt(scr.stdout) ? 'BLOCKED' : cmux.parseFooter(scr.stdout).busy ? 'WORKING' : 'ASLEEP';
    if (st !== a.status) { a.status = st; a.since = Date.now(); state.version++; }
  }
}

// cmux only reports a branch for git repo ROOTS, which misses most folders. Ask git
// directly for the same round-robin agent, so the branch is right wherever it lives.
async function sampleGit(a) {
  if (!a.rawDir) return;
  const { execFile } = await import('node:child_process');
  const run = (args) => new Promise((done) =>
    execFile('git', ['-C', a.rawDir, ...args], { timeout: 4000 },
      (err, out) => done(err ? null : (out || '').trim())));
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch == null) { a.branch = a.branch || null; a.gitDirty = false; return; }
  const dirty = await run(['status', '--porcelain', '--untracked-files=no']);
  const next = branch === 'HEAD' ? 'detached' : branch;
  if (a.branch !== next || a.gitDirty !== !!dirty) state.version++;
  a.branch = next;
  a.gitDirty = !!dirty;
}
// Scheduled jobs change slowly; a minute-old view of them is still accurate enough
// to answer "what runs next" and "what failed last night".
let crons = [], cronsAt = 0;
async function sampleCrons() {
  if (Date.now() - cronsAt < 60_000) return;
  cronsAt = Date.now();
  try {
    const next = await listCrons();
    const key = (l) => l.map(j => j.label + j.status + j.next + j.running).join('|');
    const changed = key(next) !== key(crons);
    crons = next;
    if (changed) broadcast();
  } catch (e) { log({ level: 'warn', where: 'crons', err: String(e) }); }
}

// The logins on this machine (src/server/auth.js). Each probe is the tool's own
// status command, so this is sampled rarely: every 10 minutes, or on demand from the
// strip. One run is ~2s of subprocesses and never blocks the poll.
let auth = null, authAt = 0, authBusy = null;
const authLogins = new Map();
async function sampleAuth(force = false) {
  if (authBusy) return authBusy;
  for (const [id, login] of authLogins) if (Date.now() - login.at > 10 * 60_000) authLogins.delete(id);
  if (!force && Date.now() - authAt < (authLogins.size ? 15_000 : 10 * 60_000)) return;
  authAt = Date.now();
  authBusy = probeAuth().then((next) => {
    const key = (a) => (a?.rows || []).map(r => r.id + r.ok).join('|');
    const changed = key(next) !== key(auth);
    auth = next;
    for (const row of next.rows) if (row.ok === true) authLogins.delete(row.id);
    if (changed) broadcast();
    log({ level: 'info', where: 'auth', ok: next.ok, bad: next.bad, unknown: next.unknown,
          bad_ids: next.rows.filter(r => r.ok === false).map(r => r.id) });
  }).catch((e) => log({ level: 'warn', where: 'auth', err: String(e) }))
    .finally(() => { authBusy = null; });
}

async function sampleUsage() {
  if (Date.now() - usageAt < 60_000) return;
  const live = [...state.agents.values()].find(a => a.ref && a.kind !== 'service');
  if (!live) return;
  const scr = await cmux.readScreen(live.ref, 8);
  if (!scr.ok) return;
  const u = cmux.parseUsage(scr.stdout);
  if (u.window5h != null || u.window7d != null) { usage = u; usageAt = Date.now(); }
}

let lastVersion = -1;
export let socketOk = null;
async function poll() {
  try {
    const ws = await cmux.listWorkspaces();
    const rows = cmux.readSessionJson();
    // Empty workspace list while the session file shows tabs => socket is denying us.
    const denied = ws.length === 0 && rows.length > 0;
    if (denied !== (socketOk === false)) {
      socketOk = !denied;
      if (denied) log({ level: 'error', msg: 'cmux socket denied. Run the server inside a cmux workspace, or set CMUX_SOCKET_PASSWORD (cmux Settings > socket control password).' });
    }
    if (denied) { rosterFresh = true; broadcast(); return; }
    applyCmux(state, ws, rows);
    // A tab cmux restored without a terminal is not an agent. Ask once when a tab is
    // first seen; sampleFooters() keeps asking, so a tab opened later joins the ranch.
    for (const a of state.agents.values()) {
      if (a.ref && a.hollow === undefined) markHollow(state, a.workspaceId, isHollow(await cmux.readScreen(a.ref, 4)));
    }
    // Link every workspace to the Claude session actually running in its terminal.
    // This is what makes clicking a Pokemon reliably show its conversation.
    await linkSessions(state);
    await linkCodex(state);
    // cmux always lists this server's own tab, so an empty list is cmux not answering,
    // never "everything was closed". Only a real list may retire a session.
    if (ws.length) {
      if (roster.observe(rosterEntries(state.agents.values()), { fresh: rosterFresh })) state.version++;
      rosterFresh = false;
    } else rosterFresh = true;
    if (state.version !== lastVersion) { lastVersion = state.version; broadcast(); }
    else notifyTick();          // the tick that closes a settle window changes nothing
    syncWatchers();
    await sampleUsage();
    await sampleFooters();
    await sampleCodex();
    await sampleCrons();
    sampleAuth();               // not awaited: it is subprocesses, and rare
  } catch (e) { log({ level: 'error', where: 'poll', err: String(e) }); }
}
setInterval(poll, 3000);
poll();
try { fs.watch(cmux.sessionJsonPath, () => setTimeout(poll, 150)); } catch {}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}
// True once the composer of `ref` reads empty. The screen is a snapshot, and Claude
// Code needs a moment to take a long paste, so this looks a few times before deciding.
// The box once the message has gone: { empty, queued }. `queued` means Claude Code
// was mid-turn and took the message for later, which the panel says instead of "sent".
async function composerEmpty(ref) {
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 250));
    const scr = await cmux.readScreen(ref, READ_LINES);
    if (!scr.ok) return { empty: false, queued: false };   // could not look: not evidence of failure
    if (!pendingPrompt(scr.stdout) && !draftOnScreen(scr.stdout)) return { empty: true, queued: queuedOnScreen(scr.stdout) };
    if (pendingPrompt(scr.stdout)) return { empty: false, queued: false };
  }
  // Still text: Claude Code paints a suggestion into a box the moment it is empty,
  // which is exactly when a discard has just worked or a short turn has just ended.
  // Ask the pane before calling that text stuck.
  if ((await cmux.probeDraft(ref)).ghost) return { empty: true, queued: false };
  return { empty: false, queued: false };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Resolve an agent's transcript, best evidence first:
//   1. the session id off the running claude process on that workspace's tty (exact)
//   2. a hook that linked this workspace to a session (exact, but lost on restart)
//   3. the newest transcript in the repo (a guess; only safe when it is the only agent)
// Which pens are running Codex, and which Codex conversation each one is having.
//
// This is the same idea as linkSessions() and it needs different evidence. A Claude
// process carries `--session-id` on its command line; a Codex process carries nothing,
// but holds a lock file named after its session from the moment the pane opens. That
// makes the link EXACT, which matters for the reason AGENTS.md gives at length: the
// alternative is guessing the newest file in the repo, and two Codex pens in one repo
// would then show each other's conversation.
//
// Holding that lock is also what proves a pen is a Codex pen, which is better than
// waiting for the round-robin footer read to notice.
async function linkCodex(state, { force = false } = {}) {
  const byTty = await codexByTty({ force });
  for (const a of state.agents.values()) {
    const hit = a.tty && !a.hollow ? byTty.get(normalizeTty(a.tty)) : null;
    if (!hit) { if (a.engine === 'codex') a.codexTranscript = null; continue; }
    if (a.engine !== 'codex') { a.engine = 'codex'; state.version++; }
    a.codexSessionId = hit.sessionId;
    a.procPid = hit.pid;
    a.codexTranscript = hit.path && fs.existsSync(hit.path) ? hit.path : null;
  }
}
const normalizeTty = (t) => String(t || '').replace(/^\/dev\//, '');

function transcriptFor(a) {
  // A Codex pen never has a Claude transcript, and the fallbacks below would hand it
  // the newest Claude session in the same folder - another agent's conversation.
  if (a?.engine === 'codex') return a.codexTranscript || null;
  if (a?.procTranscript && fs.existsSync(a.procTranscript)) return a.procTranscript;
  if (a?.transcriptPath && fs.existsSync(a.transcriptPath)) return a.transcriptPath;
  if (a?.rawDir) return findNewestTranscript(a.rawDir);
  return null;
}

// A Codex pen's panel. Same answer shape as the Claude path, read from Codex's own
// rollout file - and the link is exact, so it is never `ambiguous`. Codex has no
// Native questions and approvals are read from the live pane just as for Claude.
async function codexAgent(a) {
  // A pane that has only just opened holds its lock and has written nothing yet, so
  // one fresh look before reporting no conversation.
  if (!a.codexTranscript) await linkCodex(state, { force: true });
  const tp = a.codexTranscript || null;
  const tail = tp ? parseCodexTail(tp)
                  : { recentTools: [], lastQuestion: null, title: null,
                      model: null, contextTokens: null, contextWindow: null, permissionMode: null };
  const messages = tp ? parseCodexConversation(tp) : [];
  // Codex RECORDS the size of its own context window, so this is measured at both
  // ends. The Claude side has to infer the denominator from the model's name.
  const contextPct = tail.contextTokens != null && tail.contextWindow
    ? Math.round((tail.contextTokens / tail.contextWindow) * 100) : null;
  const scr = await cmux.readScreen(a.ref, READ_LINES);
  const lines = scr.ok ? pendingPrompt(scr.stdout) : null;
  const pending = lines ? { screen: lines, ask: parseAsk(lines) } : null;
  return { recentTools: tail.recentTools, lastQuestion: null, title: tail.title,
           model: tail.model || a.model || null, contextPct,
           contextTokens: tail.contextTokens, permissionMode: tail.permissionMode,
           messages, pending, transcriptPath: tp, engine: 'codex',
           linked: !!tp, linkedBy: tp ? 'process' : null,
           sessionId: a.codexSessionId || null, ambiguous: false };
}

const terminalBusy = new Set();

async function deliverMessage(a, text) {
  const reply = (status, body) => ({ status, body });
  if (!a?.ref) return reply(400, { error: 'agent has no cmux ref' });
  // Guard: only type into a terminal that is actually a live Claude composer.
  // See src/server/screen.js - the window has to be deep enough that an unsent
  // draft cannot push the prompt out of it, and the reason has to say what is
  // wrong. A screen we cannot read leaves the reply queued.
  if (typeof text !== 'string' || !text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return reply(400, { error: 'Send a nonempty message without terminal control characters.' });
  const scr = await cmux.readScreen(a.ref, READ_LINES);
  if (!scr.ok) return reply(409, { error: "Waiting for the agent terminal to become available." });
  if (a.engine === 'codex' && /esc to interrupt/i.test(scr.stdout)) return reply(409, { error: "Queued until the current turn finishes." });
  if (scr.ok) {
    const gate = inputBoxState(scr.stdout);
    // Text in the box may be a suggestion Claude Code painted in an EMPTY box,
    // which read-screen cannot tell from a draft. Ask the pane (probeDraft):
    // a suggestion is typed over, a real draft is refused, and an unverified
    // probe asks for a refreshed screen instead of claiming the tab is frozen.
    if (!gate.ok) {
      const probe = gate.draft ? await cmux.probeDraft(a.ref) : null;
      const act = boxAction(gate, probe);
      if (!act.send) {
        log({ level: 'warn', where: 'send', ws: a.ref, refused: act.reason, frozen: !!act.frozen });
        // An uncertain probe must not offer destructive draft actions.
        return reply(409, { error: act.reason, screen: scr.stdout,
          stuck: act.frozen || act.uncertain ? undefined : gate.draft, frozen: !!act.frozen });
      }
    }
  }
  // Neither result used to be looked at, so a send cmux refused still came back
  // "ok", the box emptied, and the message was simply gone.
  const typed = await cmux.send(a.ref, text);
  if (!typed.ok) {
    log({ level: 'warn', where: 'send', ws: a.ref, failed: 'type', err: typed.stderr });
    return reply(502, { error: `The message may be partly typed: ${typed.stderr || 'terminal write failed'}. Review Terminal controls before retrying.` });
  }
  // Submit once. An uncertain read must not confirm a newly opened picker.
  {
    await new Promise(r => setTimeout(r, 150));
    const hit = await cmux.sendKey(a.ref, 'enter');
    if (!hit.ok) {
      log({ level: 'warn', where: 'send', ws: a.ref, failed: 'enter', err: hit.stderr });
      return reply(502, { error: 'typed, but Enter did not reach that tab — open it and press Enter' });
    }
    const box = await composerEmpty(a.ref);
    if (box.empty) return reply(200, { ok: true, queued: box.queued });
  }
  log({ level: 'warn', where: 'send', ws: a.ref, failed: 'stuck' });
  return reply(502, { error: 'Submission could not be verified. Your message is saved. Review Terminal controls before pressing Enter or retrying.' });

}
const outbox = createOutbox(path.join(root, 'data', 'reply-outbox.json'), async row => {
  const a = state.agents.get(row.ws);
  if (!a?.ref || terminalBusy.has(row.ws)) return { status: 409, body: { error: 'Waiting for the agent.' } };
  const session = a.codexSessionId || a.procSessionId || a.sessionId;
  if (!session) return { status: 409, body: { error: 'Waiting to identify the conversation.' } };
  if (row.session && row.session !== session) return { status: 409, body: { error: 'Waiting for the original conversation to return.' } };
  terminalBusy.add(row.ws);
  try { return await deliverMessage(a, row.text); } finally { terminalBusy.delete(row.ws); }
}, ws => send({ type: 'thread', ws }));
setInterval(() => outbox.tick().catch(e => log({ level: 'error', where: 'outbox', err: String(e) })), 2000);

const terminalIO = { read: cmux.readScreen, key: cmux.tap, write: cmux.sendLiteral, sleep: ms => new Promise(r => setTimeout(r, ms)) };
// Seed the config and build any layout that is missing or older than it, BEFORE the
// first request. A clone has neither, and serving a 404 for town-5.json leaves the
// client staring at an empty field with nothing to explain it.
// This MUST stay above the createServer call: tests/local-http.test.js slices the file
// from that line and evaluates the rest inside a `new Function`, which is not a module
// and cannot hold a top-level await. Do not name that line here either; the test finds
// it with indexOf and would slice from this comment instead.
ensureRepoConfig(root);
const built = await buildStaleTowns(root, log);
if (built.length) log({ level: 'info', where: 'town.build', msg: `built ${built.join(', ')}` });

const server = http.createServer(async (req, res) => {
  let releaseTerminal = null;
  try {
    if (!localRequestAllowed(req.headers, req.socket.localPort)) {
      return sendJson(res, 403, { error: 'localhost requests from this app only' });
    }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'state', ...snapshot(state), socketOk, usage, crons, restore: roster.lost() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // The desktop app subscribes here and posts whatever arrives. Nothing else should:
    // two listeners means two banners for one event.
    if (u.pathname === '/api/notify-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      notifyClients.add(res);
      req.on('close', () => notifyClients.delete(res));
      return;
    }
    if (u.pathname === '/api/ash') {
      const limit = Math.min(200, Number(u.searchParams.get('limit')) || 50);
      return sendJson(res, 200, { entries: readAsh(root, limit) });
    }
    // The auth strip. GET reads the last sample (?refresh=1 takes a new one first);
    // POST opens a cmux tab running the sign-in command for one lapsed login, since
    // every one of those needs a browser and a person.
    if (u.pathname === '/api/auth' && req.method === 'GET') {
      if (u.searchParams.get('refresh')) await sampleAuth(true);
      return sendJson(res, 200, { auth });
    }
    if (u.pathname === '/api/auth' && req.method === 'POST') {
      const { action, id } = JSON.parse(await readBody(req));
      const row = (auth?.rows || []).find(r => r.id === id);
      if (action !== 'login' || !row) return sendJson(res, 400, { error: 'unknown login' });
      if (!row.fix) return sendJson(res, 400, { error: 'no sign-in command for this one' });
      // A previous OAuth attempt may have failed or been cancelled. Allow a fresh
      // attempt; the button disables itself while this launch request is in flight.
      const result = await startLogin(row, cmux);
      if (result.ok) { authLogins.set(id, { ref: result.ref, at: Date.now() }); authAt = 0; }
      log({ level: 'info', where: 'auth.login', id, ok: result.ok });
      return sendJson(res, result.ok ? 200 : 502, result);
    }
    if (u.pathname === '/api/crons') { cronsAt = 0; await sampleCrons(); return sendJson(res, 200, { crons }); }
    if (u.pathname === '/api/cron' && req.method === 'POST') {
      const { action, label, name, schedule, command, dir } = JSON.parse(await readBody(req));
      await sampleCrons();
      const job = crons.find(c => c.label === label);
      log({ level: 'info', where: 'cron', action, label: label || name });
      let r;
      if (action === 'create') r = await createCron({ name, schedule, command, dir });
      else if (action === 'run') r = await runCron(job);
      else if (action === 'delete') r = await deleteCron(job);
      else r = { error: 'unknown cron action' };
      // The job list on screen is now stale whatever happened, so re-read it at once
      // rather than leaving a deleted job sitting in the pen for up to a minute.
      cronsAt = 0;
      await sampleCrons();
      broadcast();
      return sendJson(res, r.error ? 400 : 200, { ...r, crons });
    }
    if (u.pathname === '/api/cronlog') {
      await sampleCrons();
      const job = crons.find(c => c.label === u.searchParams.get('label'));
      if (!job?.logPath) return sendJson(res, 404, { error: 'no log for that job' });
      let text = '';
      try {
        const fd = fs.openSync(job.logPath, 'r');
        const size = fs.fstatSync(fd).size;
        const want = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        fs.closeSync(fd);
        text = buf.toString('utf8');
        if (size > want) text = text.slice(text.indexOf('\n') + 1);
      } catch (e) { return sendJson(res, 404, { error: String(e) }); }
      return sendJson(res, 200, { label: job.label, path: job.logPath, text });
    }
    if (u.pathname === '/api/state') return sendJson(res, 200, { ...snapshot(state), socketOk, usage, crons, restore: roster.lost() });
    if (u.pathname === '/api/hook' && req.method === 'POST') {
      const body = await readBody(req);
      try { applyHook(state, JSON.parse(body)); broadcast(); } catch (e) { log({ level: 'warn', where: 'hook', err: String(e) }); }
      return sendJson(res, 200, { ok: true });
    }
    if (u.pathname === '/api/agent') {
      const a = state.agents.get(u.searchParams.get('ws'));
      if (!a) return sendJson(res, 404, { error: 'no such agent' });
      if (a.engine === 'codex') return sendJson(res, 200, { ...await codexAgent(a), outbox: outbox.list(a.workspaceId) });
      // Only the newest-in-repo guess can be wrong. If we fall back to it while other
      // agents share the directory, say so rather than showing someone else's chat.
      // A process- or hook-linked path is exact, so it is never ambiguous.
      let exact = a.procTranscript || (a.transcriptPath && fs.existsSync(a.transcriptPath) ? a.transcriptPath : null);
      if (!exact) {
        // The cached process table can be up to 5s stale, and a just-started agent
        // will not be in it. Pay for one fresh read before giving up on it.
        await linkSessions(state, { force: true });
        exact = a.procTranscript || null;
      }
      const sharing = [...state.agents.values()].filter(x => x.dir && x.dir === a.dir).length;
      const ambiguous = !exact && sharing > 1;
      const tp = exact || (ambiguous ? null : transcriptFor(a));
      const tail = tp ? parseTail(tp) : { recentTools: [], lastQuestion: null, title: null };
      const messages = tp ? parseConversation(tp) : [];
      let footer = { model: null, contextPct: null, permissionMode: null };
      // What it is waiting for lives on the screen and nowhere else: an unanswered
      // AskUserQuestion is not written to the transcript until it is answered. The
      // same read that gets the footer gets the question, so this costs nothing.
      let pending = null;
      if (a.ref) {
        const scr = await cmux.readScreen(a.ref, 60);
        if (scr.ok) {
          footer = cmux.parseFooter(scr.stdout);
          // Asked of every screen, not only one already marked BLOCKED. The status
          // comes from a hook, and a picker is drawn before that hook is delivered:
          // gating on it returned "nothing pending" while the question was plainly on
          // the pane. The screen is the evidence, and it is already read.
          const lines = pendingPrompt(scr.stdout);
          // The parsed picker is what the panel renders and can answer. The raw pane
          // travels with it as the fallback for a prompt shaped some other way, so a
          // question the parser does not recognise is still shown, not hidden.
          if (lines) pending = { screen: lines, ask: parseAsk(lines) };
        }
      }
      // Spreading the footer over the tail used to blank the model and the mode
      // whenever the screen came back without them. Merge, do not overwrite.
      const facts = cmux.agentFacts(tail, footer);
      return sendJson(res, 200, { ...tail, ...facts, messages, pending, outbox: outbox.list(a.workspaceId), transcriptPath: tp,
        linked: !!exact, linkedBy: a.procTranscript ? 'process' : (exact ? 'hook' : null),
        sessionId: a.procSessionId || a.sessionId || null, ambiguous });
    }
    if (u.pathname === '/api/screen') {
      const a = state.agents.get(u.searchParams.get('ws'));
      if (!a?.ref) return sendJson(res, 404, { error: 'no ref' });
      const scr = await cmux.readScreen(a.ref, 50);
      return sendJson(res, scr.ok ? 200 : 502, scr.ok ? { screen: scr.stdout } : { error: scr.stderr || 'Could not read the terminal' });
    }
    if (u.pathname === '/api/archive' || u.pathname === '/api/search') {
      const cfg = ensureRepoConfig(root);
      let repoDirs = cfg.repos.map(r => ({
        dir: r.dir,
        sign: r.sign || path.basename(r.dir),
      }));
      const only = u.searchParams.get('dir');
      if (only) repoDirs = repoDirs.filter(r => normalizeDir(r.dir) === normalizeDir(only));
      if (u.pathname === '/api/search') {
        const q = u.searchParams.get('q') || '';
        const t0 = Date.now();
        const results = searchSessions(repoDirs, q);
        log({ level: 'info', where: 'search', q, hits: results.length, ms: Date.now() - t0 });
        return sendJson(res, 200, { results, scope: only ? 'repo' : 'all' });
      }
      return sendJson(res, 200, { sessions: listArchive(repoDirs) });
    }
    if (u.pathname === '/api/transcript') {
      const tp = u.searchParams.get('path') || '';
      if (!isTranscriptPath(tp)) return sendJson(res, 403, { error: 'not a transcript path' });
      return sendJson(res, 200, { messages: readConversation(tp, 200) });
    }
    if (u.pathname === '/api/sessions') {
      return sendJson(res, 200, { sessions: listSessions(u.searchParams.get('dir') || '') });
    }
    if (u.pathname === '/api/act' && req.method === 'POST') {
      const { action, ws, text, dir, sessionId, engine, optionIndex, optionLabel, question, screen, key, messageId } = JSON.parse(await readBody(req));
      // One terminal transaction at a time, including across browser windows.
      if (['flush', 'discard', 'choose', 'terminal'].includes(action)) {
        if (terminalBusy.has(ws)) return sendJson(res, 409, { error: 'An action is already in progress for this agent. Wait for it to finish.' });
        terminalBusy.add(ws);
        releaseTerminal = () => terminalBusy.delete(ws);
      }
      const a = state.agents.get(ws);
      log({ level: 'info', where: 'act', action, ws: a?.ref || ws });
      if (action === 'send') {
        if (!a?.ref) return sendJson(res, 400, { error: 'Agent is not available.' });
        if (typeof text !== 'string' || !text.trim() || text.length > 100000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return sendJson(res, 400, { error: 'Send a nonempty message without terminal control characters.' });
        const session = a.codexSessionId || a.procSessionId || a.sessionId;
        if (!session) return sendJson(res, 409, { error: 'Still identifying this conversation. Your reply remains saved.' });
        const row = outbox.add(ws, text, messageId, session);
        return sendJson(res, 200, { ok: true, queued: true, id: row.id });
      }
      if (action === 'cancel-reply') return sendJson(res, 200, { ok: outbox.cancel(ws, messageId) });
      // A draft stuck in a pane's box, dealt with from the panel. Claude Code puts a
      // queued message into the box when Up is pressed and then never sends it, which
      // left the user retyping into a tab for every refusal. Both look first: the draft
      // has to still be there, and a pane showing a question is not a pane to type at.
      if (action === 'flush' || action === 'discard') {
        if (!a?.ref) return sendJson(res, 400, { error: 'agent has no cmux ref' });
        const scr = await cmux.readScreen(a.ref, READ_LINES);
        if (!scr.ok) return sendJson(res, 500, { error: 'could not read the terminal' });
        const gate = inputBoxState(scr.stdout);
        if (typeof text !== 'string' || (gate.draft && gate.draft !== text)) return sendJson(res, 409, { error: 'The terminal draft changed. Review it before sending or discarding.', stuck: gate.draft });
        if (gate.ok) return sendJson(res, 200, { ok: true, nothing: true });   // already gone
        if (!gate.draft) return sendJson(res, 409, { error: gate.reason });
        // A painted suggestion is nothing to send and nothing to clear; Enter on it
        // is not safe. Verify the probe before clearing or submitting anything.
        const probe = await cmux.probeDraft(a.ref);
        const act = boxAction(gate, probe);
        if (act.send) return sendJson(res, 200, { ok: true, nothing: true });   // a ghost: nothing to clear
        if (act.frozen || act.uncertain) return sendJson(res, 409, { error: act.reason, frozen: !!act.frozen });
        log({ level: 'info', where: action, ws: a.ref, draft: gate.draft.slice(0, 60) });
        if (action === 'flush') {
          const hit = await cmux.sendKey(a.ref, 'enter');
          if (!hit.ok) return sendJson(res, 502, { error: 'Enter did not reach that tab — open it' });
        } else {
          // One backspace per character, plus a few: a backspace on an empty box does
          // nothing, and the draft on screen may be a character or two short of what
          // is in the box once the terminal has folded it.
          const n = gate.draft.length + 4;
          for (let k = 0; k < n; k++) {
            const r = await cmux.tap(a.ref, 'backspace');
            if (!r.ok) return sendJson(res, 502, { error: 'could not clear that tab — open it' });
          }
        }
        const box = await composerEmpty(a.ref);
        if (box.empty) return sendJson(res, 200, { ok: true, queued: box.queued });
        return sendJson(res, 502, { error: `the text is still sitting in that tab — open it` });
      }
      // Answer an AskUserQuestion by driving its terminal picker. This types into a
      // live interactive prompt, so it verifies the picker is on screen AND that the
      // option we mean is the one listed at that number before pressing anything.
      if (action === 'choose' || action === 'terminal') {
        if (!a?.ref) return sendJson(res, 400, { error: 'agent has no cmux ref' });
        const result = action === 'choose'
          ? await chooseOption(a.ref, { optionIndex, optionLabel, question }, terminalIO)
          : await terminalAction(a.ref, { screen, key, text }, terminalIO);
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (action === 'open') {
        if (a?.ref) await cmux.selectWorkspace(a.ref);
        const { exec } = await import('node:child_process');
        exec('open -a cmux');
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'kill') {
        if (!a?.ref) return sendJson(res, 400, { error: 'no ref' });
        await cmux.closeWorkspace(a.ref);
        setTimeout(poll, 500);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'resume') {
        // A Codex session resumes in Codex. The engine rides on the session row the
        // PC or archive handed the client, and the id is checked before it is run.
        let command;
        try { command = resumeCommand(engine, sessionId); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        await cmux.newWorkspace(engine === 'codex' ? '◑ resume codex' : '◑ resume', dir, command);
        setTimeout(poll, 1500);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 400, { error: 'unknown action' });
    }
    // The "cmux restarted" checklist. Resume opens each ticked session in its own new
    // tab, the same way the PC does; dismiss forgets them. take() hands a session out
    // once, so a double click cannot start two processes on one conversation.
    if (u.pathname === '/api/restore' && req.method === 'POST') {
      const { action, ids } = JSON.parse(await readBody(req));
      if (!Array.isArray(ids)) return sendJson(res, 400, { error: 'ids required' });
      if (action === 'dismiss') {
        const n = roster.dismiss(ids);
        broadcast();
        return sendJson(res, 200, { ok: true, dismissed: n });
      }
      if (action !== 'resume') return sendJson(res, 400, { error: 'unknown restore action' });
      const failed = [];
      let resumed = 0;
      for (const s of roster.take(ids)) {
        let command;
        try { command = resumeCommand(s.engine, s.sessionId); }
        catch (e) { failed.push({ sessionId: s.sessionId, error: e.message }); continue; }
        if (!fs.existsSync(s.dir)) { failed.push({ sessionId: s.sessionId, error: `${s.dir} no longer exists` }); continue; }
        const r = await cmux.newWorkspace(s.engine === 'codex' ? '◑ resume codex' : '◑ resume', s.dir, command);
        if (r.ok) resumed++;
        else {
          roster.giveBack([s]);
          failed.push({ sessionId: s.sessionId, error: r.stderr || 'new-workspace failed' });
        }
        await new Promise(done => setTimeout(done, 300));   // one tab at a time, not a burst
      }
      log({ level: failed.length ? 'warn' : 'info', where: 'restore', resumed, failed });
      setTimeout(poll, 1500);
      broadcast();
      return sendJson(res, failed.length && !resumed ? 502 : 200, { ok: resumed > 0 || !failed.length, resumed, failed });
    }
    // Ask across everything. This is the ONE feature here that spends tokens, so it
    // runs through the Claude Code CLI on the Max subscription, never a raw API key.
    if (u.pathname === '/api/ask' && req.method === 'POST') {
      const { question, dirs } = JSON.parse(await readBody(req));
      if (!question) return sendJson(res, 400, { error: 'question required' });
      const cfg = ensureRepoConfig(root);
      let repoDirs = cfg.repos.map(r => ({
        dir: r.dir,
        sign: r.sign || path.basename(r.dir),
      }));
      // Only answer about what the user can actually see, when they say so.
      if (Array.isArray(dirs) && dirs.length) {
        const want = new Set(dirs.map(normalizeDir));
        repoDirs = repoDirs.filter(r => want.has(normalizeDir(r.dir)));
      }
      const visible = Array.isArray(dirs) && dirs.length
        ? new Set(dirs.map(normalizeDir)) : null;

      // Ground the answer. Pikachu reads the sessions first (src/server/recall.js):
      // every live agent's opening ask and newest turns, plus the past sessions that
      // mention the question. All local; only the call below spends tokens.
      const agents = [...state.agents.values()]
        .filter(a => a.status !== 'FAINTED')
        .filter(a => !visible || (a.dir && visible.has(a.dir)));
      const found = recall({ question, agents, transcriptFor, repoDirs });
      const live = found.live, hits = found.history;

      const prompt =
        `You are answering a question about a developer's Claude Code agents: the ones\n` +
        `running right now and the past sessions in their repos. The context below was\n` +
        `gathered by reading their transcripts. Answer in at most 10 short lines. Be\n` +
        `concrete, and say which agent or session each fact comes from (its title, in\n` +
        `quotes). If the context does not contain the answer, say so plainly rather\n` +
        `than guessing.\n\n` +
        `${found.text}\n\n` +
        `QUESTION: ${question}`;

      const { execFile } = await import('node:child_process');
      const answer = await new Promise((resolve) => {
        // Strip the cmux identity: otherwise this child's Claude hooks report the
        // SERVER's workspace, attaching a phantom session to it and reclassifying
        // the service as an agent.
        const env = { ...process.env };
        delete env.CMUX_WORKSPACE_ID; delete env.CMUX_SURFACE_ID;
        delete env.CMUX_TAB_ID; delete env.CMUX_PANEL_ID;
        const child = execFile(claudeBin(),
          ['-p', prompt, '--output-format', 'text'],
          { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, env },
          (err, stdout, stderr) => {
            if (err && !stdout) return resolve({ error: (stderr || String(err)).slice(0, 400) });
            resolve({ text: (stdout || '').trim() });
          });
        child.stdin?.end();
      });
      log({ level: 'info', where: 'ask', q: question.slice(0, 80), ok: !answer.error,
            terms: found.terms, live: live.length, hits: hits.length, chars: found.text.length });
      // Write it down before replying. An answer the user cannot get back is lost work.
      // The sessions consulted go with it, so the panel can open what Ash read.
      const grounding = { live: live.length, hits: hits.length, terms: found.terms,
                          sessions: found.sessions };
      const row = appendAsh(root, {
        question,
        answer: answer.error ? null : answer.text,
        error: answer.error || null,
        grounding,
        repos: repoDirs.map(r => r.sign),
      });
      return sendJson(res, answer.error ? 500 : 200, answer.error
        ? { error: answer.error, id: row.id }
        : { answer: answer.text, id: row.id, ts: row.ts, grounding });
    }
    // Attachments: the browser posts raw bytes, we save them next to the repo and
    // hand back an absolute path. Claude Code reads images and files by path, so the
    // path is what actually gets sent to the agent.
    if (u.pathname === '/api/upload' && req.method === 'POST') {
      try {
        const contents = await readUpload(req);
        const result = saveUpload(path.join(root, 'uploads'), req.headers['x-filename'] || 'paste.png', contents);
        log({ level: 'info', where: 'upload', file: result.path, bytes: result.bytes });
        return sendJson(res, 200, result);
      } catch (error) {
        if (error.status) return sendJson(res, error.status, { error: error.message });
        throw error;
      }
    }
    // The Finder dialog for that folder. The browser cannot produce an absolute path,
    // so the server asks macOS on its behalf. It answers slowly by design: the request
    // is open for as long as the dialog is.
    if (u.pathname === '/api/pick' && req.method === 'POST') {
      const cfg = ensureRepoConfig(root);
      // Open next to the repos that are already on the field, since the next one is
      // almost always their neighbour.
      const last = cfg.repos[cfg.repos.length - 1];
      const start = last ? path.dirname(last.dir) : (process.env.HOME || '/');
      const r = await chooseFolder(fs.existsSync(start) ? start : null);
      log({ level: 'info', where: 'repo.pick', ...r });
      return sendJson(res, 200, r);
    }
    // Add a repo to the field: validate the folder, append it to config, rebuild every
    // layout. The client then reloads the town file and the new plot appears.
    if (u.pathname === '/api/repo' && req.method === 'POST') {
      const { dir, archetype } = JSON.parse(await readBody(req));
      if (!dir) return sendJson(res, 400, { error: 'dir required' });
      const full = dir.replace(/^~/, process.env.HOME || '');
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
        return sendJson(res, 400, { error: 'no such folder: ' + full });
      }
      const cfgPath = repoConfigPath(root);
      // expand:false: this config is written back, and the file must keep its tildes.
      const cfg = ensureRepoConfig(root, process.env, { expand: false });
      // The raw list may hold tildes, so expand before comparing or a duplicate slips in.
      const already = cfg.repos.find(r => normalizeDir(expandHome(r.dir)) === normalizeDir(full));
      if (already) return sendJson(res, 409, { error: 'already on the field: ' + already.dir });
      const sizes = JSON.parse(fs.readFileSync(path.join(root, 'public/art/buildings/sizes.json'), 'utf8'));
      const kinds = Object.keys(sizes).filter(k => k !== 'tent');
      const kind = kinds.includes(archetype) ? archetype : kinds[cfg.repos.length % kinds.length];
      cfg.repos.push({ dir: full, archetype: kind, plot: cfg.repos.length });
      cfg.repos.forEach((r, i) => { r.plot = i; });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

      const { execFile } = await import('node:child_process');
      const build = (n) => new Promise((done) => execFile(process.execPath,
        [path.join(root, 'tools/build-town.js'), String(n)], { cwd: root }, () => done()));
      for (const n of [3, 4, 5]) await build(n);
      log({ level: 'info', where: 'repo.add', dir: full, archetype: kind });
      return sendJson(res, 200, { ok: true, dir: full, archetype: kind, repos: cfg.repos.length });
    }
    // What the NEW AGENT form offers: the engines installed here and the models each
    // one will take. The Codex list is read from the CLI's own cache every time, so a
    // Codex update changes the picker without changing this file.
    if (u.pathname === '/api/engines') return sendJson(res, 200, catalog());
    if (u.pathname === '/api/spawn' && req.method === 'POST') {
      const { dir, prompt, engine = 'claude', model = null } = JSON.parse(await readBody(req));
      if (!dir || typeof prompt !== 'string' || !prompt.trim()) return sendJson(res, 400, { error: 'dir and prompt required' });
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) return sendJson(res, 400, { error: 'Send a task without terminal control characters.' });
      if (!path.isAbsolute(dir)) return sendJson(res, 400, { error: 'dir must be absolute' });
      // The model comes from a <select> in a page and is about to become part of a
      // shell command line. spawnCommand refuses anything not shaped like a model and
      // quotes what is left; nothing else may build that string.
      let command;
      try { command = spawnCommand(engine, model); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      try { fs.mkdirSync(dir, { recursive: true }); }               // "new folder/repo" from the ranger
      catch (e) { return sendJson(res, 500, { error: `mkdir failed: ${e.message}` }); }
      log({ level: 'info', where: 'spawn', dir, engine, model });
      const r = await cmux.newWorkspace(`◑ new ${engine === 'codex' ? 'codex' : 'agent'}`, dir, command);
      if (!r.ok) return sendJson(res, 500, { error: r.stderr || 'new-workspace failed' });
      if (!r.ref) return sendJson(res, 500, { error: 'cmux did not return a workspace ref' });
      await poll();
      const agent = [...state.agents.values()].find(a => a.ref === r.ref);
      if (agent) {
        terminalBusy.add(agent.workspaceId);
        releaseTerminal = () => terminalBusy.delete(agent.workspaceId);
      }
      const result = await startAgent(r.ref, prompt, {
        read: cmux.readScreen, type: cmux.send, key: cmux.press,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      });
      log({ level: result.ok ? 'info' : 'error', where: 'spawn', ref: r.ref,
        msg: result.ok ? 'task sent' : result.error });
      // Keep STARTING visible and retain the task/attachments if delivery fails.
      // Returning ok as soon as the workspace opens used to hide every send failure.
      return sendJson(res, result.ok ? 200 : 502, { ...result, ref: r.ref,
        ...(result.ok ? {} : { error: `The new agent opened, but ${result.error} Review its Terminal controls before launching again. Your task is still in this form.` }) });
    }
    // static
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const f = path.join(PUB, path.normalize(p));
    if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      // No caching: this is a local dev tool and a stale module is a phantom bug.
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
      });
      return fs.createReadStream(f).pipe(res);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log({ level: 'error', where: 'http', url: req.url, err: String(e) });
    try { sendJson(res, 500, { error: String(e) }); } catch {}
  } finally { releaseTerminal?.(); }
});
server.listen(PORT, '127.0.0.1', () => log({ level: 'info', msg: `PokeClaude on http://localhost:${PORT}` }));
