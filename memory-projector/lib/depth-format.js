// How a memory's depth is written into, and read out of, its video. One source of truth for the engine (writes),
// the hologram shader (reads) and the test fixtures (tests/fixtures/make-demo.py copies these numbers).
//
// Format 2 (current): a greyscale H.264 video, SIZE * 2 wide and SIZE tall. The left half is the picture (the figures'
// brightness, 0 where nobody is; faces blurred unless the author chose otherwise), the right half is the depth.
// Format 1 (the first memories): the depth half alone, 256 × 256. The projector still plays both.
// In the depth half each pixel is either empty (no figure there) or a figure pixel whose brightness is its depth:
// 0 = farthest, 1 = nearest. Video compression smears values a little and maps black to about 16, so empty is 0 and
// anything below EMPTY_BELOW reads as empty, while figures start well clear of it at 64.
export const FORMAT = 2;
export const SIZE = 512;          // each half's width and height (px)
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

/**
 * One format-2 frame: luma (0..1, the picture) and depth (> 0 = figure), both size × size, side by side in one
 * greyscale frame (size * 2 wide). The picture is kept only where the depth says there is a figure.
 */
export function encodeMemoryFrame(luma, depth, size = SIZE, out = new Uint8ClampedArray(2 * size * size)) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, o = y * 2 * size + x, d = depth[i];
    out[o] = d > 0 ? Math.round(clamp01(luma[i]) * 255) : 0;
    out[o + size] = d > 0 ? encodeDepthValue(d) : 0;
  }
  return out;
}
