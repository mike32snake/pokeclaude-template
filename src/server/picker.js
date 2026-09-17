// The native folder chooser behind "NEW REPO".
//
// The page cannot do this on its own. <input webkitdirectory> gives relative names and
// showDirectoryPicker gives a handle, and config/repos.json needs the absolute path of
// the folder. The server is on the same Mac as the browser, so it asks macOS for the
// real Finder dialog through osascript: no dependency, and the path comes back exact.
//
// Cancelling is the common ending, not a failure. osascript exits non-zero with -128
// for it, so that one case is translated instead of being shown as an error.
import { execFile } from 'node:child_process';

const PROMPT = 'Choose a repo folder to put on the field';

// AppleScript string literal. The start folder is a real path from the field, but it
// still goes into a quoted string, and a quote or a backslash in a folder name would
// end that string early and turn the rest of the path into code.
const asString = (s) => `"${String(s).replace(/[\\"]/g, (c) => '\\' + c)}"`;

export function chooseScript(startDir) {
  const where = startDir ? ` default location POSIX file ${asString(startDir)}` : '';
  return [
    'tell application "Finder"',
    '  activate',
    `  set theFolder to choose folder with prompt ${asString(PROMPT)}${where}`,
    'end tell',
    'return POSIX path of theFolder',
  ].join('\n');
}

// osascript prints "/Users/me/Desktop/thing/" with a trailing slash on a folder.
export function parsePick(err, stdout, stderr) {
  const out = String(stdout || '').trim();
  if (err) {
    if (/-128|user canceled/i.test(String(stderr || '') + err.message)) return { cancelled: true };
    return { error: String(stderr || '').trim() || err.message };
  }
  if (!out) return { error: 'the folder chooser returned nothing' };
  return { dir: out.length > 1 ? out.replace(/\/+$/, '') : out };
}

// Injectable so the test can drive it without opening a dialog on someone's screen.
export function makePicker({ run = runOsascript } = {}) {
  return async (startDir) => {
    try {
      const { err, stdout, stderr } = await run('osascript', ['-e', chooseScript(startDir)]);
      return parsePick(err, stdout, stderr);
    } catch (e) {
      return { error: e.message };
    }
  };
}

// The dialog stays open until the person picks, so this timeout is minutes, not
// seconds. It exists only so a forgotten dialog cannot hold a request forever.
function runOsascript(cmd, args) {
  return new Promise((done) => execFile(cmd, args, { timeout: 5 * 60 * 1000 },
    (err, stdout, stderr) => done({ err, stdout, stderr })));
}

let picker = null;
export function chooseFolder(startDir) {
  if (!picker) picker = makePicker();
  return picker(startDir);
}
