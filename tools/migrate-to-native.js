// Move the pens you are working in from cmux onto our own pty.
//
//   node tools/migrate-to-native.js              # print the plan, change nothing
//   node tools/migrate-to-native.js --run        # start a native pen per conversation
//   node tools/migrate-to-native.js --run --close-cmux
//   node tools/migrate-to-native.js --run --close-cmux --include-working
//
// It reads the live cmux server's own view (http://localhost:5180/api/state), so it
// migrates exactly what is on the ranch right now. Each moved pen is a native relay
// running `claude --resume <id>` in the same directory: the same conversation, its
// history and context intact, appending to the same transcript.
//
// Nothing is closed unless --close-cmux is passed, so by default both exist for a
// moment and you can compare them before letting the old one go. Resuming one session
// in two places would have both appending to one transcript, so the plan refuses to
// move a session twice - but the cmux pen it came from is still holding that session
// open until it is closed, which is why --close-cmux exists and why it closes the pen
// only AFTER its replacement has come up.
import { migrationPlan, describePlan } from '../src/server/migrate.js';
import { resumeCommand } from '../src/server/engines.js';
import * as native from '../src/server/native.js';
import * as cmux from '../src/server/cmux.js';

const args = new Set(process.argv.slice(2));
const RUN = args.has('--run');
const CLOSE = args.has('--close-cmux');
const WORKING = args.has('--include-working');
const PORT = Number(process.env.POKECLAUDE_PORT) || 5180;

const state = await fetch(`http://localhost:${PORT}/api/state`)
  .then(r => r.json())
  .catch(() => null);
if (!state?.agents) {
  console.error(`Could not read the ranch on ${PORT}. Is PokeClaude running?`);
  process.exit(1);
}

// The server runs inside one of these tabs, and migrating it would mean resuming the
// conversation that is doing the migrating.
const selfTty = process.env.CMUX_WORKSPACE_ID || null;
const plan = migrationPlan(state.agents,
  { exclude: selfTty ? [selfTty] : [], includeWorking: WORKING });

console.log(describePlan(plan));
if (!RUN) {
  console.log('\nNothing has changed. Pass --run to move them, and add --close-cmux to');
  console.log('close each cmux tab once its replacement is up.');
  process.exit(0);
}

console.log('');
await native.attachAll();
let moved = 0;
for (const m of plan.move) {
  let command;
  try { command = resumeCommand(m.engine, m.sessionId); }
  catch (e) { console.log(`  ✗ ${m.sessionId}  ${e.message}`); continue; }

  const r = await native.newWorkspace(m.title || '◑ resumed', m.dir, command,
    { cols: 200, rows: 50 });
  if (!r.ok || !r.ref) { console.log(`  ✗ ${m.sessionId}  ${r.stderr || 'did not start'}`); continue; }

  // Up means its own footer is on its own screen, not merely that a process exists.
  const up = await waitFor(r.ref, 60_000);
  if (!up) {
    console.log(`  ✗ ${m.sessionId}  started but never drew a footer; left open for review`);
    continue;
  }
  moved++;
  console.log(`  ✓ ${m.sessionId}  ${m.dir}  -> ${r.ref}`);
  if (CLOSE) {
    const c = await cmux.closeWorkspace(m.ref);
    console.log(`    ${c.ok ? 'closed' : 'could NOT close'} the cmux tab ${m.ref}`);
  }
}

console.log(`\n${moved} of ${plan.move.length} moved.`);
if (!CLOSE && moved) {
  console.log('The cmux tabs are still open and still hold those sessions. Close them');
  console.log('before working in the native pens, or two processes share one transcript.');
}
console.log('\nStart the ranch on the moved pens with:');
console.log('  POKECLAUDE_BACKEND=native ./run-server.sh');
process.exit(0);

async function waitFor(ref, budget) {
  const until = Date.now() + budget;
  while (Date.now() < until) {
    const scr = native.readScreen(ref, 50);
    if (scr.ok && native.parseFooter(scr.stdout).model) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
