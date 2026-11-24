// Figures: the separate shapes in a cut-out (a child, an adult, a ball, a reflection), and following the ones you chose
// from frame to frame.

/**
 * Connected regions (4-connected) of alpha > threshold. Regions smaller than minArea are dropped (label 0).
 * → { labels: Int32Array (0 = none), figures: [{ id, area, box: [x0, y0, x1, y1], centroid: [x, y] }] }
 */
export function labelFigures(alpha, w, h, { threshold = 0.5, minArea = 0.002 * w * h } = {}) {
  const labels = new Int32Array(w * h), figures = [], stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || alpha[start] <= threshold) continue;
    const id = next++, members = [];
    let sp = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack[sp++] = start; labels[start] = id;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w;
      members.push(i); sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const push = (j) => { if (!labels[j] && alpha[j] > threshold) { labels[j] = id; stack[sp++] = j; } };
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
    }
    if (members.length < minArea) { for (const i of members) labels[i] = 0; continue; }
    figures.push({ id, area: members.length, box: [x0, y0, x1, y1], centroid: [sx / members.length, sy / members.length] });
  }
  return { labels, figures };
}

/** The figures of `cur` to keep: those with ≥ 20 % of their pixels on pixels that were kept in the previous frame. */
export function trackFigures(prevLabels, prevKeep, cur) {
  const hits = new Map(), keep = new Set();
  for (let i = 0; i < cur.labels.length; i++) {
    const id = cur.labels[i];
    if (id && prevKeep.has(prevLabels[i])) hits.set(id, (hits.get(id) || 0) + 1);
  }
  for (const f of cur.figures) if ((hits.get(f.id) || 0) >= 0.2 * f.area) keep.add(f.id);
  return keep;
}

/** alpha where the pixel belongs to a kept figure, 0 elsewhere. */
export function keepMask(alpha, labels, keep) {
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) if (labels[i] && keep.has(labels[i])) out[i] = alpha[i];
  return out;
}
