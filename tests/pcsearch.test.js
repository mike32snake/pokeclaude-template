// The PC search box, in the browser. Titles already on screen filter at once while
// the server searches the conversations, and the matched words are marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleMatches, highlight } from '../public/js/pcsearch.js';

test('titles filter on every term, in any case and order', () => {
  const rows = [{ title: 'Fix the login bug' }, { title: 'Banner drafts' }, { title: 'Login banner' }];
  assert.deepEqual(titleMatches(rows, 'LOGIN').map(r => r.title), ['Fix the login bug', 'Login banner']);
  assert.deepEqual(titleMatches(rows, 'banner login').map(r => r.title), ['Login banner']);
  assert.equal(titleMatches(rows, '  ').length, 3);
});

test('highlight marks each term and escapes the text first', () => {
  assert.equal(highlight('Fix <the> login', 'login'), 'Fix &lt;the&gt; <mark>login</mark>');
  assert.equal(highlight('Login and LOGIN', 'login'), '<mark>Login</mark> and <mark>LOGIN</mark>');
  assert.equal(highlight('a & b', ''), 'a &amp; b');
});

test('a term that is markup itself never breaks out of the escaping', () => {
  assert.equal(highlight('x <b> y', '<b>'), 'x <mark>&lt;b&gt;</mark> y');
  assert.equal(highlight('amp &amp', 'amp'), '<mark>amp</mark> &amp;<mark>amp</mark>');
});

test('overlapping terms mark one span', () => {
  assert.equal(highlight('pricing', 'pric icing'), '<mark>pricing</mark>');
});
