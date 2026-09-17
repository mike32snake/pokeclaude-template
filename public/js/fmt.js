// Compact elapsed time, used by both the canvas labels and the dialogue header.
export function elapsed(ms) {
  const m = Math.floor(ms / 60e3), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (h >= 48) return `${d}d`;
  if (h >= 1) return `${h}h${h < 6 ? String(m % 60).padStart(2, '0') : ''}`;
  return `${m}m`;
}
