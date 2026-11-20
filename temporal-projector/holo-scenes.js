// The hologram's subjects: point clouds reconstructed in code from artworks.
//
// Each subject starts as a picture (assets/holo/*.jpg, or the portrait for "Now"). The code reads it and rebuilds it in 3D:
//   Dots     placed where the picture is lit, densest in its highlights, as in the art; each takes the picture's colour
//            (its blue → brightness, its orange → accent).
//   Depth    silhouettes are inflated into volumes with a distance transform (thick in the middle, thin at the edges), fine
//            relief comes from the shading, and some subjects get a model of their own (the cell is a sphere, the meadow
//            and the farm recede as ground). Every shape also gets a back surface, so turning it shows real volume.
//   Motion   soft-weighted regions are skinned to bones (a ball that bounces, a tail that wags, a head that tilts),
//            flowers and feathers sway in the wind, and loose motes drift up.
// Units: 1 = the hologram's height. x across (±0.5), y up from its foot (0…1), z toward the viewer.
// Per dot: position, normal, skin (bone, bone, weight of the first, sway: + wind, − rising mote), and
// material (brightness, orange accent 0…1, ridge, thin).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

export const HOLO_DOTS = 56000;
export const MAX_BONES = 24;

const rngOf = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const spring = (tau, w = 9, z = 5) => (tau <= 0 ? 0 : 1 - Math.exp(-z * tau) * (Math.cos(w * tau) + (z / w) * Math.sin(w * tau)));
const loadImage = async (src) => createImageBitmap(await (await fetch(src)).blob());   // works on the page and in a worker
const asset = (name) => new URL(`./assets/holo/${name}.jpg`, import.meta.url).href;

// ------------------------------------------------------------------ the skeleton
class Rig {
  constructor() { this.names = []; this.parent = []; this.pivot = []; }
  bone(name, parent, pivot = [0, 0, 0]) { this.names.push(name); this.parent.push(parent ? this.names.indexOf(parent) : -1); this.pivot.push(pivot); return this; }
  id(name) { const i = this.names.indexOf(name || 'root'); if (i < 0) throw new Error('no bone ' + name); return i; }
  apply(pose, out) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const T1 = new THREE.Matrix4(), T2 = new THREE.Matrix4(), I = new THREE.Matrix4();
    for (let i = 0; i < this.names.length; i++) {
      const p = pose[this.names[i]] || {}, pv = this.pivot[i], s = p.s ?? 1, t = p.t || [0, 0, 0], r = p.r || [0, 0, 0];
      if (Array.isArray(s)) sc.set(s[0], s[1], s[2]); else sc.set(s, s, s);
      m.compose(v.set(0, 0, 0), q.setFromEuler(e.set(r[0], r[1], r[2], 'XYZ')), sc);
      T1.makeTranslation(pv[0] + t[0], pv[1] + t[1], (pv[2] || 0) + t[2]).multiply(m).multiply(T2.makeTranslation(-pv[0], -pv[1], -(pv[2] || 0)));
      out[i].copy(this.parent[i] >= 0 ? out[this.parent[i]] : I).multiply(T1);
    }
  }
}

// ------------------------------------------------------------------ picture → frame
// A crop of a picture [u0, v0, u1, v1] fitted into the hologram: centred, standing on y = 0, at most 1 wide and 1 tall.
function framer(iw, ih, crop) {
  const [u0, v0, u1, v1] = crop, w = (u1 - u0) * iw, h = (v1 - v0) * ih, s = Math.min(1 / w, 1 / h);
  return { at: (u, v) => [((u - u0) * iw - w / 2) * s, (v1 - v) * ih * s, 0], s };
}

