import { api, state, onThread } from './net.js';
import { elapsed } from './fmt.js';
import { isHidden } from './filter.js';
import { summarizeTools } from './summarize.js';
import { md } from './markdown.js';
import { allJobs, untilText, agoText, CRON_DIR } from './crons.js';
import { makeDrafts } from './drafts.js';
import { makeAttachments, filesFromDrop } from './attach.js';
import { threadKey, atBottom, nextTop, openTop } from './thread.js';
import { sessionReport } from './report.js';
import { makeArm, ARM_WINDOW } from './arm.js';
import { resolvePick, modelsFor, remember, remembered } from './engines.js';
import { restoreModel, restoreKey } from './restore.js';

const body = document.getElementById('panel-body');

const input = document.getElementById('composer-input');
const sendBtn = document.getElementById('composer-send');
const backBtn = document.getElementById('panel-back');
const clipBtn = document.getElementById('composer-clip');
const fileInput = document.getElementById('composer-file');
const attachEl = document.getElementById('attachments');

// Attachments are uploaded to disk and sent to the agent as absolute PATHS, because
// that is what Claude Code can actually open. Chips show what is staged. There are two
// trays, the composer and the NEW AGENT form, and both build their message with the
// same module so an attachment means the same thing wherever it was added.
let attached = makeAttachments();
const attachmentTrays = new Map();
let attachmentStore = null;
try { attachmentStore = window.localStorage; } catch {}
const spawnAttached = makeAttachments();

// One chip renderer for both trays: same markup, same class, same × to remove.
function drawChips(el, tray, after) {
  if (!el) return;
  el.innerHTML = tray.list().map((a, i) => `<span class="att">
    ${a.preview ? `<img src="${a.preview}" alt="">` : ''}
    <span title="${esc(a.path)}">${esc(a.name)}</span><b data-i="${i}">×</b></span>`).join('');
  el.querySelectorAll('b').forEach(b => {
    b.onclick = () => { tray.remove(Number(b.dataset.i)); drawChips(el, tray, after); after?.(); };
  });
}
const drawAttachments = () => drawChips(attachEl, attached);
function drawSpawnAttachments() {
  drawChips(body.querySelector('#sp-attachments'), spawnAttached, () =>
    body.querySelector('#sp-prompt')?.focus());
}

// Uploads land in whichever tray is on screen. An upload the server refused is
// reported and never staged, so a chip always stands for a file that exists.
async function stageFiles(files, target = null) {
  const t = target || activeTarget();
  if (!t) return;
  let staged = 0;
  for (const f of files) {
    if (!f) continue;
    const r = await api.upload(f).catch(() => ({ error: 'upload failed' }));
    if (r.error || !r.path) { toast(r.error || `could not attach ${f.name || 'that file'}`); continue; }
    if (t.tray.add({ path: r.path, name: r.name,
      preview: f.type?.startsWith('image/') ? URL.createObjectURL(f) : null })) staged++;
  }
  t.draw();
  t.focus();
  if (staged) toast(staged === 1 ? 'attached 1 file' : `attached ${staged} files`);
}
// The composer is disabled while the NEW AGENT form is open, so "can I attach here?"
// is a question about the view, not about the composer alone.
function activeTarget() {
  if (mode === 'spawn' && body.querySelector('#sp-prompt')) {
    return { tray: spawnAttached, draw: drawSpawnAttachments,
             focus: () => body.querySelector('#sp-prompt')?.focus() };
  }
  if (!input.disabled) {
    const tray = attached;
    return { tray, draw: () => { if (attached === tray) drawAttachments(); },
      focus: () => { if (attached === tray && !input.disabled) input.focus(); } };
  }
  return null;
}
// Drag and drop anywhere on the chat pane. Only accepts a drop while a conversation
// is open, since there would be nowhere to send the files otherwise.
const panelEl = document.getElementById('panel');
let dragDepth = 0;
const canDrop = (e) => !!activeTarget() && [...(e.dataTransfer?.types || [])].includes('Files');
panelEl.addEventListener('dragenter', (e) => {
  if (!canDrop(e)) return;
  e.preventDefault(); dragDepth++; panelEl.classList.add('dropping');
});
panelEl.addEventListener('dragover', (e) => { if (canDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
panelEl.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; panelEl.classList.remove('dropping'); }
});
// A drop that lit the panel up and then staged nothing used to say nothing about it,
// which reads exactly like an attachment that went through. Every way this can fail
// now says so out loud.
panelEl.addEventListener('drop', (e) => {
  dragDepth = 0; panelEl.classList.remove('dropping');
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  if (!activeTarget()) return toast('open a chat first, then drop the file');
  const files = filesFromDrop(e.dataTransfer);
  if (!files.length) return toast('that drop carried no file — try saving it first');
  stageFiles(files);
});
// A file dropped anywhere else must not navigate the page away from the app.
for (const ev of ['dragover', 'drop']) {
  window.addEventListener(ev, (e) => {
    if (!panelEl.contains(e.target) && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
}

clipBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { stageFiles([...fileInput.files]); fileInput.value = ''; });
input.addEventListener('paste', (e) => {
  const files = filesFromDrop(e.clipboardData);
  if (files.length) { e.preventDefault(); stageFiles(files); }
});

// The header's back button is the single way out of any subview. Each view says
// where "back" goes, so archived transcripts return to the archive, not the list.
let backTarget = null;
function setBack(fn, title) {
  backTarget = fn;
  backBtn.hidden = !fn;
  if (fn) backBtn.title = title || 'Back';
}
backBtn.addEventListener('click', () => { if (backTarget) backTarget(); });
const pill = document.getElementById('blocked-pill');
const toastEl = document.getElementById('toast');

let mode = 'queue';          // queue | agent | pc | spawn | crons
let current = null;          // selected actor
let pcRows = [], pcSel = 0, pcPlot = null;
let world = null, hooks = {};
let lastRenderKey = '';
const expanded = new Set();          // plot ids the user has opened; collapsed by default
// Orchestration view by default: one line per meaningful action instead of every
// raw tool call. Purely local formatting, no model involved.
let detailMode = false;
try { detailMode = localStorage.getItem('pc.detail') === '1'; } catch {}

export function init(w, h) { world = w; hooks = h; }
export const typing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
export const isModal = () => mode !== 'queue';

// The toast sits above the status bar, not under it. An error also stays up longer
// than a confirmation: the guard messages are whole sentences and you have to read one
// before you can act on it.
export function toast(msg, ms = 2600, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = kind;
  toastEl.style.display = 'block';
  clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.style.display = 'none', ms);
}
export const toastErr = (msg) => toast(msg, 6000, 'bad');

// Copy one agent's whole situation as plain text: which workspace, which transcript,
// which model, what it did last, what is on its terminal right now. Built for pasting
// into another Claude so it can see what happened without being told.
async function copySession(actor, detail) {
  const a = actor?.agent; if (!a) return;
  const scr = await api.screen(a.workspaceId).catch(() => null);
  const text = sessionReport({
    sign: actor.plot?.sign,
    species: actor.species ? actor.species[1].toUpperCase() : null,
    agent: a,
    detail: detail || {},
    screen: scr?.screen || '',
  });
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // A denied clipboard permission must not swallow the report. Fall back to the old
    // execCommand path, which works from inside a click handler without permission.
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toastErr('could not reach the clipboard — use RAW and copy by hand');
  }
  toast(`copied ${text.split('\n').length} lines about ${actor.plot?.sign || 'this agent'}`);
}
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sprite = ac => ac?.species ? `/art/pokemon/down/${ac.species[0]}.png` : '';

export function back() {
  mode = 'queue'; current = null; hooks.select?.(null); document.activeElement?.blur?.();
  renderQueue(true);
}

// ---------- the blocked strip + the chat ----------
// Every agent is in the strip, not only the blocked ones: you can start a
// conversation with anything that is running. Blocked ones sort to the front.
const RANK = { BLOCKED: 0, THINKING: 1, WORKING: 1, ASLEEP: 2, FAINTED: 3 };
export function renderQueue(force = false) {
  const all = [...world.actors.values()]
    .filter(a => a.agent && !isHidden(a.plot?.plot))     // hidden repos leave the list too
    .sort((x, y) => (RANK[x.agent.status] ?? 9) - (RANK[y.agent.status] ?? 9)
      || x.agent.since - y.agent.since);
  const blocked = all.filter(a => a.agent.status === 'BLOCKED' && a.agent.kind !== 'cron');
  pill.textContent = blocked.length;
  pill.className = blocked.length ? '' : 'zero';
  document.title = blocked.length ? `(${blocked.length}) PokeClaude` : 'PokeClaude';

  const key = all.map(a => a.id + a.agent.status + a.agent.since).join()
    + '|' + (current?.id || '') + '|' + mode + '|' + [...expanded].sort().join(',')
    + '|' + restoreKey(state.restore, restoreOff);
  if (!force && key === lastRenderKey) return;
  lastRenderKey = key;
  if (mode === 'queue') renderList(all);
}

const AGE = { BLOCKED: 0, THINKING: 1, WORKING: 1, ASLEEP: 2, SERVING: 2, FAINTED: 3 };

