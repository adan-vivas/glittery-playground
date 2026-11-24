// Synthetic masks for the engine tests.
export function disc(w, h, cx, cy, r, into = new Float32Array(w * h)) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) into[y * w + x] = 1;
  return into;
}
export function seeded(seed = 1) {
  return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
}
export const std = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
