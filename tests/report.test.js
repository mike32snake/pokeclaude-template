// The clipboard button on an agent. It copies one block of text that answers every
// question anyone debugging this ranch has to ask twice: which cmux workspace is this,
// which transcript on disk, which model, how full is the context, what did it do last,
// what is on its screen right now. Pasting that beats describing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionReport } from '../public/js/report.js';

const AGENT = {
  workspaceId: 'A548A693-76A4-472F-80B5-11494D1B6697',
  ref: 'workspace:7',
  sessionId: 'e4262301-2335-44db-9144-1ab0f727d35b',
  tty: 'ttys000',
  rawDir: '/Users/dev/Desktop/scratch/pokeclaude',
  title: 'reordering the pens',
  branch: 'master',
  gitDirty: true,
  status: 'BLOCKED',
  since: 1000,
  kind: 'agent',
  model: 'Opus 5 (1M context)',
  contextPct: 14,
  contextTokens: 135327,
  permissionMode: 'bypass permissions',
};
const DETAIL = {
  transcriptPath: '/Users/dev/.claude/projects/-x/e4262301.jsonl',
  linked: true,
  linkedBy: 'process',
  ambiguous: false,
  recentTools: [{ name: 'Bash', input: 'npm test' }],
  pending: ['Which one?', '1. keep it', '2. rewrite it'],
  messages: [
    { role: 'user', text: 'reorder the pens' },
    { role: 'assistant', text: 'Done, 202 tests pass.' },
  ],
};
const base = (o = {}) => sessionReport({
  sign: 'pokeclaude', species: 'PIKACHU', agent: AGENT, detail: DETAIL,
  screen: '❯ \n  Opus 5 (1M context) | gh:octocat', now: 601000, ...o,
});

test('the report names the workspace, the ref and the folder', () => {
  const r = base();
  assert.match(r, /workspace:7/);
  assert.match(r, /A548A693-76A4-472F-80B5-11494D1B6697/);
  assert.match(r, /\/Users\/dev\/Desktop\/scratch\/pokeclaude/);
});

// The transcript path is the whole point: it is what makes a session readable later.
test('the report carries the full transcript path and the session id', () => {
  const r = base();
  assert.match(r, /\/Users\/dev\/\.claude\/projects\/-x\/e4262301\.jsonl/);
  assert.match(r, /e4262301-2335-44db-9144-1ab0f727d35b/);
});

test('the report carries the model, the context and the mode', () => {
  const r = base();
  assert.match(r, /Opus 5 \(1M context\)/);
  assert.match(r, /14%/);
  assert.match(r, /135,327|135327/);
  assert.match(r, /bypass permissions/);
});

test('a blocked agent reports how long it has been waiting, and on what', () => {
  const r = base();
  assert.match(r, /BLOCKED/);
  assert.match(r, /10m/);
  assert.match(r, /rewrite it/);
});

test('the terminal screen goes in verbatim', () => {
  assert.match(base(), /gh:octocat/);
});

// Half the fields are null half the time. A report that throws is a report nobody has.
test('missing facts leave the report standing', () => {
  const r = sessionReport({ sign: 'x', agent: { workspaceId: 'w', status: 'ASLEEP', since: 0 } });
  assert.match(r, /x/);
  assert.doesNotMatch(r, /undefined|null|NaN/);
});

test('it is plain text, with no markdown fences to break a paste', () => {
  assert.doesNotMatch(base(), /```/);
});

// A transcript can be thousands of turns. The clipboard gets the tail.
test('only the last few turns are copied', () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', text: `turn ${i}` }));
  const r = base({ detail: { ...DETAIL, messages } });
  assert.match(r, /turn 59/);
  assert.doesNotMatch(r, /turn 0\b/);
});

test('a long turn is trimmed rather than pasted whole', () => {
  const messages = [{ role: 'assistant', text: 'z'.repeat(5000) }];
  const r = base({ detail: { ...DETAIL, messages } });
  assert.ok(r.length < 6000, `report was ${r.length} chars`);
  assert.match(r, /…/);
});

// Tool arguments are shell commands, and shell commands have newlines in them. Pasted
// raw they break every column in the report.
test('a multi-line tool argument is flattened onto one line', () => {
  const r = base({ detail: { ...DETAIL,
    recentTools: [{ tool: 'Bash', arg: 'cd /tmp\ngit status -sb | head -1' }] } });
  const line = r.split('\n').find(l => l.includes('git status'));
  assert.ok(line, 'the tool line is missing');
  assert.match(line, /cd \/tmp .*git status/);
});

// A turn that was nothing but tool calls has no text. A row reading "assistant" and
// then nothing tells the reader less than no row at all.
test('turns with no text are left out', () => {
  const messages = [{ role: 'assistant', text: '' }, { role: 'assistant', text: '  ' },
                    { role: 'user', text: 'still here' }];
  const r = base({ detail: { ...DETAIL, messages } });
  assert.match(r, /still here/);
  assert.equal(r.split('\n').filter(l => /^\s*assistant\s*$/.test(l)).length, 0);
});
