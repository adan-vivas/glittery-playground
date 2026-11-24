// Scene lab: a fixture and debugging tool for the homepage's table scene.
// Open it with ?lab in the URL, or Shift+L. Everything here changes the live scene: the camera that frames the table,
// the light (and with it every shadow), the room box around the table, and the paper's physics. Because the paper lives in
// the same 3D world as the projector, moving the camera changes how far it visibly falls, where it can roll and how it is lit.
//
// Fixtures are named snapshots of all of it. Built-in ones cover the useful extremes; yours are kept in this browser
// (localStorage) and can be copied out as JSON to become the site's defaults.
import * as THREE from 'three';

const device = document.querySelector('memory-projector, temporal-projector');   // the homepage's projector, current or archived
const paper = () => window.__paper;
const STORE = 'scene-lab:fixtures', CURRENT = 'scene-lab:current';
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const PAPER_DEFAULTS = { ...paper().PAPER };
const BUILTIN = {
  'Default · wide, 32°': {},
  'Mockup · front right, 50°': { camera: { elevation: 50, azimuth: 40, fov: 22, scale: null } },
  'Low · show the air': { camera: { elevation: 20, azimuth: 32, fov: 30, scale: 0.13, y: 0.66 }, room: { width: 1.0, depth: 0.8 } },
  'Overhead': { camera: { elevation: 82, azimuth: 15, fov: 22 } },
  'Front · against the wall': { camera: { elevation: 28, azimuth: 0, fov: 26, scale: 0.15, y: 0.62 }, room: { width: 1.4, depth: 0.42 } },
  'Wide lens, close': { camera: { elevation: 42, azimuth: 48, fov: 55, scale: 0.24 } },
  'Late light · long shadows': { light: { azimuth: 70, elevation: 18, intensity: 1.6, softness: 10 } },
};

// ------------------------------------------------------------------ config in and out
const merge = (base, patch) => { const o = JSON.parse(JSON.stringify(base)); for (const k of Object.keys(patch || {})) o[k] = { ...(o[k] || {}), ...patch[k] }; return o; };
function current() { return { ...device.getScene(), paper: { ...paper().PAPER } }; }
function apply(cfg, { save = true } = {}) {
  const { paper: p, ...sceneCfg } = cfg;
  device.setScene(sceneCfg);
  Object.assign(paper().PAPER, p || {});
  if (save) store.set(CURRENT, current());
  sync();
}
function fixture(patch) { return merge({ ...merge(device.constructor.defaultScene, {}), paper: PAPER_DEFAULTS }, patch); }

// ------------------------------------------------------------------ panel
const css = `
#scene-lab { position: fixed; z-index: 50; right: 12px; top: 12px; bottom: 12px; width: 300px; display: flex; flex-direction: column;
  font: 500 12px/1.3 "Geist", ui-sans-serif, system-ui, sans-serif; color: #13131a; border-radius: 14px; overflow: hidden;
  background: rgba(246,246,250,.86); -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.7), 0 0 0 1px rgba(19,19,26,.08), 0 12px 32px rgba(10,10,30,.18); }
#scene-lab[hidden] { display: none; }
#scene-lab header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 8px; font-weight: 650; font-size: 13px; }
#scene-lab .body { overflow-y: auto; padding: 0 14px 14px; overscroll-behavior: contain; }
#scene-lab h3 { margin: 14px 0 6px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: rgba(19,19,26,.5); font-weight: 600; }
#scene-lab .row { display: grid; grid-template-columns: 92px 1fr 46px; align-items: center; gap: 8px; min-height: 26px; }
#scene-lab .row input[type=range] { width: 100%; accent-color: #1c2eff; }
#scene-lab .row input[type=color] { width: 100%; height: 22px; padding: 0; border: 0; background: none; cursor: pointer; }
#scene-lab .row output { text-align: right; font-variant-numeric: tabular-nums; color: rgba(19,19,26,.7); }
#scene-lab .check { display: flex; align-items: center; gap: 8px; min-height: 26px; }
#scene-lab .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
#scene-lab button, #scene-lab select { font: inherit; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(19,19,26,.14); background: #fff; color: inherit; cursor: pointer; }
#scene-lab button:hover { background: #f1f1f6; }
#scene-lab select { width: 100%; }
#scene-lab pre { margin: 8px 0 0; padding: 8px; border-radius: 8px; background: rgba(19,19,26,.05); font: 11px/1.4 ui-monospace, monospace; white-space: pre-wrap; }
#scene-lab .note { color: rgba(19,19,26,.55); font-weight: 400; margin: 4px 0 0; }
@media (max-width: 599px) { #scene-lab { left: 8px; right: 8px; top: auto; height: 46vh; width: auto; } }`;

