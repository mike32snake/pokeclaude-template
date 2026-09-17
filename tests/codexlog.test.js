// Reading a Codex conversation.
//
// Codex keeps its sessions under ~/.codex/sessions as JSONL, one file per session,
// and it records the same conversation twice at two different altitudes. The raw
// `response_item` rows are the model's wire format and are full of things nobody
// said: a `role: "user"` row there is a page of `<recommended_plugins>` the harness
// injected, not the user's message. The `event_msg` / `item_completed` rows are the
// finished conversation - UserMessage, AgentMessage, CommandExecution, FileChange -
// so those are what the panel reads. Every fixture here is trimmed from a real file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexTurns, parseCodexTail, parseLsofLocks, codexPsTty, rolloutPath }
  from '../src/server/codexlog.js';

const item = (it, ts = '2026-09-05T12:32:19.000Z') => JSON.stringify({
  timestamp: ts, type: 'event_msg',
  payload: { type: 'item_completed', item: it },
});

const LOG = [
  JSON.stringify({ type: 'session_meta',
    payload: { session_id: '01a0718e-3345-76c3-8961-ed3de5d9ae31',
               cwd: '/Users/dev/Desktop/scratch/pokeclaude' } }),
  // The harness talking, in the wire format. Not a turn.
  JSON.stringify({ type: 'response_item',
    payload: { type: 'message', role: 'user',
               content: [{ type: 'input_text', text: '<recommended_plugins>\nAirtable\n' }] } }),
  JSON.stringify({ type: 'response_item',
    payload: { type: 'message', role: 'developer',
               content: [{ type: 'input_text', text: '<skills_instructions>' }] } }),
  item({ type: 'UserMessage', id: 'u1',
         content: [{ type: 'text', text: 'Write a file called hello.txt containing pong.' }] }),
  item({ type: 'AgentMessage', id: 'a1', phase: 'commentary',
         content: [{ type: 'Text', text: 'I’ll create `hello.txt` with that content.' }] }),
  item({ type: 'CommandExecution', id: 'c1', status: 'completed',
         command: ['/bin/zsh', '-lc', 'ls -la /usr/share/dict'] }),
  item({ type: 'FileChange', id: 'f1', status: 'completed',
         changes: { '/Users/dev/Desktop/scratch/pokeclaude/hello.txt': { type: 'add', content: 'pong\n' } } }),
  item({ type: 'Reasoning', id: 'r1', summary_text: [] }),
  item({ type: 'AgentMessage', id: 'a2', phase: 'final_answer',
         content: [{ type: 'Text', text: 'Done.' }] }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: 19451, total_tokens: 19457 },
            model_context_window: 258400 } } }),
  JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra',
    cwd: '/Users/dev/Desktop/scratch/pokeclaude', approval_policy: 'never',
    sandbox_policy: { type: 'danger-full-access' } } }),
].join('\n');

test('the conversation is the user and agent messages, in order', () => {
  const turns = parseCodexTurns(LOG);
  assert.deepEqual(turns.map(t => t.role), ['user', 'assistant', 'assistant']);
  assert.equal(turns[0].text, 'Write a file called hello.txt containing pong.');
  assert.equal(turns[2].text, 'Done.');
});

// This is the trap the raw rows set: a `role: "user"` response_item is the harness
// injecting plugin and skill context, and reading those as turns puts a page of
// machine text in the panel above every real message.
test('the harness talking is not a turn', () => {
  const turns = parseCodexTurns(LOG);
  assert.ok(!turns.some(t => /recommended_plugins|skills_instructions/.test(t.text)));
});

// Codex wraps every command in `/bin/zsh -lc`, and the panel's own bashLabel() reads
// the first word to say what happened. Left wrapped, every command in the ranch reads
// as "Ran a script: /bin/zsh".
test('a command becomes a Bash tool with the shell wrapper stripped', () => {
  const t = parseCodexTurns(LOG)[1];
  assert.deepEqual(t.tools[0], { tool: 'Bash', arg: 'ls -la /usr/share/dict' });
});

test('a file change becomes the write or edit it was, named by its path', () => {
  const t = parseCodexTurns(LOG)[1];
  assert.deepEqual(t.tools[1],
    { tool: 'Write', arg: '/Users/dev/Desktop/scratch/pokeclaude/hello.txt' });
  const edit = parseCodexTurns([item({ type: 'FileChange', id: 'f2', status: 'completed',
    changes: { '/tmp/notes.md': { type: 'update' } } })].join('\n'));
  assert.deepEqual(edit[0].tools[0], { tool: 'Edit', arg: '/tmp/notes.md' });
});

