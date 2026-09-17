import { elapsed } from './fmt.js';
const cache = new Map();
export function img(src) {
  if (!cache.has(src)) { const i = new Image(); i.src = src; cache.set(src, i); }
  return cache.get(src);
}
const ROW = { down: 0, left: 1, right: 2, up: 3 };
const WALK = [0, 1, 0, 2];          // stand, step, stand, other step
const FW = 32, FH = 38;             // see tools/gen_overworld.py: real frame grid

export function drawTrainer(ctx, variant, x, y, facing, frame) {
  const sheet = img(`/art/trainers/variant-${variant}.png`);
  if (!sheet.complete || !sheet.naturalWidth) return;
  ctx.drawImage(sheet, WALK[frame] * FW, ROW[facing] * FH, FW, FH,
    Math.round(x - FW / 2), Math.round(y - FH + 6), FW, FH);
}
// Agents are Pokémon: one species per agent, stable across restarts.
// The pack is single-frame, so a 1px vertical bob reads as walking.
export function drawPoke(ctx, id, x, y, facing, frame = 0, moving = false) {
  const i = img(`/art/pokemon/${facing}/${id}.png`);
  if (!i.complete || !i.naturalWidth) return y - 20;
  const bob = moving && (frame === 1 || frame === 3) ? 1 : 0;
  const top = Math.round(y - i.naturalHeight + 6 + bob);
  ctx.drawImage(i, Math.round(x - i.naturalWidth / 2), top);
  return top;                       // callers anchor bubbles to the real sprite top
}

