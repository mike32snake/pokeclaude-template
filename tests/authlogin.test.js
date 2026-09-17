import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fixFor, startLogin, loginShell } from '../src/server/auth.js';
const row = { group: 'google', name: 'client' };
test('an auth workspace creation failure is not reported as login success', async () => {
 const r = await startLogin(row, { newWorkspace: async () => ({ ok: false, stderr: 'socket denied' }) });
 assert.equal(r.ok, false); assert.match(r.error, /socket denied/);
});
test('a successful login launch selects the exact returned workspace and is only pending', async () => {
 const seen = [];
 const r = await startLogin(row, { newWorkspace: async (...args) => { seen.push(args); return { ok: true, ref: 'workspace:97' }; }, selectWorkspace: async ref => { seen.push(ref); return { ok: true }; } });
 assert.equal(r.ok, true);assert.equal(r.pending, true);assert.equal(seen[1], 'workspace:97');
 assert.match(seen[0][2], /open-auth-browser\.sh/);
});
test('the launcher reports command failure and never erases a token before the browser flow', () => {
 const command = loginShell(row);
 assert.doesNotMatch(command, /--force/);
 assert.doesNotMatch(command, /\\n|\n/, "cmux rewrites literal backslash-n as Enter");
 assert.match(command, /pc_auth_exit/);
 assert.match(command, /sign-in failed/);
 assert.match(fixFor({group:'google',name:"a'; echo surprise; '"}), /'"'"'/);
});

// Runs the real generated command through zsh, which the Linux CI image does not ship.
test('login shell strips cmux identity and reports a failing CLI without invoking a real login',
     { skip: !existsSync('/bin/zsh') }, async () => {
 const { execFileSync } = await import('node:child_process');
 const command = loginShell(row).replace('exec /bin/zsh -l', ':');
 const output = execFileSync('/bin/zsh', ['-c', `gws-cli() { test -z "$CMUX_WORKSPACE_ID" || return 88; return 42; }; ${command}`], {
   env: { ...process.env, CMUX_WORKSPACE_ID: 'server-workspace' }, encoding: 'utf8'
 });
 assert.match(output, /sign-in failed \(exit 42\)/);
});