// Tools belong to the turn that ran them. A command with no assistant text before it
// still has to land somewhere, or the work vanishes from the thread.
test('a tool with no commentary before it opens an assistant turn of its own', () => {
  const turns = parseCodexTurns([
    item({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'go' }] }),
    item({ type: 'CommandExecution', id: 'c', status: 'completed', command: ['/bin/zsh', '-lc', 'pwd'] }),
  ].join('\n'));
  assert.equal(turns.length, 2);
  assert.equal(turns[1].role, 'assistant');
  assert.deepEqual(turns[1].tools, [{ tool: 'Bash', arg: 'pwd' }]);
});

test('empty reasoning is not an empty turn', () => {
  assert.ok(!parseCodexTurns(LOG).some(t => !t.text && !t.tools.length));
});

// Unlike Claude Code, Codex records the size of its own context window, so the bar is
// measured at both ends rather than guessed from the model's name.
test('the tail carries the model, the context and the window it is measured against', () => {
  const f = path.join(os.tmpdir(), `pc-codex-${process.pid}.jsonl`);
  fs.writeFileSync(f, LOG);
  try {
    const tail = parseCodexTail(f);
    assert.equal(tail.model, 'gpt-5.6-terra');
    assert.equal(tail.contextTokens, 19451);
    assert.equal(tail.contextWindow, 258400);
    assert.equal(tail.permissionMode, 'danger full access');
    assert.equal(tail.title, 'Write a file called hello.txt containing pong.');
    assert.deepEqual(tail.recentTools.at(-1), { tool: 'Write', arg: '/Users/dev/Desktop/scratch/pokeclaude/hello.txt' });
  } finally { fs.unlinkSync(f); }
});

// Which session is running in which terminal.
//
// The Claude side reads --session-id off the process's own command line; Codex puts
// nothing there. What it does do, from the moment the pane opens and before it has
// written a single turn, is hold an open lock file named after the session. lsof is
// the link, and the process that holds it is the native binary, which carries the tty.
const LSOF = [
  'COMMAND   PID    USER   FD   TYPE DEVICE  SIZE/OFF     NODE NAME',
  'codex   34452 dev   21r   REG   1,18         0 76178462 /Users/dev/.codex/thread-writer-locks/01a07186-fd9a-7973-923a-ff886900b7b3.lock',
  'codex   34452 dev   22u   REG   1,18    114955 76178999 /Users/dev/.codex/sessions/2026/09/05/rollout-2026-09-05T08-24-27-01a07186-fd9a-7973-923a-ff886900b7b3.jsonl',
  'codex   97186 dev   21r   REG   1,18         0 76179001 /Users/dev/.codex/thread-writer-locks/01a0719e-6876-7933-a908-34f45ed5c667.lock',
  'codex   99999 dev    3u   REG   1,18       128 76179100 /Users/dev/.codex/state_5.sqlite',
].join('\n');

test('the lock file says which session a process is writing', () => {
  const m = parseLsofLocks(LSOF);
  assert.equal(m.get(34452), '01a07186-fd9a-7973-923a-ff886900b7b3');
  assert.equal(m.get(97186), '01a0719e-6876-7933-a908-34f45ed5c667');
  assert.equal(m.get(99999), undefined);        // holds a database, not a session
});

// A pane that has not had a turn yet holds the lock and no rollout file, which is the
// whole reason the lock is the link and the rollout file is not.
test('a session with no turn yet is still linked', () => {
  assert.equal(parseLsofLocks(LSOF).size, 2);
});

const PS = [
  '  34449 ttys019  node /opt/homebrew/bin/codex --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox',
  '  34452 ttys019  /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --model gpt-5.5',
  '  55000 ??       /Applications/ChatGPT.app/Contents/Resources/codex --headless',
  '  60000 ttys002  claude --model opus',
].join('\n');

test('a codex process is found by its terminal, and one with no terminal is skipped', () => {
  const m = codexPsTty(PS);
  assert.equal(m.get(34452), 'ttys019');
  assert.equal(m.get(34449), 'ttys019');
  assert.equal(m.get(55000), undefined);        // no tty: not a pen
  assert.equal(m.get(60000), undefined);        // claude, not codex
});

