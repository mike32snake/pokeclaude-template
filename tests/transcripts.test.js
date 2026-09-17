import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTail } from '../src/server/transcripts.js';

test('parseTail extracts tools, question, title', () => {
  const p = path.join(os.tmpdir(), `pc-test-${process.pid}.jsonl`);
  const lines = [
    { type: 'ai-title', aiTitle: 'Fix the tone tests', sessionId: 'S1' },
    { type: 'assistant', timestamp: '2026-08-21T10:00:00Z', message: { content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'pytest tests/' } }] } },
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/x/y.py' } },
      { type: 'text', text: 'Two tests fail. Relax the threshold?' }] } },
  ];
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const r = parseTail(p);
  assert.equal(r.title, 'Fix the tone tests');
  assert.equal(r.recentTools.length, 2);
  assert.equal(r.recentTools[0].tool, 'Bash');
  assert.equal(r.recentTools[0].arg, 'pytest tests/');
  assert.equal(r.lastQuestion, 'Two tests fail. Relax the threshold?');
  fs.unlinkSync(p);
});
test('parseTail survives a missing file', () => {
  const r = parseTail('/nonexistent/file.jsonl');
  assert.deepEqual(r.recentTools, []);
});

test('parseConversation returns ordered turns and skips tool-result noise', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-conv-${process.pid}.jsonl`);
  const lines = [
    { type: 'user', message: { content: 'fix the tone tests' } },
    { type: 'assistant', message: { content: [
      { type: 'text', text: 'Looking now.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'pytest' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Two failed. Relax it?' }] } },
  ];
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const c = parseConversation(p);
  assert.equal(c.length, 3);                       // the tool_result turn is dropped
  assert.equal(c[0].role, 'user');
  assert.equal(c[0].text, 'fix the tone tests');
  assert.equal(c[1].tools[0].tool, 'Bash');
  assert.equal(c[2].text, 'Two failed. Relax it?');
  fs.unlinkSync(p);
});

test('AskUserQuestion comes through with its options and answer state', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-ask-${process.pid}.jsonl`);
  const ask = (id, q) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{
    question: q, header: 'H',
    options: [{ label: 'Yes', description: 'do it' }, { label: 'No', description: 'skip' }],
    multiSelect: false }] } });
  const lines = [
    { type: 'assistant', message: { content: [ask('t1', 'Ship it?')] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1',
        content: 'The user answered: "Ship it?"="Yes"' }] } },
    { type: 'assistant', message: { content: [ask('t2', 'Delete it?')] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2',
        content: "The user doesn't want to proceed with this tool use." }] } },
    { type: 'assistant', message: { content: [ask('t3', 'Still waiting?')] } },
  ];
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const c = parseConversation(p, 50);
  const asks = c.flatMap(m => m.asks || []);
  assert.equal(asks.length, 3);
  assert.equal(asks[0].answered, true);
  assert.equal(asks[0].picked['Ship it?'], 'Yes');
  assert.equal(asks[0].questions[0].options.length, 2);
  assert.equal(asks[1].rejected, true);
  assert.equal(asks[1].answered, false);
  assert.equal(asks[2].pending, true, 'an unanswered question is what the agent is blocked on');
  fs.unlinkSync(p);
});

// The opening ask is the one turn a conversation cannot be read without: it says what
// the agent was told to do. Both trims used to drop it — the turn limit and, far more
// often, the byte window, because one pasted image can fill it on its own.
test('the opening ask survives a conversation longer than the turn limit', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-open-${process.pid}.jsonl`);
  const lines = [{ type: 'user', message: { content: 'build the crons panel' } }];
  for (let i = 0; i < 80; i++) {
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'step ' + i }] } });
  }
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const c = parseConversation(p, 10);
  assert.equal(c.length, 10);
  assert.equal(c[0].role, 'user');
  assert.equal(c[0].text, 'build the crons panel');
  assert.equal(c[1].role, 'gap');                     // the middle is what gets dropped
  assert.equal(c[c.length - 1].text, 'step 79');
  fs.unlinkSync(p);
});

test('the opening ask survives a transcript bigger than the byte window', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-big-${process.pid}.jsonl`);
  const fat = 'x'.repeat(60000);
  const lines = [{ type: 'user', message: { content: 'review the referral agreement' } }];
  for (let i = 0; i < 40; i++) {
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', content: fat }] } });
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn ' + i }] } });
  }
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.ok(fs.statSync(p).size > 900000, 'fixture must exceed the window');

  const c = parseConversation(p);
  assert.equal(c[0].role, 'user');
  assert.equal(c[0].text, 'review the referral agreement');
  assert.equal(c[1].role, 'gap');
  assert.equal(c[c.length - 1].text, 'turn 39');
  fs.unlinkSync(p);
});

