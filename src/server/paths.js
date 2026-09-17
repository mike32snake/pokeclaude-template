import fs from 'node:fs';

// macOS is case-insensitive; cmux reports mixed-case dirs for the same folder.
// Canonical form: realpath (resolves case + symlinks) then lowercase.
export function normalizeDir(dir) {
  if (!dir) return null;
  let p = dir.replace(/^~(?=\/|$)/, process.env.HOME || '');
  try { p = fs.realpathSync(p); } catch { /* keep as-is if it does not exist */ }
  return p.toLowerCase().replace(/\/+$/, '');
}

// Claude Code transcript directory slug. Every character that is not a letter,
// digit or dash becomes a dash: that includes '/', '.' AND spaces, which is why
// folders like "Task Manager" resolve to "-Users-...-Task-Manager".
export function projectSlug(dir) {
  return dir.replace(/[^A-Za-z0-9-]/g, '-');
}

// The name an upload came with, made safe to write. It arrives percent-encoded
// because a header cannot carry the narrow no-break space macOS puts in a screenshot
// name (see uploadHeaderName in public/js/attach.js). After decoding it is untrusted
// text on its way into a path, so it keeps only characters that cannot mean anything
// to a filesystem: no separators, no dots that could climb out of the folder.
export function uploadName(raw) {
  let name = String(raw ?? '');
  try { name = decodeURIComponent(name); } catch { /* a stray % is not worth losing the file over */ }
  name = name.split(/[\\/]/).pop();                  // basename, whatever the separator
  name = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
  name = name.replace(/^[._]+/, '');                 // no dotfiles, no leading padding
  return name.slice(-80) || 'file';
}