// ------------------------------------------------------------------ the reconstruction
async function reconstruct(cfg, rig) {
  const img = await loadImage(cfg.src);
  const W = cfg.res || 520, H = Math.round(W * img.height / img.width), cv = new OffscreenCanvas(W, H), g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data, N = W * H, F = framer(img.width, img.height, cfg.crop), r = rngOf(cfg.seed || 7);
  const L = new Float32Array(N), A = new Float32Array(N), M = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2], u = (i % W) / W, v = Math.floor(i / W) / H;
    L[i] = cfg.lum ? cfg.lum(R, G, B, u, v) : Math.max(R, G, B) / 255;
    A[i] = cfg.accent ? cfg.accent(R, G, B, u, v) : clamp((R - B * 0.75 - 18) / 110, 0, 1);   // orange against blue
    M[i] = L[i] > (cfg.floor ?? 0.1) ? 1 : 0;
    if (cfg.mask && !cfg.mask(u, v)) M[i] = 0;
  }
  // distance to the silhouette's edge (two-pass chamfer): how far "into" a shape each pixel is
  const D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = M[i] ? 1e6 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!D[i]) continue; let d = D[i];
    if (x > 0) d = Math.min(d, D[i - 1] + 1); if (y > 0) d = Math.min(d, D[i - W] + 1);
    if (x > 0 && y > 0) d = Math.min(d, D[i - W - 1] + 1.414); if (x < W - 1 && y > 0) d = Math.min(d, D[i - W + 1] + 1.414); D[i] = d; }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (!D[i]) continue; let d = D[i];
    if (x < W - 1) d = Math.min(d, D[i + 1] + 1); if (y < H - 1) d = Math.min(d, D[i + W] + 1);
    if (x < W - 1 && y < H - 1) d = Math.min(d, D[i + W + 1] + 1.414); if (x > 0 && y < H - 1) d = Math.min(d, D[i + W - 1] + 1.414); D[i] = d; }
  // a soft copy of the light, for relief
  const Lb = new Float32Array(L), tmp = new Float32Array(N), K = 3;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let k = -K; k <= K; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += Lb[y * W + xx]; c++; } } tmp[y * W + x] = s / c; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let k = -K; k <= K; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; c++; } } Lb[y * W + x] = s / c; }
  }
  const pxScale = img.width / W;   // picture pixels per sample pixel
  const depth = (x, y, u, v) => {
    const i = clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1), dome = cfg.inflate > 1 ? Math.sqrt(Math.min(D[i] * pxScale, cfg.inflate) / cfg.inflate) : 0;
    return (cfg.depth || 0) * dome + (cfg.relief || 0) * (Lb[i] - 0.4) + (cfg.z ? cfg.z(u, v, F.at(u, v)) : 0);
  };
  // how many dots each pixel gets: brighter → more, like the art
  const gamma = cfg.gamma ?? 1.25, budget = HOLO_DOTS * (cfg.over ?? 1.25) / (1 + (cfg.back ?? 0));
  const inCrop = (u, v) => u >= cfg.crop[0] && u <= cfg.crop[2] && v >= cfg.crop[1] && v <= cfg.crop[3];
  let total = 0;
  const dens = (l) => Math.pow(Math.min(l, cfg.cap ?? 0.55), gamma);   // the same density everywhere above mid-tone; brightness carries the rest
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (M[y * W + x] && inCrop(x / W, y / H)) total += dens(L[y * W + x]);
  const k = budget / (total || 1);
  const P = [], Nn = [], S = [], Mt = [], Kp = [];
  const put = (p, n, sk, b, a, keep) => { P.push(p[0], p[1], p[2]); Nn.push(n[0], n[1], n[2]); S.push(sk[0], sk[1], sk[2], sk[3]); Mt.push(b, a); Kp.push(keep ? 1 : 0); };
  const e = 1 / (F.s * pxScale);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const u = x / W, v = y / H, i = y * W + x;
    if (!M[i] || !inCrop(u, v)) continue;
    let want = dens(L[i]) * k * (cfg.thin ? cfg.thin(u, v) : 1);
    while (want > 0 && r() < want) {
      want -= 1;
      const uu = (x + r() - 0.5) / W, vv = (y + r() - 0.5) / H, [sx, sy] = F.at(uu, vv);
      const z = depth(x, y, uu, vv), dzx = (depth(x + 1, y, uu, vv) - depth(x - 1, y, uu, vv)) * e / 2, dzy = (depth(x, y - 1, uu, vv) - depth(x, y + 1, uu, vv)) * e / 2;
      const nl = Math.hypot(dzx, dzy, 1), n = [-dzx / nl, -dzy / nl, 1 / nl];
      const b = L[i] * (cfg.gain || 1.6), a = A[i];
      const rg = cfg.region ? cfg.region(uu, vv, a, L[i], D[i] * pxScale) : null;
      const sk = [rig.id(rg?.bone || 'root'), rig.id(rg?.bone2 || 'root'), rg?.w ?? 1, rg?.sway ?? 0];
      put([sx, sy, z], n, sk, b, a, rg?.keep);
      if (cfg.back && r() < cfg.back && D[i] * pxScale > 3 && !(rg?.sway < 0)) {        // the far side of the volume
        const zb = (cfg.backZ ? cfg.backZ(uu, vv, z) : z - 2 * (cfg.depth || 0) * Math.sqrt(Math.min(D[i] * pxScale, cfg.inflate) / cfg.inflate) * 0.8) - 0.004;
        put([sx, sy, zb], [n[0], n[1], -n[2]], sk, b * 0.55, a, false);
      }
    }
  }
  return finish(P, Nn, S, Mt, Kp, r);
}

