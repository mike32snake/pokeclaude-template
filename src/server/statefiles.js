// Where a backend keeps its own state on disk.
//
// The two backends host DIFFERENT PENS: a cmux workspace and a native relay are not the
// same thing, so a file recording "which sessions were running" or "which replies are
// still owed" belongs to one of them and not to both.
//
// Running the native server beside the live cmux one proved the point. They shared
// data/roster.json; the native ranch saw its one pen and rewrote the file marking all
// ten live cmux sessions as lost. The next thing you would have seen on the
// ranch you actually work in is "CMUX RESTARTED - 10 sessions stopped with it", about
// ten agents that were running perfectly well.
//
// cmux keeps the paths it has always had, so none of his history moves.
import path from 'node:path';

const PLAIN = /^[a-z][a-z0-9-]{0,31}$/;

export function stateFile(root, name, backend) {
  if (!PLAIN.test(String(backend || ''))) {
    throw new Error(`"${backend}" is not a backend name`);
  }
  if (backend === 'cmux') return path.join(root, 'data', name);
  const dot = name.lastIndexOf('.');
  const tagged = dot > 0
    ? `${name.slice(0, dot)}.${backend}${name.slice(dot)}`
    : `${name}.${backend}`;
  return path.join(root, 'data', tagged);
}
