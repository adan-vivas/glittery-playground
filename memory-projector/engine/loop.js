// Loop: the clip plays round and round, so its last moments blend into its first. The first n frames become a crossfade
// from the last n; the clip gets n frames shorter. Clips shorter than 3n frames are left alone.
export function crossfadeLoop(frames, n = 6) {
  const L = frames.length;
  if (L < 3 * n) return frames.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = frames[L - n + i], b = frames[i], k = (i + 1) / (n + 1), f = new Float32Array(b.length);
    for (let p = 0; p < b.length; p++) {
      const x = a[p], y = b[p];
      f[p] = x > 0 && y > 0 ? x * (1 - k) + y * k : x > 0 ? x : y;   // figure-ness from either frame
    }
    out.push(f);
  }
  for (let i = n; i < L - n; i++) out.push(frames[i]);
  return out;
}