// Grouped by repo, because that is how the field is grouped. Repos with a blocked
// agent float to the top, and inside a repo the longest wait comes first.
function renderList(all) {
  if (current) return;
  setBack(null);
  body.classList.remove('term-mode');
  const byPlot = new Map();
  for (const ac of all) {
    const k = ac.plot.plot;
    if (!byPlot.has(k)) byPlot.set(k, { plot: ac.plot, agents: [] });
    byPlot.get(k).agents.push(ac);
  }
  const groups = [...byPlot.values()].map(g => {
    g.agents.sort((x, y) => (AGE[x.agent.status] ?? 9) - (AGE[y.agent.status] ?? 9)
      || x.agent.since - y.agent.since);
    g.blocked = g.agents.filter(a => a.agent.status === 'BLOCKED').length;
    g.oldest = Math.min(...g.agents.filter(a => a.agent.status === 'BLOCKED')
      .map(a => a.agent.since), Infinity);
    return g;
  }).sort((a, b) => (b.blocked > 0) - (a.blocked > 0) || a.oldest - b.oldest
    || a.plot.sign.localeCompare(b.plot.sign));

  const html = groups.map(g => {
    const open = expanded.has(g.plot.plot);
    const rows = !open ? '' : g.agents.map(ac => {
      const st = ac.agent.status;
      const isSvc = ac.agent.kind === 'service';
      const isCron = ac.agent.kind === 'cron';
      const age = isCron ? untilText(ac.agent.cron.next)
        : isSvc ? (ac.agent.ports?.length ? ':' + ac.agent.ports[0] : 'up')
        : st === 'BLOCKED' ? elapsed(Date.now() - ac.agent.since)
        : st === 'ASLEEP' ? 'idle' : st === 'FAINTED' ? 'gone' : 'running';
      const species = isCron ? ac.agent.cron.name
        : isSvc ? 'service' : (ac.species ? ac.species[1] : 'agent');
      const ag = ac.agent;
      const facts = isCron
        ? [ag.cron.schedule, ag.cron.project || null, CRON_NOTE[ag.cron.state] || null]
            .filter(Boolean).join('  ·  ')
        : [
        ag.branch ? `⑂ ${ag.branch}${ag.gitDirty ? '*' : ''}` : null,
        ag.model || null,
        ag.contextPct != null ? `${ag.contextPct}% ctx` : null,
      ].filter(Boolean).join('  ·  ');
      const hot = isCron ? BROKEN.has(ag.cron.state)
        : ag.contextPct != null && ag.contextPct >= 80;
      return `<div class="q-row st-row-${st}" data-id="${esc(ac.id)}">
        <span class="sp">${isSvc ? '<span class="svc-ico">▤</span>' : `<img src="${sprite(ac)}" alt="">`}</span>
        <span class="who"><b>${esc(species)}</b><span>${esc(
          (isCron ? ag.cron.desc : ag.title) || '')}</span>
          ${facts ? `<span class="facts ${hot ? 'hot' : ''}">${esc(facts)}</span>` : ''}</span>
        <span class="age ${st === 'BLOCKED' ? '' : 'ok'}">${esc(age)}</span></div>`;
    }).join('');
    return `<div class="repo-grp ${open ? 'open' : ''}">
      <div class="repo-hd" data-plot="${g.plot.plot}">
        <span class="caret">${open ? '▾' : '▸'}</span>
        <b>${esc(g.plot.sign)}</b>
        <span class="repo-n">${g.agents.length}</span>
        ${g.blocked ? `<span class="repo-b">${g.blocked}</span>` : ''}
        ${g.plot.dir === CRON_DIR ? '' :
          `<span class="repo-pc" data-pc="${g.plot.plot}" title="Past sessions">PC</span>`}
      </div>${rows}</div>`;
  }).join('');

  body.innerHTML = restoreCard() + (html || '<div class="empty">No agents running.</div>') +
    (world.unmapped.length ? `<div class="sec"><span class="lbl">NO PLOT</span>
      <div class="q">${world.unmapped.length} agent(s) are in folders with no plot.
      Add them to config/repos.json, then run npm run build:town.</div></div>` : '') +
    `<div class="btns"><button id="q-new" class="wide">N · NEW AGENT</button>
       <button id="q-archive">ARCHIVE</button>
       <button id="q-crons">CRONS${cronAlerts() ? ` <b class="cr-badge">${cronAlerts()}</b>` : ''}</button></div>`;

  body.querySelectorAll('.q-row').forEach(el => {
    el.onclick = () => {
      const ac = world.actors.get(el.dataset.id); if (!ac) return;
      if (ac.agent?.kind === 'cron') return openCrons(ac.agent.cron.label);
      openAgent(ac);
    };
  });
  body.querySelectorAll('.repo-hd').forEach(el => {
    el.onclick = (e) => {
      if (e.target.classList.contains('repo-pc')) {
        const p = hooks.town().plots.find(pp => pp.plot === Number(e.target.dataset.pc));
        if (p) openPC(p);
        return;
      }
      const id = Number(el.dataset.plot);
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      const top = body.scrollTop;
      renderQueue(true);
      body.scrollTop = top;                   // toggling must not jump the list
    };
  });
  wireRestore();
  body.querySelector('#q-new').onclick = () => openSpawn();
  body.querySelector('#q-archive').onclick = () => openArchive();
  body.querySelector('#q-crons').onclick = () => openCrons();
  setComposer(false);
}

// ---------- sessions that died with cmux ----------
// The server remembers what was running (src/server/roster.js). After cmux comes back,
// whatever was running then and is not now is listed here, every box ticked. RESUME
// opens the ticked ones in new tabs; FORGET drops them. Unticked rows stay offered.
const restoreOff = new Set();
let restoring = false;
const signFor = (dir) => {
  const want = (dir || '').toLowerCase().replace(/\/+$/, '');
  return hooks.town?.()?.plots?.find(p => (p.rawDir || '').toLowerCase().replace(/\/+$/, '') === want)?.sign || null;
};
function restoreCard() {
  const lost = state.restore || [];
  if (!lost.length) return '';
  const { rows, picked } = restoreModel(lost, restoreOff, signFor);
  return `<div class="restore">
    <div class="rs-hd"><b>CMUX RESTARTED</b><span>${rows.length} session${rows.length === 1 ? '' : 's'} stopped with it</span></div>
    ${rows.map(r => `<label class="rs-row"><input type="checkbox" data-sid="${esc(r.id)}" ${r.checked ? 'checked' : ''}>
      <span class="who"><b>${esc(r.sign)}</b><span>${esc(r.title)}</span>
      <span class="facts">${r.engine}  ·  ${esc(r.was)}</span></span></label>`).join('')}
    <div class="btns"><button id="rs-go" class="wide" ${picked.length && !restoring ? '' : 'disabled'}>${
      restoring ? 'RESUMING…' : `RESUME ${picked.length}`}</button>
      <button id="rs-forget" ${restoring ? 'disabled' : ''}>FORGET ALL</button></div></div>`;
}
function wireRestore() {
  body.querySelectorAll('.rs-row input').forEach(cb => {
    cb.onchange = () => {
      cb.checked ? restoreOff.delete(cb.dataset.sid) : restoreOff.add(cb.dataset.sid);
      const top = body.scrollTop;
      renderQueue(true);
      body.scrollTop = top;
    };
  });
  const go = body.querySelector('#rs-go');
  if (go) go.onclick = async () => {
    const { picked } = restoreModel(state.restore, restoreOff, signFor);
    if (!picked.length || restoring) return;
    restoring = true; renderQueue(true);
    const r = await api.restore('resume', picked).catch(() => ({ error: 'Connection lost. Check the field before resuming again.' }));
    restoring = false;
    // The server has already taken them off the list; drop them here too, or the card
    // shows them until the next snapshot arrives.
    state.restore = (state.restore || []).filter(s => !picked.includes(s.sessionId)
      || r.failed?.some(f => f.sessionId === s.sessionId));
    renderQueue(true);
    if (r.error) return toastErr(r.error);
    if (r.failed?.length) return toastErr(`resumed ${r.resumed}, ${r.failed.length} failed: ${r.failed[0].error}`);
    toast(`resuming ${r.resumed} session${r.resumed === 1 ? '' : 's'} in new tabs…`);
  };
  const forget = body.querySelector('#rs-forget');
  if (forget) armButton(forget, 'restore:forget', 'FORGET ALL', 'click again to forget every session on this list', async () => {
    const ids = (state.restore || []).map(s => s.sessionId);
    await api.restore('dismiss', ids).catch(() => null);
    state.restore = []; restoreOff.clear();
    renderQueue(true);
    toast('forgotten · they are still in each repo\'s PC');
  });
}

// The composer is one box, but the text in it belongs to whoever you were typing at.
// Leaving an agent parks the unsent draft under its key and coming back brings it
// straight out again, so clicking another Pokemon never throws a half-written
// message away. Every view that owns the box passes its own key: an agent uses its
// workspaceId, Ash uses 'ash', everything else passes none and gets an empty box.
let store = null;
try { store = window.localStorage; } catch {}
const drafts = makeDrafts(store);
let draftKey = null;

