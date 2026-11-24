// The engine page: load → write → pick → process → check → export. Runs entirely in this browser.
import { extractFrames, probe } from './frames.js';
import { createMatter, createFakeMatter } from './matte.js';
import { labelFigures } from './figures.js';
import { runPipeline } from './pipeline.js';
import { encodeDepthMp4 } from './encode.js';
import { createStageView } from './stage-view.js';
import { wordCount, slugify, validateEntry, upsertMemory } from './manifest.js';
import { FPS, MAX_SECONDS } from '../lib/depth-format.js';

const $ = (id) => document.getElementById(id);
const FAKE = new URLSearchParams(location.search).get('matter') === 'fake';   // tests: magenta is foreground
const state = { file: null, duration: 0, start: 0, pick: null, keep: new Set(), result: null, blob: null, idEdited: false };
const view = createStageView($('stage-view'));
let matterP = null;

const enable = (id, on) => $(id).setAttribute('aria-disabled', on ? 'false' : 'true');
const status = (t) => { $('status').textContent = t; };
const stage = (name, s) => { const el = document.querySelector(`.stage[data-stage="${name}"]`); if (el) el.dataset.state = s; };
const download = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

function matter() {
  if (!matterP) {
    matterP = FAKE ? Promise.resolve(createFakeMatter()) : createMatter({
      onProgress: (p) => { if (p.total) $('matter-note').textContent = `Downloading the ${p.model} model, once: ${Math.round(p.loaded / p.total * 100)} %`; },
    });
    matterP.then((m) => {
      $('matter-note').textContent = m.fallback || `Cut-out by ${m.name} (${m.device}). Click a figure to keep or drop it; keep what belongs in the memory.`;
      if (m.fallback) $('matter-note').classList.add('warn');
    }, (e) => { $('matter-note').textContent = e.message; matterP = null; });
  }
  return matterP;
}

// ---------------------------------------------------------------- 1. load
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  $('load-error').hidden = true;
  try {
    const p = await probe(file);
    Object.assign(state, { file, duration: p.duration, start: 0, result: null });
    const used = Math.min(MAX_SECONDS, p.duration);
    $('start').max = Math.max(0, p.duration - MAX_SECONDS).toFixed(1);
    $('start').value = '0'; $('start-out').textContent = '0.0';
    $('trim').hidden = p.duration <= MAX_SECONDS;
    $('trim-note').textContent = p.duration > MAX_SECONDS ? `${MAX_SECONDS} s of ${p.duration.toFixed(1)} s` : `All ${used.toFixed(1)} s`;
    if (!state.idEdited && !$('title').value) setId(slugify(file.name.replace(/\.[^.]+$/, '')));
    await pickFigures();
  } catch (e) {
    $('load-error').textContent = e.message; $('load-error').hidden = false;
  }
});
let startTimer;
$('start').addEventListener('input', () => {
  state.start = +$('start').value;
  $('start-out').textContent = state.start.toFixed(1);
  clearTimeout(startTimer);
  startTimer = setTimeout(pickFigures, 250);
});

// ---------------------------------------------------------------- 2. write
const setId = (v) => { $('id').value = v; };
$('story').addEventListener('input', () => {
  const n = wordCount($('story').value);
  $('words').textContent = String(n);
  $('words-warn').hidden = n <= 120;
});
$('title').addEventListener('input', () => { if (!state.idEdited) setId(slugify($('title').value)); });
$('id').addEventListener('input', () => { state.idEdited = true; });

// ---------------------------------------------------------------- 3. pick
async function pickFigures() {
  if (!state.file) return;
  enable('s-pick', true);
  $('figures').textContent = '';
  const [frame] = await extractFrames(state.file, { start: state.start, seconds: 1 / FPS, fps: FPS });
  const m = await matter();
  const { alpha, w, h } = await m.segment(frame);
  const lab = labelFigures(alpha, w, h);
  state.pick = { frame, alpha, w, h, lab, start: state.start };
  state.keep = new Set(lab.figures.map((f) => f.id));   // everything is kept until you drop it
  lab.figures.sort((a, b) => a.centroid[0] - b.centroid[0]).forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'figure'; b.dataset.id = f.id; b.dataset.cx = f.centroid[0].toFixed(1);
    b.setAttribute('aria-pressed', 'true');
    b.textContent = `Figure ${i + 1} (${f.centroid[0] < w / 3 ? 'left' : f.centroid[0] > 2 * w / 3 ? 'right' : 'middle'})`;
    b.addEventListener('click', () => toggle(f.id));
    $('figures').append(b);
  });
  if (!lab.figures.length) $('figures').textContent = 'Nobody found in the first frame. Try another start.';
  drawPick();
  enable('s-process', lab.figures.length > 0);
}