const CONTROLS = [
  ['Camera', [
    ['camera.elevation', 'Elevation°', 5, 89, 1], ['camera.azimuth', 'Azimuth°', -90, 90, 1], ['camera.fov', 'Lens (fov°)', 8, 70, 1],
    ['camera.scale', 'Device size', 0.05, 0.4, 0.005, true], ['camera.x', 'Device x', 0, 1, 0.005, true], ['camera.y', 'Device y', 0, 1, 0.005, true],
  ]],
  ['Light & shadow', [
    ['light.azimuth', 'Direction°', -180, 180, 1], ['light.elevation', 'Height°', 5, 89, 1], ['light.intensity', 'Intensity', 0, 4, 0.05],
    ['light.softness', 'Softness', 0, 40, 1], ['light.opacity', 'Darkness', 0, 0.8, 0.01], ['light.area', 'Shadow area m', 0.15, 1.5, 0.01],
  ]],
  ['Projector', [
    ['device.x', 'Across m', -1, 1, 0.005], ['device.z', 'Depth m', -1, 1, 0.005], ['device.rotation', 'Turn°', -180, 180, 1],
  ]],
  ['Room', [
    ['room.walls', 'Walls', 'bool'], ['room.width', 'Width m', 0.6, 5, 0.01], ['room.depth', 'Depth m', 0.6, 5, 0.01],
    ['room.cove', 'Floor sweep m', 0.01, 0.8, 0.005], ['room.round', 'Corner round m', 0.01, 1.5, 0.01],
    ['room.shade', 'Wall shade', 0, 0.4, 0.005], ['room.corner', 'Bend shade', 0, 0.5, 0.005],
  ]],
  ['Look', [
    ['look.agx', 'AgX filmic (off: Neutral)', 'bool'], ['look.exposure', 'Exposure', 0.3, 2.5, 0.01],
    ['look.env', 'Reflections', 0, 3, 0.01], ['look.room', 'Studio walls', 0, 0.8, 0.01], ['look.flags', 'Black flags', 'bool'],
  ]],
  ['Case', [
    ['shell.color', 'Colour', 'color'], ['shell.metalness', 'Metalness', 0, 1, 0.01], ['shell.roughness', 'Roughness', 0, 1, 0.01], ['shell.specular', 'Specular', 0, 2, 0.01],
    ['shell.clearcoat', 'Clear coat', 0, 1, 0.01], ['shell.coatRoughness', 'Coat roughness', 0, 1, 0.01],
    ['shell.sheen', 'Sheen', 0, 1, 0.01], ['shell.ao', 'Contact shadow (AO)', 0, 2, 0.01],
  ]],
  ['Dial (aluminium)', [
    ['dial.roughness', 'Roughness', 0, 1, 0.01],
  ]],
  ['Paper', [
    ['paper.radius', 'Ball radius m', 0.005, 0.03, 0.0005], ['paper.hold', 'Held height m', 0.03, 0.5, 0.005], ['paper.gravity', 'Gravity m/s²', 0.5, 15, 0.1],
    ['paper.friction', 'Friction', 0, 2, 0.01], ['paper.drag', 'Table drag', 0, 10, 0.1], ['paper.air', 'Air drag', 0, 4, 0.05], ['paper.bounce', 'Bounce', 0, 0.9, 0.01],
    ['paper.lift', 'Pick-up lift m', 0, 0.1, 0.001], ['paper.throw', 'Throw strength', 0, 3, 0.05], ['paper.toss', 'Upward toss → away', 0, 2, 0.05],
    ['paper.key', 'Key on paper', 0, 2, 0.05], ['paper.fill', 'Sky on paper', 0, 3, 0.05], ['paper.front', 'Room behind you', 0, 3, 0.05],
  ]],
];
const get = (cfg, path) => path.split('.').reduce((o, k) => o?.[k], cfg);

