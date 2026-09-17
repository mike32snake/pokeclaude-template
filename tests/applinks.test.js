import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// PokeClaude.app is a WKWebView. A WKWebView drops every target="_blank" link and every
// window.open() unless its UI delegate implements createWebViewWith, so the links the
// markdown renderer writes did nothing in the app while they worked in Brave. The
// Swift has no test harness of its own, so this pins the handlers in the source.
const src = readFileSync(new URL('../app/main.swift', import.meta.url), 'utf8');

test('the app opens target=_blank links and window.open instead of dropping them', () => {
  assert.match(src, /createWebViewWith\s+cfg:\s*WKWebViewConfiguration/);
  assert.match(src, /func webView\([^)]*createWebViewWith[\s\S]*?openOutside\(/);
});

test('a plain link click that leaves the page goes to the browser, not the app window', () => {
  assert.match(src, /decidePolicyFor\s+action:\s*WKNavigationAction/);
  assert.match(src, /\.linkActivated/);
});

test('links open in Brave, the browser everything else here uses', () => {
  assert.match(src, /com\.brave\.Browser/);
});

// swiftc alone is not enough: the Linux toolchain has the compiler but no AppKit, so
// on CI this compiled far enough to fail on `import AppKit`. The app is macOS-only, so
// the type-check is too.
test('main.swift still type-checks', { skip: process.platform !== 'darwin' || !hasSwiftc() }, () => {
  execFileSync('swiftc', ['-typecheck', new URL('../app/main.swift', import.meta.url).pathname],
    { stdio: 'pipe' });
});

function hasSwiftc() {
  try { execFileSync('which', ['swiftc'], { stdio: 'pipe' }); return true; } catch { return false; }
}
