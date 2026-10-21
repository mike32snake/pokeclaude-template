// Which thing drives the pens.
//
// index.js talks to ONE module about terminals, and two can answer: native.js, which
// owns the pty, and cmux.js, which asks another application. NATIVE IS THE DEFAULT as
// of the switch; cmux stays importable and one flag away, because a backend you cannot
// go back to is not a backend you can trust yet.
//
//     POKECLAUDE_BACKEND=cmux ./run-server.sh
//
// Nothing here starts anything. Importing both is free; native.js only attaches to
// relays when someone calls attachAll.
import * as cmux from './cmux.js';
import * as native from './native.js';

export const BACKENDS = { cmux, native };
export const NAMES = Object.keys(BACKENDS);
export const DEFAULT = 'native';

export function pick(name = process.env.POKECLAUDE_BACKEND) {
  const key = String(name || DEFAULT).toLowerCase().trim() || DEFAULT;
  const mod = BACKENDS[key];
  // Loudly, not quietly: a typo that silently fell back to cmux would look like the
  // switch having no effect, which is the most confusing possible failure.
  if (!mod) throw new Error(`"${name}" is not a backend PokeClaude has (${NAMES.join(', ')})`);
  return { name: key, mod };
}

const chosen = pick();
export const name = chosen.name;
export const isNative = chosen.name === 'native';
export default chosen.mod;
