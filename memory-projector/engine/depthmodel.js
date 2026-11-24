// Depth: how far each pixel of a frame is from the camera, estimated by Depth Anything V2 (small, Apache-2.0), in the
// browser. Only its shape is used, inside the kept figures; no picture leaves the engine. On the GPU where there is one,
// otherwise on the CPU (it is small enough for WebAssembly).
import { loadOrt } from './ort.js';
import { MODELS } from './matte.js';

const LONG = 518, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

// Bilinear resize of a float map.
function resize(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sh / dh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sw / dw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

/** → { name, license, device, estimate(frame) → { depth: Float32Array (bigger = nearer), w, h } at the frame's size } */
export async function createDepthModel({ onProgress, base = MODELS.depth } = {}) {
  const ort = await loadOrt();
  const res = await fetch(base + 'model.onnx');
  if (!res.ok) throw new Error(`could not download the depth model (HTTP ${res.status})`);
  const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress?.({ stage: 'model', model: 'Depth Anything', loaded: got, total }); }
  const bytes = new Uint8Array(got); let o = 0; for (const q of parts) { bytes.set(q, o); o += q.length; }
  const adapter = navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null);
  let session, device = 'cpu';
  if (adapter) {
    try { session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }); device = 'gpu'; } catch { session = null; }
  }
  session ??= await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  const input = session.inputNames[0], output = session.outputNames[0];
  return {
    name: 'Depth Anything V2 (small)', license: 'Apache-2.0', device,
    async estimate(frame) {
      const w = frame.width, h = frame.height, s = LONG / Math.max(w, h);
      const iw = Math.max(14, Math.round(w * s / 14) * 14), ih = Math.max(14, Math.round(h * s / 14) * 14), n = iw * ih;
      const c = new OffscreenCanvas(iw, ih), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(frame, 0, 0, iw, ih);
      const px = g.getImageData(0, 0, iw, ih).data, data = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) data[k * n + i] = (px[i * 4 + k] / 255 - MEAN[k]) / STD[k];
      const out = (await session.run({ [input]: new ort.Tensor('float32', data, [1, 3, ih, iw]) }))[output];
      const [oh, ow] = out.dims.slice(-2);
      return { depth: resize(out.data, ow, oh, w, h), w, h };
    },
  };
}
