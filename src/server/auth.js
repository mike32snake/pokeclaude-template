// The logins on this machine, and whether each one still works: Google accounts in
// gws-cli, GitHub accounts in gh, gcloud, a Slack user token, and Claude Code itself.
// When one of them lapses the failure shows up somewhere else as a cron that stopped
// or a skill that errored, and which account it was is a hunt. The strip at the bottom
// of the field answers that at a glance. A tool you do not have reports grey rather
// than failing, so the strip is useful with any subset of them installed.
//
// Everything here shells out to the real CLIs and reads their own status commands,
// so what the strip says is what the tool itself would say. Nothing is stored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const GWS = path.join(HOME, '.local/bin/gws-cli');
const GWS_CONFIG = path.join(HOME, '.config/gws-cli/gws_config.json');
const CLAUDE = path.join(HOME, '.local/bin/claude');
// Optional: a JSON file holding a Slack user token, so the auth strip can show whether
// Slack is still signed in. Point POKECLAUDE_OAUTH_FILE at yours, or leave it unset and
// the Slack chip simply reports that it cannot tell. Read for that one check, and never
// sent anywhere but Slack.
const OAUTH_FILE = process.env.POKECLAUDE_OAUTH_FILE
  || path.join(HOME, '.config/pokeclaude/oauth-credentials.json');

// ---------- parsers: pure, tested ----------

export function googleAccounts(cfg) {
  const entries = cfg?.accounts?.entries || {};
  const def = cfg?.accounts?.default_account || null;
  return Object.keys(entries).map(name => ({ name, isDefault: name === def }));
}

// The first JSON object in the output. Typer/Rich may print a warning line first.
function firstJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

export function parseGws(stdout) {
  const d = firstJson(stdout);
  if (!d || !d.status) return { ok: null, note: String(stdout || '').trim().slice(0, 200) };
  return { ok: d.status === 'authenticated', note: d.message || d.status };
}

// `gh auth status` is prose. Each account is a "Logged in to ... account NAME" or
// "Failed to log in to ... account NAME" line followed by indented facts.
export function parseGh(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(✓|X|✗|!)?\s*(Logged in to|Failed to log in to)\s+\S+\s+account\s+(\S+)/);
    if (m) {
      cur = { name: m[3], ok: m[2].startsWith('Logged in'), active: false, note: m[2].startsWith('Logged in') ? 'Logged in' : 'Failed to log in' };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const a = line.match(/^-\s*Active account:\s*(true|false)/);
    if (a) { cur.active = a[1] === 'true'; continue; }
    // The reason a login failed is the first "- " fact that is not a field: value.
    if (!cur.ok && /^-\s+/.test(line) && !/^-\s*[\w ]+:\s/.test(line) && cur.note === 'Failed to log in') {
      cur.note = line.replace(/^-\s+/, '');
    }
  }
  return out;
}

export function parseGcloudToken({ stdout, stderr }) {
  if (String(stdout || '').trim()) return { ok: true, note: 'Token issued' };
  const err = String(stderr || '').split('\n').map(l => l.trim()).find(l => /^ERROR/.test(l));
  if (err) return { ok: false, note: err.replace(/^ERROR:\s*\([^)]*\)\s*/, '') };
  return { ok: null, note: String(stderr || '').trim().slice(0, 200) || 'no output' };
}

export function parseSlack(text) {
  const d = firstJson(text);
  if (!d || typeof d.ok !== 'boolean') return { ok: null, note: String(text || '').trim().slice(0, 200) };
  return d.ok ? { ok: true, note: `${d.user || '?'} @ ${d.team || '?'}` }
              : { ok: false, note: d.error || 'not ok' };
}

export function parseClaude(text) {
  const d = firstJson(text);
  if (!d || typeof d.loggedIn !== 'boolean') return { ok: null, note: String(text || '').trim().slice(0, 200) };
  return d.loggedIn ? { ok: true, note: [d.email, d.subscriptionType].filter(Boolean).join(' · ') }
                    : { ok: false, note: 'Not logged in' };
}

export function summarize(rows) {
  const s = { ok: 0, bad: 0, unknown: 0 };
  for (const r of rows || []) {
    if (r.ok === true) s.ok++; else if (r.ok === false) s.bad++; else s.unknown++;
  }
  return s;
}

// The command that signs a lapsed login back in. Each one opens a browser, so it is
// run in its own cmux tab rather than here.
const shellQuote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
export function fixFor({ group, name }) {
  if (group === 'google') return `gws-cli auth -a ${shellQuote(name)}`;
  if (group === 'github') return 'gh auth login -h github.com';
  if (group === 'gcloud') return `gcloud auth login ${shellQuote(name)} --no-activate --force`;
  if (group === 'claude') return 'claude auth login';
  return null;
}