// Exactly HOLO_DOTS: thin evenly (by voxel) or repeat with a whisper of jitter; then shade by neighbourhood.
function finish(P, Nn, S, Mt, Kp, r) {
  const n = HOLO_DOTS, count = P.length / 3, G = 0.006, vox = new Map(), dense = [], loose = [];
  for (let i = 0; i < count; i++) {
    if (Kp[i]) { dense.push(i); continue; }
    const key = ((Math.floor(P[i * 3] / G) + 512) * 1024 + (Math.floor(P[i * 3 + 1] / G) + 512)) * 1024 + (Math.floor(P[i * 3 + 2] / G) + 512);
    (vox.get(key) || vox.set(key, []).get(key)).push(i);
  }
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  shuffle(dense); if (dense.length > n * 0.3) dense.length = Math.floor(n * 0.3);
  const lists = [...vox.values()], want = n - dense.length;
  let lo = 1, hi = 1; for (const l of lists) hi = Math.max(hi, l.length);
  const fill = (cap) => lists.reduce((s, l) => s + Math.min(l.length, cap), 0);
  while (lo < hi) { const mid = (lo + hi) >> 1; if (fill(mid) >= want) hi = mid; else lo = mid + 1; }
  for (const l of lists) { shuffle(l); for (let j = 0; j < Math.min(l.length, lo); j++) loose.push(l[j]); }
  shuffle(loose);
  const pool = dense.concat(loose.slice(0, Math.max(0, want)));
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), skin = new Float32Array(n * 4), mat = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = pool[i % pool.length], j = i >= pool.length ? 0.002 : 0;
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = P[s * 3 + k] + (r() - 0.5) * j; nrm[i * 3 + k] = Nn[s * 3 + k]; }
    for (let k = 0; k < 4; k++) skin[i * 4 + k] = S[s * 4 + k];
    mat[i * 4] = Mt[s * 2]; mat[i * 4 + 1] = Mt[s * 2 + 1];
  }
  shade(pos, nrm, mat, n);
  return { pos, nrm, skin, mat, fit: fitOf(pos, skin, mat, n) };
}

