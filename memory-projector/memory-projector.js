// <memory-projector> — a personal holographic projector of memories (three.js web component).
//
//   <script type="importmap">{ "imports": {
//     "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
//     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }</script>
//   <script type="module" src="memory-projector.js"></script>
//   <memory-projector memories="memories/memories.json"></memory-projector>
//
// Attributes: memories (manifest URL), power (on|off), table, movable, zoom, muted, src (GLB), shadow, ao
// Events:     "memorychange" detail { id, index, title, story }
//             "powerchange"  detail { on }
// Methods:    next(), back(), shuffle(), show(id), togglePower(), setMemories(list),
//             anchor(part) — client px of power|back|shuffle|next|light|lens|hologram, hologramHit(x, y), footprint()
// Grown from the Temporal Projector (../temporal-projector/, frozen): same renderer and table scene, new device and content.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPlaylist } from './lib/playlist.js';
import { DepthHologram } from './holo-depth.js';
import { wrapLines, crawlState } from './lib/crawl.js';
import { createSeen } from './lib/seen.js';

const TOP_Y = 0.021;                // top surface height (m)
const POWER_SLIDE = 0.0088;         // the power knob slides this far right when on
const KEY_TRAVEL = -0.0011;         // how far a key goes down when pressed
const LED_P = new THREE.Vector3(0.0255, TOP_Y - 0.0023, -0.014);    // green strip the knob uncovers
const MEMORY_LED_P = new THREE.Vector3(0.0455, TOP_Y + 0.0002, -0.014);   // the memory light (from the GLB export)
const APERTURE_P = new THREE.Vector3(0.0, 0.011, 0.0312);           // front projection lens, centred
// The story's crawl: a patch of light the front lens throws on the table, in front of the device. The paragraph scrolls
// through it, away from you toward the lens, fading in at the near edge and out at the far one. Tuned by eye.
const CRAWL = {
  at: new THREE.Vector3(0.0, 0.0002, 0.108),   // centre of the patch on the table (m): its far edge just clears the front lens
  w: 0.2, d: 0.135,                            // its width and depth (m): wider than the device, so it reads on a desktop
  px: [1024, 692],                             // canvas size (same aspect as the patch)
  font: 44, lineHeight: 1.35, margin: 64,      // px on the canvas
  fade: 0.18,                                  // fraction of the depth faded at each end
  wordsPerSecond: 2, pause: 2.5,
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// The hologram rises from the top lens: a cone of light, and a dithered image floating inside it.
const HOLO = {
  lens: new THREE.Vector3(-0.024, TOP_Y + 0.0006, -0.0025),
  r0: 0.012,           // beam radius at the lens
  r1: 0.08,            // beam radius at the top of the image
  gap: 0.026,          // lens to the bottom of the image: the subject floats clear of the projector
  w: 0.145, h: 0.15,   // image plane: the subjects stand well over the projector's length tall
};
HOLO.top = HOLO.gap + HOLO.h;
// table view: what the camera looks at, and the radius that --stage-scale sizes
const TABLE_TARGET = new THREE.Vector3(0.002, 0.013, 0.006);
const TABLE_RADIUS = 0.07;
// The table scene, all of it adjustable live with setScene() (the homepage's scene lab drives this):
//   camera  elevation / azimuth in degrees (azimuth 0 = straight in front, + = from the right), fov in degrees;
//           x, y, scale: where the device sits and how big (null = the --stage-* custom properties decide)
//   light   azimuth: where it stands on the table, in degrees from "behind the scene" (the top of the screen) toward
//           the left of the screen, so it stays put on screen as the camera turns; elevation in degrees; intensity;
//           shadow softness (filter radius), opacity, area (half-size of the shadow map in metres), map size
//   device  where the projector stands on the table: x and z in metres from the middle of the room, rotation in degrees
//   room    the table is the floor of a room this wide and deep (metres). It has no hard edges: the floor sweeps up into the
//           walls along a cove of radius `cove`, and the walls meet each other around corners of radius `round`, like a
//           photo studio. The walls get `shade` darker toward the top of the sweep, and `corner` darkens the bend softly.
//           The parts of the room between the camera and the scene are cut away, like a dollhouse.
//   look    how it is rendered: `agx` (AgX filmic) or Neutral tone mapping, `exposure`, `env` = strength of the reflected
//           studio, `room` = brightness of the studio's walls (dark = crisp softbox highlights, light = soft high-key),
//           `flags` = black cards beside the set that give metal and gloss dark bands to mirror
//   shell   the case: colour, metalness (0 = moulded plastic, 1 = metal), roughness (lower = sharper reflections), specular strength, clear coat and its
//           roughness, sheen (soft velvety edge light), ao = strength of the baked contact darkening
//   dial    the aluminium crown: roughness
const TABLE_SCENE = {
  camera: { elevation: 32, azimuth: 39, fov: 55, x: null, y: null, scale: 0.16 },
  light: { azimuth: 84, elevation: 64, intensity: 1.8, softness: 25, opacity: 0.1, area: 0.37, mapSize: 1024 },
  device: { x: -0.09, z: 0.015, rotation: 5 },
  room: { walls: true, width: 1.32, depth: 1.29, shade: 0.095, corner: 0, cove: 0.025, round: 0.01 },
  look: { agx: false, exposure: 0.93, env: 1.5, room: 0.06, flags: false },
  shell: { color: '#ffffff', metalness: 0.81, roughness: 0.36, specular: 1, clearcoat: 0.48, coatRoughness: 0.61, sheen: 0.31, ao: 0.57 },
  dial: { roughness: 0.23 },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

function gradientTexture(stops, vertical = true) {
  const c = document.createElement('canvas');
  c.width = vertical ? 4 : 256; c.height = vertical ? 256 : 4;
  const g = c.getContext('2d'), grd = vertical ? g.createLinearGradient(0, 0, 0, 256) : g.createLinearGradient(0, 0, 256, 0);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Colours are sRGB triplets written straight to the framebuffer: the hologram is light, not a lit surface.
const HOLO_INK = new THREE.Vector3(0.11, 0.18, 1.0);       // the homepage's dither blue

const HOLO_BEAM_VS = `
  varying float vH, vFace, vAng;
  void main(){
    vH = uv.y; vAng = uv.x;
    vec4 mv = modelViewMatrix * vec4(position, 1.);
    vFace = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }`;

const HOLO_BEAM_FS = `
  uniform float uGrow, uTime, uAlpha, uPulse;
  uniform vec3 uCol;
  varying float vH, vFace, vAng;
  void main(){
    if (vH > uGrow) discard;
    float a6 = vAng * 6.2832;
    float streak = .62 + .38 * sin(a6 * 11. + sin(a6 * 4. + uTime * .5) * 2.4 + vH * 3. - uTime * .9);
    float body = pow(vFace, 1.6);
    float fall = .25 + .75 * pow(1. - vH, 1.4);
    float tip = smoothstep(uGrow, uGrow - .1, vH);
    gl_FragColor = vec4(uCol, body * fall * streak * tip * (.15 + .22 * uPulse) * uAlpha);
  }`;

const HOLO_MOTES_VS = `
  attribute vec3 aSeed;
  uniform float uTime, uGrow, uH, uR0, uR1, uSize;
  varying float vA;
  void main(){
    float y = fract(aSeed.z * 13.7 + aSeed.x * .31 + uTime * (.05 + aSeed.z * .09));
    float r = mix(uR0, uR1, y) * aSeed.y;
    float ang = aSeed.x + uTime * .25 * (aSeed.z - .5);
    vec4 mv = modelViewMatrix * vec4(cos(ang) * r, y * uH, sin(ang) * r, 1.);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (.55 + aSeed.z * .9);
    vA = smoothstep(0., .08, y) * smoothstep(1., .55, y) * step(y, uGrow);
  }`;

const HOLO_MOTES_FS = `
  uniform vec3 uCol; uniform float uAlpha;
  varying float vA;
  void main(){
    float d = length(gl_PointCoord - .5);
    if (d > .5) discard;
    gl_FragColor = vec4(uCol, vA * uAlpha * (1. - d * 2.) * .8);
  }`;

// ------------------------------------------------------------------ materials
function makeMaterials() {
  const P = (o) => new THREE.MeshPhysicalMaterial(o);
  const M = {
    alu_beadblast: P({ color: 0xcfd0d2, metalness: 1, roughness: 0.3 }),
    alu_polished: P({ color: 0xe6e6e8, metalness: 1, roughness: 0.07 }),
    alu_machined: P({ color: 0xdcdcde, metalness: 1, roughness: 0.16 }),
    alu_knurl: P({ color: 0xd2d3d5, metalness: 1, roughness: 0.24 }),
    black_anodized: P({ color: 0x101012, metalness: 1, roughness: 0.32 }),
    black_gloss: P({ color: 0x070707, metalness: 0.6, roughness: 0.14 }),
    black_matte: P({ color: 0x030303, metalness: 0, roughness: 0.9 }),
    base_graphite: P({ color: 0x2a2a2e, metalness: 1, roughness: 0.45 }),
    signal_orange: P({ color: 0xff3a0e, metalness: 0, roughness: 0.32, clearcoat: 0.12,
      clearcoatRoughness: 0.4, sheen: 0.3, sheenColor: 0xff6a3a, sheenRoughness: 0.6 }),
    ink_graphite: P({ color: 0x141415, roughness: 0.82 }),
    ink_white: P({ color: 0xe9e9e6, roughness: 0.82 }),
    ink_orange: P({ color: 0xff3a0c, roughness: 0.82 }),
    // thin coated glass: see-through with its anti-reflection sheen and crisp reflections. No transmission: in three.js
    // that renders the whole scene a second time every frame (over half the frame's GPU time) for a few lens pixels.
    coated_glass: P({ color: 0xffffff, metalness: 0, roughness: 0, transparent: true, opacity: 0.22, depthWrite: false,
      ior: 1.52, iridescence: 1, iridescenceIOR: 1.38, iridescenceThicknessRange: [260, 420], specularIntensity: 1 }),
    body_warm_white: P({ color: 0xece9e2, roughness: 0.52, sheen: 0.25, sheenColor: 0xffffff, sheenRoughness: 0.8 }),
    trim_grey: P({ color: 0xc9cdd2, roughness: 0.5 }),
    p_orange: P({ color: 0xf0531f, roughness: 0.42, clearcoat: 0.1, clearcoatRoughness: 0.5,
      sheen: 0.3, sheenColor: 0xff7a4a, sheenRoughness: 0.6 }),
    p_black: P({ color: 0x1a1a1b, roughness: 0.55 }),
    p_black_gloss: P({ color: 0x0b0b0c, roughness: 0.12 }),
    p_gap: P({ color: 0x040404, roughness: 0.9 }),
    p_smoke: P({ color: 0x0e0f10, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04 }),
    power_on: new THREE.MeshStandardMaterial({ color: 0x0a2a0e, emissive: 0x3dff8a, emissiveIntensity: 3 }),
    led_green: new THREE.MeshStandardMaterial({ color: 0x0a2a0e, emissive: 0x3dff6a, emissiveIntensity: 6 }),
    projector_core: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x5d8cff, emissiveIntensity: 3 }),
    front_core: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc98a, emissiveIntensity: 5 }),
    memory_led: new THREE.MeshStandardMaterial({ color: 0x0c1430, emissive: 0x5b7cff, emissiveIntensity: 0 }),
    strap_woven: P({ color: 0x8d877e, roughness: 0.86, sheen: 0.6, sheenColor: 0xb9b2a6, sheenRoughness: 0.7 }),
  };
  for (const [k, m] of Object.entries(M)) m.name = k;   // the scene lab finds them by name
  return M;
}

