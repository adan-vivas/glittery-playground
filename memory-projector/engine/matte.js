// Cut-out: separates whatever stands in the foreground from the background, one frame at a time, in the browser.
// Nothing leaves the machine: the model is downloaded once, the video never is.
//
// First choice, BiRefNet-lite (MIT): a general foreground ("dichotomous") segmentation model, so a ball, a swing or a
// dog stays with the people. It needs WebGPU (Chrome on a Mac has it): at its fixed 1024 px input it does not fit in
// WebAssembly's 4 GB, and some software GPUs lack the buffers it needs. Half precision where the GPU supports it.
// Fallback, MODNet (Apache-2.0): a portrait matting model, small and quick, that runs anywhere; it keeps the people
// but may drop what they hold. The page says which one ran, and why.
// Not used: @imgly/background-removal and Robust Video Matting (AGPL / GPL), MediaPipe (people only, no objects).
// 1.20: its WebGPU backend (JSEP) runs BiRefNet within Chrome's 10 storage buffers per shader; 1.31's native
// WebGPU backend needs 11 and fails on a Mac.
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
export const MODELS = {
  birefnet: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/',
  modnet: 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/',
};

// float32 ↔ float16 bits (for a half-precision model's input and output)
const f16 = (() => {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return (v) => {
    f[0] = v; const x = u[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
    if (e <= 0) return s;
    if (e >= 31) return s | 0x7c00;
    return s | (e << 10) | (m >>> 13);
  };
})();
const f16to32 = (h) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};

async function fetchModel(url, onProgress, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download the ${label} model (HTTP ${res.status})`);
  const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress?.({ stage: 'model', model: label, loaded: got, total });
  }
  const buf = new Uint8Array(got);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

// One model as a segment(frame) function: resize to the model's input, normalise, run, and bring the alpha back to the
// frame's own size.
function segmenter(ort, session, { inW, inH, mean, std, half, logits }) {
  const input = session.inputNames[0], output = session.outputNames[0];
  const canvas = new OffscreenCanvas(inW, inH), g = canvas.getContext('2d', { willReadFrequently: true });
  return async (frame) => {
    const w = frame.width, h = frame.height, n = inW * inH;
    g.drawImage(frame, 0, 0, inW, inH);
    const px = g.getImageData(0, 0, inW, inH).data;
    const data = half ? new Uint16Array(3 * n) : new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      const v = (px[i * 4 + c] / 255 - mean[c]) / std[c];
      data[c * n + i] = half ? f16(v) : v;
    }
    const out = (await session.run({ [input]: new ort.Tensor(half ? 'float16' : 'float32', data, [1, 3, inH, inW]) }))[output];
    const o = out.data, isHalf = o instanceof Uint16Array, small = new ImageData(inW, inH);
    for (let i = 0; i < n; i++) {
      const v = isHalf ? f16to32(o[i]) : o[i], a = logits ? 1 / (1 + Math.exp(-v)) : Math.min(1, Math.max(0, v));
      small.data[i * 4] = small.data[i * 4 + 3] = Math.round(a * 255);
    }
    const sc = new OffscreenCanvas(inW, inH); sc.getContext('2d').putImageData(small, 0, 0);
    const up = new OffscreenCanvas(w, h), ug = up.getContext('2d', { willReadFrequently: true });
    ug.drawImage(sc, 0, 0, w, h);
    const big = ug.getImageData(0, 0, w, h).data, alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = big[i * 4] / 255;
    return { alpha, w, h };
  };
}

async function birefnet(ort, adapter, base, onProgress) {
  const half = adapter.features.has('shader-f16');
  const bytes = await fetchModel(base + (half ? 'model_fp16.onnx' : 'model.onnx'), onProgress, 'BiRefNet-lite');
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
  // the half-precision file keeps full-precision input and output (only its weights are halved): always feed float32
  const segment = segmenter(ort, session, { inW: 1024, inH: 1024, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], half: false, logits: true });
  // a first run on a blank frame: a GPU that cannot run the model fails here, not halfway through a clip
  const blank = new OffscreenCanvas(64, 64); blank.getContext('2d').fillRect(0, 0, 64, 64);
  await segment(blank);
  return { name: 'BiRefNet-lite', license: 'MIT', device: `gpu (${half ? 'fp16' : 'fp32'})`, keepsObjects: true, segment };
}

async function modnet(ort, gpu, base, onProgress) {
  const bytes = await fetchModel(base + 'model.onnx', onProgress, 'MODNet');
  const session = await ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] });
  const run = new Map();   // one segmenter per frame shape (MODNet takes any size; 512 on the short side, multiples of 32)
  return {
    name: 'MODNet', license: 'Apache-2.0', device: gpu ? 'gpu' : 'cpu', keepsObjects: false,
    segment(frame) {
      const s = 512 / Math.min(frame.width, frame.height), r32 = (v) => Math.max(32, Math.round(v * s / 32) * 32);
      const key = `${r32(frame.width)}x${r32(frame.height)}`;
      if (!run.has(key)) run.set(key, segmenter(ort, session, { inW: r32(frame.width), inH: r32(frame.height), mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], half: false, logits: false }));
      return run.get(key)(frame);
    },
  };
}

/**
 * The cut-out model: BiRefNet-lite on WebGPU, or MODNet when that can't run. Resolves to
 * { name, license, device, keepsObjects, fallback?: string (why MODNet), segment(frame) → { alpha: Float32Array 0..1, w, h } }.
 */
export async function createMatter({ onProgress, models = MODELS } = {}) {
  const ort = await import(ORT + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT;
  const adapter = navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null);
  let why;
  if (adapter) {
    try {
      return await birefnet(ort, adapter, models.birefnet, onProgress);
    } catch (e) {   // ONNX Runtime puts the reason at the end of its message
      why = `BiRefNet-lite could not run on this GPU (${String(e.message || e).split('\n')[0].slice(-140).trim()})`;
    }
  } else why = 'this browser has no WebGPU';
  const m = await modnet(ort, !!adapter, models.modnet, onProgress);
  return { ...m, fallback: `${why}. Using MODNet instead: people are kept, but things they hold may be lost.` };
}

/** For tests: magenta is foreground, everything else background. Same shape as createMatter's result. */
export function createFakeMatter() {
  return {
    name: 'fake (magenta key)', license: 'n/a', device: 'cpu', keepsObjects: true,
    async segment(frame) {
      const w = frame.width, h = frame.height, c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(frame, 0, 0);
      const px = g.getImageData(0, 0, w, h).data, alpha = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4] > 200 && px[i * 4 + 1] < 60 && px[i * 4 + 2] > 200 ? 1 : 0;
      return { alpha, w, h };
    },
  };
}