// Subagents trail their parent as Poké Balls. Drawn, not loaded: 8px, always crisp.
export function drawBall(ctx, x, y, t) {
  const r = 4, cy = y - 4 + Math.sin(t * 6) * 1.5;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, cy, r, Math.PI, 0); ctx.fillStyle = '#e03b30'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI); ctx.fillStyle = '#f4f4f4'; ctx.fill();
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - r, cy); ctx.lineTo(x + r, cy); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, cy, 1.4, 0, Math.PI * 2); ctx.fillStyle = '#f4f4f4'; ctx.fill(); ctx.stroke();
  ctx.restore();
}
export function bubble(ctx, x, top, kind, bob) {
  const by = top + 34 + Math.sin(bob * 5) * 2;   // keeps the old geometry
  ctx.save();
  if (kind === 'warn' || kind === 'warn2') {
    // Escalation: it has been waiting long enough that it is now a problem.
    const two = kind === 'warn2';
    const mark = two ? '!!' : '!';
    const w = two ? 17 : 12, h = 13, bx = x - w / 2, byy = by - 44;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c62828'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(bx, byy, w, h, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c62828'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(mark, x, byy + h - 3);
  } else if (kind === 'ask' || kind === 'ask2') {
    // A waiting agent has asked you something, so it shows a question in a blue
    // speech bubble. The older it gets, the deeper the blue.
    const deep = kind === 'ask2';
    const w = 19, h = 13, bx = x - w / 2, byy = by - 44;
    ctx.fillStyle = deep ? '#0648C0' : '#4d8bf0';
    ctx.strokeStyle = '#08214f'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(bx, byy, w, h, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 2.5, byy + h); ctx.lineTo(x + 1.5, byy + h);
    ctx.lineTo(x - 0.5, byy + h + 3.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    // three dots: it is mid-conversation with you, waiting on your reply
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x - 5 + i * 5, byy + h / 2, deep ? 1.7 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (deep) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#0648C0';
      ctx.beginPath(); ctx.arc(x + 11, byy + 3, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  } else if (kind === 'z') {
    // Claude finished and went quiet: three small z's drifting up. Deliberately faint,
    // so a finished agent reads as calm rather than as something needing attention.
    ctx.textAlign = 'center';
    const drift = Math.sin(bob * 1.6) * 1.2;
    for (let i = 0; i < 3; i++) {
      const p = ((bob * 0.35) + i / 3) % 1;
      ctx.globalAlpha = 0.5 * (1 - p) + 0.18;
      ctx.fillStyle = '#4a5160';
      ctx.font = 'bold ' + (6 + i) + 'px monospace';
      ctx.fillText('z', x + 7 + i * 2.5 + drift, by - 34 - p * 12 - i * 3);
    }
    ctx.globalAlpha = 1;
  } else if (kind === 'x') {
    ctx.fillStyle = '#c62828'; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
    ctx.fillText(String.fromCharCode(10005), x, by - 36);
  }
  ctx.restore();
}

export function waitLabel(ctx, x, y, ms) {
  const s = elapsed(ms);
  ctx.save(); ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
  const w = s.length * 5 + 6;
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect(x - w / 2, y + 1, w, 9, 2); ctx.fill();
  ctx.fillStyle = '#ffd9d9'; ctx.fillText(s, x, y + 8); ctx.restore();
}
// x is the LEFT edge, or the CENTRE when `center` is set (the sign over a house).
export function signPlate(ctx, x, y, text, blocked, t, center = false) {
  ctx.save();
  ctx.font = 'bold 7px monospace'; ctx.textAlign = 'left';
  const w = Math.max(26, text.length * 4.3 + 8);
  if (center) x = Math.round(x - w / 2);
  const flash = blocked && Math.floor(t * 2) % 2 === 0;
  ctx.fillStyle = flash ? '#ffe3e0' : '#f7efc9';
  ctx.strokeStyle = flash ? '#c62828' : '#6b5b1e'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, y - 6, w, 11, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#2a2410'; ctx.fillText(text, x + 4, y + 2);
  if (blocked) {
    ctx.fillStyle = '#c62828'; ctx.beginPath(); ctx.arc(x + w, y - 5, 4.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 6px monospace'; ctx.textAlign = 'center';
    ctx.fillText(String(blocked), x + w, y - 3);
  }
  ctx.restore();
}

// ---- "it is doing something" tells ----

// Short glyph per tool, so a pop says WHAT it just did, not merely that it did something.
const TOOL_GLYPH = {
  Bash: '>_', Read: '=', Edit: '/', Write: '/', NotebookEdit: '/',
  Grep: '?', Glob: '?', WebFetch: '@', WebSearch: '@', Task: '*', Agent: '*',
  TodoWrite: '+', Artifact: '#', Skill: '^',
};

// A small card that rises and fades above the head on every real tool call.
export function toolPop(ctx, x, top, tool, age) {
  const k = Math.min(1, age / 2.4);
  const rise = 8 * Math.min(1, age / 0.35);
  const alpha = age < 1.7 ? 1 : 1 - (age - 1.7) / 0.7;
  const label = TOOL_GLYPH[tool] || '*';
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
  const w = Math.max(14, label.length * 5 + 8), y = top - 12 - rise;
  ctx.fillStyle = '#fdfdf5'; ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 8, w, 11, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#1b5e20'; ctx.fillText(label, x, y);
  ctx.restore();
}

// Cycling dots while the model is thinking with no tool call open.
export function thinking(ctx, x, top, t) {
  const n = 1 + (Math.floor(t * 2.5) % 3);
  ctx.save();
  ctx.fillStyle = '#fdfdf5'; ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x - 9, top - 20, 18, 11, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#555'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
  ctx.fillText('.'.repeat(n), x, top - 12);
  ctx.restore();
}

// Faint dust at the feet of a moving sprite: it reads as effort.
export function dust(ctx, x, y, t) {
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#e8d9a8';
  for (let i = 0; i < 2; i++) {
    const p = (t * 2 + i * 0.5) % 1;
    ctx.beginPath();
    ctx.arc(x + (i ? 5 : -5) * p, y - 1 - p * 3, 2.2 * (1 - p) + 0.6, 0, 7);
    ctx.fill();
  }
  ctx.restore();
}

// Marks the agent whose conversation is open in the panel: a soft ring at its feet
// plus a bobbing arrow. Replaces walking the player over on every click.
export function selectMark(ctx, x, footY, t) {
  ctx.save();
  ctx.strokeStyle = '#0648C0'; ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.ellipse(x, footY + 1, 11, 4.5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 0.18; ctx.fillStyle = '#0648C0'; ctx.fill();
  ctx.globalAlpha = 1;
  const dy = Math.sin(t * 4) * 1.5;
  ctx.fillStyle = '#0648C0';
  ctx.beginPath();
  ctx.moveTo(x, footY - 34 + dy); ctx.lineTo(x - 4, footY - 40 + dy); ctx.lineTo(x + 4, footY - 40 + dy);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// A service workspace (dev server, tunnel) keeps its Pokemon. This is the overlay
// that marks it as one: exhaust drifting up OVER the sprite, and its port floating
// above. Call it after drawPoke so the puffs pass in front of the creature.
export function serviceMark(ctx, x, spriteTop, footY, port, t, up = true) {
  ctx.save();
  if (up) {
    for (let i = 0; i < 3; i++) {
      const p = ((t * 0.55) + i / 3) % 1;                 // 0..1 lifetime
      const py = footY - 6 - p * (footY - spriteTop);     // rises across the body
      const drift = Math.sin((t * 2) + i * 2.1) * 3;
      ctx.globalAlpha = 0.40 * (1 - p);
      ctx.fillStyle = '#dfe6ee';
      ctx.beginPath(); ctx.arc(x + drift, py, 1.6 + p * 3.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (port) {
    ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
    const label = ':' + port, lw = label.length * 4.6 + 8;
    const ly = spriteTop - 13;
    ctx.fillStyle = '#12161c'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x - lw / 2, ly, lw, 11, 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = up ? '#9fd6a6' : '#ff6b60'; ctx.fillText(label, x, ly + 8);
  }
  ctx.restore();
}

// A cron job keeps its Pokemon too. Floating above it is the one fact that matters:
// when it next fires, or why it needs you. Red means the schedule is not working
// (last run failed, or it stopped firing); green means it is running right now.
const CRON_COL = { failed: '#ff6b60', stalled: '#ff6b60', unloaded: '#8a8f99',
                   running: '#9fd6a6', due: '#ffd479', ok: '#cfd6e0' };
export function cronMark(ctx, x, spriteTop, footY, label, state, t) {
  ctx.save();
  if (state === 'running') {                        // it is working: same exhaust as a service
    for (let i = 0; i < 3; i++) {
      const p = ((t * 0.55) + i / 3) % 1;
      ctx.globalAlpha = 0.40 * (1 - p);
      ctx.fillStyle = '#dfe6ee';
      ctx.beginPath();
      ctx.arc(x + Math.sin((t * 2) + i * 2.1) * 3, footY - 6 - p * (footY - spriteTop),
              1.6 + p * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
  const lw = label.length * 4.6 + 10, ly = spriteTop - 13;
  ctx.fillStyle = '#12161c'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x - lw / 2, ly, lw, 11, 2); ctx.fill(); ctx.stroke();
  // A tiny clock face on the left of the chip, so the pen reads as a timetable.
  ctx.strokeStyle = CRON_COL[state] || '#cfd6e0'; ctx.lineWidth = 1;
  const kx = x - lw / 2 + 5, ky = ly + 5.5;
  ctx.beginPath(); ctx.arc(kx, ky, 3, 0, Math.PI * 2); ctx.stroke();
  const a = state === 'running' ? t * 3 : 5.6;
  ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(kx + Math.cos(a) * 2, ky + Math.sin(a) * 2); ctx.stroke();
  ctx.fillStyle = CRON_COL[state] || '#cfd6e0';
  ctx.fillText(label, x + 4, ly + 8);
  ctx.restore();
}

// The front desk's computer: a little CRT on a table, next to Ash. The screen is
// TURNED TOWARDS the seat, drawn in three-quarter view, so it is obvious who it
// belongs to; `dir` is +1 when Pikachu sits to the right of it, -1 to the left. It is
// dark until there is work on the field, so the desk says at a glance whether anything
// is happening. Drawn, not loaded: it stays crisp at every zoom like the rest of the HUD.
export function deskPC(ctx, x, y, on, t, dir = 1) {
  const d = dir >= 0 ? 1 : -1;
  ctx.save();
  // table
  ctx.fillStyle = '#8a5a34'; ctx.fillRect(x - 9, y - 5, 18, 3);
  ctx.fillStyle = '#6b4526'; ctx.fillRect(x - 8, y - 2, 2, 4); ctx.fillRect(x + 6, y - 2, 2, 4);
  // stand
  ctx.fillStyle = '#3d4450'; ctx.fillRect(x - 2, y - 8, 4, 3);
  // shell, seen from behind: the case sits on the far side of the screen
  ctx.fillStyle = '#9aa3af';
  ctx.fillRect(x - d * 7, y - 18, 8, 11);
  ctx.fillStyle = '#7b8593'; ctx.fillRect(x - d * 7, y - 18, 8, 2);
  // screen face, angled towards the seat
  const nx = x + d * 1, fx = x + d * 6;
  ctx.beginPath();
  ctx.moveTo(nx, y - 18); ctx.lineTo(fx, y - 16); ctx.lineTo(fx, y - 6); ctx.lineTo(nx, y - 8);
  ctx.closePath();
  ctx.fillStyle = '#cfd6e0'; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(nx + d, y - 17); ctx.lineTo(fx - d, y - 15.4); ctx.lineTo(fx - d, y - 7.4);
  ctx.lineTo(nx + d, y - 9); ctx.closePath();
  ctx.fillStyle = on ? '#0c2b16' : '#12161c'; ctx.fill();
  if (on) {
    // output scrolling up the screen, and a cursor blinking under it
    ctx.save(); ctx.clip();
    ctx.fillStyle = '#8fbf7f';
    for (let i = 0; i < 4; i++) {
      const p = ((t * 0.9) + i / 4) % 1;
      const row = y - 8 - p * 9;
      const w = 2 + ((i * 3 + Math.floor(t * 2)) % 3) * 1.4;
      ctx.globalAlpha = 0.35 + 0.5 * (1 - Math.abs(0.5 - p) * 2);
      ctx.fillRect(d > 0 ? nx + 1 : fx, row, w, 1);
    }
    ctx.globalAlpha = Math.floor(t * 3) % 2 ? 0.95 : 0.25;
    ctx.fillRect(d > 0 ? nx + 1 : fx, y - 10, 2, 1.6);          // cursor
    ctx.restore();
    // the light falls on whoever is sitting at it
    ctx.globalAlpha = 0.18 + Math.sin(t * 9) * 0.05;
    ctx.fillStyle = '#8fbf7f';
    ctx.beginPath();
    ctx.moveTo(fx, y - 15); ctx.lineTo(fx + d * 9, y - 17); ctx.lineTo(fx + d * 9, y - 1);
    ctx.lineTo(fx, y - 7); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // keyboard, on the seat's side of the table
  ctx.fillStyle = '#e7e3d4'; ctx.fillRect(x + (d > 0 ? 0 : -6), y - 5, 6, 2);
  ctx.restore();
}

// Two small keystroke ticks beside the sprite that is typing. Nothing but motion:
// the Pokemon sheets have no typing pose, so the tell has to be around it.
export function keystrokes(ctx, x, y, t, dir = 1) {
  const d = dir >= 0 ? 1 : -1;
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const p = ((t * 1.8) + i / 3) % 1;
    ctx.globalAlpha = 0.75 * (1 - p);
    ctx.fillStyle = i % 2 ? '#8fbf7f' : '#3d4450';
    const wob = Math.sin((t * 6) + i) * 1.5;
    ctx.fillRect(Math.round(x + d * (4 + i) + wob), Math.round(y - 6 - p * 10), 2, 2);
  }
  ctx.restore();
}

// The 1px bounce of someone hammering a keyboard. Kept here with the rest of the
// motion so the loop stays a list of what to draw, not how it moves.
export const typeBob = (t) => (Math.floor(t * 9) % 2 ? -1 : 0);
