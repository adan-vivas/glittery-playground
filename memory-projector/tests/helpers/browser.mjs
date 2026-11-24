// Opens a page of this repo in headless Chromium for tests.
// Serves the repo root on localhost (a secure context, so WebCodecs works) and reroutes the CDN URLs the pages
// import from to local copies in node_modules, because the CDN is not reachable from the test machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.resolve(HERE, '../..');           // memory-projector/
export const ROOT = path.resolve(PKG, '..');               // the repo root
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.svg': 'image/svg+xml', '.webm': 'video/webm' };

// CDN prefix → local directory. Tasks that add CDN dependencies add a row here.
export const CDN_ROUTES = [
  ['https://cdn.jsdelivr.net/npm/three@0.170.0/', path.join(PKG, 'node_modules/three/')],
  ['https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/', path.join(PKG, 'node_modules/mp4-muxer/')],
  ['https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/', path.join(PKG, 'node_modules/onnxruntime-web/')],
];

function sendFile(res, file, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);   // video elements seek with ranges
    if (range) {
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

let server, origin;
// Extra directories served under a URL prefix (for big local files, like a model, that must not travel through
// Playwright's request interception). Set with mount() before opening pages.
const MOUNTS = new Map();
export function mount(prefix, dir) { MOUNTS.set(prefix, path.resolve(dir)); }
async function serve() {
  if (server) return origin;
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [prefix, dir] of MOUNTS) {
      if (!p.startsWith(prefix)) continue;
      const file = path.join(dir, p.slice(prefix.length));
      if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      return sendFile(res, file, req);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    sendFile(res, file, req);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  origin = `http://localhost:${server.address().port}`;
  return origin;
}

/**
 * Opens `pathname` (from the repo root). Returns { page, context, browser, origin, errors, warnings, network, close }.
 * errors collects page errors and console.error; warnings collects console.warn; network the browser's failed loads.
 */
export async function openPage(pathname, { reducedMotion, storageState, viewport = { width: 1280, height: 860 },
  routes = [], initScript, waitFor, webgpu = false } = {}) {
  const base = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist',
    ...(webgpu ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] : [])] });   // software WebGPU
  const context = await browser.newContext({ viewport, reducedMotion, storageState, acceptDownloads: true });
  const errors = [], warnings = [], network = [];   // network: the browser's own "Failed to load resource" lines
  for (const [prefix, dir] of CDN_ROUTES) {
    await context.route(prefix + '**', (route) => {
      const rel = route.request().url().slice(prefix.length).split('?')[0];
      const file = path.join(dir, rel);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
    });
  }
  for (const [pattern, handler] of routes) await context.route(pattern, handler);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') (/^Failed to load resource/.test(m.text()) ? network : errors).push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  try {
    await page.goto(base + pathname);
    if (waitFor) await page.waitForSelector(waitFor, { state: 'attached', timeout: 30000 });
  } catch (e) {
    await browser.close();
    throw new Error(`${e.message}\npage errors: ${errors.join('\n')}`);
  }
  return { page, context, browser, origin: base, errors, warnings, network, close: () => browser.close() };
}

/**
 * Counts dense patches of hologram ink inside rect {x, y, width, height} (clamped to the viewport): the screenshot is cut
 * into `cell`-px squares, and a square counts when its mean "blueness" (blue minus red) is above `min`. A figure made of
 * many dots reads as dense patches; the pale beam and the sparse motes rising through it do not.
 */
/** rect clipped to the viewport, in whole pixels. */
export function clampToViewport(page, rect) {
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  return { x, y, width: Math.min(vp.width, Math.ceil(rect.x + rect.width)) - x, height: Math.min(vp.height, Math.ceil(rect.y + rect.height)) - y };
}

export async function inkCells(page, rect, { cell = 6, min = 60 } = {}) {
  const clip = clampToViewport(page, rect);
  if (clip.width < cell || clip.height < cell) return 0;
  const png = await page.screenshot({ clip });
  return page.evaluate(async ({ b64, cell, min }) => {
    const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data: d, width: W, height: H } = g.getImageData(0, 0, img.width, img.height);
    let n = 0;
    for (let cy = 0; cy + cell <= H; cy += cell) for (let cx = 0; cx + cell <= W; cx += cell) {
      let s = 0;
      for (let yy = cy; yy < cy + cell; yy++) for (let xx = cx; xx < cx + cell; xx++) { const i = (yy * W + xx) * 4; s += d[i + 2] - d[i]; }
      if (s / (cell * cell) > min) n++;
    }
    return n;
  }, { b64: png.toString('base64'), cell, min });
}

/** How many pixels differ by more than `tol` (any channel) between two same-size PNG screenshots. */
export async function pixelDiff(page, a, b, tol = 8) {
  return page.evaluate(async ({ a, b, tol }) => {
    const read = async (b64) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data;
    };
    const [x, y] = await Promise.all([read(a), read(b)]);
    let n = 0;
    for (let i = 0; i < x.length; i += 4)
      if (Math.abs(x[i] - y[i]) > tol || Math.abs(x[i + 1] - y[i + 1]) > tol || Math.abs(x[i + 2] - y[i + 2]) > tol) n++;
    return n;
  }, { a: a.toString('base64'), b: b.toString('base64'), tol });
}
