// The auth strip: which logins on this machine are good and which need a hand.
import test from 'node:test';
import assert from 'node:assert';
import { googleAccounts, parseGws, parseGh, parseSlack, parseClaude,
         summarize, fixFor } from '../src/server/auth.js';
import { authChips, authHeadline, CHIP_GROUPS } from '../public/js/authbar.js';

test('googleAccounts lists every gws-cli account and marks the default', () => {
  const cfg = { accounts: { default_account: 'work', entries: {
    acme: { name: '' }, personal: {}, work: {}, client: { name: 'A Name' } } } };
  assert.deepEqual(googleAccounts(cfg), [
    { name: 'acme', isDefault: false }, { name: 'personal', isDefault: false },
    { name: 'work', isDefault: true }, { name: 'client', isDefault: false }]);
  assert.deepEqual(googleAccounts({}), []);
});

test('parseGws reads the status JSON and never guesses on garbage', () => {
  assert.deepEqual(parseGws('{"status":"authenticated","message":"Token is valid (refreshed)."}'),
                   { ok: true, note: 'Token is valid (refreshed).' });
  assert.deepEqual(parseGws('{"status":"unauthenticated","message":"No token found."}'),
                   { ok: false, note: 'No token found.' });
  // Rich prints a banner before the JSON when the token needs a browser: find the JSON.
  assert.equal(parseGws('warning: something\n{"status":"expired","message":"Refresh failed"}').ok, false);
  assert.deepEqual(parseGws('Traceback ...'), { ok: null, note: 'Traceback ...' });
  assert.equal(parseGws('').ok, null);
});