const root = document.createElement('aside');
root.id = 'scene-lab';
root.setAttribute('aria-label', 'Scene lab');
root.innerHTML = `<style>${css}</style><header><span>Scene lab</span><button type="button" data-act="hide" aria-label="Hide the lab (Shift+L)">Hide</button></header><div class="body"></div>`;
const body = root.querySelector('.body');
const inputs = new Map();

body.insertAdjacentHTML('beforeend', `<h3>Fixtures</h3><select data-fixtures aria-label="Fixture"></select>
  <div class="btns"><button data-act="save">Save as…</button><button data-act="delete">Delete</button><button data-act="reset">Defaults</button></div>
  <div class="btns"><button data-act="copy">Copy JSON</button><button data-act="paste">Paste JSON</button></div>
  <p class="note">Your fixtures stay in this browser. Copy JSON to make one the site's default.</p>`);
for (const [title, rows] of CONTROLS) {
  body.insertAdjacentHTML('beforeend', `<h3>${title}</h3>`);
  for (const [path, label, min, max, step, nullable] of rows) {
    if (min === 'color') {
      body.insertAdjacentHTML('beforeend', `<div class="row"><label for="lab-${path}">${label}</label><input id="lab-${path}" type="color" data-path="${path}"><output data-out="${path}"></output></div>`);
    } else if (min === 'bool') {
      body.insertAdjacentHTML('beforeend', `<label class="check"><input type="checkbox" data-path="${path}"> ${label}</label>`);
    } else {
      body.insertAdjacentHTML('beforeend', `<div class="row"><label for="lab-${path}">${label}${nullable ? ' <input type="checkbox" data-auto="' + path + '" title="Set by hand (unchecked: the page decides)">' : ''}</label>
        <input id="lab-${path}" type="range" min="${min}" max="${max}" step="${step}" data-path="${path}"><output data-out="${path}"></output></div>`);
    }
  }
}
body.insertAdjacentHTML('beforeend', `<p class="note">Visitors can only lift it a little; this is where it stands.</p>
  <h3>Overlays</h3>
  <label class="check"><input type="checkbox" data-ov="grid" checked> Table grid (5 cm)</label>
  <label class="check"><input type="checkbox" data-ov="room" checked> Room box</label>
  <label class="check"><input type="checkbox" data-ov="light" checked> Light and shadow frustum</label>
  <label class="check"><input type="checkbox" data-ov="bounds" checked> Where the ball can go</label>
  <label class="check"><input type="checkbox" data-ov="paper" checked> Paper height and drop point</label>
  <h3>Try it</h3>
  <div class="btns"><button data-act="drop">Drop ball from 15 cm</button><button data-act="throw">Throw at projector</button></div>
  <div class="btns"><button data-act="open">Open letter</button><button data-act="close">Crumple</button><button data-act="power">Power</button></div>
  <h3>Readout</h3><pre data-readout></pre>`);
document.body.appendChild(root);

