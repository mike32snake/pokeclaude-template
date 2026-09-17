// Ash is the only conversation in PokeClaude with no transcript of its own. An agent
// writes to ~/.claude/projects/...jsonl; Ash's answer comes from a one-shot
// `claude -p`, so unless we write it down it is gone the moment the panel re-renders.
// One JSONL, oldest first, appended to and read from the tail.
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ = 512 * 1024;     // plenty for a long history; keeps a runaway file cheap

export function ashLogPath(root) {
  return path.join(root, 'data', 'ash-log.jsonl');
}

export function appendAsh(root, entry) {
  const file = ashLogPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                ts: Date.now(), ...entry };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

// Oldest first, so the panel can render it as a chat and scroll to the bottom.
export function readAsh(root, limit = 50) {
  const file = ashLogPath(root);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, MAX_READ);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    if (size > want) text = text.slice(text.indexOf('\n') + 1);   // drop the half line
  } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line is not worth failing on */ }
  }
  return rows.slice(-limit);
}