// Every subject the same presence: fitted to the footprint of the puppy and the book (same visible area, never taller
// than 0.75 or wider than 0.95), standing just above the hologram's foot, centred; and the same overall brightness.
const AREA = 0.45, MAXW = 0.95, MAXH = 0.75, LEVEL = 1.0;
function fitOf(pos, skin, mat, n) {
  const xs = [], ys = [], zs = [];
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) { if (skin[i * 4 + 3] < 0) continue; xs.push(pos[i * 3]); ys.push(pos[i * 3 + 1]); zs.push(pos[i * 3 + 2]); sum += mat[i * 4]; cnt++; }
  const q = (a, f) => { a.sort((x, y) => x - y); return a[Math.floor((a.length - 1) * f)]; };
  const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99), zc = q(zs, 0.5), w = x1 - x0, h = y1 - y0;
  const s = Math.min(Math.sqrt(AREA / (w * h)), MAXW / w, MAXH / h), gain = LEVEL / (sum / cnt || 1);
  for (let i = 0; i < n; i++) mat[i * 4] *= gain;
  return [s, -(x0 + x1) / 2 * s, 0.03 - y0 * s, -zc * s];
}

function shade(pos, nrm, mat, n) {
  const R = 0.014, cell = new Map(), key = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  for (let i = 0; i < n; i++) { const k = key(Math.floor(pos[i * 3] / R), Math.floor(pos[i * 3 + 1] / R), Math.floor(pos[i * 3 + 2] / R)); (cell.get(k) || cell.set(k, []).get(k)).push(i); }
  const ridge = new Float32Array(n), cnt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], cx = Math.floor(x / R), cy = Math.floor(y / R), cz = Math.floor(z / R);
    let sx = 0, sy = 0, sz = 0, c = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const list = cell.get(key(cx + a, cy + b, cz + d)); if (!list) continue;
      for (const j of list) { const dx = pos[j * 3] - x, dy = pos[j * 3 + 1] - y, dz = pos[j * 3 + 2] - z; if (j !== i && dx * dx + dy * dy + dz * dz < R * R) { sx += dx; sy += dy; sz += dz; c++; } }
    }
    cnt[i] = c; ridge[i] = c ? -((sx / c) * nrm[i * 3] + (sy / c) * nrm[i * 3 + 1] + (sz / c) * nrm[i * 3 + 2]) / R : 0;
  }
  const abs = Array.from(ridge, Math.abs).sort((a, b) => a - b), p90 = abs[Math.floor(n * 0.9)] || 1, med = Array.from(cnt).sort((a, b) => a - b)[n >> 1] || 1;
  for (let i = 0; i < n; i++) { mat[i * 4 + 2] = clamp(ridge[i] / p90, -1, 1); mat[i * 4 + 3] = clamp(1 - cnt[i] / (0.55 * med), 0, 1); }
}

// a soft region in the picture's uv: weight 1 inside r0, fading to 0 at r1 (ax stretches it across)
const soft = (u, v, cu, cv, r0, r1, ax = 1) => 1 - smooth(r0, r1, Math.hypot((u - cu) * ax, v - cv));
const WIDE = [1672, 941], TALL = [1199, 1312];

// ================================================================== 1996: a zygote
const CELL = { src: asset('cell'), crop: [0.25, 0.04, 0.75, 0.93], inflate: 1, gamma: 1.15, gain: 1.7, back: 0.5, seed: 1996 };
const cF = framer(...WIDE, CELL.crop), cC = cF.at(0.497, 0.484), cR = 0.217 * WIDE[0] * cF.s;
CELL.z = (u, v, p) => { const d2 = (p[0] - cC[0]) ** 2 + (p[1] - cC[1]) ** 2; return Math.sqrt(Math.max(0, cR * cR - d2)) * 0.9; };   // a sphere
CELL.backZ = (u, v, z) => -z;
CELL.region = (u, v, a, l) => {
  const inside = Math.hypot((u - 0.497) * WIDE[0], (v - 0.484) * WIDE[1]) < 0.217 * WIDE[0] * 1.04;
  if (!inside) return { sway: -(0.3 + l) };                                                        // the haze drifts off it
  const pn = soft(u, v, 0.51, 0.5, 0.07, 0.11, 1.8);
  return pn > 0.02 ? { bone: 'nuclei', w: pn } : null;
};
const cellRig = new Rig().bone('root', null, [cC[0], cC[1], 0]).bone('nuclei', 'root', [cC[0], cC[1], 0]);
const cell = {
  rig: cellRig, lean: 1, lit: 0.25,
  build: () => reconstruct(CELL, cellRig),
  anim(t, B) {
    cellRig.apply({ root: { r: [0.06 * Math.sin(t * 0.3), 0.32 * Math.sin(t * 0.21), 0.04 * Math.sin(t * 0.17)], s: 1 + 0.012 * Math.sin(t * 1.2) },
      nuclei: { r: [0, 0, 0.06 * Math.sin(t * 0.5)], s: 1 + 0.02 * Math.sin(t * 0.9) } }, B);
  },
};

