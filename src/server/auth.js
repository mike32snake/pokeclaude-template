// The logins on this machine, and whether each one still works: Google accounts in
// gws-cli, GitHub accounts in gh, Vercel, a Slack user token, and the two agent CLIs,
// Claude Code and Codex. When one of them lapses the failure shows up somewhere else
// as a cron that stopped or a skill that errored, and which account it was is a hunt.
// The strip at the bottom of the field answers that at a glance.
//
// Nothing here names an account. Every probe asks the tool what IT is signed into, so
// the strip shows whatever this machine has, and a tool that is not installed reports
// grey rather than failing. Everything shells out to the real CLIs and reads their own
// status commands, so what the strip says is what the tool itself would say. Nothing
// is stored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();

// The order the strip shows them in, and the only list that decides which probes run.
export const AUTH_GROUPS = [
  { key: 'google', label: 'Google' },
  { key: 'github', label: 'GitHub' },
  { key: 'vercel', label: 'Vercel' },
  { key: 'slack',  label: 'Slack'  },
  { key: 'claude', label: 'Claude' },
  { key: 'codex',  label: 'Codex'  },
];

// Where a CLI lives is a property of the machine, not of this project. POKECLAUDE_<X>_BIN
// wins, then the common user install, then PATH. execFile takes no shell, so a bare name
// is a real PATH lookup and a shell function or alias is invisible to it either way.
export function bin(name, env = process.env) {
  const key = 'POKECLAUDE_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_BIN';
  if (env[key]) return env[key];
  const local = path.join(env.HOME || HOME, '.local/bin', name);
  try { if (fs.existsSync(local)) return local; } catch { /* unreadable home: use PATH */ }
  return name;
}

const gwsConfigPath = (env = process.env) =>
  env.POKECLAUDE_GWS_CONFIG || path.join(env.HOME || HOME, '.config/gws-cli/gws_config.json');

// A Slack user token, if the machine has one. An env var is the portable way; the JSON
// file is a convenience for people who already keep one. Read for this one check and
// never sent anywhere but Slack. Without it the Slack chip simply does not appear.
export function slackToken(env = process.env, readFile = readOauthFile) {
  if (env.SLACK_USER_TOKEN) return env.SLACK_USER_TOKEN;
  if (env.SLACK_TOKEN) return env.SLACK_TOKEN;
  const d = readFile(env);
  return d?.slack?.token || d?.slack?.botToken || d?.token || null;
}

function readOauthFile(env = process.env) {
  const file = env.POKECLAUDE_OAUTH_FILE
    || path.join(env.HOME || HOME, '.config/pokeclaude/oauth-credentials.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

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

// `vercel whoami` prints the username on stdout and its own version banner on stderr.
// No login is an error line, not an empty answer, so the two are told apart.
export function parseVercel({ stdout, stderr, err } = {}) {
  const name = String(stdout || '').split('\n').map(l => l.trim())
    .filter(Boolean).filter(l => !/^Vercel CLI/i.test(l)).pop();
  if (name) return { ok: true, note: name };
  const bad = String(stderr || '').split('\n').map(l => l.trim())
    .find(l => /^(Error|Error!)/i.test(l));
  if (bad) return { ok: false, note: bad.replace(/^Error!?:?\s*/i, '') };
  return { ok: null, note: String(stderr || err || '').trim().slice(0, 200) || 'no answer' };
}

// `codex login status` answers in a sentence, not JSON: "Logged in using ChatGPT".
export function parseCodex(text) {
  const line = String(text || '').split('\n').map(l => l.trim()).find(Boolean);
  if (!line) return { ok: null, note: 'no answer' };
  if (/^logged in/i.test(line)) return { ok: true, note: line };
  if (/not logged in|no credentials|run .?codex login/i.test(line)) return { ok: false, note: line };
  return { ok: null, note: line.slice(0, 200) };
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
  if (group === 'vercel') return 'vercel login';
  if (group === 'claude') return 'claude auth login';
  if (group === 'codex') return 'codex login';
  return null;   // slack is a token to paste, not a CLI to run
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
    `printf '%s\\012' ${shellQuote(`PokeClaude: sign in to ${row.group} / ${row.name} in your browser. This tab is the login progress.`)}`,
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
  try { cfg = JSON.parse(fs.readFileSync(gwsConfigPath(), 'utf8')); } catch { return []; }
  const accounts = googleAccounts(cfg);
  const gws = bin('gws-cli');
  return Promise.all(accounts.map(async (a) => {
    const r = await run(gws, ['auth', 'status', '-a', a.name]);
    const p = missing(r) ? { ok: null, note: 'gws-cli not installed' }
            : timedOut(r) ? { ok: null, note: 'timed out' } : parseGws(r.stdout || r.stderr);
    return { id: `google:${a.name}`, group: 'google', name: a.name, isDefault: a.isDefault, ...p };
  }));
}

async function probeGithub() {
  const r = await run(bin('gh'), ['auth', 'status']);
  if (missing(r)) return [];
  if (timedOut(r)) return [{ id: 'github:?', group: 'github', name: 'gh', ok: null, note: 'timed out' }];
  // gh writes status to stderr and exits 1 when any account is bad; both streams hold accounts.
  return parseGh(r.stdout + '\n' + r.stderr).map(a => ({ id: `github:${a.name}`, group: 'github', ...a }));
}

async function probeVercel() {
  const r = await run(bin('vercel'), ['whoami']);
  if (missing(r)) return [];
  const p = timedOut(r) ? { ok: null, note: 'timed out' } : parseVercel(r);
  return [{ id: 'vercel:account', group: 'vercel', name: p.ok ? p.note : 'Vercel', ...p }];
}

async function probeSlack() {
  const token = slackToken();
  if (!token) return [];
  const r = await run('curl', ['-s', '-m', '10', '-H', `Authorization: Bearer ${token}`,
                               'https://slack.com/api/auth.test']);
  const p = r.err ? { ok: null, note: 'no answer from Slack' } : parseSlack(r.stdout);
  return [{ id: 'slack:user-token', group: 'slack', name: 'Slack', ...p }];
}

async function probeClaude() {
  const r = await run(bin('claude'), ['auth', 'status']);
  if (missing(r)) return [];
  const p = timedOut(r) ? { ok: null, note: 'timed out' } : parseClaude(r.stdout);
  return [{ id: 'claude:code', group: 'claude', name: 'Claude Code', ...p }];
}

async function probeCodex() {
  const r = await run(bin('codex'), ['login', 'status']);
  if (missing(r)) return [];
  const p = timedOut(r) ? { ok: null, note: 'timed out' } : parseCodex(r.stdout || r.stderr);
  return [{ id: 'codex:cli', group: 'codex', name: 'Codex', ...p }];
}

// Every login, in the order the strip shows them. Probes run side by side; one that
// hangs is reported as unknown, never allowed to hold up the rest.
export async function probeAuth() {
  const groups = await Promise.all([probeGoogle(), probeGithub(), probeVercel(),
                                    probeSlack(), probeClaude(), probeCodex()]);
  const rows = groups.flat().map(r => ({ ...r, fix: r.ok === false ? fixFor(r) : null }));
  return { at: Date.now(), rows, ...summarize(rows) };
}
