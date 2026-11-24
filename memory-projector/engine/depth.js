// Depth: gives each silhouette volume, thick in the middle and thin at the edges (the same idea as the Temporal
// Projector's point clouds), plus a little relief. This is the stage to swap for a real depth model later.

/** Two-pass chamfer distance (1, 1.414) from each mask pixel (alpha > 0.5) to the nearest pixel outside. */
export function distanceTransform(mask, w, h) {
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = mask[i] > 0.5 ? 1e6 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!D[i]) continue; let d = D[i];
    d = Math.min(d, x > 0 ? D[i - 1] + 1 : 1, y > 0 ? D[i - w] + 1 : 1);
    if (x > 0 && y > 0) d = Math.min(d, D[i - w - 1] + 1.414); else d = Math.min(d, 1.414);
    if (x < w - 1 && y > 0) d = Math.min(d, D[i - w + 1] + 1.414);
    D[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!D[i]) continue; let d = D[i];
    d = Math.min(d, x < w - 1 ? D[i + 1] + 1 : 1, y < h - 1 ? D[i + w] + 1 : 1);
    if (x < w - 1 && y < h - 1) d = Math.min(d, D[i + w + 1] + 1.414);
    if (x > 0 && y < h - 1) d = Math.min(d, D[i + w - 1] + 1.414);
    D[i] = d;
  }
  return D;
}

/**
 * Depth 0..1 for each mask pixel (0 outside): sqrt(min(dt / (0.25 * heightPx), 1)), blended with `relief` of the
 * frame's own shading (if given, 0..1), kept above 0 inside. With `cut` (feet out of frame), the bottom 12 % of the
 * figure fades away, as if it sinks into the beam.
 */
export function inflate(mask, w, h, { heightPx, relief = 0.15, shading, cut = false }) {
  const dt = distanceTransform(mask, w, h), out = new Float32Array(w * h), reach = Math.max(1, 0.25 * heightPx);
  let bottom = -1;
  if (cut) for (let i = w * h - 1; i >= 0 && bottom < 0; i--) if (mask[i] > 0.5) bottom = Math.floor(i / w);
  const fadeH = 0.12 * heightPx;
  for (let i = 0; i < w * h; i++) {
    if (!(mask[i] > 0.5)) continue;
    let d = Math.sqrt(Math.min(dt[i] / reach, 1));
    if (shading) d = (1 - relief) * d + relief * shading[i];
    if (cut && bottom >= 0) {
      const y = Math.floor(i / w), t = Math.min(1, Math.max(0, (bottom - y) / fadeH));
      d *= t * t * (3 - 2 * t);
    }
    out[i] = Math.min(1, Math.max(d, cut ? 0 : 1e-3));
  }
  return out;
}

/** Blend toward the previous frame (weight a) where both frames have a figure; elsewhere the current frame as is. */
export function smoothTemporal(prev, cur, a = 0.5) {
  if (!prev) return cur.slice();
  const out = cur.slice();
  for (let i = 0; i < cur.length; i++) if (prev[i] > 0 && cur[i] > 0) out[i] = a * prev[i] + (1 - a) * cur[i];
  return out;
}
