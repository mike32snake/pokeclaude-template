// Scheduled work, read from the machine itself: launchd agents in ~/Library/LaunchAgents
// plus the user crontab. Nothing is stored; every field comes from a real source.
//   schedule   <- StartCalendarInterval / StartInterval in the plist
//   lastRun    <- mtime of the job's StandardOutPath log
//   lastStatus <- `launchctl list` exit code (0 ok, anything else is a failure)
//   running    <- launchctl reporting a live PID
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function crontabId(schedule, command, occurrence = 0) {
  return 'crontab:' + createHash('sha256').update(JSON.stringify([schedule.trim().replace(/\s+/g, ' '), command, occurrence])).digest('hex').slice(0, 24);
}

const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

const run = (cmd, args) => new Promise((done) =>
  execFile(cmd, args, { timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
    (err, out) => done(err && !out ? null : (out || ''))));

// `launchctl list` -> { label: { pid, status } }
async function launchctlState() {
  const out = await run('launchctl', ['list']);
  const map = new Map();
  for (const line of (out || '').split('\n').slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    map.set(m[3].trim(), {
      pid: m[1] === '-' ? null : Number(m[1]),
      status: m[2] === '-' ? null : Number(m[2]),
    });
  }
  return map;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

function describeCalendar(cal) {
  const parts = [];
  if (cal.Weekday != null) parts.push(DAYS[cal.Weekday % 7]);
  if (cal.Day != null) parts.push('day ' + cal.Day);
  if (cal.Month != null) parts.push('month ' + cal.Month);
  const time = cal.Hour != null ? `${pad(cal.Hour)}:${pad(cal.Minute ?? 0)}` : 'every hour';
  return parts.length ? `${parts.join(' ')} ${time}` : `daily ${time}`;
}

// Next time a StartCalendarInterval fires, searched minute-agnostically over 60 days.
function nextCalendarRun(cal, from = new Date()) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cal.Minute != null && d.getMinutes() !== cal.Minute) continue;
    if (cal.Hour != null && d.getHours() !== cal.Hour) continue;
    if (cal.Weekday != null && d.getDay() !== cal.Weekday % 7) continue;
    if (cal.Day != null && d.getDate() !== cal.Day) continue;
    if (cal.Month != null && d.getMonth() + 1 !== cal.Month) continue;
    return d.getTime();
  }
  return null;
}

// Standard 5-field crontab: minute hour day-of-month month day-of-week.
// Supports *, lists, ranges and steps, which is everything a real crontab uses.
function cronField(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) return null;
    const [, range, stepStr] = match;
    const step = stepStr == null ? 1 : Number(stepStr);
    let lo = min, hi = max;
    if (range !== '*') {
      const [a, b2] = range.split('-');
      lo = Number(a); hi = b2 == null ? (stepStr ? max : Number(a)) : Number(b2);
    }
    // Bound before expanding: a browser-supplied range must never allocate a Set
    // larger than the field, blocking the server before validation runs.
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) ||
        !Number.isSafeInteger(step) || step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function nextCrontabRun(spec, from = new Date()) {
  const f = spec.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = [
    cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31),
    cronField(f[3], 1, 12), cronField(f[4], 0, 6)];
  if (!mi || !ho || !dom || !mo || !dow) return null;
  const domAny = f[2] === '*', dowAny = f[4] === '*';
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (!mi.has(d.getMinutes()) || !ho.has(d.getHours()) || !mo.has(d.getMonth() + 1)) continue;
    // cron's own rule: with both day fields set, either one matching is enough
    const dayOk = domAny && dowAny ? true
      : domAny ? dow.has(d.getDay())
      : dowAny ? dom.has(d.getDate())
      : dom.has(d.getDate()) || dow.has(d.getDay());
    if (dayOk) return d.getTime();
  }
  return null;
}

// A crontab line is a shell command. Name it after the script it runs, not the `cd`
// that happens to come first, or the list is a wall of identical prefixes.
function crontabName(cmd) {
  const script = cmd.match(/([\w.-]+\.(?:sh|py|js|ts|rb|php))/);
  if (script) return script[1];
  const last = cmd.split(/&&|;|\|/).pop().trim();
  return last.split(/\s+/).slice(0, 3).join(' ').slice(0, 40) || cmd.slice(0, 40);
}

