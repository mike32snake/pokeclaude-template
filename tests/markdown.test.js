import test from 'node:test';
import assert from 'node:assert';
import { md } from '../public/js/markdown.js';

const SAMPLE = [
  '**The guard set is now fully proven on real traffic:**',
  '',
  '| Guard | Result |',
  '|---|---|',
  '| Suppression (unsubscribe) | blocks send, enrollment `stopped` |',
  '| Stop-on-reply | blocks send, enrollment `replied` |',
  '',
  '- item one with *emphasis*',
  '- item two',
].join('\n');

test('renders a pipe table as a real table', () => {
  const h = md(SAMPLE);
  assert.match(h, /<table class="md-table"/);
  assert.match(h, /<th>Guard<\/th>/);
  assert.equal((h.match(/<tr>/g) || []).length, 3);        // header + 2 rows
  assert.match(h, /<code>stopped<\/code>/);
});
test('renders bold, italics and lists', () => {
  const h = md(SAMPLE);
  assert.match(h, /<strong>The guard set is now fully proven on real traffic:<\/strong>/);
  assert.match(h, /<ul class="md-list">/);
  assert.match(h, /<em>emphasis<\/em>/);
});
test('escapes html before transforming', () => {
  const h = md('a <script>alert(1)</script> b');
  assert.ok(!h.includes('<script>'), 'script tag must not survive');
  assert.match(h, /&lt;script&gt;/);
});
test('fenced code keeps its contents verbatim', () => {
  const h = md(['```js', 'const x = 1 < 2 && 3 > 2;', '```'].join('\n'));
  assert.match(h, /<pre class="md-code">/);
  assert.match(h, /const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;/);
  assert.ok(!h.includes('<em>'), 'no emphasis inside code');
});
test('a ragged table row does not lose columns', () => {
  const h = md(['| a | b |', '|---|---|', '| only-one |'].join('\n'));
  assert.equal((h.match(/<td>/g) || []).length, 2);
});
test('plain prose is untouched apart from paragraphs', () => {
  assert.equal(md('just a line'), '<p class="md-p">just a line</p>');
});

test('quotes in link destinations cannot introduce HTML attributes', () => {
  const h = md('[link](https://example.test/"onmouseover="globalThis.injected=1)');
  assert.ok(!h.includes('"onmouseover="'), h);
  assert.match(h, /href="https:\/\/example.test\/&quot;onmouseover=&quot;/);
});

test('inline formatting never transforms the destination of a link', () => {
  assert.equal(md('[**link**](https://example.test/**path**)'),
    '<p class="md-p"><a href="https://example.test/**path**" target="_blank" rel="noreferrer"><strong>link</strong></a></p>');
  assert.ok(!md('[link](https://example.test/`"`)').includes('href="https://example.test/<code>'));
});

test('inline code escapes once and keeps markdown literal', () => {
  assert.equal(md('`a < b && **c**`'), '<p class="md-p"><code>a &lt; b &amp;&amp; **c**</code></p>');
});

test('literal placeholder delimiters cannot refer to generated markup', () => {
  assert.equal(md('\u00000\u0000 `safe`'), '<p class="md-p">&#0;0&#0; <code>safe</code></p>');
});

test('links preserve query strings and inline code in their labels', () => {
  assert.equal(md('[a `b` & c](https://example.test/?a=1&b=2)'),
    '<p class="md-p"><a href="https://example.test/?a=1&amp;b=2" target="_blank" rel="noreferrer">a <code>b</code> &amp; c</a></p>');
});

test('bare URLs in a reply become links', () => {
  assert.equal(md('see https://example.test/a?b=1&c=2 now'),
    '<p class="md-p">see <a href="https://example.test/a?b=1&amp;c=2" target="_blank" rel="noreferrer">https://example.test/a?b=1&amp;c=2</a> now</p>');
});

test('a bare URL leaves trailing punctuation and closing brackets outside the link', () => {
  assert.equal(md('(at http://localhost:5180/x).'),
    '<p class="md-p">(at <a href="http://localhost:5180/x" target="_blank" rel="noreferrer">http://localhost:5180/x</a>).</p>');
});

test('bare URLs are not linked twice or inside code', () => {
  assert.equal(md('[doc](https://example.test/d)'),
    '<p class="md-p"><a href="https://example.test/d" target="_blank" rel="noreferrer">doc</a></p>');
  assert.equal(md('`https://example.test/c`'), '<p class="md-p"><code>https://example.test/c</code></p>');
  assert.equal(md('[https://example.test/e](https://example.test/e)'),
    '<p class="md-p"><a href="https://example.test/e" target="_blank" rel="noreferrer">https://example.test/e</a></p>');
});

test('a bare URL cannot break out of its attribute', () => {
  const h = md('https://example.test/"onmouseover="x');
  assert.ok(!h.includes('" onmouseover'));
  assert.match(h, /href="https:\/\/example.test\/&quot;onmouseover=&quot;x"/);
});