// A studio built from emissive panels, matching the Cycles light rig.
function softboxTexture() {
  // diffusion fabric: bright centre, soft falloff to the frame
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 10, 128, 128, 150);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.55, '#d9d9d9');
  grd.addColorStop(1, '#3a3a3a');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function studioEnvironment(renderer, table = false, { room = 0.06, flags = false } = {}) {
  const env = new THREE.Scene();
  const basic = (c, side = THREE.FrontSide, map = null) => new THREE.MeshBasicMaterial({ color: c, side, map });
  // the room the softboxes hang in: dark gives crisp highlights on a dark ground (product look), light gives high-key
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), basic(new THREE.Color(room, room, room * 1.02), THREE.BackSide)));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(19, 64), basic(new THREE.Color().setScalar(Math.max(0.3, room * 1.3))));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.35;
  env.add(floor);
  const soft = softboxTexture();
  const panel = (w, h, pos, k, tint = [1, 1, 1]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      basic(new THREE.Color(...tint).multiplyScalar(k), THREE.DoubleSide, soft));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(6, 6, [-5.5, 6.0, 3.0], 9, [1, 0.985, 0.96]);   // key, front-left high
  panel(11, 5, [1, 5.5, -6], 4.2, [0.97, 0.98, 1]);       // top-back softbox
  panel(7, 5, [6.5, 2.2, 3.5], 2.2);                      // fill
  panel(3, 1.5, [4.5, 1.0, -3.5], 1.5);                   // kicker
  const flag = (w, h, pos) => {                            // negative fill: dark bands for the metal to mirror
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basic(new THREE.Color(0.02, 0.02, 0.02), THREE.DoubleSide));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  if (flags) { flag(9, 2.2, [0.8, 0.9, 4.5]); flag(6, 1.8, [4.5, 0.6, -2.5]); }
  if (table) panel(7, 5, [-3.4, 6.2, -4.0], 1.3, [1, 0.99, 0.97]);   // table view: the top-left window the device's top mirrors
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.012).texture;
  pmrem.dispose();
  return tex;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Short mechanical click synthesised with WebAudio (no assets).
class Clicker {
  constructor() { this.ctx = null; this.muted = false; }
  play(gain = 0.25, freq = 3200) {
    if (this.muted) return;
    try {
      this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this.ctx, len = Math.floor(ctx.sampleRate * 0.03);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.12));
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.2;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start();
    } catch { /* audio is optional */ }
  }
}

// Critically-damped-ish spring toward a target value.
class Spring {
  constructor(v, k = 260, zeta = 0.62) { this.v = v; this.t = v; this.vel = 0; this.k = k; this.zeta = reduceMotion ? 1 : zeta; }
  step(dt) {
    // fixed sub-steps: frame-rate independent and stable for stiff springs
    const c = 2 * Math.sqrt(this.k) * this.zeta;
    for (let left = dt; left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      const a = this.k * (this.t - this.v) - c * this.vel;
      this.vel += a * h;
      this.v += this.vel * h;
    }
    return Math.abs(this.t - this.v) > 1e-4 || Math.abs(this.vel) > 1e-3;
  }
}

const TEMPLATE = `
<style>
  :host { display: block; position: relative; width: 100%; height: 100%; min-height: 320px;
          outline: none; -webkit-tap-highlight-color: transparent; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none;
           opacity: 0; transition: opacity .9s ease; }
  :host([data-ready]) canvas { opacity: 1; }
  :host(:focus-visible) { box-shadow: inset 0 0 0 2px rgba(255,74,20,.55); border-radius: 4px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .status { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
            font: 500 11px/1 "Helvetica Neue", Helvetica, Arial, sans-serif; letter-spacing: .14em;
            color: rgba(0,0,0,.38); text-transform: uppercase; pointer-events: none; transition: opacity .4s; }
  :host([data-ready]) .status { opacity: 0; }
</style>
<canvas part="canvas"></canvas>
<div class="status">Loading</div>
<div class="sr" aria-live="polite"></div>`;

class MemoryProjector extends HTMLElement {
  static observedAttributes = ['power', 'zoom', 'muted', 'memories'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    this.canvas = this.shadowRoot.querySelector('canvas');
    this.live = this.shadowRoot.querySelector('.sr');
    this.clicker = new Clicker();
    this.state = { power: true, index: 0, id: null, developing: false };
    this.playlist = createPlaylist([]);
    this.seen = createSeen();
  }

  // The memories, in story order: [{ id, src, story, title?, date?, fps, seconds, aspect }]. `src` is relative to
  // `base` (the manifest's URL when loaded from the `memories` attribute). Returns a promise.
  setMemories(list, base = location.href) {
    const ok = Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
    this.playlist = createPlaylist(ok.map((m) => ({ ...m, url: m.src ? new URL(m.src, base).href : null })));
    this._changed();
    return Promise.resolve();
  }