// ================================================================== 2006: a puppy playing with a ball
const PUP = { src: asset('puppy'), crop: [0.08, 0.06, 0.92, 0.92], inflate: 80, depth: 0.2, relief: 0.03, gamma: 1.3, gain: 1.6, back: 0.4, seed: 2006 };
const pF = framer(...WIDE, PUP.crop);
const pupRig = new Rig().bone('root', null, [0, 0, 0]).bone('body', 'root', pF.at(0.4, 0.85))
  .bone('head', 'body', pF.at(0.6, 0.52)).bone('tail', 'body', pF.at(0.22, 0.33)).bone('ball', 'root', pF.at(0.775, 0.85));
PUP.region = (u, v, a) => {
  if (a > 0.4 && u > 0.72) return { bone: 'ball', keep: true };
  const hd = soft(u, v, 0.66, 0.5, 0.07, 0.12, 1.3), tl = soft(u, v, 0.15, 0.2, 0.06, 0.11, 1.4);
  if (hd > 0.02) return { bone: 'head', bone2: 'body', w: hd };
  if (tl > 0.02) return { bone: 'tail', bone2: 'body', w: tl, sway: 0.4 * tl };
  return v > 0.86 ? { bone: 'root' } : { bone: 'body' };                                           // the floor stays put
};
const puppy = {
  rig: pupRig, lean: 1, lit: 0.3,
  build: () => reconstruct(PUP, pupRig),
  anim(t, B) {
    const hop = Math.abs(Math.sin(t * 2.4)), pant = Math.sin(t * 8);
    pupRig.apply({
      root: { r: [0, 0.28 * Math.sin(t * 0.25), 0] },
      body: { s: [1, 1 + 0.012 * pant, 1 + 0.012 * pant], t: [0.006 * Math.sin(t * 2.4 + 1), 0, 0] },
      head: { r: [0, 0.08 * Math.sin(t * 0.7), -0.06 + 0.1 * hop] },                               // it follows the ball
      tail: { r: [0.35 * Math.sin(t * 13), 0, 0.12 * Math.sin(t * 13)] },
      ball: { t: [0.02 * Math.sin(t * 0.9), 0.085 * hop, 0], r: [0, 0, -t * 3] },
    }, B);
  },
};

// ================================================================== 2016: an open book
const BOOK = { src: asset('book'), crop: [0.1, 0.12, 0.9, 0.82], inflate: 40, depth: 0.08, relief: 0.05, gamma: 1.2, gain: 1.7, back: 0.25, seed: 2016 };
const bF = framer(...WIDE, BOOK.crop);
BOOK.z = (u, v) => (v - 0.62) * 0.55;                                                              // the far pages lean away
BOOK.region = (u, v, a, l, d) => (d < 4 && v < 0.6 ? { sway: -(0.4 + l), keep: true } : (u > 0.5 && v < 0.6 ? { bone: 'page', w: smooth(0.5, 0.72, u) } : null));
const bookRig = new Rig().bone('root', null, bF.at(0.5, 0.72)).bone('page', 'root', bF.at(0.5, 0.72));
const book = {
  rig: bookRig, lean: 1, lit: 0.3,
  build: () => reconstruct(BOOK, bookRig),
  anim(t, B) { bookRig.apply({ root: { r: [0.05 * Math.sin(t * 0.23), 0.3 * Math.sin(t * 0.2), 0] }, page: { r: [0, 0, 0.05 * Math.sin(t * 1.1) + 0.03] } }, B); },
};

