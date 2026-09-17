// Turn raw tool calls into orchestration-level activity:
// one line per meaningful action, phrased for a human, with runs collapsed.
// The raw calls are still there under DETAIL when you actually need them.

const base = (p) => (p || '').split('/').filter(Boolean).pop() || p || '';

function bashLabel(cmd) {
  const c = (cmd || '').trim();
  if (/^git\s+commit/.test(c)) return ['Committed changes', ''];
  if (/^git\s+push/.test(c)) return ['Pushed to remote', ''];
  if (/^git\s+(status|diff|log)/.test(c)) return ['Checked git', ''];
  if (/(pytest|jest|vitest|npm (run )?test|node --test|go test)/.test(c)) return ['Ran tests', ''];
  if (/^(npm|pnpm|yarn|pip|brew)\s+(i|install|add)/.test(c)) return ['Installed dependencies', ''];
  if (/^(npm|pnpm|yarn)\s+run\s+build/.test(c)) return ['Built the project', ''];
  if (/^curl/.test(c)) { const m = c.match(/https?:\/\/([^/\s"']+)/); return ['Called an API', m ? m[1] : '']; }
  if (/^(cat|head|tail|less|sed -n)/.test(c)) return ['Read a file', base(c.split(/\s+/).pop())];
  if (/^(ls|find|tree)\b/.test(c)) return ['Looked around the filesystem', ''];
  if (/^(grep|rg)\b/.test(c)) return ['Searched the code', ''];
  if (/^(mkdir|cp|mv|rm|chmod|touch)\b/.test(c)) return ['Changed files on disk', c.split(/\s+/)[0]];
  if (/^(python3?|node|deno|ruby)\b/.test(c)) return ['Ran a script', ''];
  if (/^(pm2|docker|launchctl)\b/.test(c)) return ['Managed a service', c.split(/\s+/)[0]];
  return ['Ran a command', c.split(/\s+/)[0] || ''];
}

// tool -> [label, detail]
function label(t) {
  const name = t.tool || '', arg = t.arg || '';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const service = (parts[1] || 'service').replace(/^plugin_/, '').replace(/_/g, ' ')
      .split(' ').filter((w, i, a) => a.indexOf(w) === i).join(' ');
    const action = (parts.slice(2).join(' ') || '').replace(/_/g, ' ')
      .split(' ').filter(Boolean).filter((w) => !service.split(' ').includes(w)).join(' ');
    return [`${service}: ${action || 'call'}`.trim(), arg];
  }
  switch (name) {
    case 'Bash': return bashLabel(arg);
    case 'Read': case 'NotebookRead': return ['Read a file', base(arg)];
    case 'Edit': case 'Write': case 'NotebookEdit': return ['Edited a file', base(arg)];
    case 'Grep': case 'Glob': return ['Searched the code', arg];
    case 'WebFetch': { const m = arg.match(/https?:\/\/([^/\s]+)/); return ['Read a web page', m ? m[1] : arg]; }
    case 'WebSearch': return ['Searched the web', arg];
    case 'Task': case 'Agent': return ['Handed work to a subagent', arg];
    case 'TodoWrite': return ['Updated its plan', ''];
    case 'Skill': return ['Loaded a skill', arg];
    case 'Artifact': return ['Published an artifact', ''];
    case 'AskUserQuestion': return ['Asked you a question', ''];
    default: return [name || 'Tool', arg];
  }
}

const PLURAL = {
  'Read a file': (n) => `Read ${n} files`,
  'Edited a file': (n) => `Edited ${n} files`,
  'Ran a command': (n) => `Ran ${n} commands`,
  'Searched the code': (n) => `Searched the code ${n} times`,
  'Ran a script': (n) => `Ran ${n} scripts`,
};

// Collapse consecutive calls that mean the same thing into one line.
export function summarizeTools(tools) {
  const out = [];
  for (const t of tools || []) {
    const [lab, detail] = label(t);
    const prev = out[out.length - 1];
    if (prev && prev.key === lab) {
      prev.count += 1;
      if (detail && prev.details.length < 4) prev.details.push(detail);
    } else {
      out.push({ key: lab, count: 1, details: detail ? [detail] : [] });
    }
  }
  return out.map((g) => ({
    label: g.count > 1 && PLURAL[g.key] ? PLURAL[g.key](g.count)
      : g.count > 1 ? `${g.key} (${g.count})` : g.key,
    detail: g.details.slice(0, 3).join(', ') + (g.details.length > 3 ? '…' : ''),
  }));
}
