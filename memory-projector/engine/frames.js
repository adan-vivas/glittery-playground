// Frames: pull still frames out of a clip, at the memory's frame rate, in the browser.
export const DECODE_HELP = 'This video can’t be decoded in this browser. Export it from Photos as “Most Compatible” and try again.';

function open(src) {
  const v = document.createElement('video');
  Object.assign(v, { muted: true, playsInline: true, preload: 'auto' });
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  v.src = url;
  const done = () => { if (url !== src) URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); };
  return new Promise((ok, fail) => {
    v.addEventListener('loadeddata', () => ok({ v, done }), { once: true });
    v.addEventListener('error', () => { done(); fail(new Error(DECODE_HELP)); }, { once: true });
  });
}

/** Duration (s) and size of a clip. */
export async function probe(src) {
  const { v, done } = await open(src);
  const r = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  done();
  return r;
}

const seek = (v, t) => new Promise((ok) => { v.addEventListener('seeked', ok, { once: true }); v.currentTime = t; });

/** Frames from `start` for up to `seconds` (never past the clip's end), at `fps`, the longer side at most maxSide. */
export async function extractFrames(src, { start = 0, seconds = 7, fps = 12, maxSide = 960, onFrame } = {}) {
  const { v, done } = await open(src);
  try {
    const end = Math.min(v.duration, start + seconds), n = Math.max(1, Math.floor((end - start) * fps + 1e-6));
    const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(2, Math.round(v.videoWidth * s)), h = Math.max(2, Math.round(v.videoHeight * s));
    const frames = [];
    for (let i = 0; i < n; i++) {
      await seek(v, Math.min(start + (i + 0.5) / fps, v.duration - 0.001));
      frames.push(await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }));
      onFrame?.(i, n, frames[i]);
    }
    return frames;
  } finally { done(); }
}