// ================================================================== 2026: Adán, from his portrait (in the bust's style)
const SPAN = 0.84, V0 = 0.02;
const faceRig = new Rig().bone('root', null, [0, 0.4, 0]).bone('head', 'root', [-0.01, 0.4, -0.05]);
const lens = [[0.332, 0.325, 0.094, 0.052], [0.582, 0.302, 0.094, 0.054]];
const glasses = (u, v, l) => {
  if (l > 0.42) return false;
  for (const [cx, cy, rx, ry] of lens) { const e = Math.hypot((u - cx) / rx, (v - cy) / ry); if (e > 0.8 && e < 1.2) return true; }
  return (u > 0.415 && u < 0.49 && v > 0.278 && v < 0.31) || (u > 0.67 && u < 0.765 && v > 0.258 && v < 0.29);
};
const face = {
  rig: faceRig, lean: 1, lit: 0.45,
  async build(entry) {
    const dep = await loadImage(entry.mask), dc = new OffscreenCanvas(256, Math.round(256 * dep.height / dep.width)), dg = dc.getContext('2d', { willReadFrequently: true });
    dg.drawImage(dep, 0, 0, dc.width, dc.height); const dm = dg.getImageData(0, 0, dc.width, dc.height).data;
    const dAt = (u, v) => { const i = (clamp(Math.round(v * dc.height), 0, dc.height - 1) * dc.width + clamp(Math.round(u * dc.width), 0, dc.width - 1)) * 4; return [dm[i], dm[i + 1]]; };
    return reconstruct({
      thin: (u, v) => 1 - smooth(0.5, V0 + SPAN, v) * 0.92,   // the bust dissolves toward the lens instead of ending in a cut
      src: entry.image, crop: [0, V0, 1, V0 + SPAN], inflate: 90, depth: 0.12, relief: 0.025, gamma: 1.05, gain: 1.4, back: 0.45, seed: 2026, floor: 0.04, res: 420,
      lum: (R) => 0.12 + 0.95 * Math.pow(1 - R / 255, 1.25),                                        // an engraving: hair, beard and frames are dense
      mask: (u, v) => dAt(u, v)[1] > 110,
      accent: (R, G, B, u, v) => (glasses(u, v, R / 255) ? 0.95 : 0),
      z: (u, v) => { const [dr, dgr] = dAt(u, v); return dgr > 110 ? (dr - 110) / 255 * 0.32 : 0; },   // the depth mask brings the head forward
      region: (u, v) => { const w = 1 - smooth(0.5, 0.6, v); return w > 0.01 ? { bone: 'head', w } : null; },
    }, faceRig);
  },
  anim(t, B) { faceRig.apply({ root: { r: [0, 0.3 * Math.sin(t * 0.18), 0] }, head: { r: [0.04 * Math.sin(t * 0.23), 0.12 * Math.sin(t * 0.31 + 1), 0.03 * Math.sin(t * 0.19)] } }, B); },
};