function readPlist(file) {
  return new Promise((done) =>
    execFile('plutil', ['-convert', 'json', '-o', '-', file], { timeout: 5000 },
      (err, out) => {
        if (err) return done(null);
        try { done(JSON.parse(out)); } catch { done(null); }
      }));
}

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };

export async function listCrons() {
  let files = [];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.plist'));
  } catch { return []; }

  const state = await launchctlState();
  const jobs = [];

  for (const f of files) {
    const p = await readPlist(path.join(AGENTS_DIR, f));
    if (!p?.Label) continue;
    // Only scheduled work; plain login items are not crons.
    const cals = p.StartCalendarInterval
      ? (Array.isArray(p.StartCalendarInterval) ? p.StartCalendarInterval : [p.StartCalendarInterval])
      : [];
    const interval = typeof p.StartInterval === 'number' ? p.StartInterval : null;
    if (!cals.length && interval == null) continue;

    const live = state.get(p.Label) || {};
    const last = p.StandardOutPath ? mtime(p.StandardOutPath) : null;
    const lastErr = p.StandardErrorPath ? mtime(p.StandardErrorPath) : null;
    const nexts = cals.map(c => nextCalendarRun(c)).filter(Boolean);
    const next = interval != null && last
      ? last + interval * 1000
      : (nexts.length ? Math.min(...nexts) : null);

    // args[2] of a `zsh -lc "..."` job is a shell command. Everything else is a plain
    // argv, and a `-p` prompt inside it must be lifted OUT before the rest is joined:
    // a page of prompt text names files the job never runs, and the first one wins.
    const argv = p.ProgramArguments || [];
    const shell = /^-[a-z]*c$/.test(argv[1] || '');
    const pi = shell ? -1 : argv.findIndex(a => a === '-p' || a === '--print');
    const prompt = pi >= 0 && argv[pi + 1] && !argv[pi + 1].startsWith('-') ? argv[pi + 1] : null;
    const command = shell ? (argv[2] || '')
      : argv.filter((_, i) => !(prompt && i === pi + 1)).join(' ');
    const { desc, project, undocumented } = describeJob({
      command, prompt, program: shell ? null : argv[0], dir: p.WorkingDirectory || null,
      script: shell ? null : argv.find(a => /\.(sh|py|js|mjs|ts|rb|php)$/.test(a)) });

    jobs.push({
      label: p.Label,
      name: p.Label.replace(/^(com|ai)\.[^.]+\./, ''),
      desc, project, undocumented, command,
      schedule: cals.length ? cals.map(describeCalendar).join(', ') : `every ${Math.round(interval / 60)} min`,
      dir: p.WorkingDirectory || null,
      next,
      lastRun: last,
      lastErrAt: lastErr,
      status: live.status ?? null,
      running: Boolean(live.pid),
      loaded: state.has(p.Label),
      logPath: p.StandardOutPath || null,
      usesClaude: JSON.stringify(p.ProgramArguments || []).includes('claude'),
    });
  }

  // The crontab is a second, easily forgotten source of scheduled work.
  const tab = await run('crontab', ['-l']);
  const occurrences = new Map();
  for (const line of (tab || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const identity = crontabId(m[1], m[2]);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    const { desc, project, undocumented } = describeJob({ command: m[2], dir: null });
    jobs.push({
      label: crontabId(m[1], m[2], occurrence), name: crontabName(m[2]),
      desc, project, undocumented,
      schedule: m[1], command: m[2], dir: null, next: nextCrontabRun(m[1]),
      lastRun: null, status: null, running: false, loaded: true, logPath: null,
      usesClaude: m[2].includes('claude'), isCrontab: true,
    });
  }

  jobs.sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  return jobs;
}

// ---------- what a job actually does ----------
// A name like "weekly-traffic-report" says WHEN a job runs, never what it does or which
// project it belongs to; two jobs can carry that exact name. The sentence below
// comes from a real file the job itself names, in this order:
//   the prompt fed to claude   -> $(cat x.md) heading, or the first sentence of -p '...'
//   the script it runs         -> the header comment under the shebang
//   the command itself         -> last resort: what runs, and in which folder
// Nothing is invented and no model is called; if a job documents nothing, it says so.

const unquote = (m) => (m ? (m[1] ?? m[2] ?? m[3] ?? null) : null);

export function cdDir(cmd) {
  return unquote(String(cmd || '').match(
    /(?:^|&&|;|\n)\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/));
}