  async _loadMemories(url) {
    const href = new URL(url, location.href).href;
    try {
      const res = await fetch(href, { cache: 'no-cache' });   // always ask: a memory may have arrived since last time
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this.setMemories(await res.json(), href);
    } catch (e) {
      console.warn(`memory-projector: could not load memories from ${href} (${e.message})`);
      await this.setMemories([]);
    }
  }

  connectedCallback() {
    if (this._started) return;
    this._started = true;
    this.tabIndex = 0;
    this.setAttribute('role', 'application');
    this.setAttribute('aria-label',
      'Memory projector. Left and right arrows go back and forward through the memories, S or Enter shuffles, P toggles power.');
    this.clicker.muted = this.hasAttribute('muted');
    if (this.getAttribute('power') === 'off') this.state.power = false;
    this._loadMemories(this.getAttribute('memories') || new URL('./memories/memories.json', import.meta.url).href);
    this._init().catch((e) => {
      console.error(e);
      this.shadowRoot.querySelector('.status').textContent = 'Could not load model';
    });
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    if (this.depth) { this.depth.video.pause(); this.depth._load(null); }   // stop decoding the memory's video
    this._ro?.disconnect();
    this._io?.disconnect();
    this.renderer?.dispose();
    this._started = false;
  }

  attributeChangedCallback(name, old, val) {
    if (name === 'memories' && this._started && val && val !== old) this._loadMemories(val);
    if (!this.renderer) return;
    if (name === 'power') this._setPower(val !== 'off');
    if (name === 'zoom' && !this.table) this.controls.enableZoom = val !== null;
    if (name === 'muted') this.clicker.muted = val !== null;
  }

  // ---------------------------------------------------------------- setup
  async _init() {
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.AgXToneMapping;      // filmic roll-off, closer to the Cycles renders
    renderer.toneMappingExposure = 1.18;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);

    const scene = this.scene = new THREE.Scene();
    this.table = this.hasAttribute('table');
    scene.environment = studioEnvironment(renderer, this.table);
    scene.environmentIntensity = 1.0;
    this._envKey = '0.06|false';

    // Table view (the `table` attribute): a fixed camera looking down at the desk the device stands on,
    // lit from the top left of the screen, with real shadows falling on a transparent floor, so the page colour is the table.
    if (this.table) renderer.shadowMap.type = THREE.PCFShadowMap;   // honours shadow.radius: a softer, wider shadow

    const camera = this.camera = new THREE.PerspectiveCamera(22, 1, 0.01, 5);
    const controls = this.controls = new OrbitControls(camera, this.canvas);
    controls.enabled = !this.table;
    // framed for the device, the table projection and the hologram above the lens
    controls.target.set(0.0, 0.08, 0.06);   // between the story on the table and the top of the memory
    camera.position.set(-0.13, 0.27, 0.46);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.enableZoom = this.hasAttribute('zoom');
    controls.minDistance = 0.2;
    controls.maxDistance = 0.9;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = 1.36;
    controls.rotateSpeed = 0.55;

    // key light for self-shadowing (knob onto the top plate etc.)
    const key = new THREE.DirectionalLight(0xfff8f0, 1.1);
    key.position.set(-0.30, 0.33, 0.165);
    key.castShadow = true;
    Object.assign(key.shadow.camera, { left: -0.075, right: 0.075, top: 0.075, bottom: -0.075, near: 0.2, far: 0.8 });
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.00008;
    key.shadow.normalBias = 0.0002;
    scene.add(key, key.target);

    this.keyLight = key;
    this.rig = new THREE.Group();   // the projector and everything it carries: placed on the table as one
    this.floorRig = new THREE.Group();   // what it leaves on the table: its contact shadow and the date it projects. Stays down when it is lifted.
    scene.add(this.rig, this.floorRig);
    this.tickers = new Set();   // functions called every frame with dt, before the scene is drawn
    if (this.table) {
      this.sceneCfg = clone(TABLE_SCENE);
      key.shadow.bias = -0.0002;
      key.shadow.blurSamples = 25;
      const floor = this.floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ color: 0x1c1a2e, opacity: 0.22 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.0002;
      floor.receiveShadow = true;
      scene.add(floor);
      this.room = new THREE.Group();
      scene.add(this.room);
      this._applyScene();
    }

    const base = new URL('./assets/', import.meta.url);
    const src = this.getAttribute('src') || new URL('memory-projector.glb', base).href;
    const shadowSrc = this.getAttribute('shadow') || new URL('shadow.png', base).href;
    const aoSrc = this.getAttribute('ao') || new URL('ao.jpg', base).href;
    const [gltf, shadowTex, aoTex] = await Promise.all([
      new GLTFLoader().loadAsync(src),
      new THREE.TextureLoader().loadAsync(shadowSrc),
      new THREE.TextureLoader().loadAsync(aoSrc).catch(() => null),
    ]);

    // baked Cycles contact shadow
    shadowTex.colorSpace = THREE.SRGBColorSpace;
    shadowTex.anisotropy = 4;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = -1;
    this.bakedShadow = shadow;
    this.floorRig.add(shadow);

