// Which account a pen spends from.
//
// AGENTS.md has said from the start that PokeClaude runs on the Max subscription and
// never a raw API key, and nothing enforced it. One environment variable is the whole
// difference: `claude` prefers ANTHROPIC_API_KEY over its Keychain login, and `codex`
// prefers OPENAI_API_KEY over the ChatGPT plan in ~/.codex/auth.json. Either one turns
// every pen into metered billing on top of a subscription you already pay for.
//
// A pen runs under `zsh -lc`, which is a LOGIN shell, so it reads the profile. A profile
// may have a claude-bedrock function that exports CLAUDE_CODE_USE_BEDROCK and an AWS bearer
// token - harmless because it is a function, and one `source` away from not being.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_ENV, redirectedBy, claudeAuth, codexAuth, codexPlan } from '../src/server/subscriptions.js';

test('the variables that redirect billing away from a subscription are all named', () => {
  for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                   'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                   'AWS_BEARER_TOKEN_BEDROCK', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    assert.ok(BILLING_ENV.includes(v), `${v} is not in the list`);
  }
});

test('a clean environment redirects nothing', () => {
  assert.deepEqual(redirectedBy({ PATH: '/usr/bin', HOME: '/Users/dev' }), []);
  assert.deepEqual(redirectedBy({}), []);
  assert.deepEqual(redirectedBy(null), []);
});

test('a set key is reported, and an empty one is not a key', () => {
  assert.deepEqual(redirectedBy({ ANTHROPIC_API_KEY: 'sk-ant-xxx' }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(redirectedBy({ ANTHROPIC_API_KEY: '' }), []);
  assert.deepEqual(redirectedBy({ ANTHROPIC_API_KEY: '   ' }), []);
  assert.deepEqual(redirectedBy({ CLAUDE_CODE_USE_BEDROCK: '1', OPENAI_API_KEY: 'sk-x' }).sort(),
    ['CLAUDE_CODE_USE_BEDROCK', 'OPENAI_API_KEY']);
});

// Claude Code keeps the subscription login in the macOS Keychain, not in a file.
test('Claude runs on the subscription when there is a login and no key', () => {
  const a = claudeAuth({ env: {}, hasLogin: true });
  assert.equal(a.mode, 'subscription');
  assert.equal(a.ok, true);
});

test('an API key beats the subscription, and that is the thing to warn about', () => {
  const a = claudeAuth({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' }, hasLogin: true });
  assert.equal(a.mode, 'api-key');
  assert.equal(a.ok, false);
  assert.match(a.detail, /ANTHROPIC_API_KEY/);
});

test('Bedrock and Vertex are their own kind of not-the-subscription', () => {
  assert.equal(claudeAuth({ env: { CLAUDE_CODE_USE_BEDROCK: '1' }, hasLogin: true }).mode, 'bedrock');
  assert.equal(claudeAuth({ env: { CLAUDE_CODE_USE_VERTEX: '1' }, hasLogin: true }).mode, 'vertex');
});

test('no login and no key is not a working pen at all', () => {
  const a = claudeAuth({ env: {}, hasLogin: false });
  assert.equal(a.mode, 'none');
  assert.equal(a.ok, false);
});

// ~/.codex/auth.json holds either a ChatGPT-plan token or an API key.
const PLAN = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'x', account_id: 'a' } };

test('Codex runs on the ChatGPT plan when auth.json says so and no key is set', () => {
  const a = codexAuth(PLAN, {});
  assert.equal(a.mode, 'subscription');
  assert.equal(a.ok, true);
});

test('an API key in the environment or in auth.json is metered either way', () => {
  assert.equal(codexAuth(PLAN, { OPENAI_API_KEY: 'sk-x' }).mode, 'api-key');
  assert.equal(codexAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }, {}).mode, 'api-key');
});

test('no auth.json at all is no Codex login', () => {
  assert.equal(codexAuth(null, {}).mode, 'none');
  assert.equal(codexAuth({}, {}).ok, false);
});

// The plan name comes out of the id_token's own claims, so it is whatever OpenAI says
// rather than whatever we assumed.
test('the plan is read from the token, not guessed', () => {
  const claims = { 'https://api.openai.com/auth': { chatgpt_plan_type: 'self_serve_business_prolite' } };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  assert.equal(codexPlan({ tokens: { id_token: `aaa.${body}.bbb` } }), 'self_serve_business_prolite');
  assert.equal(codexPlan({ tokens: { id_token: 'nonsense' } }), null);
  assert.equal(codexPlan(null), null);
});