test('a short conversation is returned whole, with no gap marker', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-short-${process.pid}.jsonl`);
  fs.writeFileSync(p, [
    { type: 'user', message: { content: 'hello' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  const c = parseConversation(p, 10);
  assert.equal(c.length, 2);
  assert.ok(!c.some(m => m.role === 'gap'));
  fs.unlinkSync(p);
});

test('a windowed transcript whose opening is already in the window is not duplicated', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-nodup-${process.pid}.jsonl`);
  const lines = [{ type: 'user', message: { content: 'the only ask' } }];
  for (let i = 0; i < 5; i++) {
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn ' + i }] } });
  }
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const c = parseConversation(p, 40);
  assert.equal(c.filter(m => m.text === 'the only ask').length, 1);
  fs.unlinkSync(p);
});

// How much of the context window is gone. The terminal cannot answer this: in a narrow
// pane Claude Code truncates the footer before the percentage. The transcript can, and
// exactly: every assistant turn records the tokens the request actually carried.
test('context is read from the transcript, not scraped off the screen', async () => {
  const { parseTail } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-ctx-${process.pid}.jsonl`);
  fs.writeFileSync(p, [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 1878, cache_read_input_tokens: 105123,
               output_tokens: 121 } } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  const t = parseTail(p);
  // Everything the model had to read: the new tokens plus both kinds of cached ones.
  assert.equal(t.contextTokens, 2 + 1878 + 105123);
  assert.equal(t.model, 'claude-opus-5');
  fs.unlinkSync(p);
});

test('the newest turn wins, because context only grows within a session', async () => {
  const { parseTail } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-ctx2-${process.pid}.jsonl`);
  const turn = (read) => ({ type: 'assistant', message: { model: 'claude-opus-5',
    content: [{ type: 'text', text: 'x' }],
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: read,
             output_tokens: 5 } } });
  fs.writeFileSync(p, [turn(1000), turn(50000)].map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(parseTail(p).contextTokens, 50001);
  fs.unlinkSync(p);
});

test('a transcript with no usage yet reports no context, never zero', async () => {
  const { parseTail } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-ctx3-${process.pid}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  const t = parseTail(p);
  assert.equal(t.contextTokens, null);      // zero would draw an empty bar as if measured
  assert.equal(t.model, null);
  fs.unlinkSync(p);
});