    // device
    const M = this.M = makeMaterials();
    const device = gltf.scene;
    device.traverse((o) => {
      if (!o.isMesh) return;
      const m = M[o.material.name];
      if (m) o.material = m;
      o.castShadow = o.material !== M.coated_glass;
      o.receiveShadow = true;
    });
    // baked Cycles ambient occlusion on the body: seams, pockets and wells darken like the real part
    if (aoTex) {
      Object.assign(aoTex, { flipY: false, colorSpace: THREE.NoColorSpace, anisotropy: 4 });
      const lit = new Set([M.front_core, M.projector_core, M.power_on, M.led_green, M.coated_glass]);   // driven live; keep shared
      device.getObjectByName('body')?.traverse((o) => {
        if (!o.isMesh || !o.geometry.attributes.uv || lit.has(o.material)) return;
        o.material = o.material.clone();
        o.material.aoMap = aoTex;
        o.material.aoMapIntensity = 1.0;
      });
    }
    this.rig.add(device);
    this.deviceRoot = device;
    this._applyLook();
    this.localBox = new THREE.Box3().setFromObject(device);   // before placement: the projector's own extents
    this._placeDevice();
    this.powerBtn = device.getObjectByName('power_button');
    this.keys = { back: device.getObjectByName('key_back'), shuffle: device.getObjectByName('key_shuffle'),
      next: device.getObjectByName('key_next') };
    this.memoryLed = device.getObjectByName('memory_led');
    this.interactive = [this.keys.back, this.keys.shuffle, this.keys.next, this.powerBtn];
    // generous invisible hit areas, so the controls are easy to catch with a finger or cursor (the row keys only
    // grow toward the free sides, so neighbours never steal each other's presses)
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    for (const [o, gx, gz] of [[this.keys.back, 1.15, 1.6], [this.keys.shuffle, 1.1, 1.6], [this.keys.next, 1.15, 1.6], [this.powerBtn, 1.6, 1.6]]) {
      const b = new THREE.Box3();
      o.traverse((c) => { if (c.isMesh) { c.geometry.computeBoundingBox(); b.union(c.geometry.boundingBox); } });
      const size = b.getSize(new THREE.Vector3()).multiply(new THREE.Vector3(gx, 1.6, gz)).max(new THREE.Vector3(0.008, 0.008, 0.012));
      const hit = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), hitMat);
      b.getCenter(hit.position);
      hit.castShadow = hit.receiveShadow = false;
      o.add(hit);
    }
    this.keyRest = Object.fromEntries(Object.entries(this.keys).map(([k, o]) => [k, o.position.y]));
    this.powerX = this.powerBtn.position.x;

    // glows
    const gt = glowTexture();
    const sprite = (color, scale, pos) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, color, blending: THREE.AdditiveBlending,
        depthWrite: false, transparent: true }));
      s.scale.setScalar(scale);
      s.position.copy(pos);
      this.rig.add(s);
      return s;
    };
    this.ledGlow = sprite(0x3dff8a, 0.007, LED_P);
    this.memoryGlow = sprite(0x5b7cff, 0.008, MEMORY_LED_P);   // the memory light: a new memory is developing
    this.memoryGlow.material.opacity = 0;
    this.frontGlow = sprite(0x7f95ff, 0.018, APERTURE_P);   // the front lens, lit in the beam's blue

    // the year, thrown onto the table by the front lens
    this.projCanvas = this._crawlCanvas = document.createElement('canvas');
    [this.projCanvas.width, this.projCanvas.height] = CRAWL.px;
    this.projTex = new THREE.CanvasTexture(this.projCanvas);
    this.projTex.colorSpace = THREE.SRGBColorSpace;
    this.projTex.anisotropy = 8;
    this.proj = new THREE.Mesh(new THREE.PlaneGeometry(CRAWL.w, CRAWL.d),   // the story, cast on the table in the beam's blue
      new THREE.MeshBasicMaterial({ map: this.projTex, transparent: true, depthWrite: false, toneMapped: false,
        color: new THREE.Color(0.06, 0.1, 0.8), opacity: 1 }));
    this.proj.rotation.x = -Math.PI / 2;
    this.proj.position.copy(CRAWL.at);
    this.floorRig.add(this.proj);

    // the light the front lens throws on the table: a fan from the lens out over the story, brightest at the lens
    const z0 = APERTURE_P.z + 0.002, z1 = CRAWL.at.z + CRAWL.d / 2, w0 = 0.024, w1 = CRAWL.w * 1.05;
    const fan = new THREE.BufferGeometry();
    fan.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-w0 / 2, 0.00025, z0, w0 / 2, 0.00025, z0, w1 / 2, 0.00025, z1, -w1 / 2, 0.00025, z1]), 3));
    fan.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    fan.setIndex([0, 2, 1, 0, 3, 2]);
    this.projBeam = new THREE.Mesh(fan, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uAlpha: { value: 0 }, uCol: { value: HOLO_INK.clone() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: `uniform float uAlpha; uniform vec3 uCol; varying vec2 vUv;
        void main(){
          float across = 1. - pow(abs(vUv.x - .5) * 2., 2.5);          // soft sides
          float along = pow(1. - vUv.y, 1.6) * .8 + .2 * smoothstep(1., .55, vUv.y);   // bright at the lens, a wash over the story
          gl_FragColor = vec4(uCol, uAlpha * .16 * across * along);
        }`,
    }));
    this.projBeam.renderOrder = -1;
    this.projBeam.visible = false;
    this.floorRig.add(this.projBeam);

    this._buildHologram();
    this._buildMist();
    this.lensGlow = sprite(0x6f8cff, 0.038, HOLO.lens);

    // animation state
    this.keySprings = Object.fromEntries(Object.keys(this.keys).map((k) => [k, new Spring(0, 900, 0.7)]));
    this.powerSpring = new Spring(this.state.power ? POWER_SLIDE : 0, 520, 0.85);
    this.lightSpring = new Spring(this.state.power ? 1 : 0, 60, 1);
    this.projFade = new Spring(this.state.power ? 1 : 0, 80, 1);
    this.holoSpring = new Spring(this.state.power ? 1 : 0, 16, 1);
    this.glitch = 0;
    this._drawProjection();
    this._applyLights(this.lightSpring.v);
    if (this.state.power) this._onMemory(this.playlist.current);

    this._bindInput();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this);
    this._io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; });
    this._io.observe(this);
    this.visible = true;
    this._resize();
    this.clock = new THREE.Clock();
    const loop = () => { this._raf = requestAnimationFrame(loop); if (this.visible) this._tick(); };
    loop();
    this.setAttribute('data-ready', '');
    this._announce();
  }

  _resize() {
    const w = this.clientWidth || 1, h = this.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this._footprint = null;
    if (this.table) return this._frameTable(w, h);
    // keep the whole device, projection and hologram in frame at any aspect ratio
    // (the scene is taller than it is wide, so tall screens fit to its width and wide screens to its height)
    const rv = 0.135, rh = 0.125, vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = Math.max(rv / Math.sin(vfov / 2), rh / Math.sin(hfov / 2));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.maxDistance = Math.max(dist * 1.6, 0.4);
    this.camera.updateProjectionMatrix();
  }

  // The page places the device with custom properties on the element:
  //   --stage-x, --stage-y  where the device's centre sits, as fractions of the element (default .5, .55)
  //   --stage-scale         device radius as a fraction of the element's height (default .16), never wider than 42% of its width
  _frameTable(w, h) {
    const cs = getComputedStyle(this), num = (n, d) => { const v = parseFloat(cs.getPropertyValue(n)); return Number.isFinite(v) ? v : d; };
    const cam = this.sceneCfg.camera, el = THREE.MathUtils.degToRad(cam.elevation), az = THREE.MathUtils.degToRad(cam.azimuth);
    this.viewDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.camera.fov = cam.fov;
    const fx = cam.x ?? num('--stage-x', 0.5), fy = cam.y ?? num('--stage-y', 0.55), sc = cam.scale ?? num('--stage-scale', 0.16);
    const pr = Math.min(h * sc, w * 0.42), tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const dist = TABLE_RADIUS * (h / 2) / (pr * tan);
    this.camera.position.copy(TABLE_TARGET).addScaledVector(this.viewDir, dist);
    this.camera.lookAt(TABLE_TARGET);
    this.camera.setViewOffset(w, h, (0.5 - fx) * w, (0.5 - fy) * h, w, h);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this._placeLight();
  }

  // ---------------------------------------------------------------- table scene
  // Merge a partial config ({ camera: { elevation: 30 } }) and rebuild what it touches.
  setScene(patch = {}) {
    if (!this.table) return;
    for (const k of Object.keys(patch)) Object.assign(this.sceneCfg[k] ??= {}, patch[k]);
    this._applyScene();
    this.dispatchEvent(new CustomEvent('scenechange', { detail: clone(this.sceneCfg) }));
  }
  getScene() { return clone(this.sceneCfg ?? TABLE_SCENE); }
  static get defaultScene() { return clone(TABLE_SCENE); }

  _applyScene() {
    const L = this.sceneCfg.light, key = this.keyLight;
    key.intensity = L.intensity;
    key.shadow.radius = L.softness;
    if (key.shadow.mapSize.x !== L.mapSize) { key.shadow.mapSize.set(L.mapSize, L.mapSize); key.shadow.map?.dispose(); key.shadow.map = null; }
    Object.assign(key.shadow.camera, { left: -L.area, right: L.area, top: L.area, bottom: -L.area, near: 0.05, far: 2 });
    key.shadow.camera.updateProjectionMatrix();
    this.floor.material.opacity = L.opacity;
    this._applyLook();
    this._placeDevice();
    this._buildRoom();
    this._footprint = null;
    if (this.renderer) this._resize();
  }

  // Rendering and materials, live: tone mapping, the reflected studio, the plastic shell and the aluminium dial.
  _applyLook() {
    const cfg = this.sceneCfg ?? TABLE_SCENE, L = { ...TABLE_SCENE.look, ...cfg.look },
      S = { ...TABLE_SCENE.shell, ...cfg.shell }, D = { ...TABLE_SCENE.dial, ...cfg.dial }, r = this.renderer;
    if (!r) return;
    r.toneMapping = L.agx ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
    r.toneMappingExposure = L.exposure;
    this.scene.environmentIntensity = L.env;
    const envKey = L.room + '|' + L.flags;
    if (envKey !== this._envKey) {
      this._envKey = envKey;
      const old = this.scene.environment;
      this.scene.environment = studioEnvironment(r, this.table, { room: L.room, flags: L.flags });
      old?.dispose();
    }
    this.deviceRoot?.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material, n = m.name;
      if (n === 'body_warm_white' || n === 'trim_grey') {
        Object.assign(m, { metalness: S.metalness, roughness: S.roughness, specularIntensity: S.specular,
          clearcoat: S.clearcoat, clearcoatRoughness: S.coatRoughness, sheen: S.sheen });
        if (n === 'body_warm_white') m.color.set(S.color);
        if (m.aoMap) m.aoMapIntensity = S.ao;
        m.needsUpdate = true;
      }
      if (n === 'alu_beadblast') m.roughness = D.roughness;
    });
  }

  // The light stands where the camera's screen says "top left": measured from the viewer's own directions on the table.
  _placeLight() {
    const L = this.sceneCfg.light, key = this.keyLight, v = this.viewDir;
    const away = new THREE.Vector3(-v.x, 0, -v.z).normalize(), left = new THREE.Vector3(-v.z, 0, v.x).normalize();
    const az = THREE.MathUtils.degToRad(L.azimuth), el = THREE.MathUtils.degToRad(L.elevation), d = 0.6;
    const ground = away.multiplyScalar(Math.cos(az)).addScaledVector(left, Math.sin(az)).multiplyScalar(Math.cos(el) * d);
    key.position.copy(TABLE_TARGET).add(ground).add(new THREE.Vector3(0, Math.sin(el) * d, 0));
    key.target.position.copy(TABLE_TARGET);
    key.target.updateMatrixWorld();
  }

  // Unit vector toward the light, in world space (for things the page draws itself).
  get lightDir() { return this.keyLight.position.clone().sub(this.keyLight.target.position).normalize(); }

  _placeDevice() {
    const d = this.sceneCfg?.device;
    if (!d || !this.rig) return;
    this.rig.position.set(d.x, this.rig.position.y, d.z);
    this.rig.rotation.y = THREE.MathUtils.degToRad(d.rotation);
    this.rig.updateMatrixWorld(true);
    this._syncFloorRig();
    if (this.deviceRoot) this.deviceBox = new THREE.Box3().setFromObject(this.deviceRoot);
    this._footprint = null;
  }

  _syncFloorRig() {
    this.floorRig.position.set(this.rig.position.x, 0, this.rig.position.z);
    this.floorRig.rotation.y = this.rig.rotation.y;
    const up = this.rig.position.y;
    if (this.bakedShadow) { this.bakedShadow.material.opacity = 1 / (1 + up * 60); this.bakedShadow.scale.setScalar(1 + up * 4); }
  }

  // Picked up, the projector follows the hand (with a little weight); let go, it falls, lands with a thud, and settles.
  _tickRig(dt) {
    const H = this._hold, rig = this.rig, d = this.sceneCfg?.device;
    if (!d) return;
    const p0 = rig.position.clone();
    if (H?.target) {
      rig.position.lerp(H.target, 1 - Math.exp(-dt * 18));
      this.rigVel.copy(rig.position).sub(p0).divideScalar(Math.max(dt, 1e-3));
      H.hist.push([rig.position.clone(), performance.now()]); if (H.hist.length > 16) H.hist.shift();
    } else if (this._fall) {
      const v = this._fall;
      v.y -= 9.8 * dt;
      v.multiplyScalar(Math.exp(-0.4 * dt));
      rig.position.addScaledVector(v, dt);
      this._clampRig(rig.position);
      if (rig.position.y <= 0) {
        rig.position.y = 0;
        const vn = -v.y;
        if (vn > 0.25) {                                                // a heavy little object: a short, dull bounce
          this.clicker.play(Math.min(0.6, 0.15 + vn * 0.12), 260);
          this.clicker.play(Math.min(0.35, vn * 0.08), 1200);
          v.y = vn * 0.12; v.x *= 0.4; v.z *= 0.4;
        } else { v.set(0, 0, 0); this._fall = null; if (vn > 0.02) this.clicker.play(0.12, 400); }
      }
      this.rigVel.copy(rig.position).sub(p0).divideScalar(Math.max(dt, 1e-3));
      if (!this._fall) { this.rigVel.set(0, 0, 0); this.dispatchEvent(new CustomEvent('scenechange', { detail: clone(this.sceneCfg) })); }
    } else return;
    d.x = +rig.position.x.toFixed(4); d.z = +rig.position.z.toFixed(4);
    rig.updateMatrixWorld(true);
    this.deviceBox = new THREE.Box3().setFromObject(this.deviceRoot);
    this._syncFloorRig();
    this.dispatchEvent(new CustomEvent('devicemove', { detail: { x: d.x, y: rig.position.y, z: d.z }, bubbles: true }));
  }
  // It stays on the flat of the table, clear of the sweep up into the walls, and below the ceiling of reach.
  _clampRig(p) {
    if (this.sceneCfg.room.walls) {
      const b = this.localBox, margin = b ? Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2 : 0.07;
      for (let i = 0; i < 3; i++) { const s = this.roomSDF(p.x, p.z); if (s.d > -margin) { p.x += s.nx * (s.d + margin); p.z += s.nz * (s.d + margin); } }
    }
    p.y = THREE.MathUtils.clamp(p.y, 0, 0.45);
  }

  // The projector's footprint on the table, a rounded rectangle wherever it stands: signed distance (metres, negative inside)
  // and the outward normal at the table point (x, z), in world space.
  footprintSDF(x, z) {
    const b = this.localBox; if (!b) return { d: 9, nx: 0, nz: 0 };
    const p = this.rig.worldToLocal(new THREE.Vector3(x, 0, z)), rad = 0.012;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, hx = (b.max.x - b.min.x) / 2 - rad, hz = (b.max.z - b.min.z) / 2 - rad;
    const px = p.x - cx, pz = p.z - cz, qx = Math.abs(px) - hx, qz = Math.abs(pz) - hz;
    let d, nx, nz;
    if (qx > 0 && qz > 0) { const l = Math.hypot(qx, qz); d = l - rad; nx = Math.sign(px) * qx / l; nz = Math.sign(pz) * qz / l; }
    else if (qx > qz) { d = qx - rad; nx = Math.sign(px); nz = 0; } else { d = qz - rad; nx = 0; nz = Math.sign(pz); }
    const n = new THREE.Vector3(nx, 0, nz).applyQuaternion(this.rig.quaternion);
    return { d, nx: n.x, nz: n.z };
  }
  // The room's floor, inside the foot of the cove: signed distance from its edge (negative inside) and the inward normal.
  roomSDF(x, z) {
    const R = this.sceneCfg.room, rc = Math.min(R.round, R.width / 2 - R.cove, R.depth / 2 - R.cove);
    const hx = R.width / 2 - R.cove - rc, hz = R.depth / 2 - R.cove - rc, qx = Math.abs(x) - hx, qz = Math.abs(z) - hz;
    let d, nx, nz;
    if (qx > 0 && qz > 0) { const l = Math.hypot(qx, qz); d = l - rc; nx = -Math.sign(x) * qx / l; nz = -Math.sign(z) * qz / l; }
    else if (qx > qz) { d = qx - rc; nx = -Math.sign(x); nz = 0; } else { d = qz - rc; nx = 0; nz = -Math.sign(z); }
    return { d, nx, nz };
  }

  // The room: one smooth surface. Around the floor runs a rounded rectangle; from it the surface sweeps up a quarter circle
  // (the cove) and rises as a wall. Faces point into the room and are one-sided, so whatever is between the camera and the
  // scene is cut away. Drawn flat in the table's own colour, with a soft darkening in the bend and up the wall, and a twin
  // that catches shadows.
  _buildRoom() {
    const R = this.sceneCfg.room, g = this.room;
    g.children.slice().forEach((o) => { g.remove(o); o.geometry?.dispose(); o.material?.dispose(); });
    g.visible = !!R.walls;
    this.floor.scale.set(1, 1, 1);
    if (!R.walls) return;
    const page = new THREE.Color(getComputedStyle(this).getPropertyValue('--table-color').trim() || '#e8e7ee');
    const H = 1.6, cv = Math.max(0.01, R.cove), rc = Math.max(0.01, Math.min(R.round, R.width / 2 - cv, R.depth / 2 - cv));
    const hx = R.width / 2 - cv - rc, hz = R.depth / 2 - cv - rc;
    // the path: a rounded rectangle at the foot of the cove, as points with outward normals
    const path = [], seg = 14, straight = (a, b, n, k) => { for (let i = 0; i < k; i++) path.push([a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k, n[0], n[1]]); };
    const arc = (cx, cz, a0) => { for (let i = 0; i < seg; i++) { const a = a0 + i / seg * Math.PI / 2; path.push([cx + Math.cos(a) * rc, cz + Math.sin(a) * rc, Math.cos(a), Math.sin(a)]); } };
    const sx = Math.max(2, Math.round(hx * 2 / 0.1)), sz = Math.max(2, Math.round(hz * 2 / 0.1));
    straight([hx + rc, -hz], [hx + rc, hz], [1, 0], sz); arc(hx, hz, 0);
    straight([hx, hz + rc], [-hx, hz + rc], [0, 1], sx); arc(-hx, hz, Math.PI / 2);
    straight([-hx - rc, hz], [-hx - rc, -hz], [-1, 0], sz); arc(-hx, -hz, Math.PI);
    straight([-hx, -hz - rc], [hx, -hz - rc], [0, -1], sx); arc(hx, -hz, Math.PI * 1.5);
    // the profile: a quarter circle up the cove, then straight up the wall
    const prof = [];
    for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI / 2; prof.push([Math.sin(a) * cv, (1 - Math.cos(a)) * cv, a]); }
    prof.push([cv, H, Math.PI / 2]);
    const P = path.length, Q = prof.length, pos = new Float32Array(P * Q * 3), col = new Float32Array(P * Q * 3), idx = [];
    for (let i = 0; i < P; i++) for (let j = 0; j < Q; j++) {
      const [px, pz, nx, nz] = path[i], [off, y, a] = prof[j], k = (i * Q + j) * 3;
      pos[k] = px + nx * off; pos[k + 1] = y; pos[k + 2] = pz + nz * off;
      // the wall is a step darker than the table, reached smoothly through the bend and easing off toward the top (the light
      // is high up); the bend itself gets a soft extra shade
      const r0 = Math.min(1, y / (cv * 1.6)), ramp = r0 * r0 * (3 - 2 * r0), bend = Math.sin(a * 2) ** 2;
      const c = page.clone().multiplyScalar((1 - R.shade * ramp * (1 - 0.35 * Math.min(1, y / 0.8))) * (1 - R.corner * bend));
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
    for (let i = 0; i < P; i++) { const i2 = (i + 1) % P; for (let j = 0; j < Q - 1; j++) { const a = i * Q + j, b = i2 * Q + j, c = a + 1, d = b + 1; idx.push(a, b, c, b, d, c); } }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setIndex(idx);
    geo.computeVertexNormals();
    const surface = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
    const catcher = new THREE.Mesh(geo, new THREE.ShadowMaterial({ color: 0x1c1a2e, opacity: this.sceneCfg.light.opacity, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    catcher.receiveShadow = true;
    // the shadow catcher on the floor must not show past the foot of the cove, or under the bend it would double up
    this.floor.scale.set(Math.max(0.01, (R.width - 2 * cv) / 6), Math.max(0.01, (R.depth - 2 * cv) / 6), 1);
    g.add(surface, catcher);
  }

  // The visible table: where the screen's edges meet the floor, as rays from the camera. For pages that keep things in view.
  floorRay(clientX, clientY, y = 0) {
    const r = this.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1), this.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), hit) ? hit : null;
  }
  // World point -> client px (and depth in front of the camera).
  toScreen(v) {
    const r = this.getBoundingClientRect(), p = v.clone().project(this.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, z: p.z };
  }

  // The device's outline on screen (client px, convex, clockwise on screen), for pages that let things bump into it.
  footprint() {
    if (!this.renderer || !this.deviceBox) return null;
    if (this._footprint) return this._footprint;
    const b = this.deviceBox, r = 0.012, pts = [];
    const rect = this.getBoundingClientRect(), v = new THREE.Vector3();
    const corners = [[b.max.x - r, b.max.z - r, 0], [b.min.x + r, b.max.z - r, 1], [b.min.x + r, b.min.z + r, 2], [b.max.x - r, b.min.z + r, 3]];
    for (const y of [0, b.max.y]) for (const [cx, cz, q] of corners) for (let k = 0; k <= 6; k++) {
      const a = (q + k / 6) * Math.PI / 2;
      v.set(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r).project(this.camera);
      pts.push([rect.left + (v.x + 1) / 2 * rect.width, rect.top + (1 - v.y) / 2 * rect.height]);
    }
    // convex hull, monotone chain
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
    const lo = [], hi = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    return (this._footprint = lo.slice(0, -1).concat(hi.slice(0, -1)));
  }

  // ---------------------------------------------------------------- input
  _bindInput() {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const toNdc = (e) => {
      const r = this.canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
    };
    const pick = (e) => {
      toNdc(e);
      const hit = ray.intersectObjects(this.interactive, true)[0];
      if (!hit) return null;
      let o = hit.object;
      while (o && !this.interactive.includes(o)) o = o.parent;
      return o;
    };
    const keyOf = (o) => Object.keys(this.keys).find((k) => this.keys[k] === o);

    let pressed = null, move = null;
    // Table view with the `movable` attribute: the projector's body (not its controls) can be picked up a little and let drop.
    // It stays where it stands; only the scene config (the lab) places it.
    const movable = () => this.table && this.hasAttribute('movable');
    const hitsBody = (e) => { toNdc(e); return ray.intersectObject(this.deviceRoot, true).length > 0; };
    const holdHit = (e, through) => {
      toNdc(e);
      const fwd = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize(), hit = new THREE.Vector3();
      return ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, through), hit) ? hit : null;
    };
    this.rigVel = new THREE.Vector3();
    this.canvas.addEventListener('pointerdown', (e) => {
      const target = pick(e);
      if (!target) {
        if (!movable() || e.button !== 0 || !hitsBody(e)) return;
        const anchor = this.rig.position.clone(), hit = holdHit(e, anchor); if (!hit) return;
        move = { id: e.pointerId };
        this._fall = null;
        const start = anchor.clone().setY(Math.max(anchor.y, 0.012));     // it comes straight up off the table a touch, where it stood
        this._hold = { anchor, off: start.clone().sub(hit), hist: [], target: start };
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
        this.canvas.style.cursor = 'grabbing';
        this.clicker.play(0.1, 700);                                    // a soft lift off the table
        e.stopPropagation();
        return;
      }
      this.controls.enabled = false;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
      pressed = target;
      const k = keyOf(target);
      if (k) this.keySprings[k].t = KEY_TRAVEL;
      this.clicker.play(0.22, 2400);
    }, { capture: true });

    this.canvas.addEventListener('pointermove', (e) => {
      if (move) {
        // It only comes up a little, straight up where it stands: moving up raises it toward MAX_LIFT, never sideways.
        const H = this._hold, hit = holdHit(e, H.anchor); if (!hit) return;
        H.target = H.anchor.clone().setY(THREE.MathUtils.clamp(hit.y + H.off.y, 0.012, 0.04));
        return;
      }
      if (!pressed && e.pointerType === 'mouse') this.canvas.style.cursor = pick(e) ? 'pointer' : !this.table || (movable() && hitsBody(e)) ? 'grab' : '';
    });

    const end = () => {
      if (move) {
        // let go: it keeps a little of the hand's motion (it is heavy) and falls
        const H = this._hold, now = performance.now(), h = H.hist.filter(([, t]) => now - t < 110);
        const vy = h.length > 1 ? (h[h.length - 1][0].y - h[0][0].y) / Math.max(0.016, (h[h.length - 1][1] - h[0][1]) / 1000) : 0;
        this._fall = new THREE.Vector3(0, Math.max(0, vy) * 0.3, 0); this._hold = null; move = null;   // straight back down where it stood
        this.canvas.style.cursor = 'grab';
      }
      if (pressed) {
        const k = keyOf(pressed);
        if (k) this.keySprings[k].t = 0;
        this.clicker.play(0.16, 1800);
        if (k) this[k]();
        if (pressed === this.powerBtn) this.togglePower();
        pressed = null;
      }
      this.controls.enabled = !this.table;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.addEventListener('keydown', (e) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const tap = (k) => {   // the key on the device goes down and up with it
        if (!this.keySprings) return this[k]();
        this.keySprings[k].t = KEY_TRAVEL;
        this.clicker.play(0.2, 2400);
        setTimeout(() => { this.keySprings[k].t = 0; }, 110);
        this[k]();
      };
      if (key === 'ArrowRight' || key === 'ArrowUp') tap('next');
      else if (key === 'ArrowLeft' || key === 'ArrowDown') tap('back');
      else if (key === 'Enter' || key === ' ' || key === 's') tap('shuffle');
      else if (key === 'p') this.togglePower();
      else return;
      e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- public API
  next() { this.playlist.next(); this._changed(true); }
  back() { this.playlist.back(); this._changed(true); }
  shuffle() { this.playlist.shuffle(); this._changed(true); }
  show(id) { if (this.playlist.show(id)) this._changed(true); }

  // The current memory changed (or the list did, or a key was pressed): tell the hologram if it is on, and the page if
  // the memory is a different one. A press that lands on the same memory still re-shows it (it retries playback).
  _changed(pressed = false) {
    const m = this.playlist.current, id = m ? m.id : null;
    const moved = id !== this.state.id || this.playlist.index !== this.state.index;
    this.state.index = this.playlist.index;
    this.state.id = id;
    if (this.renderer && this.state.power && (moved || pressed)) this._onMemory(m);
    if (!moved && this._announced) return;
    this._announced = true;
    this._announce();
    this.dispatchEvent(new CustomEvent('memorychange', {
      detail: { id, index: this.state.index, title: m?.title || '', story: m?.story || '' }, bubbles: true, composed: true }));
  }

  // Screen position (client px) of a part, for pages that point at it: power, back, shuffle, next, light, lens, hologram.
  anchor(name) {
    if (!this.renderer) return null;
    const v = new THREE.Vector3(), obj = { power: this.powerBtn, ...this.keys }[name];
    if (obj) {   // the top of the part, where a finger lands
      const b = new THREE.Box3().setFromObject(obj, true);
      b.getCenter(v); v.y = b.max.y;
    } else if (name === 'light') this.rig.localToWorld(v.copy(MEMORY_LED_P));
    else if (name === 'lens') this.rig.localToWorld(v.copy(HOLO.lens));
    else if (name === 'hologram') this.rig.localToWorld(v.copy(HOLO.lens).add(new THREE.Vector3(0, HOLO.gap + HOLO.h / 2, 0)));
    else return null;
    v.project(this.camera);
    const r = this.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }

  // True when the point (client px) is on the hologram (its frame above the lens), while it is on.
  hologramHit(x, y) {
    if (!this.holo || this.holoSpring.v < 0.6) return false;
    const r = this.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1), this.camera);
    return ray.intersectObject(this.holo.frame).length > 0;
  }

  togglePower() { this._setPower(!this.state.power); }

  _setPower(on) {
    if (on === this.state.power) return;
    this.state.power = on;
    this.lightSpring.t = on ? 1 : 0;
    this.powerSpring.t = on ? POWER_SLIDE : 0;
    this.projFade.t = on ? 1 : 0;
    this.holoSpring.t = on ? 1 : 0;
    if (on) { this._crawlNext = this.playlist.current?.story || ''; this._onMemory(this.playlist.current); }
    else { this.depth?.show(null); this.state.developing = false; }    // off: the memory drains back into the lens
    this.dispatchEvent(new CustomEvent('powerchange', { detail: { on }, bubbles: true, composed: true }));
    this._announce();
  }

  // ---------------------------------------------------------------- projection on the table
  _drawProjection() {
    const c = this.projCanvas, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    this.projTex.needsUpdate = true;
  }

  // Lay out a story for the crawl (or nothing). Called when the memory changes; the crawl restarts.
  _setCrawl(story) {
    const g = this.projCanvas.getContext('2d'), font = this._crawlFont();
    g.font = font;
    const lines = wrapLines(story || '', (t) => g.measureText(t).width, CRAWL.px[0] - CRAWL.margin * 2);
    const words = String(story || '').split(/\s+/).filter(Boolean).length;
    this._crawl = { lines, words, font, t0: performance.now() / 1000 };
    this._drawCrawl(this._crawl.t0);
  }

  _crawlFont() {
    const family = getComputedStyle(this).fontFamily || '"Helvetica Neue", Helvetica, Arial, sans-serif';
    return `400 ${CRAWL.font}px ${family}`;
  }

  // Draw the crawl at time `now` (s). Moving text, faded at the near and far edges; still under reduced motion.
  _drawCrawl(now) {
    const c = this.projCanvas, g = c.getContext('2d'), cr = this._crawl, [W, H] = CRAWL.px;
    g.clearRect(0, 0, W, H);
    if (cr && cr.lines.length) {
      const lh = CRAWL.font * CRAWL.lineHeight;
      const st = reduceMotion ? { offset: -lh * 0.5, alpha: 1 }
        : crawlState(now - cr.t0, { lineCount: cr.lines.length, lineHeight: lh, viewHeight: H, words: cr.words,
          wordsPerSecond: CRAWL.wordsPerSecond, pause: CRAWL.pause });
      if (st.alpha > 0) {
        g.save();
        g.font = cr.font;
        g.fillStyle = '#fff';
        g.textAlign = 'left';
        g.textBaseline = 'top';
        const top = -st.offset;                 // the text's first line, from the canvas top (the far edge, by the lens)
        cr.lines.forEach((l, i) => {
          const y = top + i * lh;
          if (y > -lh && y < H) g.fillText(l, CRAWL.margin, y);
        });
        // fade in at the near edge, out at the far edge
        g.globalCompositeOperation = 'destination-in';
        const f = g.createLinearGradient(0, 0, 0, H);
        f.addColorStop(0, 'rgba(0,0,0,0)'); f.addColorStop(CRAWL.fade, 'rgba(0,0,0,1)');
        f.addColorStop(1 - CRAWL.fade, 'rgba(0,0,0,1)'); f.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = f;
        g.fillRect(0, 0, W, H);
        g.restore();
      }
    }
    this.projTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- fog
  // The image needs a medium: a faint fog breathes out of the perforation ring around the lens,
  // drifts inward and up through the beam, and thins out above the picture.
  _buildMist() {
    const N = 320, pos = new Float32Array(N * 3), col = new Float32Array(N * 4);
    this.mistP = Array.from({ length: N }, () => this._spawnMist({}, Math.random()));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));   // rgba: per-particle alpha
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d'), grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = grd;
    x.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.mist = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.011, map: tex, vertexColors: true,
      transparent: true, depthWrite: false, sizeAttenuation: true }));
    this.mist.position.copy(HOLO.lens);
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 2;
    this.rig.add(this.mist);
  }

  _spawnMist(p, age = 0) {
    const a = Math.random() * Math.PI * 2, r = 0.0206 + Math.random() * 0.0015;   // the fog perforations around the 18 mm lens
    p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.y = 0.0005;
    p.life = 3.2 + Math.random() * 2.4;
    p.t = age * p.life;
    p.vy = 0.010 + Math.random() * 0.010;
    p.swirl = (Math.random() - 0.5) * 0.6;
    if (age) { const k = p.t; p.y += p.vy * k; p.x *= Math.max(0.15, 1 - k * 0.22); p.z *= Math.max(0.15, 1 - k * 0.22); }
    return p;
  }

  _tickMist(dt) {
    if (!this.mist) return;
    const k = THREE.MathUtils.clamp(this.holoSpring.v, 0, 1);
    this.mist.visible = k > 0.01;
    if (!this.mist.visible) return;
    const pos = this.mist.geometry.attributes.position.array, col = this.mist.geometry.attributes.color.array;
    const top = HOLO.top + 0.01, step = reduceMotion ? 0 : dt;
    this.mistP.forEach((p, i) => {
      p.t += step;
      if (p.t > p.life) this._spawnMist(p);
      const r = Math.hypot(p.x, p.z), pull = 0.22 * step * (r > 0.004 ? 1 : 0);   // drawn in toward the beam
      const ca = Math.cos(p.swirl * step), sa = Math.sin(p.swirl * step);
      const nx = p.x * ca - p.z * sa, nz = p.x * sa + p.z * ca;
      p.x = nx * (1 - pull); p.z = nz * (1 - pull);
      p.y += p.vy * step;
      const u = p.t / p.life, h = p.y / top;
      const a = Math.sin(Math.PI * Math.min(1, u)) * (1 - THREE.MathUtils.smoothstep(h, 0.6, 1)) * 0.10 * k;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 4] = 0.93; col[i * 4 + 1] = 0.95; col[i * 4 + 2] = 1; col[i * 4 + 3] = a;
    });
    this.mist.geometry.attributes.position.needsUpdate = true;
    this.mist.geometry.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------- hologram
  // The beam rises from the top lens: a cone of light with motes in it. The memory itself floats inside it.
  _buildHologram() {
    const group = new THREE.Group();
    group.position.copy(HOLO.lens);
    this.rig.add(group);
    const blend = { transparent: true, depthWrite: false, blending: THREE.NormalBlending };
    const U = (v) => ({ value: v });

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(HOLO.r1, HOLO.r0, HOLO.top, 64, 1, true).translate(0, HOLO.top / 2, 0),
      new THREE.ShaderMaterial({ ...blend, side: THREE.BackSide, vertexShader: HOLO_BEAM_VS, fragmentShader: HOLO_BEAM_FS,   // the far wall only: half the fill
        uniforms: { uGrow: U(0), uTime: U(0), uAlpha: U(0), uPulse: U(0), uCol: U(HOLO_INK.clone()) } }));
    beam.renderOrder = 2;
    group.add(beam);

    const N = 1400, seeds = new Float32Array(N * 3);   // the stream of light rising out of the lens
    for (let i = 0; i < N; i++) seeds.set([Math.random() * Math.PI * 2, Math.sqrt(Math.random()) * 0.9, Math.random()], i * 3);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    const motes = new THREE.Points(mg, new THREE.ShaderMaterial({ ...blend, vertexShader: HOLO_MOTES_VS, fragmentShader: HOLO_MOTES_FS,
      uniforms: { uTime: U(0), uGrow: U(0), uH: U(HOLO.top), uR0: U(HOLO.r0), uR1: U(HOLO.r1), uSize: U(3), uAlpha: U(0),
        uCol: U(HOLO_INK.clone()) } }));
    motes.frustumCulled = false;
    motes.renderOrder = 4;
    group.add(motes);

    // an invisible card where the memory stands, facing the camera: what hologramHit() and anchor('hologram') aim at
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(HOLO.w, HOLO.h), new THREE.MeshBasicMaterial({ visible: false }));
    frame.position.y = HOLO.gap + HOLO.h / 2;
    group.add(frame);

    // the memory itself
    const depth = this.depth = new DepthHologram({ frame: HOLO, ink: HOLO_INK, reduceMotion });
    group.add(depth.object3d);

    this.holo = { group, beam, motes, frame };
  }

  // The hologram shows this memory (null: nothing). `first`: its first showing here, so it develops slowly.
  // The first showing of a memory in this browser develops: it rises slowly out of the lens while the memory light
  // pulses, and once it stands it counts as seen.
  _onMemory(memory) {
    if (memory !== this._memory || !this._crawl) this._crawlNext = memory?.story || '';   // dissolve to the new story
    this._memory = memory;
    const url = memory?.url || null, first = !!url && !this.seen.has(memory.id);
    this.state.developing = first;
    const done = this.depth?.show(url, { developing: first });
    if (url && done) done.then(() => {
      const d = this.depth;
      if (this._memory !== memory || d.shown?.url !== url) return;                 // superseded
      if (d.failed === url) {                                                       // its video won't load: beam and mist only
        this.state.developing = false;
        this._crawlNext = '';
        return;
      }
      if (!first || !d.settled) return;
      this.seen.mark(memory.id);
      this.state.developing = false;
    });
  }

  _tickHologram(dt, now) {
    const h = this.holo, bu = h.beam.material.uniforms, mu = h.motes.material.uniforms;
    this.holoSpring.step(dt);
    const k = THREE.MathUtils.clamp(this.holoSpring.v, 0, 1);
    const grow = THREE.MathUtils.clamp(k * 1.7, 0, 1);
    const t = reduceMotion ? 0 : now / 1000;
    if (this.table) h.frame.quaternion.copy(this.rig.quaternion).invert().multiply(this.camera.quaternion);   // a fixed view: face the camera squarely
    else { const cam = this.camera.position; h.frame.rotation.y = Math.atan2(cam.x - HOLO.lens.x, cam.z - HOLO.lens.z); }
    if (!reduceMotion && this.state.power && Math.random() < dt * 0.25) this.glitch = Math.max(this.glitch, 0.3);   // the odd stray flicker
    this.glitch = Math.max(0, this.glitch - dt * 2.6);
    const flicker = reduceMotion ? 1 : 1 - 0.05 * Math.random() * (this.state.power ? 1 : 0);
    bu.uGrow.value = grow;
    bu.uTime.value = t;
    bu.uAlpha.value = Math.min(1, k * 3) * flicker * 0.8;
    bu.uPulse.value = 0;
    mu.uTime.value = t;
    mu.uGrow.value = grow;
    mu.uAlpha.value = Math.min(1, k * 2);
    mu.uSize.value = 2.2 * this.renderer.getPixelRatio();
    h.group.visible = k > 0.001;
    this.lensGlow.material.opacity = 0.85 * grow;

    // the memory: it turns to you around its vertical axis and leans a little toward your eye
    const pts = this.depth.object3d;
    const eye = h.group.worldToLocal((this._eyeV ??= new THREE.Vector3()).copy(this.camera.position));
    pts.rotation.y = Math.atan2(eye.x, eye.z);
    pts.rotation.x = -Math.atan2(eye.y - (HOLO.gap + HOLO.h / 2), Math.hypot(eye.x, eye.z)) * 0.2;
    const top = this.rig.localToWorld((this._topV ??= new THREE.Vector3()).copy(HOLO.lens).setY(HOLO.lens.y + HOLO.top)).project(this.camera);
    const bottom = this.rig.localToWorld((this._botV ??= new THREE.Vector3()).copy(HOLO.lens).setY(HOLO.lens.y + HOLO.gap)).project(this.camera);
    const imgPx = Math.abs(top.y - bottom.y) / 2 * this.clientHeight;
    const dist = this.camera.position.distanceTo(pts.getWorldPosition(this._ptsV ??= new THREE.Vector3()));
    this.depth.update(dt, t, { power: Math.min(1, k * 2.5), glitch: this.glitch, flicker,
      size: THREE.MathUtils.clamp(imgPx / 110, 1, 3.2) * this.renderer.getPixelRatio() * dist });
  }

  _announce() {
    const m = this.playlist.current;
    this.live.textContent = !this.state.power ? 'Powered off'
      : m ? [m.title, m.story].filter(Boolean).join('. ') : 'No memories';
  }

  // ---------------------------------------------------------------- frame
  _applyLights(k) {
    this.M.led_green.emissiveIntensity = 6 * k;
    this.M.projector_core.emissiveIntensity = 1.2 * k;
    this.M.front_core.emissiveIntensity = 2.4 * k;
    this.M.power_on.emissiveIntensity = 3 * k;
    this.ledGlow.material.opacity = 0.5 * k;
    // the memory light pulses softly while a memory develops, then dims
    const want = this.state.developing && this.state.power ? 0.75 + 0.15 * Math.sin(performance.now() / 1000 * 4) : 0;
    this._memoryK = (this._memoryK ?? 0) + (want - (this._memoryK ?? 0)) * Math.min(1, (this._dtLight ?? 0.016) * 6);
    this.M.memory_led.emissiveIntensity = 4 * this._memoryK;
    this.memoryGlow.material.opacity = this._memoryK;
    this.frontGlow.material.opacity = 0.45 * k;
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.25);
    for (const [k, sp] of Object.entries(this.keySprings)) { sp.step(dt); this.keys[k].position.y = this.keyRest[k] + sp.v; }
    this.powerSpring.step(dt);
    this.powerBtn.position.x = this.powerX + this.powerSpring.v;
    this.lightSpring.step(dt);
    this.projFade.step(dt);
    this._dtLight = dt;
    this._applyLights(this.lightSpring.v);
    const flicker = this.state.power ? 1 - 0.025 * Math.random() : 1;
    // the crawl: a new story dissolves in (the old one fades out first), then it keeps moving
    const now = performance.now() / 1000;
    if (this._crawlNext !== undefined) {
      this._crawlFade = Math.max(0, (this._crawlFade ?? 1) - dt / 0.35);
      if (this._crawlFade === 0 || !this._crawl) { this._setCrawl(this._crawlNext); this._crawlNext = undefined; }
    } else this._crawlFade = Math.min(1, (this._crawlFade ?? 1) + dt / 0.35);
    if (this.state.power && this._crawl?.lines.length && !reduceMotion) this._drawCrawl(now);
    this.proj.material.opacity = 0.62 * this.projFade.v * flicker * (this._crawlFade ?? 1);
    this.projBeam.material.uniforms.uAlpha.value = this.projFade.v * flicker;
    this.projBeam.visible = this.projFade.v > 0.005;
    if (!this.table) this.controls.update();
    this._tickHologram(dt, performance.now());
    this._tickMist(dt);
    if (this.table) this._tickRig(dt);
    for (const f of this.tickers) { try { f(dt); } catch (e) { console.error(e); } }
    this.renderer.render(this.scene, this.camera);
  }
}

if (!customElements.get('memory-projector')) customElements.define('memory-projector', MemoryProjector);
export { MemoryProjector };