test('a session id resolves to the file it is written to', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-codex-home-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(dir, { recursive: true });
  const want = path.join(dir, 'rollout-2026-09-05T08-24-27-01a07186-fd9a-7973-923a-ff886900b7b3.jsonl');
  fs.writeFileSync(want, '');
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-05T07-00-00-other.jsonl'), '');
  try {
    assert.equal(rolloutPath('01a07186-fd9a-7973-923a-ff886900b7b3', home), want);
    assert.equal(rolloutPath('nope', home), null);
    assert.equal(rolloutPath('', home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('multiple locks select the main conversation, regardless of lsof order', () => {
  const root = '01a076de-58d1-7673-ad31-59983e5bfd84';
  const child = '01a076de-ba55-71a1-b289-5bbc59f9ee9c';
  const rows = [root, child].map(id => `codex 81632 user 46u REG 1,15 0 123 /home/.codex/thread-writer-locks/${id}.lock`);
  const metadata = id => id === root ? { id, source: 'cli' }
    : { id, session_id: root, parent_thread_id: root, source: { subagent: {} } };
  for (const lines of [rows, [...rows].reverse()]) {
    assert.equal(parseLsofLocks(lines.join('\n'), metadata).get(81632), root);
  }
  assert.equal(parseLsofLocks(rows.join('\n')).has(81632), false);
  assert.equal(parseLsofLocks(rows.join('\n'), () => ({ source: 'cli' })).has(81632), false);
});

// ---- past sessions: the PC and the archive list Codex sessions next to Claude's ----
import { listCodexSessions, isCodexTranscriptPath } from '../src/server/codexlog.js';

function codexHome(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-codex-home-'));
  for (const [rel, rows] of Object.entries(files)) {
    const p = path.join(home, '.codex', 'sessions', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  }
  return home;
}
const meta = (id, cwd, extra = {}) => ({ type: 'session_meta', timestamp: '2026-09-07T10:26:42.140Z',
  payload: { session_id: id, id, cwd, source: 'cli', thread_source: 'user', ...extra } });
const ID1 = '01a07b67-ae0e-7df1-befe-c028ac83fd16';
const ID2 = '01a076de-58d1-7673-ad31-59983e5bfd84';
const ID3 = '01a0718e-3345-76c3-8961-ed3de5d9ae31';

test('listCodexSessions lists the sessions whose cwd is the repo, newest first, as Codex', () => {
  const home = codexHome({
    [`2026/09/07/rollout-2026-09-07T06-26-27-${ID1}.jsonl`]: [
      meta(ID1, '/Users/dev/Desktop/scratch/pokeclaude'),
      item({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'List the past Codex sessions in the PC.' }] }),
      item({ type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'Done.' }] }),
    ],
    [`2026/09/06/rollout-2026-09-06T06-26-27-${ID2}.jsonl`]: [
      meta(ID2, '/Users/dev/Desktop/website'),
      item({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Other repo.' }] }),
    ],
    // A subagent thread is a helper of another session, not a session of its own.
    [`2026/09/07/rollout-2026-09-07T07-00-00-${ID3}.jsonl`]: [
      meta(ID3, '/Users/dev/Desktop/scratch/pokeclaude',
           { thread_source: 'subagent', parent_thread_id: ID1,
             source: { subagent: { thread_spawn: { parent_thread_id: ID1 } } } }),
      item({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Helper.' }] }),
    ],
  });
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'),
    JSON.stringify({ id: ID1, thread_name: 'List Codex sessions', updated_at: '2026-09-07T10:30:00Z' }) + '\n');
  const rows = listCodexSessions('/Users/dev/Desktop/scratch/pokeclaude', { home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, 'codex');
  assert.equal(rows[0].sessionId, ID1);
  assert.equal(rows[0].title, 'List Codex sessions');
  assert.equal(rows[0].msgs, 2);
  assert.ok(rows[0].path.endsWith(`-${ID1}.jsonl`));
  assert.ok(rows[0].mtime > 0);
  // The parent repo lists the sessions of the repos inside it, as the Claude side does.
  assert.equal(listCodexSessions('/Users/dev/Desktop/scratch', { home }).length, 1);
  assert.equal(listCodexSessions('/Users/dev/Desktop/nowhere', { home }).length, 0);
});

test('a Codex session with no name in the index is titled by its opening ask', () => {
  const home = codexHome({
    [`2026/09/07/rollout-2026-09-07T06-26-27-${ID1}.jsonl`]: [
      meta(ID1, '/Users/dev/Desktop/scratch/pokeclaude'),
      item({ type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Fix the footer reader.' }] }),
    ],
  });
  const rows = listCodexSessions('/Users/dev/Desktop/scratch/pokeclaude', { home });
  assert.equal(rows[0].title, 'Fix the footer reader.');
});

test('a missing ~/.codex is an empty list, not an error', () => {
  assert.deepEqual(listCodexSessions('/x', { home: '/nonexistent-home-for-pc' }), []);
});

test('isCodexTranscriptPath only accepts rollout files under ~/.codex/sessions', () => {
  const home = '/Users/me';
  assert.ok(isCodexTranscriptPath(`/Users/me/.codex/sessions/2026/09/07/rollout-x-${ID1}.jsonl`, home));
  assert.ok(!isCodexTranscriptPath('/Users/me/.codex/auth.json', home));
  assert.ok(!isCodexTranscriptPath(`/Users/me/.codex/sessions/../auth.json`, home));
  assert.ok(!isCodexTranscriptPath('/Users/me/.claude/projects/x/y.jsonl', home));
});
