// How a memory's depth is written into, and read out of, its video. One source of truth for the engine (writes),
// the hologram shader (reads) and the test fixtures (tests/fixtures/make-demo.py copies these numbers).
//
// A memory is a square greyscale H.264 video. Each pixel is either empty (no figure there) or a figure pixel whose
// brightness is its depth: 0 = farthest, 1 = nearest. Video compression smears values a little and maps black to
// about 16, so empty is 0 and anything below EMPTY_BELOW reads as empty, while figures start well clear of it at 64.
export const SIZE = 256;          // frame width and height (px)
export const FPS = 12;
export const MAX_SECONDS = 7;
export const EMPTY_BELOW = 32;    // luma below this = no figure
export const FIGURE_MIN = 64;     // depth 0 (farthest figure pixel)
export const FIGURE_SPAN = 191;   // depth 1 = 64 + 191 = 255

const clamp01 = (d) => (d < 0 ? 0 : d > 1 ? 1 : d);

/** Depth 0..1 of a figure pixel → its byte value (64..255). */
export function encodeDepthValue(d) {
  return FIGURE_MIN + Math.round(clamp01(d) * FIGURE_SPAN);
}

/** Byte value → depth 0..1, or null when the pixel is empty. */
export function decodeDepthValue(v) {
  if (v < EMPTY_BELOW) return null;
  return clamp01((v - FIGURE_MIN) / FIGURE_SPAN);
}

/** A depth map (> 0 = figure depth, 0 or NaN = no figure) → bytes, 0 where empty. */
export function encodeDepthFrame(depth, out = new Uint8ClampedArray(depth.length)) {
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    out[i] = d > 0 ? encodeDepthValue(d) : 0;
  }
  return out;
}
