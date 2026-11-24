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
async function serve() {
  if (server) return origin;
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
  routes = [], initScript, waitFor } = {}) {
  const base = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'] });
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

/** Counts "ink blue" pixels (b > r + 40 and b > g + 20) in a PNG screenshot buffer, inside rect {x, y, w, h}. */
export async function countInk(page, rect) {
  const png = await page.screenshot({ clip: rect });
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 40 && d[i + 2] > d[i + 1] + 20) n++;
    return n;
  }, png.toString('base64'));
}
