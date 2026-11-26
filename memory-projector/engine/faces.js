// Faces: find them, so the engine can blur them before export. MediaPipe's face detector (Apache-2.0), in the
// browser. Its model is made for faces near the camera, so each frame is also searched in square tiles half its short
// side wide, overlapping by half, to catch a child further away. Overlapping finds of the same face are merged.
const TV = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/';
export const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i);
};

/** → { name, license, detect(frame) → [{ x, y, w, h }] in the frame's pixels } */
export async function createFaceDetector({ model = FACE_MODEL } = {}) {
  const { FilesetResolver, FaceDetector } = await import(TV + 'vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(TV + 'wasm');
  const det = await FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: model, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.45 });
  const tile = new OffscreenCanvas(1, 1), tg = tile.getContext('2d');
  const find = (img, ox, oy, s) => det.detect(img).detections.map(({ boundingBox: b, categories }) =>
    ({ x: ox + b.originX / s, y: oy + b.originY / s, w: b.width / s, h: b.height / s, score: categories?.[0]?.score ?? 1, tile: s !== 1 }));
  return {
    name: 'MediaPipe face detector', license: 'Apache-2.0',
    async detect(frame) {
      const W = frame.width, H = frame.height, found = find(frame, 0, 0, 1);
      // square tiles half the short side wide, overlapping by half; each is enlarged to 256 px for the detector
      const T = Math.max(64, Math.round(Math.min(W, H) / 2)), step = Math.round(T / 2), S = 256;
      tile.width = tile.height = S;
      const at = (n, len) => { const xs = []; for (let v = 0; v + T < len; v += step) xs.push(v); xs.push(Math.max(0, len - T)); return xs; };
      for (const oy of at(0, H)) for (const ox of at(0, W)) {
        tg.drawImage(frame, ox, oy, T, T, 0, 0, S, S);
        found.push(...find(tile, ox, oy, S / T));
      }
      const out = [];
      for (const b of found) if (!out.some((o) => iou(o, b) > 0.3)) out.push(b);
      return out;
    },
  };
}
