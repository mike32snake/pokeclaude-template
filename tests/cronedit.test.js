// Creating a launchd job from a crontab-shaped schedule. Only the pure parts are
// tested here: nothing in this file writes a plist or talks to launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cronLabel, cronToLaunchd, plistXml } from '../src/server/crons.js';

test('a name becomes one safe, namespaced label', () => {
  assert.equal(cronLabel('Weekly sales report'), 'com.pokeclaude.weekly-sales-report');
  assert.equal(cronLabel('  ap/ar  sync!! '), 'com.pokeclaude.ap-ar-sync');
});

test('a name with nothing usable in it is refused, not turned into an empty label', () => {
  assert.equal(cronLabel('///'), null);
  assert.equal(cronLabel(''), null);
});

test('a plain time becomes one calendar entry with only the fields that were given', () => {
  const s = cronToLaunchd('30 9 * * *');
  assert.deepEqual(s.StartCalendarInterval, [{ Minute: 30, Hour: 9 }]);
});

test('a weekday schedule keeps the weekday and drops the wildcards', () => {
  const s = cronToLaunchd('0 7 * * 1');
  assert.deepEqual(s.StartCalendarInterval, [{ Minute: 0, Hour: 7, Weekday: 1 }]);
});

test('lists and ranges expand into one entry each', () => {
  const s = cronToLaunchd('0 9,17 * * 1-3');
  assert.equal(s.StartCalendarInterval.length, 6);
  assert.deepEqual(s.StartCalendarInterval[0], { Minute: 0, Hour: 9, Weekday: 1 });
});

test('a pure minute step is an interval, which is what launchd does well', () => {
  assert.deepEqual(cronToLaunchd('*/15 * * * *'), { StartInterval: 900 });
});

test('a step inside a fixed hour stays a calendar, four entries wide', () => {
  const s = cronToLaunchd('*/15 9 * * *');
  assert.equal(s.StartCalendarInterval.length, 4);
  assert.deepEqual(s.StartCalendarInterval[3], { Minute: 45, Hour: 9 });
});

test('a schedule that would explode into hundreds of entries is refused', () => {
  assert.ok(cronToLaunchd('* * * * *').error);
  assert.ok(cronToLaunchd('*/2 * 1-28 * *').error);
});

test('a schedule that is not five fields is refused with a readable reason', () => {
  assert.match(cronToLaunchd('0 9 *').error, /five fields/i);
  assert.ok(cronToLaunchd('bogus 9 * * *').error);
});

test('malformed cron fields are rejected rather than partly parsed', () => {
  for (const field of ['1.5', '1e1', '0x10', '1/', '1//2', '1/NaN', '1/Infinity',
                       '1-3-5', '1,,2', '5-1', '1/0.5', '60']) {
    assert.ok(cronToLaunchd(`${field} 9 * * *`).error, field);
  }
});

test('out-of-range cron fields are rejected before expanding them', () => {
  // A child timeout bounds the regression: the old loop tried to allocate a Set
  // containing a trillion entries and blocked every request on the server.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { cronToLaunchd } from ${JSON.stringify(new URL('../src/server/crons.js', import.meta.url).href)};
     if (!cronToLaunchd('0-1000000000000 9 * * *').error) process.exit(1);`],
    { timeout: 2000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('the plist carries the label, the command, the log paths and the schedule', () => {
  const xml = plistXml({
    label: 'com.pokeclaude.demo', command: 'echo hi',
    dir: '/tmp/x', out: '/tmp/x.log', schedule: { StartCalendarInterval: [{ Minute: 0, Hour: 9 }] },
  });
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<key>Label<\/key><string>com\.pokeclaude\.demo<\/string>/);
  assert.match(xml, /echo hi/);
  assert.match(xml, /<key>WorkingDirectory<\/key><string>\/tmp\/x<\/string>/);
  assert.match(xml, /<key>StandardOutPath<\/key><string>\/tmp\/x\.log<\/string>/);
  assert.match(xml, /<key>Hour<\/key><integer>9<\/integer>/);
  // a login shell, or a launchd job gets a PATH that finds none of your tools
  assert.match(xml, /<string>-lc<\/string>/);
});

test('a command with shell metacharacters cannot break out of the XML', () => {
  const xml = plistXml({ label: 'com.pokeclaude.x', command: 'a && b < c > d "e"',
    out: '/tmp/x.log', schedule: { StartInterval: 600 } });
  assert.ok(!xml.includes('a && b'));
  assert.match(xml, /a &amp;&amp; b &lt; c &gt; d/);
  assert.match(xml, /<key>StartInterval<\/key><integer>600<\/integer>/);
});