// The UI is launching an interactive sign-in, not declaring authentication success.
export function loginShell(row) {
  const command = fixFor(row);
  if (!command) return null;
  const browser = fileURLToPath(new URL('../../tools/open-auth-browser.sh', import.meta.url));
  return [
    `export PATH=${shellQuote(`${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}:"$PATH"`,
    `export BROWSER=${shellQuote(browser)} GH_BROWSER=${shellQuote(browser)} CLOUDSDK_BROWSER=${shellQuote(browser)}`,
    // claude auth is still a Claude subprocess: never inherit the server identity.
    `for pc_env in $(env | sed -n 's/\\(CMUX_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$pc_env"; done`,
    `printf '%s\\012' ${shellQuote(`PokeClaude: sign in to ${row.group} / ${row.name} in Brave. This tab is the login progress.`)}`,
    command,
    'pc_auth_exit=$?',
    `if [ "$pc_auth_exit" -eq 0 ]; then printf '%s\\012' 'Sign-in command completed. PokeClaude will verify the account.'; else printf '%s\\012' "PokeClaude sign-in failed (exit $pc_auth_exit). Review the error above."; fi`,
    'exec /bin/zsh -l',
  ].join('; ');
}
export async function startLogin(row, io) {
  const command = loginShell(row);
  if (!command) return { ok: false, error: 'No supported sign-in command for this account.' };
  const result = await io.newWorkspace(`🔑 ${row.name}`, HOME, command);
  if (!result.ok || !result.ref) return { ok: false, error: result.stderr || 'cmux did not return a login workspace.' };
  const selected = await io.selectWorkspace(result.ref);
  return { ok: true, pending: true, ref: result.ref, fix: fixFor(row),
    warning: selected.ok ? undefined : 'Sign-in started, but the tab could not be brought forward. Open cmux to continue.' };
}

// ---------- probes: the real CLIs ----------

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  // Strip the cmux identity: a child that is itself a Claude process would otherwise
  // report the server's workspace. The others do not care.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CMUX_')) delete env[k];
  execFile(cmd, args, { timeout: 25_000, maxBuffer: 1 << 20, env, ...opts },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

const timedOut = (r) => r.err && /ETIMEDOUT|SIGTERM/.test(String(r.err.signal || r.err.code || r.err));
const missing = (r) => r.err && r.err.code === 'ENOENT';

async function probeGoogle() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(GWS_CONFIG, 'utf8')); } catch { return []; }
  const accounts = googleAccounts(cfg);
  return Promise.all(accounts.map(async (a) => {
    const r = await run(GWS, ['auth', 'status', '-a', a.name]);
    const p = missing(r) ? { ok: null, note: 'gws-cli not installed' }
            : timedOut(r) ? { ok: null, note: 'timed out' } : parseGws(r.stdout || r.stderr);
    return { id: `google:${a.name}`, group: 'google', name: a.name, isDefault: a.isDefault, ...p };
  }));
}

async function probeGithub() {
  const r = await run('gh', ['auth', 'status']);
  if (missing(r)) return [];
  if (timedOut(r)) return [{ id: 'github:?', group: 'github', name: 'gh', ok: null, note: 'timed out' }];
  // gh writes status to stderr and exits 1 when any account is bad; both streams hold accounts.
  return parseGh(r.stdout + '\n' + r.stderr).map(a => ({ id: `github:${a.name}`, group: 'github', ...a }));
}

async function probeGcloud() {
  const list = await run('gcloud', ['auth', 'list', '--format=json']);
  if (missing(list) || timedOut(list)) return [];
  let rows = [];
  try { rows = JSON.parse(list.stdout); } catch { return []; }
  return Promise.all(rows.map(async (row) => {
    const r = await run('gcloud', ['auth', 'print-access-token', '--account', row.account]);
    const p = timedOut(r) ? { ok: null, note: 'timed out' } : parseGcloudToken(r);
    return { id: `gcloud:${row.account}`, group: 'gcloud', name: row.account,
             active: row.status === 'ACTIVE', ...p };
  }));
}

async function probeSlack() {
  let token = null;
  try { token = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'))?.slack?.botToken; } catch { return []; }
  if (!token) return [];
  const r = await run('curl', ['-s', '-m', '10', '-H', `Authorization: Bearer ${token}`,
                               'https://slack.com/api/auth.test']);
  const p = r.err ? { ok: null, note: 'no answer from Slack' } : parseSlack(r.stdout);
  return [{ id: 'slack:user-token', group: 'slack', name: 'Slack', ...p }];
}

async function probeClaude() {
  const r = await run(fs.existsSync(CLAUDE) ? CLAUDE : 'claude', ['auth', 'status']);
  if (missing(r)) return [];
  const p = timedOut(r) ? { ok: null, note: 'timed out' } : parseClaude(r.stdout);
  return [{ id: 'claude:code', group: 'claude', name: 'Claude Code', ...p }];
}

// Every login, in the order the strip shows them. Probes run side by side; one that
// hangs is reported as unknown, never allowed to hold up the rest.
export async function probeAuth() {
  const groups = await Promise.all([probeGoogle(), probeGithub(), probeGcloud(), probeSlack(), probeClaude()]);
  const rows = groups.flat().map(r => ({ ...r, fix: r.ok === false ? fixFor(r) : null }));
  return { at: Date.now(), rows, ...summarize(rows) };
}