// The mode is written into the transcript on every prompt, so it does not depend on
// the footer being wide enough to print it.
test('the permission mode comes off the transcript in the words the panel shows', async () => {
  const { parseTail } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-mode-${process.pid}.jsonl`);
  const write = (mode) => fs.writeFileSync(p,
    JSON.stringify({ type: 'user', permissionMode: mode, message: { content: 'go' } }) + '\n');
  write('bypassPermissions');
  assert.equal(parseTail(p).permissionMode, 'bypass permissions');
  write('acceptEdits');
  assert.equal(parseTail(p).permissionMode, 'accept edits');
  write('plan');
  assert.equal(parseTail(p).permissionMode, 'plan');
  write('default');
  assert.equal(parseTail(p).permissionMode, 'default');
  fs.unlinkSync(p);
});

test('a mode nobody has seen before is passed through rather than dropped', async () => {
  const { parseTail } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-mode2-${process.pid}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({ type: 'user', permissionMode: 'somethingNew',
    message: { content: 'go' } }) + '\n');
  assert.equal(parseTail(p).permissionMode, 'something new');
  fs.unlinkSync(p);
});

// A message typed while the agent is working is queued, and Claude Code writes it to
// the transcript as an attachment, not a user turn. Captured live. Dropping it left
// the thread with no sign the message was ever sent, right after the panel said it was.
test('a queued message shows in the thread as the user turn it is', async () => {
  const { parseConversation } = await import('../src/server/transcripts.js');
  const p = path.join(os.tmpdir(), `pc-queued-${process.pid}.jsonl`);
  const lines = [
    { type: 'user', message: { content: 'sleep for a while' }, timestamp: '2026-08-26T23:00:00.000Z' },
    { type: 'queue-operation', operation: 'enqueue', content: 'queued from the api' },
    { type: 'attachment', uuid: 'q1', timestamp: '2026-08-26T23:00:23.586Z',
      attachment: { type: 'queued_command', prompt: 'queued from the api', commandMode: 'prompt' } },
    { type: 'queue-operation', operation: 'remove', content: 'queued from the api', reason: 'absorbed_mid_turn' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  ];
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const c = parseConversation(p);
  assert.deepEqual(c.map(m => [m.role, m.text]),
    [['user', 'sleep for a while'], ['user', 'queued from the api'], ['assistant', 'done']]);
  assert.equal(c[1].at, Date.parse('2026-08-26T23:00:23.586Z'));
  assert.equal(c[1].queued, true);
  fs.unlinkSync(p);
});

// ---- past sessions carry their engine, and are read by the parser that wrote them ----
import { readConversation, isTranscriptPath, mergeSessions } from '../src/server/transcripts.js';

test('readConversation picks the Codex parser for a Codex rollout and the Claude one otherwise', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-read-home-'));
  const cx = path.join(home, '.codex', 'sessions', '2026', '09', '07', 'rollout-2026-09-07-01a07b67-ae0e-7df1-befe-c028ac83fd16.jsonl');
  fs.mkdirSync(path.dirname(cx), { recursive: true });
  fs.writeFileSync(cx, [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'x', cwd: '/r' } }),
    JSON.stringify({ timestamp: '2026-09-07T10:00:00Z', type: 'event_msg', payload: { type: 'item_completed',
      item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hello codex' }] } } }),
  ].join('\n') + '\n');
  const cl = path.join(home, 'claude.jsonl');
  fs.writeFileSync(cl, JSON.stringify({ type: 'user', timestamp: '2026-09-07T10:00:00Z',
    message: { content: 'hello claude' } }) + '\n');
  assert.deepEqual(readConversation(cx, 40, { home }).map(m => m.text), ['hello codex']);
  assert.deepEqual(readConversation(cl, 40, { home }).map(m => m.text), ['hello claude']);
});

test('isTranscriptPath accepts a Codex rollout as well as a Claude transcript', () => {
  const home = os.homedir();
  assert.ok(isTranscriptPath(path.join(home, '.claude', 'projects', 'x', 'y.jsonl')));
  assert.ok(isTranscriptPath(path.join(home, '.codex', 'sessions', '2026', '09', '07', 'rollout-a-b.jsonl')));
  assert.ok(!isTranscriptPath(path.join(home, '.codex', 'auth.json')));
  assert.ok(!isTranscriptPath('/etc/passwd'));
});

test('mergeSessions interleaves both engines newest first and keeps the limit', () => {
  const claude = [{ path: 'c1', mtime: 30, engine: 'claude' }, { path: 'c2', mtime: 10, engine: 'claude' }];
  const codex = [{ path: 'x1', mtime: 20, engine: 'codex' }];
  assert.deepEqual(mergeSessions(claude, codex, 2).map(r => r.path), ['c1', 'x1']);
  assert.deepEqual(mergeSessions(claude, codex, 5).map(r => r.engine), ['claude', 'codex', 'claude']);
});