function sync() {
  const cfg = current();
  for (const el of body.querySelectorAll('[data-path]')) {
    const v = get(cfg, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'color') { el.value = v ?? el.value; const o = body.querySelector(`[data-out="${el.dataset.path}"]`); if (o) o.textContent = v ?? ''; continue; }
    else { el.value = v ?? el.value; el.disabled = v == null && !!body.querySelector(`[data-auto="${el.dataset.path}"]`); }
    const out = body.querySelector(`[data-out="${el.dataset.path}"]`);
    if (out) out.textContent = v == null ? 'auto' : (+v).toFixed(+el.step < .01 ? 3 : +el.step < 1 ? 2 : 0);
  }
  for (const el of body.querySelectorAll('[data-auto]')) el.checked = get(cfg, el.dataset.auto) != null;
}
function setPath(path, value) {
  const [sec, key] = path.split('.');
  apply({ [sec]: { [key]: value } });
}
body.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.path) setPath(el.dataset.path, el.type === 'checkbox' ? el.checked : el.type === 'color' ? el.value : +el.value);
  if (el.dataset.auto) {
    const range = body.querySelector(`input[type=range][data-path="${el.dataset.auto}"]`);
    setPath(el.dataset.auto, el.checked ? +range.value : null);
  }
  if (el.dataset.ov) overlays[el.dataset.ov].visible = el.checked;
  if (el.matches('[data-fixtures]')) {
    const all = { ...Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [k, fixture(v)])), ...store.get(STORE, {}) };
    if (all[el.value]) apply(all[el.value]);
  }
});
function fillFixtures(sel) {
  const s = body.querySelector('[data-fixtures]'), mine = store.get(STORE, {});
  s.innerHTML = `<optgroup label="Built in">${Object.keys(BUILTIN).map((k) => `<option>${k}</option>`).join('')}</optgroup>` +
    (Object.keys(mine).length ? `<optgroup label="Yours">${Object.keys(mine).map((k) => `<option>${k}</option>`).join('')}</optgroup>` : '');
  if (sel) s.value = sel;
}
root.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const P = paper(), mine = store.get(STORE, {}), s = body.querySelector('[data-fixtures]');
  if (act === 'hide') root.hidden = true;
  if (act === 'save') { const name = prompt('Name this fixture', s.value.replace(/^Mockup.*/, 'My view')); if (name) { mine[name] = current(); store.set(STORE, mine); fillFixtures(name); } }
  if (act === 'delete') { if (mine[s.value]) { delete mine[s.value]; store.set(STORE, mine); fillFixtures(); } }
  if (act === 'reset') { apply(fixture({})); fillFixtures(Object.keys(BUILTIN)[0]); }
  if (act === 'copy') { const txt = JSON.stringify(current(), null, 2); try { await navigator.clipboard.writeText(txt); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy JSON'), 1200); } catch { prompt('Copy this JSON', txt); } }
  if (act === 'paste') { const txt = prompt('Paste a fixture JSON'); if (txt) try { apply(JSON.parse(txt)); } catch { alert('That is not valid JSON.'); } }
  if (act === 'drop') { const c = device.rig.localToWorld(new THREE.Vector3(0.02, 0, 0.08)); P.drop(c.x, c.z, 0.15); }
  if (act === 'throw') { if (P.mode === 'ball') { const d = new THREE.Vector3().sub(P.B.p).setY(0).normalize().multiplyScalar(0.9); P.B.v.x = d.x; P.B.v.z = d.z; } }
  if (act === 'open') document.getElementById('ball').click();
  if (act === 'close') window.__work?.close(null);
  if (act === 'power') device.togglePower();
});
addEventListener('keydown', (e) => { if (e.shiftKey && e.key.toLowerCase() === 'l' && !e.metaKey && !e.ctrlKey) root.hidden = !root.hidden; });

// ------------------------------------------------------------------ overlays, drawn in the projector's scene
const overlays = {};
const ink = (hex, o = 0.9) => new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: o, depthTest: false });
function group(name) { const g = new THREE.Group(); g.renderOrder = 10; device.scene.add(g); overlays[name] = g; return g; }
const gGrid = group('grid'), gRoom = group('room'), gLight = group('light'), gBounds = group('bounds'), gPaper = group('paper');
function rebuildStatic() {
  const cfg = device.getScene();
  for (const g of [gGrid, gRoom, gLight]) g.children.slice().forEach((o) => { g.remove(o); o.geometry?.dispose(); });
  const size = Math.max(cfg.room.width, cfg.room.depth), grid = new THREE.GridHelper(size, Math.round(size / 0.05), 0x1c2eff, 0x8890c8);
  grid.material.transparent = true; grid.material.opacity = 0.35; grid.position.y = 0.0006;
  gGrid.add(grid);
  const pts = [], N = 240;
  for (let i = 0; i <= N; i++) {   // the foot of the cove: where the floor starts to sweep up
    const a = i / N * Math.PI * 2, dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    let lo = 0, hi = 3; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; device.roomSDF(dir.x * m, dir.z * m).d < 0 ? lo = m : hi = m; }
    pts.push(dir.x * lo, 0.001, dir.z * lo);
  }
  const outline = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), ink(0xff3a0e, 0.7));
  gRoom.add(outline);
  const k = device.keyLight, cam = new THREE.CameraHelper(k.shadow.camera);
  cam.material.depthTest = false; cam.material.transparent = true; cam.material.opacity = 0.5;
  const arrow = new THREE.ArrowHelper(device.lightDir, k.target.position, 0.25, 0xffb000, 0.03, 0.015);
  arrow.line.material.depthTest = false; arrow.cone.material.depthTest = false;
  gLight.add(cam, arrow);
}
const boundsLine = new THREE.LineSegments(new THREE.BufferGeometry(), ink(0x00a86b)); gBounds.add(boundsLine);
const footLine = new THREE.LineLoop(new THREE.BufferGeometry(), ink(0x00a86b)); gBounds.add(footLine);
const dropLine = new THREE.Line(new THREE.BufferGeometry(), ink(0x1c2eff)); gPaper.add(dropLine);
const dropDot = new THREE.Mesh(new THREE.RingGeometry(0.008, 0.011, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x1c2eff, depthTest: false, transparent: true }));
gPaper.add(dropDot);
device.addEventListener('scenechange', rebuildStatic);
rebuildStatic();