// ================================================================== 2036: a floating farm (I retire as a farmer)
const FARM = { src: asset('farm'), crop: [0.03, 0.12, 0.97, 0.94], inflate: 60, depth: 0.1, relief: 0.05, gamma: 1.1, gain: 2, back: 0.2, seed: 2036 };
const fF = framer(...WIDE, FARM.crop);
FARM.z = (u, v) => (v < 0.66 ? -(0.66 - v) * 0.4 : -(v - 0.66) * 0.15);                           // the land recedes; the rock hangs below
FARM.region = (u, v, a) => (a > 0.45 && v > 0.42 ? { sway: 0.5, keep: a > 0.7 } : a > 0.45 ? { bone: 'glow', keep: true } : (v < 0.5 && (u < 0.32 || u > 0.72) ? { sway: 0.25 } : null));
const farmRig = new Rig().bone('root', null, fF.at(0.5, 0.6)).bone('glow', 'root', fF.at(0.3, 0.4));
const farm = {
  rig: farmRig, lean: 1, lit: 0.3,
  build: () => reconstruct(FARM, farmRig),
  anim(t, B, A) {
    farmRig.apply({ root: { t: [0, 0.012 * Math.sin(t * 0.8), 0], r: [0.04 * Math.sin(t * 0.31), 0.32 * Math.sin(t * 0.17), 0.02 * Math.sin(t * 0.27)] } }, B);
    if (A) A[farmRig.id('glow')] = 0.85 + 0.15 * Math.sin(t * 2.3) * Math.sin(t * 0.7);              // the windows flicker
  },
};

// ================================================================== 2036: a child with a bird's face (the sci-fi book)
const BIRD = { src: asset('bird'), crop: [0.06, 0.06, 0.94, 1], inflate: 110, depth: 0.22, relief: 0.03, gamma: 1.2, gain: 1.6, back: 0.4, seed: 2042 };
const dF = framer(...TALL, BIRD.crop);
const birdRig = new Rig().bone('root', null, [0, 0, 0]).bone('head', 'root', dF.at(0.52, 0.55)).bone('feathers', 'head', dF.at(0.33, 0.33));
BIRD.region = (u, v, a) => {
  const hd = soft(u, v, 0.56, 0.32, 0.2, 0.3, 1);
  if (a > 0.4 && u < 0.4 && v < 0.45) return { bone: 'feathers', bone2: 'head', w: 0.9, sway: 0.5 };
  return hd > 0.02 ? { bone: 'head', w: hd, sway: v < 0.2 ? 0.25 : 0 } : null;
};
const bird = {
  rig: birdRig, lean: 1, lit: 0.3,
  build: () => reconstruct(BIRD, birdRig),
  anim(t, B) {
    const looks = [[0, 0, 0], [0.04, 0.16, 0.08], [-0.03, -0.12, -0.06], [0.05, 0.2, -0.04], [0, -0.06, 0.1]], hold = 2.6, i = Math.floor(t / hold), tau = t - i * hold;
    const a = looks[i % looks.length], b = looks[(i + 1) % looks.length], sp = spring(tau, 10, 6), head = a.map((x, k) => x + (b[k] - x) * sp);
    birdRig.apply({ root: { r: [0, 0.2 * Math.sin(t * 0.19), 0] }, head: { r: head }, feathers: { r: [0, 0, 0.08 * Math.sin(t * 1.6)] } }, B);
  },
};

// ================================================================== 2036: a man lying in a meadow (I die trying)
const MEAD = { src: asset('meadow'), crop: [0, 0.25, 1, 1], inflate: 45, depth: 0.07, relief: 0.04, gamma: 1.05, gain: 2.2, back: 0.15, seed: 2050 };
MEAD.z = (u, v) => -(1 - (v - 0.25) / 0.75) * 0.3;                                                  // the field recedes to the horizon
MEAD.region = (u, v, a) => (a > 0.4 ? { sway: 0.7, keep: a > 0.7 } : v > 0.82 ? { sway: 0.35 } : null);
const meadRig = new Rig().bone('root', null, [0, 0.3, -0.35]);
const meadow = {
  rig: meadRig, lean: 1, lit: 0.25,
  build: () => reconstruct(MEAD, meadRig),
  anim(t, B) { meadRig.apply({ root: { r: [0.04 * Math.sin(t * 0.21), 0.22 * Math.sin(t * 0.16), 0] } }, B); },
};

export const SCENES = { cell, puppy, book, face, farm, bird, meadow };
