// ONNX Runtime for the browser, shared by the engine's models.
// 1.20: its WebGPU backend (JSEP) runs BiRefNet within Chrome's 10 storage buffers per shader; 1.31's native WebGPU
// backend needs 11 and fails on a Mac.
export const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
let p;
export function loadOrt() {
  p ??= import(ORT + 'ort.webgpu.min.mjs').then((ort) => { ort.env.wasm.wasmPaths = ORT; return ort; });
  return p;
}