let frames = 0, fpsT = performance.now(), fps = 0;
device.tickers.add(() => {
  const P = paper(), r = P.PAPER.radius;
  // where the ball can go: the screen's edges on the table, and the projector's footprint
  if (gBounds.visible) {
    const pts = [];
    for (const e of P.viewLines()) { const tx = -e.nz, tz = e.nx; pts.push(e.px - tx * 2, r, e.pz - tz * 2, e.px + tx * 2, r, e.pz + tz * 2); }
    boundsLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const b = device.localBox, f = [];
    if (b) for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2, rad = 0.012 + r, hx = (b.max.x - b.min.x) / 2 - 0.012, hz = (b.max.z - b.min.z) / 2 - 0.012;
      const q = Math.floor(i / 16) % 4, cx = [hx, -hx, -hx, hx][q], cz = [hz, hz, -hz, -hz][q];
      const w = device.rig.localToWorld(new THREE.Vector3((b.min.x + b.max.x) / 2 + cx + Math.cos(a) * rad, 0.0008, (b.min.z + b.max.z) / 2 + cz + Math.sin(a) * rad)); f.push(w.x, w.y, w.z); }
    footLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(f, 3));
  }
  // the paper: a line from it straight down to the table, and a ring where it would land
  if (gPaper.visible) {
    const s = window.__paperState, p = s ? new THREE.Vector3(...(s.pmode === 'open' ? s.held : s.p)) : P.B.p;
    dropLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute([p.x, p.y, p.z, p.x, 0.0008, p.z], 3));
    dropDot.position.set(p.x, 0.0008, p.z);
  }
  frames++;
  const now = performance.now();
  if (now - fpsT > 500) {
    fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now;
    const cam = device.camera, cp = cam.position, cfg = device.getScene();
    const a = device.toScreen(new THREE.Vector3(0, 0, 0)), b = device.toScreen(new THREE.Vector3(0.01, 0, 0));
    const s = window.__paperState || {};
    body.querySelector('[data-readout]').textContent = [
      `camera   ${cp.toArray().map((v) => v.toFixed(3)).join(', ')} m`,
      `distance ${cp.distanceTo(new THREE.Vector3(0.002, 0.013, 0.006)).toFixed(3)} m, fov ${cam.fov}°`,
      `projector at ${cfg.device.x.toFixed(3)}, ${cfg.device.z.toFixed(3)} m, turned ${cfg.device.rotation}°`,
      `1 cm on the table at the device ≈ ${Math.hypot(b.x - a.x, b.y - a.y).toFixed(1)} px`,
      `light    el ${cfg.light.elevation}°, dir ${cfg.light.azimuth}° from top toward left`,
      `paper    ${s.pmode ?? '–'} at ${(s.p || []).join(', ')}`,
      s.pmode === 'open' || s.pmode === 'opening' ? `held     ${(s.held || []).join(', ')} (${((s.held || [0, 0])[1] * 100).toFixed(1)} cm up)` : '',
      `${fps} fps`,
    ].filter(Boolean).join('\n');
  }
});

// Dragging the projector on the page moves these sliders too, and is remembered as your working view.
device.addEventListener('scenechange', () => { sync(); store.set(CURRENT, current()); });
device.addEventListener('devicemove', () => sync());

// start from what you were last looking at
const last = store.get(CURRENT, null);
if (last) apply(last, { save: false });
fillFixtures();
sync();
