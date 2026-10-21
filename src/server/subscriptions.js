// Which account a pen spends from.
//
// AGENTS.md has said from the start that PokeClaude runs on the Max subscription and
// never a raw API key, and until now nothing enforced it. One environment variable is
// the whole difference: `claude` prefers ANTHROPIC_API_KEY over its Keychain login and
// `codex` prefers OPENAI_API_KEY over the ChatGPT plan in ~/.codex/auth.json. Either
// turns every pen into metered billing on top of a subscription already paid for, and
// nothing on screen would look any different.
//
// This matters more with our own pty than it did with cmux. A pen runs under
// `zsh -lc`, a LOGIN shell, so it reads the profile - and a profile may hold a claude-bedrock
// function that exports CLAUDE_CODE_USE_BEDROCK and an AWS bearer token. It is a
// function, so it is harmless, and it is one `source` away from not being.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Everything that sends a CLI somewhere other than its subscription login. The relay
// strips these from a pen (tools/pty-agent.py) and this is the list it strips.
export const BILLING_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION',
];

// Set, and not just present-and-empty: an exported empty string is how a shell says
// "no" and treating it as a key would report a problem that is not there.
const isSet = (v) => typeof v === 'string' && v.trim() !== '';
export const redirectedBy = (env) =>
  BILLING_ENV.filter(k => isSet((env || {})[k]));

export function claudeAuth({ env = {}, hasLogin = false } = {}) {
  if (isSet(env.CLAUDE_CODE_USE_BEDROCK)) return {
    mode: 'bedrock', ok: false,
    detail: 'CLAUDE_CODE_USE_BEDROCK is set, so this pen bills AWS, not the subscription',
  };
  if (isSet(env.CLAUDE_CODE_USE_VERTEX)) return {
    mode: 'vertex', ok: false,
    detail: 'CLAUDE_CODE_USE_VERTEX is set, so this pen bills Google Cloud, not the subscription',
  };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    if (isSet(env[k])) return {
      mode: 'api-key', ok: false,
      detail: `${k} is set, so this pen bills the API on top of the subscription`,
    };
  }
  return hasLogin
    ? { mode: 'subscription', ok: true, detail: 'the Claude Code login in the Keychain' }
    : { mode: 'none', ok: false, detail: 'no Claude Code login on this machine; run `claude` once to sign in' };
}

// The plan name from the id_token's own claims, so it is whatever OpenAI says rather
// than whatever we assumed. Nothing here is sent anywhere; only the plan name is read.
export function codexPlan(auth) {
  const t = auth?.tokens?.id_token;
  if (typeof t !== 'string') return null;
  const part = t.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return claims?.['https://api.openai.com/auth']?.chatgpt_plan_type || null;
  } catch { return null; }
}

export function codexAuth(auth, env = {}) {
  if (isSet(env.OPENAI_API_KEY)) return {
    mode: 'api-key', ok: false,
    detail: 'OPENAI_API_KEY is set, so this pen bills the API, not the ChatGPT plan',
  };
  if (!auth) return { mode: 'none', ok: false, detail: 'no ~/.codex/auth.json; run `codex` once to sign in' };
  if (isSet(auth.OPENAI_API_KEY)) return {
    mode: 'api-key', ok: false,
    detail: '~/.codex/auth.json holds an API key rather than a ChatGPT login',
  };
  if (!auth.tokens?.id_token) return { mode: 'none', ok: false, detail: 'no ChatGPT login in ~/.codex/auth.json' };
  const plan = codexPlan(auth);
  return { mode: 'subscription', ok: true, plan,
           detail: plan ? `the ChatGPT plan (${plan})` : 'the ChatGPT login' };
}

// ---- what this machine actually has ----------------------------------------------

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Claude Code keeps the subscription login in the macOS Keychain, with a file as the
// fallback on other platforms. Only whether it EXISTS is read, never its contents.
function claudeLoggedIn(home = os.homedir()) {
  if (fs.existsSync(path.join(home, '.claude', '.credentials.json'))) return Promise.resolve(true);
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((done) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials'],
      { timeout: 4000 }, (err) => done(!err));
  });
}

// What each engine will spend from, for the panel and for the startup log.
export async function subscriptionStatus({ home = os.homedir(), env = process.env } = {}) {
  const claude = claudeAuth({ env, hasLogin: await claudeLoggedIn(home) });
  const codex = codexAuth(readJson(path.join(home, '.codex', 'auth.json')), env);
  return { claude, codex, redirected: redirectedBy(env) };
}
