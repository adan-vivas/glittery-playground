// Steady: clips are often handheld. Per frame, find where the kept figures stand (their ground point) and how tall they
// are, then move and scale each frame so the figures stand still on the hologram's foot while they move naturally.
// The ground point is pinned frame by frame (groundTau 0): smoothing can't tell a shaking camera from a moving figure,
// and pinning removes the shake. The cost: a jump stays on the ground. The size is smoothed (heightTau), so the figure
// doesn't pump as arms go up and down.

/** → { ground: [x, y], height, cut } for a mask (alpha > 0.5), or null when it is empty. */
export function measure(mask, w, h) {
  let top = -1, bottom = -1;
  for (let y = 0; y < h && top < 0; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] > 0.5) { top = y; break; }
  if (top < 0) return null;
  for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (mask[y * w + x] > 0.5) { bottom = y; break; }
  const height = bottom - top + 1, band = Math.max(1, Math.round(height * 0.1));
  let sx = 0, n = 0;
  for (let y = bottom - band + 1; y <= bottom; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] > 0.5) { sx += x; n++; }
  return { ground: [sx / n, bottom], height, cut: bottom >= h - 2 };
}

/** Zero-phase exponential smoothing (forward then backward), time constant tau seconds at fps. */
export function smooth(values, tau, fps = 12) {
  if (!values.length) return [];
  if (!(tau > 0)) return values.slice();
  const a = 1 - Math.exp(-1 / (tau * fps)), f = values.slice();
  for (let i = 1; i < f.length; i++) f[i] = f[i - 1] + a * (f[i] - f[i - 1]);
  for (let i = f.length - 2; i >= 0; i--) f[i] = f[i + 1] + a * (f[i] - f[i + 1]);
  return f;
}

/**
 * Per frame { scale, tx, ty }: a frame pixel (x, y) goes to (x * scale + tx, y * scale + ty) in the out × out frame.
 * Frames whose measure is null hold the last good transform (the first good one is back-filled to the start).
 */
export function steadyTransforms(measures, { out = 256, foot = 0.92, fill = 0.8, fps = 12, groundTau = 0, heightTau = 0.6 } = {}) {
  const firstGood = measures.findIndex(Boolean);
  if (firstGood < 0) return measures.map(() => ({ scale: 1, tx: 0, ty: 0 }));
  const filled = [];
  let last = measures[firstGood];
  for (const m of measures) { if (m) last = m; filled.push(last); }
  const gx = smooth(filled.map((m) => m.ground[0]), groundTau, fps), gy = smooth(filled.map((m) => m.ground[1]), groundTau, fps);
  const hh = smooth(filled.map((m) => m.height), heightTau, fps);
  const T = filled.map((_, i) => {
    const scale = (fill * out) / hh[i];
    return { scale, tx: out / 2 - gx[i] * scale, ty: foot * out - gy[i] * scale };
  });
  // frames with nothing in them hold the transform of the last frame that had something
  for (let i = 0; i < measures.length; i++) if (!measures[i] && i > firstGood) T[i] = T[i - 1];
  for (let i = 0; i < firstGood; i++) T[i] = T[firstGood];
  return T;
}
