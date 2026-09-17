// Which repos are hidden from the field and the list, and what order they are in.
// Both are per browser, both come out of this menu.
import { move, applyOrder, dropTarget } from './order.js';

const KEY = 'pc.hidden';
const ORDER_KEY = 'pc.order';
let hidden = new Set();
let order = [];
const listeners = new Set();
try { hidden = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch {}
try { order = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch {}
if (!Array.isArray(order)) order = [];

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {}
  for (const fn of listeners) fn();
}
export const isHidden = (plotId) => hidden.has(plotId);
export const hiddenCount = () => hidden.size;
export const repoOrder = () => order.slice();
export function toggle(plotId) {
  hidden.has(plotId) ? hidden.delete(plotId) : hidden.add(plotId);
  save();
}
export function showAll() { hidden.clear(); save(); }
export function hideAll(repos) { hidden = new Set(repos.map(r => r.id)); save(); }
// Reorder against the repos as they are listed NOW, not against the saved order:
// repos with no saved rank are on screen too and must be draggable like the rest.
export function reorder(repos, fromId, toId) {
  order = move(repos.map(r => r.id), fromId, toId);
  save();
}
export function onFilterChange(fn) { listeners.add(fn); }

// Build the dropdown. Lives on the field, opposite the zoom control.
export function mountFilter(town, onChanged) {
  const root = document.getElementById('filter-ctl');
  const btn = root.querySelector('#filter-btn');
  const menu = root.querySelector('#filter-menu');
  const label = root.querySelector('#filter-count');

  // never town.plots: that is the VISIBLE subset. Read town.repos each time; a grid
  // switch replaces the array wholesale.
  const all = () => applyOrder(town.repos, repoOrder());
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const refresh = () => {
    const n = hiddenCount(), total = all().length;
    label.textContent = n ? `${total - n}/${total}` : 'ALL';
    label.classList.toggle('on', n > 0);
    menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.checked = !isHidden(Number(cb.dataset.plot));
    });
  };

  // Dragging a row is done with pointer events, not HTML5 drag-and-drop: a draggable
  // row inside this menu never started a drag reliably, and every failed attempt fell
  // through to the row's click and hid the repo instead of moving it.
  let drag = null;                          // {id, y0, moved} while a row is held
  let dragEnd = 0;                          // when the last real drag let go

  const rowEls = () => [...menu.querySelectorAll('.f-repo')];
  const unmark = () => rowEls().forEach(r =>
    r.classList.remove('dragging', 'drop-above', 'drop-below'));
  const boxes = () => rowEls().map(r => {
    const b = r.getBoundingClientRect();
    return { id: Number(r.dataset.plot), top: b.top, height: b.height };
  });
  const rowFor = (id) => menu.querySelector(`.f-repo[data-plot="${id}"]`);
  const unmarkLines = () => rowEls().forEach(r =>
    r.classList.remove('drop-above', 'drop-below'));

  // Show where the held row will land, by the same rule move() uses: dragging down
  // puts it under the row it is over, dragging up puts it over that row.
  const markDrop = (y) => {
    const list = boxes();
    const over = dropTarget(list, y);
    unmarkLines();
    if (over === null || over === drag.id) return null;
    const ids = list.map(r => r.id);
    const down = ids.indexOf(drag.id) < ids.indexOf(over);
    rowFor(over)?.classList.add(down ? 'drop-below' : 'drop-above');
    return over;
  };

  const onMove = (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientY - drag.y0) < 4) return;  // a click, not a drag
    if (!drag.moved) { drag.moved = true; rowFor(drag.id)?.classList.add('dragging'); }
    e.preventDefault();
    markDrop(e.clientY);
  };
  const onUp = (e) => {
    if (!drag) return;
    const held = drag;
    const over = held.moved ? markDrop(e.clientY) : null;
    drag = null;
    unmark();
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    if (!held.moved) return;                // no movement: the click handler has it
    dragEnd = e.timeStamp;
    if (over !== null && over !== held.id) {
      reorder(all(), held.id, over);
      render();
    }
    onChanged?.();
  };

  const render = () => {
    menu.innerHTML = `<div class="f-row f-actions">
        <button id="f-all">Show all</button><button id="f-none">Hide all</button></div>` +
      // A row is a div, not a label: a label toggles its checkbox on any mouseup
      // inside it, which turns the end of a drag into a hidden repo.
      all().map(r => `<div class="f-row f-repo" data-plot="${r.id}">
        <span class="f-grip" aria-hidden="true">⠿</span>
        <input type="checkbox" data-plot="${r.id}" checked>
        <span class="f-swatch" style="background:rgb(${r.tint.join(',')})"></span>
        <span>${esc(r.sign)}</span></div>`).join('');

    menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.onchange = () => { toggle(Number(cb.dataset.plot)); refresh(); onChanged?.(); };
    });
    menu.querySelector('#f-all').onclick = () => { showAll(); refresh(); onChanged?.(); };
    menu.querySelector('#f-none').onclick = () => { hideAll(all()); refresh(); onChanged?.(); };

    rowEls().forEach(row => {
      const id = Number(row.dataset.plot);
      // The row reads as one target: anywhere on it toggles the repo, as the label
      // used to. A drag that ended here is not a click and must not toggle anything.
      row.onclick = (e) => {
        if (e.target.tagName === 'INPUT') return;      // the box fires its own change
        if (e.timeStamp - dragEnd < 400) return;       // the tail of a drag, not a click
        const cb = row.querySelector('input');
        cb.checked = !cb.checked;
        cb.onchange();
      };
      row.onpointerdown = (e) => {
        if (e.button !== 0) return;
        drag = { id, y0: e.clientY, moved: false };
        addEventListener('pointermove', onMove);
        addEventListener('pointerup', onUp);
      };
    });
    refresh();
  };
  render();

  // Any change to the set refreshes the button and the boxes, wherever it came from.
  onFilterChange(refresh);
  btn.onclick = (e) => { e.stopPropagation(); root.classList.toggle('open'); };
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) root.classList.remove('open');
  });
  refresh();
}
