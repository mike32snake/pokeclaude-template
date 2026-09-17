import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdDir, promptFileOf, inlinePromptOf, scriptOf, headingOf, commentBlurb,
         firstSentence, describeJob } from '../src/server/crons.js';

const reader = (files) => (p) => (p in files ? files[p] : null);

test('the cd a job starts with is the project it works on', () => {
  assert.equal(cdDir('cd "/Users/m/.local/share/demo-network" && claude -p x'),
    '/Users/m/.local/share/demo-network');
  assert.equal(cdDir("cd '/Users/m/Robot Team' && python3 r.py"), '/Users/m/Robot Team');
  assert.equal(cdDir('/Users/m/.local/bin/pm2-reaper.sh'), null);
});

test('a prompt fed in with $(cat ...) is found and resolved against the cd', () => {
  assert.equal(promptFileOf('cd "/p" && claude -p "$(cat weekly-report-prompt.md)" --max-turns 60'),
    'weekly-report-prompt.md');
  assert.equal(promptFileOf('claude -p "run it"'), null);
});

test('an inline -p prompt is read even when the shell escapes quotes inside it', () => {
  const cmd = `claude -p 'Run the weekly usage report for Lakeshore. Steps:\n1. Verify today'"'"'s date'`;
  assert.match(inlinePromptOf(cmd), /^Run the weekly usage report for Lakeshore\./);
});

test('the script a job runs is named, ignoring the cd that comes first', () => {
  assert.equal(scriptOf('cd "/x/logs" && /Users/m/.local/bin/pm2-reaper.sh'),
    '/Users/m/.local/bin/pm2-reaper.sh');
  assert.equal(scriptOf('cd "/x" && python3 weekly_report.py && claude -p y'), 'weekly_report.py');
});

test('a prompt file describes itself with its first heading', () => {
  assert.equal(headingOf('# Weekly Demo Network traffic + AEO/GEO report\n\nYou are running as a job.'),
    'Weekly Demo Network traffic + AEO/GEO report');
  // no heading: the first real line still says more than the file name does
  assert.equal(headingOf('\nScore every new applicant.\n'), 'Score every new applicant.');
});

test('a header comment that runs past one line is joined only while it is unfinished', () => {
  const reaper = `#!/bin/bash
# pm2-reaper: stops pm2 dev servers running > 3 days,
# alerts on crash-looping processes.
# Runs daily via launchd. Log: ~/Library/Logs/pm2-reaper.log
export PATH=/bin`;
  assert.equal(commentBlurb(reaper),
    'pm2-reaper: stops pm2 dev servers running > 3 days, alerts on crash-looping processes.');

  // a new capitalised line is a new sentence, not a continuation of the title
  const mem = `#!/bin/bash
# Daily Claude Code Memory Update Script
# Searches recent sessions and maintains CLAUDE.md learnings
set -e`;
  assert.equal(commentBlurb(mem), 'Daily Claude Code Memory Update Script');

  assert.equal(commentBlurb('#!/bin/bash\nset -e\n'), null);
});

test('a description is one sentence, cut at a word boundary when it runs long', () => {
  assert.equal(firstSentence('Do the thing. Then do another thing.'), 'Do the thing.');
  const long = 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' ' + 'c'.repeat(40) + ' ' + 'd'.repeat(40);
  const cut = firstSentence(long, 100);
  assert.ok(cut.length <= 101, cut);
  assert.ok(cut.endsWith('…'));
  assert.ok(!cut.includes('d'.repeat(40)));
});

test('two jobs with the same name are told apart by what they run and where', () => {
  const files = {
    '/Users/m/.local/share/demo-network/weekly-report-prompt.md': '# Weekly Demo Network traffic report\n',
    '/Users/m/.local/share/photo-analytics/weekly-report-prompt.md': '# Weekly Photo Tools traffic report\n',
  };
  const cmd = (d) => `cd "${d}" && claude -p "$(cat weekly-report-prompt.md)" --max-turns 60`;
  const a = describeJob({ command: cmd('/Users/m/.local/share/demo-network') }, reader(files));
  const b = describeJob({ command: cmd('/Users/m/.local/share/photo-analytics') }, reader(files));

  assert.equal(a.desc, 'Weekly Demo Network traffic report');
  assert.equal(a.project, 'demo-network');
  assert.equal(b.desc, 'Weekly Photo Tools traffic report');
  assert.equal(b.project, 'photo-analytics');
});

test('a script job is described by its own header comment', () => {
  const files = { '/Users/m/bin/reaper.sh': '#!/bin/bash\n# Stops stale pm2 dev servers.\n' };
  const d = describeJob({ command: '/Users/m/bin/reaper.sh' }, reader(files));
  assert.equal(d.desc, 'Stops stale pm2 dev servers.');
});

test('an undocumented job still says what runs and which folder it runs in', () => {
  const d = describeJob({ command: 'cd "/Users/m/Desktop/website" && node sync.js', dir: null },
    reader({}));
  assert.match(d.desc, /sync\.js/);
  assert.equal(d.project, 'website');
});

test('WorkingDirectory is the project when the command has no cd of its own', () => {
  const d = describeJob({ command: '/Users/m/bin/x.sh', dir: '/Users/m/Desktop/scratch/pokeclaude' },
    reader({}));
  assert.equal(d.project, 'pokeclaude');
});

test('reading a file must never throw the whole cron list away', () => {
  const boom = () => { throw new Error('EACCES'); };
  const d = describeJob({ command: 'cd "/p" && claude -p "$(cat prompt.md)"' }, boom);
  assert.ok(d.desc);
});

test('a script path with a space in it is taken from the argv, not the joined command', () => {
  const file = '/Users/m/Desktop/CO OP Candidates/daily_resume_check.py';
  const d = describeJob({ command: `/usr/bin/python3 ${file}`, script: file },
    reader({ [file]: '#!/usr/bin/env python3\n"""\nDaily CO-OP resume checker.\n"""\n' }));
  assert.equal(d.desc, 'Daily CO-OP resume checker.');
});

test('a job whose program is a path with spaces is named by its argv[0]', () => {
  const d = describeJob({ command: '/Users/m/Application Support/Updater --wake', program: '/Users/m/Application Support/Updater' }, reader({}));
  assert.equal(d.desc, 'Runs Updater');
});