test('parseGh reads every account out of gh auth status, good or bad', () => {
  const text = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Token scopes: 'repo'

  ✓ Logged in to github.com account octocat-work (keyring)
  - Active account: false

  X Failed to log in to github.com account octocat-bot (keyring)
  - Active account: false
  - The token in keyring is invalid.
`;
  assert.deepEqual(parseGh(text), [
    { name: 'octocat', ok: true, active: true, note: 'Logged in' },
    { name: 'octocat-work', ok: true, active: false, note: 'Logged in' },
    { name: 'octocat-bot', ok: false, active: false, note: 'The token in keyring is invalid.' }]);
  assert.deepEqual(parseGh('You are not logged into any GitHub hosts.'), []);
});

test('parseSlack and parseClaude read their JSON', () => {
  assert.deepEqual(parseSlack('{"ok":true,"user":"dev","team":"Lakeshore"}'),
                   { ok: true, note: 'dev @ Lakeshore' });
  assert.deepEqual(parseSlack('{"ok":false,"error":"token_revoked"}'), { ok: false, note: 'token_revoked' });
  assert.equal(parseSlack('<html>').ok, null);
  assert.deepEqual(parseClaude('{"loggedIn":true,"email":"dev@example.com","subscriptionType":"max"}'),
                   { ok: true, note: 'dev@example.com · max' });
  assert.deepEqual(parseClaude('{"loggedIn":false}'), { ok: false, note: 'Not logged in' });
});

test('summarize counts, and fixFor names the command that repairs each kind', () => {
  const rows = [
    { id: 'google:acme', ok: true }, { id: 'google:personal', ok: false },
    { id: 'gh:x', ok: null }];
  assert.deepEqual(summarize(rows), { ok: 1, bad: 1, unknown: 1 });
  assert.equal(fixFor({ group: 'google', name: 'acme' }), "gws-cli auth -a 'acme'");
  assert.equal(fixFor({ group: 'github', name: 'octocat-bot' }), 'gh auth login -h github.com');
  assert.equal(fixFor({ group: 'claude', name: 'claude' }), 'claude auth login');
  assert.equal(fixFor({ group: 'slack', name: 'acme' }), null);   // no CLI: a file to edit
});

test('authChips groups the rows for the strip and colours them by state', () => {
  const auth = { at: 1000, rows: [
    { id: 'google:work', group: 'google', name: 'work', ok: true, note: 'valid', isDefault: true },
    { id: 'google:acme', group: 'google', name: 'acme', ok: false, note: 'No token', fix: "gws-cli auth -a 'acme'" },
    { id: 'github:octocat', group: 'github', name: 'octocat', ok: true, active: true, note: 'Logged in' },
    { id: 'slack:work', group: 'slack', name: 'work', ok: null, note: 'timed out' },
  ] };
  const groups = authChips(auth);
  assert.deepEqual(groups.map(g => g.label), ['Google', 'GitHub', 'Slack']);
  const [google, github, slack] = groups;
  assert.deepEqual(google.chips.map(c => c.cls), ['ok', 'bad']);
  assert.equal(google.chips[0].label, 'work');
  assert.ok(google.chips[0].title.includes('default'));
  assert.ok(google.chips[1].title.includes("gws-cli auth -a 'acme'"));
  assert.equal(google.chips[1].fixable, true);
  assert.equal(github.chips[0].label, 'octocat');
  assert.ok(github.chips[0].title.includes('active'));
  assert.deepEqual(slack.chips.map(c => c.cls), ['unknown']);
  // A lone chip named for its tool drops the group label; a named account keeps it.
  assert.equal(slack.solo, false);
  assert.equal(authChips({ rows: [{ id: 'claude:code', group: 'claude', name: 'Claude Code', ok: true }] })[0].solo, true);
  assert.equal(slack.chips[0].fixable, false);
  // Nothing sampled yet: no groups, and a headline that says so.
  assert.deepEqual(authChips(null), []);
  assert.equal(authHeadline(null, 5000), 'checking logins…');
});

test('authHeadline says what needs you, or that all is well, and how old the check is', () => {
  const at = Date.parse('2026-09-02T10:00:00Z');
  const now = at + 3 * 60e3;
  const ok = { at, rows: [{ ok: true }, { ok: true }] };
  assert.equal(authHeadline(ok, now), '2 logins ok · 3m');
  const bad = { at, rows: [{ ok: true }, { ok: false, name: 'acme' }, { ok: false, name: 'octocat-bot' }] };
  assert.equal(authHeadline(bad, now), '2 need sign-in · 3m');
  const unk = { at, rows: [{ ok: true }, { ok: null, name: 'slack' }] };
  assert.equal(authHeadline(unk, now), '1 ok · 1 unknown · 3m');
});

test('compact chips fold the healthy logins of a group into a count, and keep the rest named', () => {
  const auth = { at: 1, rows: [
    { id: 'google:acme', group: 'google', name: 'acme', ok: true },
    { id: 'google:personal', group: 'google', name: 'personal', ok: true },
    { id: 'google:client', group: 'google', name: 'client', ok: false, fix: 'gws-cli auth login -a client --force' },
    { id: 'vercel:account', group: 'vercel', name: 'some-user', ok: true },
    { id: 'claude:code', group: 'claude', name: 'Claude Code', ok: true },
  ] };
  const [google, vercel, claude] = authChips(auth, { compact: true });
  assert.deepEqual(google.chips.map(c => c.label), ['2 ok', 'client']);
  assert.equal(google.chips[0].cls, 'ok');
  assert.ok(google.chips[0].title.includes('acme') && google.chips[0].title.includes('personal'));
  assert.equal(google.chips[1].fixable, true);
  // A group with one healthy login keeps its name: "1 ok" says less than the name does.
  assert.deepEqual(vercel.chips.map(c => c.label), ['some-user']);
  assert.deepEqual(claude.chips.map(c => c.label), ['Claude Code']);
});

// ---------- the provider set ----------
// The strip covers the tools a Claude Code / Codex workspace actually signs into:
// Google through gws-cli, GitHub, Vercel, Slack, and the two agent CLIs. Every probe
// discovers whatever accounts the machine has; none of them names a particular one.

import { AUTH_GROUPS, parseVercel, parseCodex, bin, slackToken } from '../src/server/auth.js';

test('the strip covers exactly the tools a workspace signs into', () => {
  assert.deepEqual(AUTH_GROUPS.map(g => g.key),
                   ['google', 'github', 'vercel', 'slack', 'claude', 'codex']);
});

// The server decides what to probe and the client decides what to draw. A group in one
// list and not the other is probed and never shown, or labelled and never filled.
test('the server probe list and the client chip list agree', () => {
  assert.deepEqual(CHIP_GROUPS.map(([key]) => key), AUTH_GROUPS.map(g => g.key));
  assert.deepEqual(CHIP_GROUPS.map(([, label]) => label), AUTH_GROUPS.map(g => g.label));
});

test('every CLI is resolved from the environment, never a hardcoded install path', () => {
  assert.equal(bin('gws-cli', { POKECLAUDE_GWS_CLI_BIN: '/opt/x/gws-cli' }), '/opt/x/gws-cli');
  assert.equal(bin('codex', { POKECLAUDE_CODEX_BIN: '/opt/x/codex' }), '/opt/x/codex');
  // No override and nothing in ~/.local/bin: fall through to a PATH lookup.
  assert.equal(bin('vercel', { HOME: '/Users/nobody' }), 'vercel');
});

test('vercel whoami is a username on stdout, and a missing login is an error', () => {
  assert.deepEqual(parseVercel({ stdout: 'some-user\n', stderr: 'Vercel CLI 56.2.0\n' }),
                   { ok: true, note: 'some-user' });
  assert.deepEqual(parseVercel({ stdout: '', stderr: 'Vercel CLI 56.2.0\nError: No existing credentials found. Please run `vercel login`\n' }),
                   { ok: false, note: 'No existing credentials found. Please run `vercel login`' });
  assert.equal(parseVercel({ stdout: '', stderr: '' }).ok, null);
});

test('codex login status is a plain sentence, not JSON', () => {
  assert.deepEqual(parseCodex('Logged in using ChatGPT\n'),
                   { ok: true, note: 'Logged in using ChatGPT' });
  assert.deepEqual(parseCodex('Not logged in\n'), { ok: false, note: 'Not logged in' });
  assert.equal(parseCodex('').ok, null);
});

// The Slack check needs a user token. An env var is the portable way to supply one;
// the JSON file is a convenience, and neither is required for the rest of the strip.
test('the slack token comes from the environment or an optional file', () => {
  assert.equal(slackToken({ SLACK_USER_TOKEN: 'xoxp-env' }, () => null), 'xoxp-env');
  assert.equal(slackToken({ SLACK_TOKEN: 'xoxp-alt' }, () => null), 'xoxp-alt');
  assert.equal(slackToken({}, () => ({ slack: { token: 'xoxp-file' } })), 'xoxp-file');
  assert.equal(slackToken({}, () => ({ token: 'xoxp-bare' })), 'xoxp-bare');
  assert.equal(slackToken({}, () => null), null);
});

test('every group that can be repaired names its own sign-in command', () => {
  assert.equal(fixFor({ group: 'vercel', name: 'vercel' }), 'vercel login');
  assert.equal(fixFor({ group: 'codex', name: 'Codex' }), 'codex login');
  assert.equal(fixFor({ group: 'claude', name: 'Claude Code' }), 'claude auth login');
  assert.equal(fixFor({ group: 'slack', name: 'Slack' }), null, 'a token file, not a CLI');
});