function autoGrow() {
  input.style.height = 'auto';
  if (input.value) input.style.height = Math.min(120, input.scrollHeight) + 'px';
}
function saveDraft() { if (draftKey) drafts.set(draftKey, input.value); }
function useDraft(key) {
  if ((key || null) === draftKey) return; // A live refresh must preserve cursor/selection.
  saveDraft();
  if (draftKey) attachmentTrays.set(draftKey, attached);
  draftKey = key || null;
  attached = (draftKey && attachmentTrays.get(draftKey)) || makeAttachments({ store: attachmentStore, key: draftKey });
  if (draftKey) attachmentTrays.set(draftKey, attached);
  drawAttachments();
  input.value = draftKey ? drafts.get(draftKey) : '';
  autoGrow();
}

function setComposer(on, placeholder, key = null) {
  useDraft(on ? key : null);
  input.disabled = !on; sendBtn.disabled = !on || sending.has(key); clipBtn.disabled = !on;

  input.placeholder = placeholder || (on ? 'Reply… Enter to send, Shift+Enter for a new line'
                                         : 'Pick a Pokémon to talk to…');
}

// ---------- one agent ----------
// `move` walks the player over. Only Tab does that, because Tab means "take me
// there". Clicking a Pokemon just opens its chat; teleporting the avatar on every
// click is disorienting.
export async function openAgent(actor, move = false) {
  hooks.reveal?.();
  mode = 'agent'; current = actor;
  setBack(back, 'Back to all agents');
  expanded.add(actor.plot.plot);          // leaving the chat lands on an open group
  lastRepoDir = actor.plot.rawDir;
  if (move) hooks.focusOn?.(actor);
  hooks.select?.(actor);
  renderQueue(true);
  const a = actor.agent;
  body.innerHTML = `<div class="empty">loading conversation…</div>`;
  setComposer(a.status === 'BLOCKED' || a.status === 'ASLEEP', null, a.workspaceId);
  if (a.kind === 'service') { renderService(actor); return; }
  const d = await api.agent(a.workspaceId);
  if (mode !== 'agent' || current !== actor) return;
  renderChat(actor, d);
}

// Rendered the way Claude Code prints it: your prompt with a caret, the reply as
// plain text, each tool call on its own bulleted line.
// AskUserQuestion rendered as the decision it is: the question, every option with
// its description, the one that was picked, or a clear "waiting on you".
function renderAsk(a) {
  const state = a.pending ? 'pending' : a.rejected ? 'rejected' : 'answered';
  const badge = a.pending ? 'WAITING ON YOU' : a.rejected ? 'DECLINED' : 'ANSWERED';
  const qs = (a.questions || []).map(q => {
    const picked = a.picked?.[q.question];
    const opts = (q.options || []).map((o, oi) => {
      const on = picked && (o.label === picked || picked.startsWith(o.label));
      const live = a.pending ? ` data-opt="${oi + 1}" data-label="${esc(o.label)}"` : '';
      return `<div class="ask-opt ${on ? 'picked' : ''}${a.pending ? ' live' : ''}"${live}>
        <b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</div>`;
    }).join('');
    const other = picked && !(q.options || []).some(o => picked.startsWith(o.label))
      ? `<div class="ask-opt picked"><b>${esc(picked)}</b><span>your own answer</span></div>` : '';
    return `<div class="ask-q">
      ${q.header ? `<span class="ask-hd">${esc(q.header)}</span>` : ''}
      <div class="ask-text">${md(q.question)}</div>${opts}${other}</div>`;
  }).join('');
  const hint = a.pending
    ? '<div class="ask-hint">Click an option to answer it in the terminal</div>' : '';
  return `<div class="ask ask-${state}"><div class="ask-badge">${badge}</div>${qs}${hint}</div>`;
}

function renderThread(messages) {
  return (messages || []).map(m => {
    // A trimmed conversation says so. Without this the panel implies the chat began
    // where the visible turns begin, which is exactly the confusing part.
    if (m.role === 'gap') return '<div class="t-gap">earlier turns not shown</div>';
    const tools = detailMode
      ? (m.tools || []).map(t =>
          `<div class="t-tool">⏺ ${esc(t.tool)}(<span class="t-arg">${esc(t.arg)}</span>)</div>`).join('')
      : summarizeTools(m.tools).map(a =>
          `<div class="t-act">✓ ${esc(a.label)}${a.detail ? ` <span class="t-arg">${esc(a.detail)}</span>` : ''}</div>`).join('');
    // md() escapes before it transforms, so transcript text can never inject markup.
    const asks = (m.asks || []).map(renderAsk).join('');
    return m.role === 'user'
      ? `<div class="t-user">${md(m.text)}</div>`
      : `${m.text ? `<div class="t-asst">${md(m.text)}</div>` : ''}${asks}${tools}`;
  }).join('');
}

// ---------- archive: transcripts outlive the agents that made them ----------
let archiveScope = null;      // null = every repo, else a repo dir
let archiveQuery = '';
export async function openArchive(scopeDir = null) {
  mode = 'archive'; current = null; body.classList.remove('term-mode');
  setBack(back, 'Back to all agents');
  if (scopeDir !== undefined) archiveScope = scopeDir;
  setComposer(false, 'Archive · Esc to go back');
  await drawArchive(true);
}

async function drawArchive(fetchNow) {
  const scopeName = archiveScope
    ? (hooks.town().plots.find(p => p.rawDir === archiveScope)?.sign || 'this repo')
    : 'all repos';
  const shell = (inner, count) => `
    <div class="hd"><b>ARCHIVE</b><span class="muted">${esc(scopeName)}${count != null ? ` · ${count}` : ''}</span></div>
    <div class="sec"><input id="ar-q" placeholder="Search past sessions…" value="${esc(archiveQuery)}">
      <div class="btns" style="margin-top:6px">
        <button id="ar-scope">${archiveScope ? 'ALL REPOS' : 'THIS REPO'}</button>
        <button id="ar-clear">CLEAR</button></div></div>
    ${inner}`;
  body.innerHTML = shell('<div class="empty">reading…</div>');
  wireArchiveControls();

  let rows = [], count = 0;
  if (archiveQuery.trim()) {
    const { results } = await api.search(archiveQuery, archiveScope);
    if (mode !== 'archive') return;
    count = results.length;
    rows = results.map((r, i) => `<div class="q-row" data-i="${i}">
      <span class="who"><b>${esc(r.title)}</b>
        <span>${engineTag(r)}${esc(r.sign)} · ${r.matches} match${r.matches === 1 ? '' : 'es'}</span>
        <span class="snip">${esc(r.snippet)}</span></span></div>`);
    archiveRows = results;
  } else {
    const { sessions } = await api.archive(archiveScope);
    if (mode !== 'archive') return;
    count = sessions.length;
    rows = sessions.map((r, i) => {
      const d = new Date(r.mtime);
      return `<div class="q-row" data-i="${i}">
        <span class="who"><b>${esc(r.title)}</b>
          <span>${engineTag(r)}${esc(r.sign)} · ${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} · ${r.msgs} msgs</span></span>
        </div>`;
    });
    archiveRows = sessions;
  }
  body.innerHTML = shell(rows.join('') || '<div class="empty">Nothing matched.</div>', count);
  wireArchiveControls();
  body.querySelectorAll('.q-row').forEach(el => {
    el.onclick = () => openArchived(archiveRows[Number(el.dataset.i)]);
  });
}

let archiveRows = [];
// Which CLI wrote a past session. Claude sessions come from ~/.claude/projects and
// Codex sessions from ~/.codex/sessions; the server tags every row so the two read
// apart in one list. A row from before the tag existed is a Claude one.
const engineTag = (r) => r.engine === 'codex'
  ? '<i class="eng eng-codex">CODEX</i>' : '<i class="eng eng-claude">CLAUDE</i>';
function wireArchiveControls() {
  const q = body.querySelector('#ar-q');
  if (q) {
    q.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { archiveQuery = q.value; drawArchive(); }
      if (e.key === 'Escape') { q.blur(); }
    };
  }
  body.querySelector('#ar-scope').onclick = () => {
    archiveScope = archiveScope ? null : (current?.plot?.rawDir || lastRepoDir);
    drawArchive();
  };
  body.querySelector('#ar-clear').onclick = () => { archiveQuery = ''; drawArchive(); };
}
let lastRepoDir = null;

// A past session, read-only. Reached from the archive, or from the chips under one of
// Ash's answers, so the way back is whoever opened it.
async function openArchived(row, backTo = openArchive, backLabel = 'Back to the archive') {
  mode = 'archived';
  setBack(backTo, backLabel);
  body.classList.add('term-mode');
  body.innerHTML = `<div class="t-head"><div class="hd"><b>${esc(row.sign)}</b>
      <span class="muted">archived · ${row.engine === 'codex' ? 'Codex' : 'Claude Code'}</span></div>
    <div class="muted">${esc(row.title)}</div>
    <div class="btns"><button id="ar-resume">RESUME</button></div></div>
    <div class="term"><div class="t-note">reading…</div></div>`;
  const { messages } = await api.transcript(row.path);
  if (mode !== 'archived') return;
  body.querySelector('.term').innerHTML =
    renderThread(messages) || '<div class="t-note">This session has no readable turns.</div>';
  body.querySelector('#ar-resume').onclick = async () => {
    await api.act({ action: 'resume', dir: row.dir, sessionId: row.sessionId, engine: row.engine });
    toast('resuming in a new tab…'); back();
  };
}

