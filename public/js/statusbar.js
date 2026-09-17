// A status line across the bottom, in the spirit of Claude Code's own footer: what the
// fleet is doing, what is serving, and how much of the account's usage window is gone.
const el = {
  fleet: document.getElementById('sb-fleet'),
  svc: document.getElementById('sb-svc'),
  usage: document.getElementById('sb-usage'),
  view: document.getElementById('sb-view'),
};

function meter(pct) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const cls = p >= 90 ? 'crit' : p >= 70 ? 'hot' : '';
  return `<span class="sb-meter ${cls}"><i style="width:${p}%"></i></span>`;
}

export function renderStatus({ agents = [], usage = null, town = null, scale = 1, hidden = 0,
                               selected = null }) {
  // With an agent selected the left half becomes that agent: its repo, branch, model,
  // context and mode. Deselect and it goes back to the whole fleet.
  if (selected) {
    const a = agents.find(x => x.workspaceId === selected.workspaceId) || selected;
    const ctx = a.contextPct;
    const stateCls = a.status === 'BLOCKED' ? 'sb-block'
      : ['WORKING', 'THINKING'].includes(a.status) ? 'sb-work' : 'sb-idle';
    el.fleet.innerHTML =
      `<span class="sb-n">${esc(selected.sign || '')}</span>` +
      `<span class="sb-dim">${esc(selected.species || '')}</span>` +
      `<span class="${stateCls}">${esc(a.kind === 'service' ? 'SERVING' : a.status)}</span>` +
      (a.branch ? `<span class="sb-sep"></span><span class="sb-dim">⑂</span>${esc(a.branch)}${a.gitDirty ? '*' : ''}` : '');
    el.svc.innerHTML =
      (a.model ? `<span class="sb-dim">${esc(a.model)}</span>` : '<span class="sb-dim">model –</span>') +
      (ctx != null
        ? `<span class="sb-sep"></span>ctx ${meter(ctx)} <span class="${ctx >= 80 ? 'sb-block' : 'sb-n'}">${ctx}%</span>`
        : '<span class="sb-sep"></span><span class="sb-dim">ctx –</span>') +
      (a.permissionMode ? `<span class="sb-sep"></span><span class="sb-dim">${esc(a.permissionMode)}</span>` : '') +
      ((a.ports || []).length ? `<span class="sb-sep"></span><span class="sb-svc">:${a.ports.join(' :')}</span>` : '');
    renderTail({ usage, town, scale, hidden });
    return;
  }
  renderFleet({ agents, usage, town, scale, hidden });
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

function renderTail({ usage, town, scale, hidden }) {
  el.usage.innerHTML = usage
    ? `5h ${meter(usage.window5h)} <span class="sb-n">${usage.window5h ?? '–'}%</span>` +
      (usage.resets5h ? `<span class="sb-dim">↻${esc(usage.resets5h)}</span>` : '') +
      `<span class="sb-sep"></span>` +
      `7d ${meter(usage.window7d)} <span class="sb-n">${usage.window7d ?? '–'}%</span>`
    : '<span class="sb-dim">usage: sampling…</span>';
  const repos = town ? town.repos.length : 0;
  el.view.innerHTML =
    `<span class="sb-dim">${town ? town.size + '×' + town.size : ''}</span>` +
    `<span class="sb-n">${repos - hidden}</span>/<span>${repos}</span> repos` +
    `<span class="sb-dim">${Math.round(scale * 100)}%</span>`;
}

function renderFleet({ agents, usage, town, scale, hidden }) {
  const blocked = agents.filter(a => a.status === 'BLOCKED').length;
  const working = agents.filter(a => ['WORKING', 'THINKING'].includes(a.status)).length;
  const idle = agents.filter(a => a.status === 'ASLEEP').length;
  const services = agents.filter(a => a.kind === 'service');

  el.fleet.innerHTML =
    `<span class="sb-n">${agents.length}</span> agents` +
    `<span class="sb-block">${blocked}</span> waiting` +
    `<span class="sb-work">${working}</span> working` +
    `<span class="sb-idle">${idle}</span> idle`;

  // Context pressure is the thing that actually bites: an agent near its limit will
  // start compacting or fail, and it is invisible unless you open it.
  const withCtx = agents.filter(a => a.contextPct != null);
  const hot = withCtx.filter(a => a.contextPct >= 80);
  const worst = withCtx.length ? Math.max(...withCtx.map(a => a.contextPct)) : null;
  const models = [...new Set(agents.map(a => a.model).filter(Boolean))];
  el.fleet.innerHTML +=
    (worst != null
      ? `<span class="sb-sep"></span>ctx ${meter(worst)} <span class="${hot.length ? 'sb-block' : 'sb-n'}">${worst}%</span>` +
        `<span class="sb-dim">max${hot.length ? ` · ${hot.length} over 80%` : ''}</span>`
      : '') +
    (models.length ? `<span class="sb-sep"></span><span class="sb-dim">${models.join(' · ')}</span>` : '');

  el.svc.innerHTML = services.length
    ? services.map(s => `<span class="sb-svc">▤ ${(s.ports || []).map(p => ':' + p).join(' ') || 'up'}</span>`).join('')
    : '<span class="sb-dim">no services</span>';

  renderTail({ usage, town, scale, hidden });
}