export function promptFileOf(cmd) {
  return unquote(String(cmd || '').match(
    /\$\(\s*cat\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))\s*\)/));
}

// `claude -p 'text'`. The shell writes an apostrophe inside single quotes as '"'"', so the
// first closing quote can land mid-word; that is fine, only the first sentence is wanted.
export function inlinePromptOf(cmd) {
  const m = String(cmd || '').match(/-p\s+(?:"([^"]+)"|'([^']+)')/);
  const text = m ? (m[1] ?? m[2]) : null;
  return text && !text.includes('$(') ? text.trim() : null;
}

export function scriptOf(cmd) {
  const m = String(cmd || '').match(/(?:^|[\s"'=])((?:[\w./~-]*\/)?[\w.-]+\.(?:sh|py|js|mjs|ts|rb|php))/);
  return m ? m[1] : null;
}

// The first heading of a prompt file, or failing that its first real line.
export function headingOf(text) {
  for (const raw of String(text || '').split('\n').slice(0, 20)) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^#{1,3}\s+(.+)$/);
    // A trailing colon is heading punctuation; a full stop is part of a real sentence.
    return (h ? h[1] : line).replace(/\s*:$/, '').trim() || null;
  }
  return null;
}

// Lines of a header, joined only while the sentence is unfinished: a line ending in a
// comma continues, so does one whose next line starts lower case; a new capitalised line
// is a new sentence and stops the join.
function joinLines(lines) {
  const parts = [];
  for (const raw of lines) {
    const text = raw.trim().replace(/^[-*]\s*/, '');
    if (!text) { if (parts.length) break; continue; }
    const prev = parts[parts.length - 1];
    if (prev) {
      if (/[.!?]$/.test(prev)) break;
      if (!/[,;:-]$/.test(prev) && !/^[a-z0-9]/.test(text)) break;
    }
    parts.push(text);
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(' ') : null;
}

// What a script says about itself at the top: a python or js docstring block, or the
// comment lines under the shebang.
export function commentBlurb(src) {
  const text = String(src || '');
  // A docstring or /** */ header: read the lines after the opener, not the whole block.
  // The block itself can run for pages, and joinLines stops at the first blank line.
  const open = text.match(/^(?:#![^\n]*\n)?\s*("""|'''|\/\*\*?)/);
  if (open) {
    const joined = joinLines(text.slice(open[0].length).split('\n')
      .map(l => l.replace(/^\s*\*+\s?/, '').replace(/("""|'''|\*\/)[\s\S]*$/, '')));
    if (joined) return joined;
  }
  const lines = [];
  for (const raw of text.split('\n').slice(0, 12)) {
    const line = raw.trim();
    if (line.startsWith('#!')) continue;
    const c = line.match(/^(?:#|\/\/)\s?(.*)$/);
    if (!c) { if (lines.length || line) break; continue; }
    lines.push(c[1]);
  }
  return joinLines(lines);
}

// One sentence, cut at a word boundary if it runs long. Abbreviations like "Foo.md"
// survive because a sentence only ends at a full stop followed by a space.
export function firstSentence(text, max = 150) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const end = flat.search(/[.!?](\s|$)/);
  let out = end > 0 ? flat.slice(0, end + 1) : flat;
  if (out.length > max) {
    const cut = out.slice(0, max);
    out = cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.-]+$/, '') + '…';
  }
  return out;
}

const readHead = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    return buf.slice(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
};

// Reads are cached on (path, mtime): the list is re-sampled every minute and these files
// almost never change, but a job edited today must describe itself correctly today.
const blurbCache = new Map();
export function readCached(file) {
  let stamp;
  try { stamp = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = blurbCache.get(file);
  if (hit && hit.stamp === stamp) return hit.text;
  let text = null;
  try { text = readHead(file); } catch { text = null; }
  blurbCache.set(file, { stamp, text });
  return text;
}

// { desc, project } for one job. `read` is injected so this stays testable and so a
// permission error on one file can never take the whole cron list down with it.
export function describeJob(job, read = readCached) {
  const cmd = String(job?.command || '');
  const base = job?.dir || cdDir(cmd) || null;
  // Home is where a job with no project of its own runs; naming it says nothing.
  const project = base && path.resolve(base) !== os.homedir()
    ? path.basename(base.replace(/\/+$/, '')) : null;
  const at = (f) => (f && f.startsWith('/') ? f : base ? path.join(base, f) : null);
  const slurp = (f) => { try { return f ? read(f) : null; } catch { return null; } };

  const promptFile = promptFileOf(cmd);
  if (promptFile) {
    const heading = headingOf(slurp(at(promptFile)));
    if (heading) return { desc: firstSentence(heading), project };
  }

  const inline = job?.prompt || inlinePromptOf(cmd);
  if (inline) return { desc: firstSentence(inline), project };

  // A path with a space in it survives only in the argv; the joined command splits it.
  const script = job?.script || scriptOf(cmd);
  if (script) {
    const blurb = commentBlurb(slurp(at(script)));
    if (blurb) return { desc: firstSentence(blurb), project };
  }

  // Undocumented: say what runs, which is still more than the name alone.
  // argv[0] is the only reliable program name: joining an argv loses the quoting, so a
  // path with a space in it ("Application Support") reads as two arguments.
  const first = job?.program || cmd.trim().split(/\s+/)[0] || '';
  const what = script ? path.basename(script)
    : first.startsWith('/') ? path.basename(first) : crontabName(cmd);
  return { desc: firstSentence(`Runs ${what}`), project, undocumented: true };
}

// ---------- creating, running and deleting jobs ----------
// A job the panel creates is a launchd agent like any other: a plist in
// ~/Library/LaunchAgents, its own log file, and a schedule translated from the
// crontab syntax people already know. Nothing here is stored by the app.

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'pokeclaude');
const UID = process.getuid ? process.getuid() : 501;
const domain = (label) => `gui/${UID}/${label}`;

// The label is the job's identity for launchctl, so it must be stable and safe.
export function cronLabel(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
  return slug ? 'com.pokeclaude.' + slug : null;
}

// Crontab syntax in, launchd schedule out. "*/N * * * *" becomes StartInterval,
// which is what launchd is actually good at; everything else becomes one
// StartCalendarInterval entry per combination, with wildcards left out entirely
// (a missing key IS the wildcard).
const MAX_ENTRIES = 60;
export function cronToLaunchd(spec) {
  const f = String(spec || '').trim().split(/\s+/);
  if (f.length !== 5) return { error: 'A schedule needs five fields: minute hour day month weekday' };
  const [mi, ho, dom, mo, dow] = f;

  const step = mi.match(/^\*\/(\d+)$/);
  if (step && ho === '*' && dom === '*' && mo === '*' && dow === '*') {
    const n = Number(step[1]);
    if (n < 1 || n > 59) return { error: 'A minute step must be between 1 and 59' };
    return { StartInterval: n * 60 };
  }

  const dims = [];
  for (const [key, raw, lo, hi] of [['Minute', mi, 0, 59], ['Hour', ho, 0, 23],
                                    ['Day', dom, 1, 31], ['Month', mo, 1, 12],
                                    ['Weekday', dow, 0, 6]]) {
    if (raw === '*') continue;
    const set = cronField(raw, lo, hi);
    if (!set || !set.size) return { error: `Could not read "${raw}" in that schedule` };
    const vals = [...set].sort((a, b) => a - b);
    if (vals[0] < lo || vals[vals.length - 1] > hi) return { error: `"${raw}" is out of range` };
    dims.push([key, vals]);
  }
  if (!dims.length) return { error: 'Every minute is not a schedule; give at least a minute or an hour' };

  const total = dims.reduce((n, [, v]) => n * v.length, 1);
  if (total > MAX_ENTRIES) return { error: `That expands to ${total} launchd entries; use a simpler schedule` };

  let entries = [{}];
  for (const [key, vals] of dims) {
    entries = entries.flatMap(e => vals.map(v => ({ ...e, [key]: v })));
  }
  return { StartCalendarInterval: entries };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The command runs under a LOGIN shell. launchd hands a job a bare PATH, so without
// -l nothing you installed by hand (claude, gws-cli, pm2) is on it and the job fails at 3am
// with "command not found".
export function plistXml({ label, command, dir, out, err, schedule }) {
  const cal = schedule.StartCalendarInterval
    ? `<key>StartCalendarInterval</key><array>` + schedule.StartCalendarInterval.map(e =>
        '<dict>' + Object.entries(e).map(([k, v]) =>
          `<key>${k}</key><integer>${v}</integer>`).join('') + '</dict>').join('') + '</array>'
    : `<key>StartInterval</key><integer>${schedule.StartInterval}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${xml(command)}</string></array>
${dir ? `<key>WorkingDirectory</key><string>${xml(dir)}</string>` : ''}
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err || out)}</string>
<key>RunAtLoad</key><false/>
${cal}
</dict></plist>
`;
}

const exec = (cmd, args, opts = {}) => new Promise((done) =>
  execFile(cmd, args, { timeout: 15000, ...opts },
    (err, out, errOut) => done({ ok: !err, out: out || '', err: err ? (errOut || String(err)) : '' })));

// Write the plist, then load it. A job that is on disk but not bootstrapped shows in
// the panel as "not loaded", which is honest but useless, so both steps must happen.
export async function createCron({ name, schedule, command, dir }) {
  if (!String(command || '').trim()) return { error: 'A job needs a command to run' };
  const label = cronLabel(name);
  if (!label) return { error: 'Give the job a name with letters or numbers in it' };
  const sched = cronToLaunchd(schedule);
  if (sched.error) return { error: sched.error };
  if (dir && !fs.existsSync(dir)) return { error: `No such folder: ${dir}` };

  const file = path.join(AGENTS_DIR, label + '.plist');
  if (fs.existsSync(file)) return { error: `A job called ${label} already exists` };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = path.join(LOG_DIR, label + '.log');
  fs.writeFileSync(file, plistXml({ label, command, dir, out, schedule: sched }));

  const boot = await exec('launchctl', ['bootstrap', `gui/${UID}`, file]);
  if (!boot.ok) {
    const legacy = await exec('launchctl', ['load', file]);
    if (!legacy.ok) return { label, file, warning: `written, but launchctl refused it: ${boot.err.trim()}` };
  }
  return { ok: true, label, file, logPath: out };
}

// "Run it now" means now, not "at the next scheduled time". kickstart -k restarts a
// job that is already running; `start` is the fallback for older launchd.
export async function runCron(job) {
  if (!job) return { error: 'no such job' };
  if (job.isCrontab) {
    // A crontab line is just a shell command; cron itself has no "run now".
    const child = execFile('/bin/zsh', ['-lc', job.command], { timeout: 0 }, () => {});
    child.unref?.();
    return { ok: true, how: 'shell' };
  }
  const r = await exec('launchctl', ['kickstart', '-k', domain(job.label)]);
  if (r.ok) return { ok: true, how: 'kickstart' };
  const legacy = await exec('launchctl', ['start', job.label]);
  return legacy.ok ? { ok: true, how: 'start' } : { error: (r.err || legacy.err || 'launchctl refused').trim() };
}

// Deleting unloads first: removing the plist while launchd still holds the job leaves
// a ghost in `launchctl list` that nothing can start or stop.
export async function deleteCron(job) {
  if (!job) return { error: 'no such job' };
  if (job.isCrontab) {
    const tab = await run('crontab', ['-l']);
    if (tab == null) return { error: 'could not read the crontab' };
    const lines = tab.split('\n');
    const schedule = String(job.schedule || '').trim().replace(/\s+/g, ' ');
    const index = lines.findIndex(l => {
      const t = l.trim();
      if (!t || t.startsWith('#')) return false;
      const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
      return m && m[1].replace(/\s+/g, ' ') === schedule && m[2] === job.command;
    });
    if (index < 0) return { error: 'that line is no longer in the crontab' };
    // Remove one exact row, never a substring shared by other commands or jobs.
    const kept = lines.slice();
    kept.splice(index, 1);
    const w = await new Promise((done) => {
      const child = execFile('crontab', ['-'], { timeout: 10000 },
        (err, out, errOut) => done({ ok: !err, err: errOut || String(err || '') }));
      child.stdin.end(kept.join('\n').replace(/\n*$/, '\n'));
    });
    return w.ok ? { ok: true } : { error: w.err.trim() || 'crontab refused the change' };
  }
  const file = path.join(AGENTS_DIR, job.label + '.plist');
  await exec('launchctl', ['bootout', domain(job.label)]);
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (e) { return { error: String(e) }; }
    return { ok: true, file };
  }
  // Not one of ours: it lives in some other plist we must not go hunting for.
  return { error: 'unloaded it, but its plist is not in ~/Library/LaunchAgents' };
}