// A service is a running process, not a conversation: show what it serves and give
// the actions that make sense for it.
// The buttons that end something ask twice, in the page.
//
// They used to call window.confirm, which works in a browser and does NOTHING in the
// desktop app: a WKWebView whose host implements no WKUIDelegate answers every JS
// dialog as if Cancel was clicked. KILL, STOP and cron delete were all dead there, and
// silent about it. So the question is asked with the button itself: one click arms it,
// the next one acts, and an arm goes cold on its own.
const arm = makeArm();
function armButton(el, key, base, note, run) {
  arm.reset();                       // a fresh render always starts unarmed
  el.onclick = async (e) => {
    e?.stopPropagation?.();
    const done = () => { el.textContent = base; el.classList.remove('armed'); };
    if (arm.press(key)) { done(); return run(); }
    el.textContent = arm.label(key, base);
    el.classList.add('armed');
    toast(note);
    // Say so when the moment passes, or an armed-looking button lies about what the
    // next click does.
    setTimeout(() => { if (!arm.armed(key)) done(); }, ARM_WINDOW + 50);
  };
}

function renderService(actor) {
  const a = actor.agent;
  const ports = a.ports || [];
  body.classList.remove('term-mode');
  body.innerHTML = `
    <div class="hd"><b>${esc(actor.plot.sign)}</b><span class="st-WORKING">SERVICE</span></div>
    <div class="muted">${esc(a.title || '')}</div>
    <div class="sec"><span class="lbl">LISTENING ON</span>
      ${ports.length
        ? ports.map(p => `<div class="q-row" data-port="${p}"><span class="who">
            <b>localhost:${p}</b><span>open in Brave</span></span></div>`).join('')
        : '<div class="q">No port bound yet.</div>'}</div>
    <div class="sec"><span class="lbl">NOTE</span><div class="q">This workspace is a running
      process, not a Claude agent. It has no transcript, and stopping it stops the service.</div></div>
    <div class="btns"><button id="sv-back">← ALL</button><button id="sv-open">OPEN TAB</button>
      <button id="sv-raw">RAW</button><button id="sv-stop" class="danger">STOP</button>
      <button id="sv-copy" class="icon" title="Copy this service">📋</button></div>`;
  setComposer(false, 'Service · no conversation');
  body.querySelectorAll('.q-row[data-port]').forEach(el => {
    el.onclick = () => window.open(`http://localhost:${el.dataset.port}`, '_blank');
  });
  body.querySelector('#sv-open').onclick = () => api.act({ action: 'open', ws: a.workspaceId });
  body.querySelector('#sv-copy').onclick = () => copySession(actor, {});
  body.querySelector('#sv-raw').onclick = async () => {
    const s2 = await api.screen(a.workspaceId);
    const pre = document.createElement('pre'); pre.className = 'screen';
    pre.textContent = s2.screen || '(no screen)';
    body.append(pre);
  };
  armButton(body.querySelector('#sv-stop'), `stop:${a.workspaceId}`, 'STOP',
    'Click again to stop it. Whatever it is serving goes down.', async () => {
      await api.act({ action: 'kill', ws: a.workspaceId }); toast('stopped'); back();
    });
}