function toggle(id) {
  if (state.keep.has(id)) state.keep.delete(id); else state.keep.add(id);
  document.querySelector(`button.figure[data-id="${id}"]`)?.setAttribute('aria-pressed', String(state.keep.has(id)));
  drawPick();
  enable('s-process', state.keep.size > 0);
}

function drawPick() {
  const { frame, w, h, lab } = state.pick, c = $('pick-canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(frame, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    const id = lab.labels[i];
    if (!id) { for (let k = 0; k < 3; k++) img.data[i * 4 + k] = img.data[i * 4 + k] * 0.45 + 228 * 0.55; continue; }
    if (state.keep.has(id)) { img.data[i * 4] *= 0.6; img.data[i * 4 + 1] *= 0.65; img.data[i * 4 + 2] = img.data[i * 4 + 2] * 0.5 + 128; }
    else for (let k = 0; k < 3; k++) img.data[i * 4 + k] = 150;
  }
  g.putImageData(img, 0, 0);
}
$('pick-canvas').addEventListener('click', (e) => {
  if (!state.pick) return;
  const r = e.currentTarget.getBoundingClientRect(), { w, h, lab } = state.pick;
  const x = Math.floor((e.clientX - r.left) / r.width * w), y = Math.floor((e.clientY - r.top) / r.height * h);
  const id = lab.labels[y * w + x];
  if (id) toggle(id);
});

// ---------------------------------------------------------------- 4. process
$('process').addEventListener('click', async () => {
  if (!state.pick || !state.keep.size) return;
  $('process').disabled = true;
  for (const s of ['frames', 'cutout', 'steady', 'depth', 'loop']) stage(s, '');
  try {
    stage('frames', 'running'); status('Reading frames…');
    const frames = await extractFrames(state.file, { start: state.pick.start, seconds: MAX_SECONDS, fps: FPS,
      onFrame: (i, n, f) => { view.drawVideo(f); status(`Reading frames… ${i + 1} / ${n}`); } });
    stage('frames', 'done');
    const m = await matter();
    let current = 'cutout';
    stage('cutout', 'running');
    const result = await runPipeline({ frames, matter: m, keep: state.keep, firstAlpha: state.pick.alpha,
      onStage: (name, i, n, d) => {
        if (name !== current) { stage(current, 'done'); current = name; stage(name, 'running'); }
        status(`${name[0].toUpperCase() + name.slice(1)}… ${i + 1} / ${n}`);
        if (name === 'cutout') { view.drawVideo(d.frame); view.drawCutout(d.frame, d.mask, d.w, d.h); }
        if (name === 'depth') view.drawDepth(d.depth);
      } });
    stage(current, 'done');
    status('Encoding…');
    state.blob = await encodeDepthMp4(result.encoded);
    state.result = result;
    const url = URL.createObjectURL(state.blob);
    $('public').src = url;
    view.setDots(url);
    view.play({ frames, masks: result.masks, depth: result.depth });
    status(`Done: ${(result.depth.length / FPS).toFixed(1)} s, ${Math.round(state.blob.size / 1024)} KB.`);
    for (const id of ['s-check', 's-export']) enable(id, true);
    $('still').disabled = $('record').disabled = false;
  } catch (e) {
    console.warn(e);
    status(e.message);
  } finally { $('process').disabled = false; }
});
$('still').addEventListener('click', async () => download(await view.still(), `${$('id').value || 'memory'}-stages.png`));
$('record').addEventListener('click', async () => {
  $('record').disabled = true; $('record').textContent = 'Recording…';
  download(await view.record(MAX_SECONDS), `${$('id').value || 'memory'}-stages.webm`);
  $('record').disabled = false; $('record').textContent = 'Record clip';
});

// ---------------------------------------------------------------- 6. export
$('export').addEventListener('click', async () => {
  if (!state.blob) return;
  const id = slugify($('id').value), title = $('title').value.trim(), date = $('date').value;
  const entry = { id, src: `${id}.mp4`, story: $('story').value.trim(), ...(title && { title }), ...(date && { date }),
    fps: FPS, seconds: +(state.result.depth.length / FPS).toFixed(2), aspect: 1 };
  const errs = validateEntry(entry);
  if (errs.length) { status(`Can't export yet: ${errs.join('; ')}.`); return; }
  let list = [];
  try {
    const res = await fetch('../memories/memories.json', { cache: 'no-store' });
    if (res.ok) list = await res.json();
  } catch { /* no list yet: start one */ }
  list = upsertMemory(Array.isArray(list) ? list : [], entry);
  download(state.blob, `${id}.mp4`);
  setTimeout(() => download(new Blob([JSON.stringify(list, null, 2) + '\n'], { type: 'application/json' }), 'memories.json'), 300);
  status(`Exported ${id}.mp4 and memories.json. Put both in memory-projector/memories/ and commit them.`);
});
