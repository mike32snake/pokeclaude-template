// What a pen proved about its last turn. This is OPTIONAL: a Stop hook of your own (for
// example ~/.claude/hooks/verify-gate.py) runs on every Stop, decides whether the agent checked its work after its last edit, and posts the
// result to /api/hook as a VerifyResult event. The server keeps it on the pen and the
// "finished" notification and the panel both read it, so you can see at a glance
// which "done" was proved and which one you still have to check yourself. With no
// such hook nothing is posted and the label is never drawn.
//
// Shared by the server (notify.js) and the client (ui.js), like dex.js, so the words
// in the notification and on the panel cannot drift apart.

const STATES = new Set(['verified', 'unverified', 'blocked', 'none']);
const EVIDENCE = new Set(['tests', 'browser', 'image', 'local-request', 'render', 'ran-script', 'review']);

// The hook is ours, but the endpoint takes anything on localhost, so only the shape the
// gate sends survives. Evidence names end up in the panel's HTML.
export function cleanVerify(v) {
  if (!v || typeof v !== 'object' || !STATES.has(v.state)) return null;
  return {
    state: v.state,
    evidence: (Array.isArray(v.evidence) ? v.evidence : []).filter(e => EVIDENCE.has(e)),
    files: Number.isFinite(v.files) ? v.files : 0,
    at: Number.isFinite(v.at) ? v.at : 0,
  };
}

// One short phrase, or null when there is nothing to say (no edits that turn).
export function proofLabel(v) {
  if (!v || v.state === 'none') return null;
  if (v.state === 'verified') return v.evidence?.length ? `verified: ${v.evidence.join(', ')}` : 'verified';
  if (v.state === 'blocked') return 'checking its work';
  return 'no proof';
}