// A question the agent is waiting on, drawn as the picker it is rather than as a
// picture of a terminal. The options are the same markup the answered ones use, so
// clicking one goes through the same path: `action: choose` checks the option is still
// on screen before it presses anything. A prompt the parser does not recognise falls
// back to the pane itself, because showing it is still better than hiding it.
function renderPending(p) {
  const ask = p.ask;
  if (!ask) {
    return `<div class="ask ask-pending"><div class="ask-badge">WAITING ON YOU</div>
      <div class="ask-q"><pre class="ask-screen">${esc((p.screen || []).join('\n'))}</pre></div>
      <div class="ask-hint">Answer below, or open the tab</div></div>`;
  }
  // One ask can hold several questions, shown as tabs. Without them, answering the one
  // on screen looks like nothing happened when it has simply moved to the next.
  const tabs = (ask.tabs || []).length > 1
    ? `<div class="ask-tabs">${ask.tabs.map(t =>
        `<span class="ask-tab${t.done ? ' done' : ''}">${t.done ? '✓' : '○'} ${esc(t.label)}</span>`
      ).join('')}</div>` : '';

  const opts = (ask.options || []).map(o => {
    // The terminal's own two rows are not answers. "Type something" opens an input
    // that only the terminal can take, so saying so beats a click that does nothing.
    if (o.kind === 'text' || o.kind === 'chat') {
      return `<button class="ask-opt live" data-opt="${o.n}" data-label="${esc(o.label)}"><b>${esc(o.label)}</b></button>`;
    }
    const box = ask.multi ? `<i class="ask-box">${o.checked ? '☑' : '☐'}</i>` : '';
    const cls = ['ask-opt', 'live', ask.multi ? 'tick' : '', o.checked ? 'checked' : '',
                 o.selected ? 'on' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-opt="${o.n}" data-label="${esc(o.label)}">
      <b>${box}${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</div>`;
  }).join('');

  // Ticking is not answering. A multi-select stays on screen until it is submitted,
  // and the panel cannot press Submit yet, so it must not imply that a click finished
  // anything: that silence is exactly what made this feel broken.
  const hint = ask.multi
    ? 'Click to tick and untick. Use Terminal controls to move between questions and submit.'
    : 'Click an answer, or press its number in the terminal';
  return `<div class="ask ask-pending"><div class="ask-badge">WAITING ON YOU</div>
    ${tabs}
    <div class="ask-q">
      ${ask.header ? `<span class="ask-hd">${esc(ask.header)}</span>` : ''}
      <div class="ask-text">${esc(ask.question)}</div>${opts}</div>
    <div class="ask-hint">${hint}</div></div>`;
}

// Clicking an option drives the picker in the real terminal. The server refuses if
// the question has moved on, so a stale panel can never pick the wrong thing.
function wireAskOptions(workspaceId, actor) {
  // The terminal's own rows cannot be driven from here, so they open the tab instead
  // of failing quietly. Clicking "Type something" and having nothing happen is worse
  // than being sent where the typing actually works.
  body.querySelectorAll('.ask-opt.extra').forEach(el => {
    el.onclick = () => { api.act({ action: 'open', ws: workspaceId }); toast('opened the tab'); };
  });
  body.querySelectorAll('.ask-opt.live').forEach(el => {
    const tick = el.classList.contains('tick');
    el.onclick = async () => {
      if (el.classList.contains('busy')) return;
      el.classList.add('busy');
      const r = await api.act({ action: 'choose', ws: workspaceId,
        optionIndex: Number(el.dataset.opt), optionLabel: el.dataset.label, question: lastDetail?.pending?.ask?.question }).catch(() => ({ error: 'Connection lost. Review Terminal controls before trying again.' }));
      if (!r.ok) {
        el.classList.remove('busy');
        toastErr(r.error || 'could not answer from here');
        return;
      }
      // A tick is not an answer. Re-reading the pane is what puts the new checkbox on
      // screen; without it the option just greyed out and the question sat there,
      // which is what made ticking feel like it had failed.
      if (tick) { toast('ticked'); setTimeout(() => { if (current === actor) openAgent(actor); }, 400); return; }
      el.classList.add('picked');
      toast(r.stillAsking ? 'answered · it has another question' : 'answered');
      if (el.textContent.match(/Type something|Chat about this/i)) { await showTerminal(workspaceId); return; }
      setTimeout(() => { if (current === actor) openAgent(actor); }, 900);
    };
  });
}

// Live thread: when the open agent's transcript changes, refresh it in place. Keeps
// the scroll pinned to the bottom only if you were already reading the newest turn.
let refreshing = false;
onThread(async (ws) => {
  if (mode !== 'agent' || !current || current.agent?.workspaceId !== ws || refreshing) return;
  refreshing = true;
  try {
    const d = await api.agent(ws);
    if (mode === 'agent' && current?.agent?.workspaceId === ws) refresh(current, d);
  } finally { refreshing = false; }
});

// While an agent is blocked, the transcript does not change: the question it is asking
// has not been written yet. The SSE thread event that keeps this pane live therefore
// never fires, and without a poll the panel sits there showing the turn before the
// question until the answer is typed somewhere else.
let blockedPoll = null;
function watchBlocked(actor, blocked) {
  clearInterval(blockedPoll); blockedPoll = null;
  if (!blocked) return;
  blockedPoll = setInterval(async () => {
    const ws = current?.agent?.workspaceId;
    if (mode !== 'agent' || !ws || current !== actor) { clearInterval(blockedPoll); blockedPoll = null; return; }
    const d = await api.agent(ws).catch(() => null);
    if (d && mode === 'agent' && current === actor) refresh(actor, d);
  }, 2000);
}

// Redraw only what changed, and put the reader back where they were. Every refresh
// used to rebuild the thread and pin it to the newest turn, so scrolling up to read
// something lasted until the next poll, about two seconds.
let lastKey = '';
function refresh(actor, d) {
  if (body.querySelector('.terminal-controls')) return;
  const key = threadKey(d);
  if (key === lastKey) return;             // nothing on screen would differ; leave it alone
  const wasAtBottom = atBottom(body);
  const prevTop = body.scrollTop;
  renderChat(actor, d, { keepScroll: { wasAtBottom, prevTop } });
}

let lastDetail = null;
function renderChat(actor, d, opts = {}) {
  lastKey = threadKey(d);
  lastDetail = d;
  const a = actor.agent;
  const species = actor.species ? actor.species[1].toUpperCase() : 'AGENT';
  const ctxPct = d.contextPct ?? a.contextPct ?? null;
  // A percentage alone cannot say whether 40% is 80k of a standard window or 400k of
  // a 1M one, so the count it was measured from is shown beside it.
  const ctxTok = d.contextTokens ?? a.contextTokens ?? null;
  const head = `<div class="t-head"><div class="hd"><b>${esc(actor.plot.sign)}</b>
      <span class="st-${a.status}">${a.status}${a.status === 'BLOCKED' ? ` ${elapsed(Date.now() - a.since)}` : ''}</span></div>
    <div class="muted">${esc(species)} · ${esc(d.title || a.title || '')}</div>
    <div class="facts-row">
      ${a.branch ? `<span class="fact"><b>branch</b>${esc(a.branch)}${a.gitDirty ? ' <span title="uncommitted changes">*</span>' : ''}</span>` : ''}
      ${(d.model || a.model) ? `<span class="fact"><b>model</b>${esc(d.model || a.model)}</span>` : ''}
      ${ctxPct != null ? `<span class="fact ${ctxPct >= 80 ? 'hot' : ''}"><b>context</b>
        ${ctxPct}%${ctxTok != null ? ` <span class="muted">${Math.round(ctxTok / 1000)}k</span>` : ''}
        <span class="ctx-meter ${ctxPct >= 80 ? 'hot' : ''}"><i style="width:${ctxPct}%"></i></span></span>` : ''}
      ${(d.permissionMode || a.permissionMode) ? `<span class="fact"><b>mode</b>${esc(d.permissionMode || a.permissionMode)}</span>` : ''}
    </div>
    <div class="btns"><button id="b-detail">${detailMode ? 'SUMMARY' : 'DETAIL'}</button>
      <button id="b-open">OPEN TAB</button><button id="b-screen">TERMINAL CONTROLS</button>
      <button id="b-pc">PC</button><button id="b-kill" class="danger">KILL</button>
      <button id="b-copy" class="icon" title="Copy this session — everything an agent needs to QA it">📋</button></div></div>`;

  const msgs = renderThread(d.messages);
  const queued = (d.outbox || []).map(row => `<div class="t-user"><b>${row.status === 'review' ? 'Delivery needs review' : 'Queued'}</b><p>${esc(row.text)}</p>${row.reason ? `<div class="muted">${esc(row.reason)}</div>` : ''}<button data-cancel-reply="${esc(row.id)}">${row.status === 'review' ? 'Dismiss' : 'Cancel queued reply'}</button></div>`).join('');

  // A question the agent is waiting on goes at the BOTTOM, under the conversation,
  // because that is where it happened and that is where you are already looking. It
  // comes off the terminal screen: an unanswered question is not in the transcript.
  const asking = d.pending ? renderPending(d.pending) : '';

  body.classList.add('term-mode');
  body.innerHTML = head + `<div class="term">` + (d.ambiguous
    ? `<div class="t-note">No Claude session is running in this terminal, and several
       agents share this folder, so the newest transcript here could belong to a
       different one. Start Claude in this tab and the conversation appears.</div>`
    : (msgs || '<div class="t-note">No conversation yet.</div>')) + asking + queued + `</div>`;
  // Opening an agent starts at the newest turn - unless it is asking something, in
  // which case it starts at the top of the question. A refresh keeps the reader's place.
  const askEl = body.querySelector('.ask-pending');
  body.scrollTop = opts.keepScroll
    ? nextTop({ ...opts.keepScroll, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight })
    : openTop({ askTop: askEl ? askEl.getBoundingClientRect().top - body.getBoundingClientRect().top : null,
                scrollHeight: body.scrollHeight, clientHeight: body.clientHeight });
  setComposer(true, null, a.workspaceId);
  if (!opts.keepScroll) input.focus();
  body.querySelectorAll('[data-cancel-reply]').forEach(button => { button.onclick = async () => {
    const r = await api.act({ action: 'cancel-reply', ws: a.workspaceId, messageId: button.dataset.cancelReply });
    if (!r.ok) toastErr('Reply is already being sent.');
    const next = await api.agent(a.workspaceId); if (current === actor) refresh(actor, next);
  }; });
  wireAskOptions(a.workspaceId, actor);
  // Poll while there is a question up, whatever the status says. The status arrives by
  // hook and can lag the picker being drawn, and nothing is written to the transcript
  // while a question waits, so this is the only thing keeping the panel current.
  watchBlocked(actor, true);

  body.querySelector('#b-detail').onclick = () => {
    detailMode = !detailMode;
    try { localStorage.setItem('pc.detail', detailMode ? '1' : '0'); } catch {}
    renderChat(actor, d);
  };
  body.querySelector('#b-open').onclick = () => api.act({ action: 'open', ws: a.workspaceId });
  body.querySelector('#b-copy').onclick = () => copySession(actor, d);
  body.querySelector('#b-pc').onclick = () => openPC(actor.plot);
  armButton(body.querySelector('#b-kill'), `kill:${a.workspaceId}`, 'KILL',
    `Click again to close "${a.title}". The session ends.`, async () => {
      const r = await api.act({ action: 'kill', ws: a.workspaceId });
      toast(r?.error || 'closed');
      if (!r?.error) back();
    });
  body.querySelector('#b-screen').onclick = () => showTerminal(a.workspaceId);
}


// A deliberate fallback for pickers, custom answers, slash menus, and terminal drafts.
// The main chat draft stays untouched. Every keystroke is checked against this screen.
async function showTerminal(ws) {
  if (current?.agent?.workspaceId !== ws) return;
  body.querySelector('.terminal-controls')?.remove();
  const el = document.createElement('div'); el.className = 'terminal-controls stuck';
  el.innerHTML = `<b>Terminal controls</b><p>Review the live screen. Type inserts one line; Enter submits or confirms the selected choice. Your chat draft stays saved.</p>
    <pre class="screen"></pre><div class="btns"><button data-refresh>Refresh</button><button data-close>Close controls</button><button data-open>Open in cmux</button></div>
    <div class="btns">${[['up','↑'],['down','↓'],['left','←'],['right','→'],['space','Space / toggle'],['tab','Tab'],['shift+tab','Shift+Tab'],['escape','Escape / cancel'],['enter','Enter / confirm'],['backspace','Backspace'],['ctrl+a','Start of line'],['ctrl+e','End of line'],['ctrl+k','Delete to end'],['ctrl+u','Delete to start']].map(([key,label]) => `<button data-key="${key}">${label}</button>`).join('')}</div>
    <div class="btns"><input aria-label="Text to type into the terminal" placeholder="Custom answer or terminal text" autocomplete="off"><button data-type>Type without submitting</button></div><p class="muted" data-result></p>`;
  (body.querySelector('.term') || body).append(el);
  let screen = null;
  const pre = el.querySelector('pre'), status = el.querySelector('[data-result]');
  const busy = on => el.querySelectorAll('button, input').forEach(b => b.disabled = on);
  const refreshScreen = async () => {
    const r = await api.screen(ws).catch(() => ({ error: 'Could not read the terminal' }));
    screen = r.screen || null; pre.textContent = screen || r.error || '(blank screen)';
    pre.scrollTop = pre.scrollHeight;
  };
  const act = async request => {
    busy(true);
    try {
      const r = await api.act({ action: 'terminal', ws, screen, ...request });
      status.textContent = r.ok ? 'Key sent. Review the updated screen before the next action.' : r.error || 'Action failed';
      if (r.ok && request.text) el.querySelector('input').value = '';
      await new Promise(resolve => setTimeout(resolve, 150));
      await refreshScreen();
    } catch { status.textContent = 'Connection lost. Refresh before trying again.'; screen = null; }
    finally { busy(false); }
  };
  el.querySelectorAll('[data-key]').forEach(b => b.onclick = () => act({ key: b.dataset.key }));
  el.querySelector('[data-type]').onclick = () => act({ text: el.querySelector('input').value });
  el.querySelector('input').onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') e.preventDefault(); };
  el.querySelector('[data-refresh]').onclick = async () => { busy(true); await refreshScreen(); busy(false); };
  el.querySelector('[data-close]').onclick = () => el.remove();
  el.querySelector('[data-open]').onclick = () => api.act({ action: 'open', ws });
  busy(true); await refreshScreen(); busy(false);
  if (el.isConnected) el.scrollIntoView({ block: 'nearest' });
}

// The composer is always the same box, whichever agent is selected.
const sending = new Set();
async function sendCurrent() {
  const text = input.value.trim();
  // Ash shares the message box with the agents, so asking him is the same gesture.
  if (mode === 'ranger') {
    if (!text) return;
    input.value = ''; input.style.height = 'auto'; saveDraft();
    return askAsh(text);
  }
  const body_ = attached.compose(text);
  if (!body_ || !current) return;
  const actor = current;
  const a = actor.agent;
  const ws = a.workspaceId;
  if (sending.has(ws)) return;
  sending.add(ws);
  sendBtn.disabled = true;
  const sentTray = attached;
  const sentFiles = sentTray.list();
  const el = document.createElement('div');
  el.className = 't-user pending';
  el.textContent = '> ' + body_;
  (body.querySelector('.term') || body).append(el);
  body.scrollTop = body.scrollHeight;
  const r = await api.act({ action: 'send', ws, text: body_, messageId: crypto.randomUUID() }).catch(() => ({ error: 'Connection lost. Your draft is saved. Check the queued replies before retrying.' }));
  sending.delete(ws);
  if (draftKey === ws) sendBtn.disabled = false;
  if (r.ok) {
    el.classList.remove('pending');
    // A busy agent takes the message for when it finishes. Saying "sent" for that
    // reads as a lie the moment the thread does not move.
    toast(r.queued ? `queued → ${actor.plot.sign}` : `sent → ${actor.plot.sign}`);
    if (draftKey === ws && input.value.trim() === text) { input.value = ''; autoGrow(); saveDraft(); }
    else if (draftKey !== ws && drafts.get(ws).trim() === text) drafts.clear(ws);
    for (let i = sentTray.list().length - 1; i >= 0; i--) {
      if (sentFiles.includes(sentTray.list()[i])) sentTray.remove(i);
    }
    drawAttachments();
    body.querySelector('.terminal-controls')?.remove();
    const next = await api.agent(ws).catch(() => null);
    if (next && current === actor) refresh(actor, next);
    return;
  }
  el.remove(); toastErr(r.error || 'send failed');
  // Keep the composer usable. Terminal controls are opened only on request.
}

// A draft stuck in the pane's own box, which the server will not type after. Claude
// Code parks a queued message there when Up is pressed and then never sends it, so
// the panel offers the two things the user would do in the tab: send it, or clear it.
// Each action handles only the terminal draft. Never automatically submit the
// separate chat reply: it may be the same message after a partially failed send.
function offerStuck(a, draft) {
  body.querySelector('.stuck')?.remove();
  const el = document.createElement('div');
  el.className = 'stuck';
  el.innerHTML = `<div class="stuck-q">That tab already has unsent text in its box. Your separate reply stays saved:</div>
    <pre class="stuck-draft">${esc(draft)}</pre>
    <div class="stuck-row"><button data-do="flush">Send terminal draft</button>
    <button data-do="discard">Discard terminal draft</button></div>`;
  el.querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      el.querySelectorAll('button').forEach(x => x.disabled = true);
      const r = await api.act({ action: b.dataset.do, ws: a.workspaceId, text: draft }).catch(() => ({ error: 'Connection lost. Review Terminal controls before trying again.' }));
      // A frozen tab takes no keystroke, so neither button can ever work: drop the
      // offer and say what is wrong, rather than re-arming buttons for another try.
      if (!r.ok && r.frozen) { el.remove(); return toastErr(r.error); }
      if (!r.ok) { el.querySelectorAll('button').forEach(x => x.disabled = false); toastErr(r.error || 'could not do that from here'); await showTerminal(a.workspaceId); return; }
      el.remove();
      toast(r.nothing ? 'nothing left in the terminal box' : b.dataset.do === 'flush' ? 'terminal draft sent · review your saved reply before sending again' : 'terminal draft cleared · your reply is ready to send');
    };
  });
  (body.querySelector('.term') || body).append(el);
  body.scrollTop = body.scrollHeight;
}
input.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
  if (e.key === 'Escape') { e.preventDefault(); input.blur(); }
});
input.addEventListener('input', () => {
  autoGrow();
  saveDraft();               // an unsent line survives leaving this agent, and a reload
});
sendBtn.addEventListener('click', sendCurrent);

// ---------- the PC ----------
export async function openPC(plot) {
  hooks.reveal?.();
  mode = 'pc'; pcPlot = plot; pcSel = 0; lastRepoDir = plot.rawDir; body.classList.remove('term-mode');
  setBack(back, 'Back to all agents');
  setComposer(false, 'PC open · Esc to go back');
  body.innerHTML = `<div class="hd"><b>${esc(plot.sign)} · PC</b></div><div class="muted">reading sessions…</div>`;
  const { sessions } = await api.sessions(plot.rawDir);
  if (mode !== 'pc') return;
  pcRows = sessions; renderPC();
}
function renderPC() {
  const live = new Set(state.agents.map(a => a.sessionId).filter(Boolean));
  const rows = pcRows.map((s, i) => {
    const d = new Date(s.mtime);
    return `<div class="q-row ${i === pcSel ? 'sel' : ''}" data-i="${i}">
      <span class="who"><b>${esc(s.title)}</b>
        <span>${engineTag(s)}${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} · ${s.msgs} msgs${live.has(s.sessionId) ? ' · LIVE' : ''}</span></span>
      </div>`;
  }).join('');
  body.innerHTML = `<div class="hd"><b>${esc(pcPlot.sign)} · PC</b><span class="muted">past sessions</span></div>
    ${rows || '<div class="empty">No past sessions here.</div>'}
    <div class="btns"><button id="pc-go" class="wide">RESUME SELECTED</button></div>`;
  body.querySelectorAll('.q-row').forEach(el => {
    el.onclick = () => { pcSel = Number(el.dataset.i); renderPC(); };
    el.ondblclick = resumeSel;
  });
  body.querySelector('#pc-go').onclick = resumeSel;
}
async function resumeSel() {
  const s = pcRows[pcSel]; if (!s) return;
  await api.act({ action: 'resume', dir: pcPlot.rawDir, sessionId: s.sessionId, engine: s.engine });
  toast('resuming in a new tab…'); back();
}
export function pcKey(e) {
  if (mode !== 'pc') return false;
  if (e.key === 'ArrowDown') { pcSel = Math.min(pcRows.length - 1, pcSel + 1); renderPC(); return true; }
  if (e.key === 'ArrowUp') { pcSel = Math.max(0, pcSel - 1); renderPC(); return true; }
  if (e.key === 'Enter') { resumeSel(); return true; }
  return false;
}

// ---------- spawn ----------
// Ash is the front desk: start an agent, put a new repo on the field, or ask about
// what is currently visible.
let ashRows = [], ashBusy = false;

// The map asks whether the front desk is busy, so Pikachu can be shown working at
// the desk computer while Ash's answer is still being written.
export const ashWorking = () => ashBusy;

export async function openRanger(town) {
  hooks.reveal?.();
  mode = 'ranger'; current = null; body.classList.remove('term-mode');
  setBack(back, 'Back to all agents');
  hooks.select?.(null);
  const t = town || hooks.town();
  renderRanger(t);
  // History lives on the server, so an answer survives leaving the panel, a reload,
  // and a restart. Without this the reply vanished the moment the view re-rendered.
  const r = await api.ash(50).catch(() => null);
  if (mode !== 'ranger') return;
  ashRows = r?.entries || [];
  renderRanger(t);
}

function renderRanger(t) {
  const visible = (t.plots || []).map(p => p.sign).join(', ');
  const free = (t.slots?.length || 0) - (t.repos?.length || 0);
  // The sessions Pikachu read for an answer, offered as chips: click one to read
  // the whole transcript Ash was quoting from.
  const sources = (e, i) => (e.grounding?.sessions || []).map((s, k) =>
    `<span class="ash-src" data-e="${i}" data-k="${k}" title="${esc(s.path || '')}">` +
    `${esc(s.sign)} · ${esc(s.title)}</span>`).join('');
  const thread = ashRows.map((e, i) => `
    <div class="t-user">&gt; ${esc(e.question)}</div>
    ${e.error ? `<div class="ash-err">${esc(e.error)}</div>`
              : `<div class="t-asst">${md(e.answer || '')}</div>`}
    <div class="ash-meta">${esc(when(e.ts))}${e.grounding
      ? ` · read ${e.grounding.live} live agent${e.grounding.live === 1 ? '' : 's'}` +
        ` · ${e.grounding.hits} past session${e.grounding.hits === 1 ? '' : 's'}` : ''}
      ${sources(e, i)}</div>`).join('');

  body.innerHTML = `
    <div class="hd"><b>ASH</b><span class="muted">front desk</span></div>
    <div class="btns">
      <button id="rg-agent" class="wide">NEW AGENT</button>
      <button id="rg-repo" class="wide">NEW REPO</button>
    </div>
    <div class="sec"><span class="lbl">ASK ABOUT THE FIELD</span>
      <div class="muted">Answers cover the ${(t.plots || []).length} repos on screen:
        ${esc(visible)}. This one costs tokens; it runs Claude on your subscription.</div></div>
    <div class="ash-thread">${thread ||
      '<div class="empty">Nothing asked yet. Use the box below.</div>'}</div>
    ${ashBusy ? '<div class="sec muted" id="ash-wait">Pikachu is reading the sessions, then Ash answers… (a few seconds)</div>' : ''}
    <div class="muted">${free} empty square${free === 1 ? '' : 's'} left on this grid.</div>`;
  body.querySelector('#rg-agent').onclick = () => openSpawn(t);
  body.querySelector('#rg-repo').onclick = () => openNewRepo(t);
  body.querySelectorAll('.ash-src').forEach(el => {
    el.onclick = () => {
      const s = ashRows[Number(el.dataset.e)]?.grounding?.sessions?.[Number(el.dataset.k)];
      if (!s?.path) return;
      // The box belongs to Ash; a transcript being read is not something to type at.
      setComposer(false, 'Archived · the back arrow returns to Ash');
      openArchived(s, () => openRanger(t), 'Back to Ash');
    };
  });
  // Ash uses the same message box as every agent, so asking him is the same gesture
  // as talking to a Pokemon.
  setComposer(!ashBusy, ashBusy ? 'Ash is thinking…' : 'Ask Ash about the field…', 'ash');
  body.scrollTop = body.scrollHeight;
}

const when = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric',
                                     hour: 'numeric', minute: '2-digit' });
};

export async function askAsh(question) {
  if (!question || ashBusy) return;
  const t = hooks.town();
  ashBusy = true;
  ashRows = [...ashRows, { question, answer: null, pending: true, ts: Date.now() }];
  renderRanger(t);
  const r = await api.ask(question, (t.plots || []).map(p => p.rawDir)).catch(
    (e) => ({ error: String(e) }));
  ashBusy = false;
  // Replace the pending row with what the server actually stored.
  ashRows = ashRows.filter(x => !x.pending);
  ashRows.push({ id: r.id, ts: r.ts || Date.now(), question,
                 answer: r.answer || null, error: r.error || null, grounding: r.grounding });
  if (mode === 'ranger') renderRanger(t);
  else toast(r.error ? 'Ash failed' : 'Ash answered · open him to read it');
}

// Put a folder on the field. The server validates it and rebuilds every layout.
function openNewRepo(town) {
  mode = 'newrepo'; body.classList.remove('term-mode');
  setBack(() => openRanger(town), 'Back to Ash');
  setComposer(false, 'New repo · Esc to go back');
  const kinds = ['office', 'lab', 'clinic', 'mart', 'tower', 'guild', 'workshop',
                 'center', 'shop', 'block', 'command', 'house'];
  body.innerHTML = `
    <div class="hd"><b>NEW REPO</b><span class="muted">adds a plot</span></div>
    <div class="sec"><span class="lbl">FOLDER</span>
      <div class="pathrow">
        <input id="nr-dir" placeholder="~/Projects/my-repo" spellcheck="false">
        <button id="nr-pick" title="Choose a folder in Finder">CHOOSE…</button>
      </div></div>
    <div class="sec"><span class="lbl">BUILDING</span>
      <select id="nr-kind">${kinds.map(k => `<option value="${k}">${k}</option>`).join('')}</select></div>
    <div class="btns"><button id="nr-go" class="wide">ADD TO THE FIELD</button></div>
    <div id="nr-out" class="muted"></div>`;
  const dirEl = body.querySelector('#nr-dir');
  dirEl.focus();
  dirEl.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); };
  // The real Finder dialog, opened by the server on this same Mac. A page cannot
  // produce an absolute path on its own, and an absolute path is what the field needs.
  // Cancelling is the usual ending, so it leaves no message behind.
  const pickEl = body.querySelector('#nr-pick');
  pickEl.onclick = async () => {
    const out = body.querySelector('#nr-out');
    pickEl.disabled = true; pickEl.textContent = 'FINDER…';
    out.textContent = 'pick a folder in the dialog';
    const r = await api.pickFolder().catch((e) => ({ error: String(e) }));
    if (mode !== 'newrepo') return;
    pickEl.disabled = false; pickEl.textContent = 'CHOOSE…';
    out.textContent = r.error || '';
    if (r.dir) { dirEl.value = r.dir; dirEl.focus(); }
  };
  const go = async () => {
    const dir = dirEl.value.trim();
    if (!dir) return;
    const out = body.querySelector('#nr-out');
    out.textContent = 'adding…';
    const r = await api.addRepo(dir, body.querySelector('#nr-kind').value);
    if (r.error) { out.textContent = r.error; return; }
    toast(`added ${r.dir}`);
    await hooks.reloadTown?.();
    openRanger(hooks.town());
  };
  body.querySelector('#nr-go').onclick = go;
}

// The engine and model dropdowns. The catalog is fetched once and kept, because the
// form is opened often and the answer only changes when a CLI is updated. Until it
// arrives both selects hold the last choice as their only option, so the form is never
// briefly empty and a fast Enter still launches what the user last used.
let catalog = null;
async function drawEngines(root, focusAfter) {
  const eng = root.querySelector('#sp-engine'), mod = root.querySelector('#sp-model');
  const custom = root.querySelector('#sp-model-other');
  if (!eng || !mod || !custom) return;
  const paint = () => {
    if (!catalog) {                      // still fetching: hold the last choice
      const was = remembered() || { engine: 'claude', model: '' };
      eng.innerHTML = `<option value="${esc(was.engine)}">${esc(was.engine)}</option>`;
      mod.innerHTML = `<option value="${esc(was.model || '')}">${esc(was.model || '…')}</option>`;
      return;
    }
    const pick = resolvePick(catalog, remembered());
    eng.innerHTML = Object.entries(catalog).map(([k, e]) =>
      `<option value="${esc(k)}"${k === pick.engine ? ' selected' : ''}>${esc(e.label)}</option>`).join('');
    paintModels(pick.model);
  };
  // The picker lists what each CLI says it can run today, which is always behind
  // something: a model announced this morning, or one the vendor serves but hides.
  // OTHER is the way to run it now instead of after an edit to engines.js.
  // A value no model name can be: MODEL_SLUG on the server rejects spaces, so if this
  // ever reached it the refusal would be plain rather than a pen on a nonsense model.
  const OTHER = 'other model';
  const paintModels = (want) => {
    const models = modelsFor(catalog || {}, eng.value);
    const listed = models.some(m => m.id === want);
    mod.innerHTML = models.map(m =>
      `<option value="${esc(m.id)}"${m.id === want ? ' selected' : ''}>${esc(m.label)}</option>`).join('')
      + `<option value="${OTHER}"${want && !listed ? ' selected' : ''}>Other model…</option>`;
    custom.hidden = mod.value !== OTHER;
    if (!custom.hidden && want && !listed) custom.value = want;
  };
  // What the form actually sends: the typed name when OTHER is chosen, the option
  // otherwise. Read in one place so the launch and the remembered choice agree.
  root.__model = () => (mod.value === OTHER ? custom.value.trim() : mod.value);
  // Switching engine must not leave the other engine's model selected: the server
  // refuses it, and "gpt-5.5 is not a model claude is offered here" is not a sentence
  // anyone reads as "you changed the engine".
  const save = () => remember({ engine: eng.value, model: root.__model(),
                               custom: mod.value === OTHER });
  eng.onchange = () => { paintModels(null); save(); };
  mod.onchange = () => { custom.hidden = mod.value !== OTHER; if (!custom.hidden) custom.focus(); save(); };
  custom.oninput = save;
  custom.onkeydown = (e) => e.stopPropagation();      // it is a text field, not the map
  paint();
  if (!catalog) {
    catalog = await api.engines().catch(() => null);
    if (!catalog || !root.querySelector('#sp-engine')) return;   // form closed meanwhile
    paint();
    focusAfter?.focus();
  }
}

// A new agent can be started with files, the same way a running one can be sent them:
// clip button, paste, or drop onto the panel. The paths are prefixed to the task, so
// the agent opens the screenshot before it reads the instruction about it.
export function openSpawn(town, preselectDir = null) {
  hooks.reveal?.();
  mode = 'spawn'; body.classList.remove('term-mode');
  setBack(back, 'Cancel');
  setComposer(false, 'New agent · Esc to cancel');
  spawnAttached.clear();
  const plots = (town || hooks.town())?.plots || [];
  const opts = plots.map(p =>
    `<option value="${esc(p.rawDir)}"${p.rawDir === preselectDir ? ' selected' : ''}>${esc(p.sign)}</option>`).join('');
  body.innerHTML = `<div class="hd"><b>NEW AGENT</b></div>
    <div class="sec"><span class="lbl">PEN</span><select id="sp-dir">${opts}</select></div>
    <div class="sec"><span class="lbl">ENGINE</span><select id="sp-engine"></select></div>
    <div class="sec"><span class="lbl">MODEL</span><select id="sp-model"></select>
      <input id="sp-model-other" placeholder="model name, e.g. gpt-5.7-astra" spellcheck="false" hidden></div>
    <div class="sec"><span class="lbl">TASK</span>
      <textarea id="sp-prompt" placeholder="What should it do? Enter to launch."></textarea>
      <div id="sp-attachments" class="attstrip"></div></div>
    <input type="file" id="sp-file" multiple hidden>
    <div class="btns">
      <button id="sp-clip" class="clip" title="Attach a file or screenshot">+</button>
      <button id="sp-go" class="wide">LAUNCH</button></div>`;
  const ta = body.querySelector('#sp-prompt'); ta.focus();
  drawEngines(body, ta);
  const fileEl = body.querySelector('#sp-file');
  body.querySelector('#sp-clip').onclick = () => fileEl.click();
  fileEl.onchange = () => { stageFiles([...fileEl.files], activeTarget()); fileEl.value = ''; };
  ta.onpaste = (e) => {
    const files = filesFromDrop(e.clipboardData);
    if (files.length) { e.preventDefault(); stageFiles(files, activeTarget()); }
  };
  const launch = body.querySelector('#sp-go');
  let launching = false;
  const go = async () => {
    // One attempt per form. A failure keeps the task and files here for correction.
    if (launching) return;
    const prompt = spawnAttached.compose(ta.value.trim());
    if (!prompt) return;
    const request = { dir: body.querySelector('#sp-dir').value, prompt,
      engine: body.querySelector('#sp-engine').value,
      model: body.__model ? body.__model() : null };
    launching = true; launch.disabled = true; launch.textContent = 'STARTING…';
    const r = await api.spawn(request).catch(() => ({ error: 'Connection lost. Check the field before retrying; your task is still here.' }));
    launching = false; launch.disabled = false; launch.textContent = 'LAUNCH';
    if (!r.ok) { toastErr(r.error || 'spawn failed'); return; }
    toast(r.queued ? 'agent started · task queued' : 'agent started · task sent');
    // Do not dismiss a different view or clear a newly opened form after a slow spawn.
    if (body.querySelector('#sp-prompt') === ta) { spawnAttached.clear(); back(); }
  };
  ta.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    if (e.key === 'Escape') { e.preventDefault(); back(); }
  };
  body.querySelector('#sp-go').onclick = go;
}

// ---------- crons ----------
const BROKEN = new Set(['failed', 'stalled']);
export function cronAlerts() {
  return allJobs(state.crons).filter(j => BROKEN.has(j.state)).length;
}
// The timetable. The pen only shows jobs that need you; this shows all of them, so
// "what runs next" and "what quietly stopped working" are both one click away.
let cronFocus = null, cronLogFor = null;

const CRON_NOTE = {
  failed: 'last run exited non-zero',
  stalled: 'schedule has stopped firing',
  unloaded: 'not loaded into launchd',
  running: 'running right now',
  due: 'runs soon',
  ok: '',
};

export function openCrons(focusLabel = null) {
  hooks.reveal?.();
  mode = 'crons'; current = null; cronFocus = focusLabel; cronLogFor = null;
  body.classList.remove('term-mode');
  setBack(back, 'Back to all agents');
  setComposer(false, 'Crons · Esc to go back');
  renderCrons();
}

function renderCrons() {
  const jobs = allJobs(state.crons);
  const bad = jobs.filter(j => BROKEN.has(j.state));
  const off = jobs.filter(j => j.state === 'unloaded');
  // Rows are addressed by INDEX, never by label: a crontab job's label is its shell
  // command, which is free to contain the quotes that would end the attribute.
  const rows = jobs.map((j, i) => {
    const note = CRON_NOTE[j.state];
    // The name says when a job runs, never what it does or whose project it belongs to
    // (two jobs here are both called weekly-traffic-report). The sentence carries that.
    const meta = [j.schedule, j.project, j.usesClaude ? 'claude' : null,
                  j.isCrontab ? 'crontab' : null].filter(Boolean).join(' · ');
    return `<div class="cron-row cr-${j.state} ${j.label === cronFocus ? 'sel' : ''}" data-i="${i}">
      <span class="cr-dot"></span>
      <span class="who"><b>${esc(j.name)}</b>
        ${j.desc ? `<span class="cr-desc ${j.undocumented ? 'thin' : ''}">${esc(j.desc)}</span>` : ''}
        <span>${esc(meta)}</span>
        ${note ? `<span class="facts ${BROKEN.has(j.state) ? 'hot' : ''}">${esc(note)}</span>` : ''}</span>
      <span class="cr-when"><b>${esc(untilText(j.next))}</b>
        <span>ran ${esc(agoText(j.lastRun))}</span></span>
    </div>` + (j.label === cronLogFor ? `<div class="btns cron-acts">
        <button data-run="${i}">RUN NOW</button>
        <button data-del="${i}" class="danger">DELETE</button></div>
      <pre class="cron-log" id="cron-log">loading log…</pre>` : '');
  }).join('');

  body.innerHTML = `<div class="hd"><b>CRONS</b>
      <span class="muted">${jobs.length} scheduled${bad.length ? ` · ${bad.length} failing` : ''}${off.length ? ` · ${off.length} not loaded` : ''}</span></div>
    ${rows || '<div class="empty">No scheduled jobs found.</div>'}
    <div class="btns"><button id="cr-new" class="wide">NEW CRON</button>
      <button id="cr-refresh">REFRESH</button></div>`;

  body.querySelectorAll('.cron-row').forEach(el => {
    el.onclick = () => {
      const l = jobs[Number(el.dataset.i)]?.label;
      if (!l) return;
      cronFocus = l;
      cronLogFor = cronLogFor === l ? null : l;      // click again to close the log
      renderCrons();
      if (cronLogFor) loadCronLog(l);
    };
  });
  body.querySelectorAll('[data-run]').forEach(el => {
    el.onclick = (e) => { e.stopPropagation(); runCronNow(jobs[Number(el.dataset.run)]); };
  });
  body.querySelectorAll('[data-del]').forEach(el => {
    const job = jobs[Number(el.dataset.del)];
    const what = job?.isCrontab ? 'this crontab line' : `${job?.label}.plist`;
    armButton(el, `cron:${job?.label}`, 'DELETE',
      `Click again to delete "${job?.name}". This removes ${what} for good.`,
      () => deleteCronJob(job));
  });
  body.querySelector('#cr-new').onclick = () => openNewCron();
  body.querySelector('#cr-refresh').onclick = () => refreshCrons();
  if (cronFocus) body.querySelector('.cron-row.sel')?.scrollIntoView({ block: 'center' });
}

async function refreshCrons() {
  const r = await fetch('/api/crons').then(x => x.json()).catch(() => null);
  state.crons = r?.crons || state.crons;
  if (mode === 'crons') renderCrons();
}

// Run it now means NOW, not at the next scheduled time. The log is reloaded a moment
// later so you watch the run you just started instead of the previous one.
async function runCronNow(job) {
  if (!job) return;
  toast(`starting ${job.name}…`);
  const r = await api.cron({ action: 'run', label: job.label });
  if (r.error) return toast(r.error);
  state.crons = r.crons || state.crons;
  toast(`${job.name} started`);
  if (mode !== 'crons') return;
  renderCrons();
  if (cronLogFor === job.label) setTimeout(() => loadCronLog(job.label), 1500);
}

// Deleting unloads the job and removes its plist. There is no undo, so the button
// asks first (armButton) and names the file that is going.
async function deleteCronJob(job) {
  if (!job) return;
  const r = await api.cron({ action: 'delete', label: job.label });
  if (r.error) return toast(r.error);
  state.crons = r.crons || state.crons;
  if (cronFocus === job.label) { cronFocus = null; cronLogFor = null; }
  toast(`deleted ${job.name}`);
  if (mode === 'crons') renderCrons();
}

// New jobs are launchd agents, written with the crontab syntax people already know.
// The command runs in a login shell from the folder given, and its output goes to
// ~/Library/Logs/pokeclaude/<label>.log, which is what the row's log then shows.
function openNewCron() {
  mode = 'newcron'; body.classList.remove('term-mode');
  setBack(() => openCrons(), 'Back to the timetable');
  setComposer(false, 'New cron · Esc to go back');
  body.innerHTML = `<div class="hd"><b>NEW CRON</b><span class="muted">launchd agent</span></div>
    <div class="sec"><span class="lbl">NAME</span>
      <input id="nc-name" placeholder="weekly sales report" spellcheck="false"></div>
    <div class="sec"><span class="lbl">SCHEDULE</span>
      <input id="nc-when" placeholder="0 9 * * 1" value="0 9 * * 1" spellcheck="false">
      <div class="muted">crontab syntax: minute hour day month weekday.
        <b>0 9 * * 1</b> is Monday 09:00, <b>*/30 * * * *</b> is every 30 minutes.</div></div>
    <div class="sec"><span class="lbl">FOLDER</span>
      <input id="nc-dir" placeholder="~/Projects/my-repo (optional)" spellcheck="false"></div>
    <div class="sec"><span class="lbl">COMMAND</span>
      <textarea id="nc-cmd" placeholder="claude -p &quot;…&quot; --output-format text"></textarea>
      <div class="muted">Runs in a login shell, so your PATH is the one you get in a terminal.</div></div>
    <div class="btns"><button id="nc-go" class="wide">SCHEDULE IT</button></div>
    <div id="nc-out" class="muted"></div>`;
  const nameEl = body.querySelector('#nc-name');
  nameEl.focus();
  const go = async () => {
    const out = body.querySelector('#nc-out');
    const cmd = body.querySelector('#nc-cmd').value.trim();
    if (!nameEl.value.trim() || !cmd) { out.textContent = 'A name and a command are both needed.'; return; }
    out.textContent = 'scheduling…';
    const r = await api.cron({ action: 'create', name: nameEl.value.trim(),
      schedule: body.querySelector('#nc-when').value.trim(), command: cmd,
      dir: body.querySelector('#nc-dir').value.trim() || null });
    if (r.error) { out.textContent = r.error; return; }
    state.crons = r.crons || state.crons;
    toast(r.warning ? r.warning : `scheduled ${r.label}`);
    cronFocus = r.label;
    openCrons(r.label);
  };
  body.querySelectorAll('#nc-name, #nc-when, #nc-dir').forEach(el => {
    el.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); };
  });
  body.querySelector('#nc-cmd').onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); }
    if (e.key === 'Escape') { e.preventDefault(); openCrons(); }
  };
  body.querySelector('#nc-go').onclick = go;
}

async function loadCronLog(label) {
  const r = await api.cronLog(label).catch(() => null);
  if (mode !== 'crons' || cronLogFor !== label) return;
  const el = document.getElementById('cron-log');
  if (!el) return;
  // The tail is what matters: a failure explains itself in its last lines.
  const text = r?.text ? r.text.split('\n').slice(-60).join('\n') : (r?.error || 'no log on disk');
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}
