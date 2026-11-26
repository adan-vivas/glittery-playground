// Encode: memory frames (greyscale bytes, picture | depth side by side: SIZE * 2 × SIZE) into the memory's H.264 MP4,
// in the browser (WebCodecs).
import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs';
import { SIZE, FPS } from '../lib/depth-format.js';

export async function encodeDepthMp4(frames, { fps = FPS, width = SIZE * 2, height = SIZE } = {}) {
  const cfg = { codec: 'avc1.42001f', width, height, bitrate: 1_600_000, framerate: fps };
  const ok = typeof VideoEncoder !== 'undefined' && (await VideoEncoder.isConfigSupported(cfg).catch(() => ({}))).supported;
  if (!ok) throw new Error('H.264 encoding is not supported in this browser');
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  enc.configure({ ...cfg, avc: { format: 'avc' } });
  const canvas = new OffscreenCanvas(width, height), g = canvas.getContext('2d'), img = g.createImageData(width, height);
  frames.forEach((luma, i) => {
    for (let p = 0; p < width * height; p++) { const v = luma[p]; img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v; img.data[p * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % fps === 0 });
    vf.close();
  });
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
