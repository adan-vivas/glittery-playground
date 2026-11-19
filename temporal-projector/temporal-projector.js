// <temporal-projector> — interactive three.js web component.
//
//   <script type="importmap">{ "imports": {
//     "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
//     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }</script>
//   <script type="module" src="temporal-projector.js"></script>
//   <temporal-projector date="2026"></temporal-projector>
//
// Attributes: date (1996|2006|2016|2026|FUTURE), power (on|off), zoom (boolean), muted (boolean),
//             src (GLB url), shadow (shadow PNG url), table (fixed desk view; place it with --stage-x/-y/-scale)
// Events:     "datechange"  detail { date, projected, label, future }
//             "powerchange" detail { on }
// Methods:    setDate(label), randomFuture(), togglePower(),
//             setContent({ dates, futures }) — pictures for the hologram (see the method),
//             anchor(part) — client px of power|key|dial|lens|hologram, hologramHit(x, y), footprint()

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DATES = [
  { label: '1996', angle: 210 },
  { label: '2006', angle: 150 },
  { label: '2016', angle: 90 },
  { label: '2026', angle: 30 },
  { label: 'FUTURE', angle: -30 },
];
const BAKED_POINTER = 30;           // pointer angle baked into the dial geometry
const MIN_A = -30, MAX_A = 210;
const TOP_Y = 0.026;                // top surface height (m)
const DIAL_C = new THREE.Vector3(0.025, TOP_Y + 0.0075, -0.0075);
const LED_P = new THREE.Vector3(0.010, TOP_Y + 0.0003, -0.0265);
const FRONT_LENS_P = new THREE.Vector3(0.031, 0.011, 0.0362);
const PROJ_P = new THREE.Vector3(0.030, 0.0002, 0.065);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// The hologram rises from the top lens: a cone of light, and a dithered image floating inside it.
const HOLO = {
  lens: new THREE.Vector3(-0.026, TOP_Y + 0.0006, -0.002),
  r0: 0.0075,          // beam radius at the lens
  r1: 0.036,           // beam radius at the top of the image
  gap: 0.016,          // lens to the bottom of the image
  w: 0.056, h: 0.074,  // image plane
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
const TABLE_SCENE = {
  camera: { elevation: 32, azimuth: 39, fov: 55, x: null, y: null, scale: 0.16 },
  light: { azimuth: 56, elevation: 43, intensity: 1.35, softness: 16, opacity: 0.22, area: 0.45, mapSize: 1024 },
  device: { x: 0, z: 0, rotation: 0 },
  room: { walls: true, width: 2.4, depth: 2, shade: 0, corner: 0.05, cove: 0.3, round: 0.35 },
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
const HOLO_SIGNAL = new THREE.Vector3(1.0, 0.23, 0.055);   // FUTURE orange

const GLSL_NOISE = `
  float B2(vec2 a){ a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
  float B4(vec2 a){ return B2(.5 * a) * .25 + B2(a); }
  float B8(vec2 a){ return B4(.5 * a) * .25 + B2(a); }
  float hash(vec2 p){ p = fract(p * vec2(.1031, .1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y); }`;

const HOLO_IMAGE_VS = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;

// Ordered dither in screen space, like the homepage portrait: every cell samples the image at its own centre,
// so the dots stay crisp at any size. Two slots cross-dissolve cell by cell when the date changes.
const HOLO_IMAGE_FS = `
  uniform sampler2D uTexA, uTexB, uMaskA, uMaskB;
  uniform vec4 uRectA, uRectB;
  uniform vec3 uSheetA, uSheetB, uFlagA, uFlagB;   // sheet: cols, rows, frame. flag: invert, mask, future
  uniform vec3 uLevelsA, uLevelsB;                 // black point, white point, gamma on the ink
  uniform float uMix, uReveal, uTime, uScan, uCell, uGlitch, uAlpha;
  uniform vec3 uInk, uSignal;
  varying vec2 vUv;
  ${GLSL_NOISE}
  float tone(sampler2D tex, sampler2D mask, vec4 rect, vec3 sheet, vec3 fl, vec3 lv, vec2 uv){
    vec2 st = clamp(rect.xy + vec2(uv.x, 1. - uv.y) * rect.zw, .002, .998), sv = st;
    if (sheet.x > 1.5) { float f = floor(sheet.z); sv = (vec2(mod(f, sheet.x), floor(f / sheet.x)) + st) / sheet.xy; }
    float l = clamp((texture2D(tex, sv).r - lv.x) / max(lv.y - lv.x, .01), 0., 1.);
    float t = pow(fl.x > .5 ? 1. - l : l, lv.z);
    if (fl.y > .5) t *= smoothstep(.3, .7, texture2D(mask, st).g);
    return t;
  }
  void main(){
    vec2 fc = gl_FragCoord.xy, id = floor(fc / uCell), cc = (id + .5) * uCell;
    vec2 uv = vUv + dFdx(vUv) * (cc.x - fc.x) + dFdy(vUv) * (cc.y - fc.y);
    float band = floor(uv.y * 30.), tg = floor(uTime * 16.);
    uv.x += (hash(vec2(band, tg)) - .5) * .14 * uGlitch * step(.7, hash(vec2(band * 1.7, tg + 3.)));
    if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) discard;
    float edge = (1. - smoothstep(.74, 1., length((uv - .5) * vec2(2., 1.86)))) * smoothstep(0., .2, uv.y);
    float rv = uReveal * 1.12 - .06;
    float below = smoothstep(rv + .015, rv - .03, uv.y);
    bool useB = hash(id) * .45 + vnoise(id / 14.) * .55 < uMix * 1.1 - .05;
    float t = useB ? tone(uTexB, uMaskB, uRectB, uSheetB, uFlagB, uLevelsB, uv) : tone(uTexA, uMaskA, uRectA, uSheetA, uFlagA, uLevelsA, uv);
    float fut = useB ? uFlagB.z : uFlagA.z;
    t *= edge * below;
    float on = step(B8(id) * .94 + .04, t);
    float d = 1. - smoothstep(.36, .5, length(fc - cc) / uCell);
    float scan = uScan * (.5 + .5 * sin(uv.y * 190. - uTime * 7.));   // 0 = no scanline dimming
    float screen = edge * below * .055;
    float front = (1. - smoothstep(0., .018, abs(uv.y - rv))) * step(.002, uReveal) * step(uReveal, .998) * edge;
    float a = max(on * d * (.95 - .25 * scan), screen * (1. - .5 * scan)) + front * .7;
    gl_FragColor = vec4(mix(uInk, uSignal, fut), clamp(a, 0., 1.) * uAlpha);
  }`;

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

// Levels for an image, so a dark photo doesn't dither into a solid block: stretch the 2nd to 98th percentile,
// then thin the ink until it covers about a third of the picture. Never thickens: gamma stays at 1 or above.
function autoLevels(img, maskImg, invert) {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data;
  let mk = null;
  if (maskImg) { g.clearRect(0, 0, S, S); g.drawImage(maskImg, 0, 0, S, S); mk = g.getImageData(0, 0, S, S).data; }
  const lum = [];
  for (let i = 0; i < px.length; i += 4) if (!mk || mk[i + 1] > 128) lum.push(px[i] / 255);
  if (!lum.length) return new THREE.Vector3(0, 1, 1);
  lum.sort((a, b) => a - b);
  const lo = lum[Math.floor(lum.length * 0.02)], hi = Math.max(lum[Math.floor(lum.length * 0.98)], lo + 0.1);
  let ink = 0;
  for (const l of lum) { const n = THREE.MathUtils.clamp((l - lo) / (hi - lo), 0, 1); ink += invert ? 1 - n : n; }
  ink /= lum.length;
  const gamma = THREE.MathUtils.clamp(Math.log(0.34) / Math.log(Math.max(ink, 0.01)), 1, 3.5);
  return new THREE.Vector3(lo, hi, gamma);
}

// Cover-fit one frame of an image into the hologram's aspect, keeping `focus` (image space, 0..1 from the top left) in view.
function coverRect(iw, ih, focus = [0.5, 0.42]) {
  const A = HOLO.w / HOLO.h, a = iw / ih;
  if (a > A) { const w = A / a; return new THREE.Vector4(THREE.MathUtils.clamp(focus[0] - w / 2, 0, 1 - w), 0, w, 1); }
  const h = a / A; return new THREE.Vector4(0, THREE.MathUtils.clamp(focus[1] - h / 2, 0, 1 - h), 1, h);
}

// ------------------------------------------------------------------ materials
function makeMaterials() {
  const P = (o) => new THREE.MeshPhysicalMaterial(o);
  return {
    alu_beadblast: P({ color: 0xd6d7d9, metalness: 1, roughness: 0.36 }),
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
    coated_glass: P({ color: 0xffffff, metalness: 0, roughness: 0, transmission: 1,
      thickness: 0.002, ior: 1.52, iridescence: 1, iridescenceIOR: 1.38,
      iridescenceThicknessRange: [260, 420], specularIntensity: 1 }),
    led_green: new THREE.MeshStandardMaterial({ color: 0x0a2a0e, emissive: 0x3dff6a, emissiveIntensity: 6 }),
    projector_core: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x5d8cff, emissiveIntensity: 3 }),
    front_core: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc98a, emissiveIntensity: 5 }),
  };
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

function studioEnvironment(renderer, table = false) {
  const env = new THREE.Scene();
  const basic = (c, side = THREE.FrontSide, map = null) => new THREE.MeshBasicMaterial({ color: c, side, map });
  // dim room, gradient from darker ceiling to the lit table plane
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), basic(new THREE.Color(0.06, 0.06, 0.065), THREE.BackSide)));
  const floor = new THREE.Mesh(new THREE.CircleGeometry(19, 64), basic(new THREE.Color(0.30, 0.30, 0.30)));
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
  .caption { position: absolute; left: 0; top: 0; pointer-events: none; text-align: center; white-space: nowrap;
             font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1.25; color: rgb(28, 46, 255); opacity: 0;
             translate: -50% -100%; will-change: transform, opacity; }
  .caption b { display: block; font-weight: 600; font-size: 15px; letter-spacing: .04em; font-variant-numeric: tabular-nums; }
  .caption span { display: block; max-width: 28ch; white-space: normal; text-wrap: balance; opacity: .8; }
  .caption.future { color: rgb(255, 58, 14); }
</style>
<canvas part="canvas"></canvas>
<div class="caption" part="caption" aria-hidden="true"><b></b><span></span></div>
<div class="status">Loading</div>
<div class="sr" aria-live="polite"></div>`;

class TemporalProjector extends HTMLElement {
  static observedAttributes = ['date', 'power', 'zoom', 'muted'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    this.canvas = this.shadowRoot.querySelector('canvas');
    this.live = this.shadowRoot.querySelector('.sr');
    this.caption = this.shadowRoot.querySelector('.caption');
    this.clicker = new Clicker();
    this.state = { power: true, index: 3, projected: '2026', label: '' };
    this._content = { dates: {}, futures: [] };
    this.futureIndex = null;
  }

  // What the hologram shows. Without content it projects the dithered year.
  //   setContent({
  //     dates:   { '2026': { image, mask, focus: [x, y], label }, '1996': { image, sheet: [cols, rows], fps, label } },
  //     futures: [{ year: '2036', label, image, focus }],   // the orange key picks one of these
  //   })
  // image and mask are URLs (data: URLs work). Returns a promise that settles once every image has loaded.
  setContent({ dates = {}, futures = [] } = {}) {
    const loader = new THREE.TextureLoader();
    const tex = (url) => loader.loadAsync(url).then((t) => {
      t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false;
      t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
    });
    const prep = async (e) => {
      const [t, m] = await Promise.all([tex(e.image), e.mask ? tex(e.mask) : null]);
      const [cols, rows] = e.sheet || [1, 1];
      Object.assign(e, { tex: t, maskTex: m, rect: coverRect(t.image.width / cols, t.image.height / rows, e.focus),
        cols, rows, levels: autoLevels(t.image, m?.image, e.invert !== false), ready: true });
      this._holoRefresh();
    };
    this._content = {
      dates: Object.fromEntries(Object.entries(dates).map(([k, v]) => [k.toUpperCase(), { ...v }])),
      futures: futures.map((f) => ({ ...f, year: String(f.year) })),
    };
    const all = [...Object.values(this._content.dates), ...this._content.futures].filter((e) => e.image);
    if (this.state.index === 4 && this._content.futures.length && this.futureIndex == null) this._pickFuture();
    this._holoRefresh();
    return Promise.allSettled(all.map(prep));
  }

  connectedCallback() {
    if (this._started) return;
    this._started = true;
    this.tabIndex = 0;
    this.setAttribute('role', 'application');
    this.setAttribute('aria-label',
      'Temporal projector. Arrow keys turn the date dial, Enter presses Plausible Random Futures, P toggles power. Drag to orbit.');
    this.clicker.muted = this.hasAttribute('muted');
    const initial = DATES.findIndex((d) => d.label === (this.getAttribute('date') || '').toUpperCase());
    if (initial >= 0) this.state.index = initial;
    if (this.getAttribute('power') === 'off') this.state.power = false;
    this._init().catch((e) => {
      console.error(e);
      this.shadowRoot.querySelector('.status').textContent = 'Could not load model';
    });
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this._io?.disconnect();
    this.renderer?.dispose();
    this._started = false;
  }

  attributeChangedCallback(name, _old, val) {
    if (!this.renderer) return;
    if (name === 'date') this.setDate(val);
    if (name === 'power') this._setPower(val !== 'off');
    if (name === 'zoom' && !this.table) this.controls.enableZoom = val !== null;
    if (name === 'muted') this.clicker.muted = val !== null;
  }

  // ---------------------------------------------------------------- setup
  async _init() {
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);

    const scene = this.scene = new THREE.Scene();
    this.table = this.hasAttribute('table');
    scene.environment = studioEnvironment(renderer, this.table);
    scene.environmentIntensity = 1.0;

    // Table view (the `table` attribute): a fixed camera looking down at the desk the device stands on,
    // lit from the top left of the screen, with real shadows falling on a transparent floor, so the page colour is the table.
    if (this.table) renderer.shadowMap.type = THREE.PCFShadowMap;   // honours shadow.radius: a softer, wider shadow

    const camera = this.camera = new THREE.PerspectiveCamera(22, 1, 0.01, 5);
    const controls = this.controls = new OrbitControls(camera, this.canvas);
    controls.enabled = !this.table;
    // framed for the device, the table projection and the hologram above the lens
    controls.target.set(-0.004, 0.056, 0.006);
    camera.position.set(-0.215, 0.255, 0.40);
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
    scene.add(this.rig);
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
    const src = this.getAttribute('src') || new URL('zeitlinse.glb', base).href;
    const shadowSrc = this.getAttribute('shadow') || new URL('shadow.png', base).href;
    const [gltf, shadowTex] = await Promise.all([
      new GLTFLoader().loadAsync(src),
      new THREE.TextureLoader().loadAsync(shadowSrc),
    ]);

    // baked Cycles contact shadow
    shadowTex.colorSpace = THREE.SRGBColorSpace;
    shadowTex.anisotropy = 4;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = -1;
    this.rig.add(shadow);

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
    this.rig.add(device);
    this.deviceRoot = device;
    this.localBox = new THREE.Box3().setFromObject(device);   // before placement: the projector's own extents
    this._placeDevice();
    this.dial = device.getObjectByName('dial');
    this.key = device.getObjectByName('prf_key');
    this.powerBtn = device.getObjectByName('power_button');
    this.interactive = [this.dial, this.key, this.powerBtn];
    this.keyY = this.key.position.y;
    this.powerY = this.powerBtn.position.y;

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
    this.ledGlow = sprite(0x3dff6a, 0.0042, LED_P);
    this.frontGlow = sprite(0xffc98a, 0.011, FRONT_LENS_P);

    // projected date on the surface
    this.projCanvas = document.createElement('canvas');
    this.projCanvas.width = 1024;
    this.projCanvas.height = 384;
    this.projTex = new THREE.CanvasTexture(this.projCanvas);
    this.projTex.colorSpace = THREE.SRGBColorSpace;
    this.projTex.anisotropy = 8;
    this.proj = new THREE.Mesh(new THREE.PlaneGeometry(0.056, 0.021),
      new THREE.MeshBasicMaterial({ map: this.projTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, color: new THREE.Color(1.0, 0.86, 0.68), opacity: 0.6 }));
    this.proj.rotation.x = -Math.PI / 2;
    this.proj.position.copy(PROJ_P);
    this.rig.add(this.proj);

    this._buildHologram(scene);
    this.lensGlow = sprite(0x6f8cff, 0.03, HOLO.lens);

    // animation state
    this.dialSpring = new Spring(DATES[this.state.index].angle, 240, 0.55);
    this.keySpring = new Spring(0, 900, 0.7);
    this.powerSpring = new Spring(0, 900, 0.7);
    this.lightSpring = new Spring(this.state.power ? 1 : 0, 60, 1);
    this.projFade = new Spring(this.state.power ? 1 : 0, 80, 1);
    this.holoSpring = new Spring(this.state.power ? 1 : 0, 16, 1);
    this.glitch = 0;
    this.lastDetent = this.state.index;
    this._applyDial(this.dialSpring.v);
    this.state.projected = this._labelFor(this.state.index);
    this.state.label = this._entry()?.label || '';
    this._drawProjection(this.state.projected);
    this._holoRefresh();
    this._applyLights(this.lightSpring.v);

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
    const rv = 0.1, rh = 0.076, vfov = THREE.MathUtils.degToRad(this.camera.fov);
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
    this._placeDevice();
    this._buildRoom();
    this._footprint = null;
    if (this.renderer) this._resize();
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
    this.rig.position.set(d.x, 0, d.z);
    this.rig.rotation.y = THREE.MathUtils.degToRad(d.rotation);
    this.rig.updateMatrixWorld(true);
    if (this.deviceRoot) this.deviceBox = new THREE.Box3().setFromObject(this.deviceRoot);
    this._footprint = null;
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
      const up = Math.min(1, y / (cv + 0.4)), bend = Math.sin(a * 2) ** 2;    // up the wall; strongest mid-bend, zero on floor and wall
      const c = page.clone().multiplyScalar((1 - R.shade * up * up) * (1 - R.corner * bend));
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
    const dialPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DIAL_C.y);
    const hitPoint = new THREE.Vector3();
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
    const pointerAngle = () => {
      if (!ray.ray.intersectPlane(dialPlane, hitPoint)) return null;
      this.rig.worldToLocal(hitPoint);
      return THREE.MathUtils.radToDeg(Math.atan2(-(hitPoint.z - DIAL_C.z), hitPoint.x - DIAL_C.x));
    };

    let drag = null, pressed = null, move = null;
    // Table view with the `movable` attribute: the projector's body (not its controls) can be picked up and slid across the table.
    const movable = () => this.table && this.hasAttribute('movable');
    const hitsBody = (e) => { toNdc(e); return ray.intersectObject(this.deviceRoot, true).length > 0; };
    this.rigVel = new THREE.Vector3();
    this.canvas.addEventListener('pointerdown', (e) => {
      const target = pick(e);
      if (!target) {
        if (!movable() || e.button !== 0 || !hitsBody(e)) return;
        const hit = this.floorRay(e.clientX, e.clientY); if (!hit) return;
        const d = this.sceneCfg.device;
        move = { id: e.pointerId, dx: d.x - hit.x, dz: d.z - hit.z, t: performance.now() };
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = 'grabbing';
        this.clicker.play(0.1, 700);                                    // a soft lift off the table
        e.stopPropagation();
        return;
      }
      this.controls.enabled = false;
      this.canvas.setPointerCapture(e.pointerId);
      if (target === this.dial) {
        drag = { a0: pointerAngle(), start: this.dialSpring.v, acc: 0, prev: null, x: e.clientX, y: e.clientY, moved: false };
        drag.prev = drag.a0;
      } else {
        pressed = target;
        if (target === this.key) this.keySpring.t = -0.0011;
        if (target === this.powerBtn) this.powerSpring.t = -0.0008;
        this.clicker.play(0.22, 2400);
      }
    }, { capture: true });

    this.canvas.addEventListener('pointermove', (e) => {
      if (move) {
        const hit = this.floorRay(e.clientX, e.clientY); if (!hit) return;
        const d = this.sceneCfg.device, x0 = d.x, z0 = d.z;
        let x = hit.x + move.dx, z = hit.z + move.dz;
        if (this.sceneCfg.room.walls) {                                 // it stays on the flat of the table, clear of the sweep
          const b = this.localBox, margin = b ? Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2 : 0.07;
          for (let i = 0; i < 3; i++) { const s = this.roomSDF(x, z); if (s.d > -margin) { x += s.nx * (s.d + margin); z += s.nz * (s.d + margin); } }
        }
        const now = performance.now(), dt = Math.max(0.008, (now - move.t) / 1000); move.t = now;
        d.x = +x.toFixed(4); d.z = +z.toFixed(4);
        this.rigVel.set((d.x - x0) / dt, 0, (d.z - z0) / dt);
        this._placeDevice();
        this.dispatchEvent(new CustomEvent('devicemove', { detail: { x: d.x, z: d.z }, bubbles: true }));
        return;
      }
      if (drag) {
        toNdc(e);
        const a = pointerAngle();
        if (a == null || drag.a0 == null) return;
        let d = a - drag.prev;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        drag.prev = a;
        drag.acc += d;
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        const v = THREE.MathUtils.clamp(drag.start + drag.acc, MIN_A, MAX_A);
        this.dialSpring.t = v;
        this.dialSpring.v = v;
        this.dialSpring.vel = 0;
        return;
      }
      if (!pressed && e.pointerType === 'mouse') this.canvas.style.cursor = pick(e) ? 'pointer' : !this.table || (movable() && hitsBody(e)) ? 'grab' : '';
    });

    const end = () => {
      if (move) {
        move = null; this.rigVel.set(0, 0, 0);
        this.canvas.style.cursor = 'grab';
        this.clicker.play(0.14, 520);                                   // and set down
        this.dispatchEvent(new CustomEvent('scenechange', { detail: clone(this.sceneCfg) }));
      }
      if (drag) {
        if (!drag.moved) this.setDate(DATES[(this.state.index + 1) % DATES.length].label);
        else this.setDate(DATES[this._nearest(this.dialSpring.v)].label);
        drag = null;
      }
      if (pressed) {
        this.keySpring.t = 0;
        this.powerSpring.t = 0;
        this.clicker.play(0.16, 1800);
        if (pressed === this.key) this.randomFuture();
        if (pressed === this.powerBtn) this.togglePower();
        pressed = null;
      }
      this.controls.enabled = !this.table;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.addEventListener('keydown', (e) => {
      const i = this.state.index;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.setDate(DATES[Math.min(i + 1, 4)].label);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.setDate(DATES[Math.max(i - 1, 0)].label);
      else if (e.key === 'Enter' || e.key === ' ') {
        this.keySpring.t = -0.0011;
        setTimeout(() => { this.keySpring.t = 0; this.randomFuture(); }, 110);
      } else if (e.key.toLowerCase() === 'p') this.togglePower();
      else return;
      e.preventDefault();
    });
  }

  _nearest(angle) {
    let best = 0, bd = Infinity;
    DATES.forEach((d, i) => { const dd = Math.abs(d.angle - angle); if (dd < bd) { bd = dd; best = i; } });
    return best;
  }

  _labelFor(i) { return DATES[i].label === 'FUTURE' ? (this.futureYear ? String(this.futureYear) : 'FUTURE') : DATES[i].label; }

  // ---------------------------------------------------------------- public API
  setDate(label) {
    const i = DATES.findIndex((d) => d.label === String(label).toUpperCase());
    if (i < 0) return;
    const changed = i !== this.state.index;
    this.state.index = i;
    this.dialSpring.t = DATES[i].angle;
    if (i !== 4) { this.futureYear = null; this.futureIndex = null; }
    else if (changed && this._content.futures.length) this._pickFuture();   // the dial lands on one of the given futures
    if (changed || !this.futureYear) this._project(this._labelFor(i), 260);
  }

  randomFuture() {
    if (!this.state.power) return;
    if (this._content.futures.length) this._pickFuture();
    // plausible: near futures more likely than far ones
    else this.futureYear = 2026 + Math.round(4 + Math.pow(Math.random(), 1.7) * 70);
    this.state.index = 4;
    this.dialSpring.t = DATES[4].angle;
    this._project(String(this.futureYear), 900);
    this.pulse = 1;
    this.glitch = 1;
  }

  _pickFuture() {
    const F = this._content.futures;
    let i;
    do i = Math.floor(Math.random() * F.length); while (F.length > 1 && i === this.futureIndex);
    this.futureIndex = i;
    this.futureYear = F[i].year;
  }

  // Screen position (client px) of a part, for pages that point at it: power, key, dial, lens, hologram.
  anchor(name) {
    if (!this.renderer) return null;
    const v = new THREE.Vector3(), obj = { power: this.powerBtn, key: this.key, dial: this.dial }[name];
    if (obj) new THREE.Box3().setFromObject(obj).getCenter(v);
    else if (name === 'lens') this.rig.localToWorld(v.copy(HOLO.lens));
    else if (name === 'hologram') this.rig.localToWorld(v.copy(HOLO.lens).add(new THREE.Vector3(0, HOLO.gap + HOLO.h / 2, 0)));
    else return null;
    v.project(this.camera);
    const r = this.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }

  // True when the point (client px) is on the visible hologram image.
  hologramHit(x, y) {
    if (!this.holo || this.holoSpring.v < 0.6) return false;
    const r = this.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.holo.image)[0];
    return !!hit && Math.hypot((hit.uv.x - 0.5) * 2, (hit.uv.y - 0.5) * 1.86) < 0.9 && hit.uv.y > 0.12;
  }

  togglePower() { this._setPower(!this.state.power); }

  _setPower(on) {
    if (on === this.state.power) return;
    this.state.power = on;
    this.lightSpring.t = on ? 1 : 0;
    this.projFade.t = on ? 1 : 0;
    this.holoSpring.t = on ? 1 : 0;
    if (on) this._project(this._labelFor(this.state.index), 500);
    this.dispatchEvent(new CustomEvent('powerchange', { detail: { on }, bubbles: true, composed: true }));
    this._announce();
  }

  // ---------------------------------------------------------------- projection
  _drawProjection(text, jitter = 0) {
    const c = this.projCanvas, g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (!text) { this.projTex.needsUpdate = true; return; }
    const word = /\D/.test(text);
    g.font = `${word ? 400 : 300} ${word ? 150 : 250}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    if ('letterSpacing' in g) g.letterSpacing = word ? '18px' : '6px';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(255,226,190,0.85)';
    g.shadowBlur = 22;
    g.fillStyle = '#fff';
    g.globalAlpha = 1 - jitter * 0.5;
    g.fillText(text, c.width / 2 + (Math.random() - 0.5) * 14 * jitter, c.height / 2 + 6);
    g.shadowBlur = 0;
    g.globalAlpha = 0.85 - jitter * 0.4;
    g.fillText(text, c.width / 2, c.height / 2 + 6);
    this.projTex.needsUpdate = true;
    this._holoText(text);
  }

  // ---------------------------------------------------------------- hologram
  _buildHologram(scene) {
    const group = new THREE.Group();
    group.position.copy(HOLO.lens);
    this.rig.add(group);
    const blend = { transparent: true, depthWrite: false, blending: THREE.NormalBlending };

    // the year, drawn white on black: the fallback image when a date has no picture
    const tc = document.createElement('canvas');
    tc.width = 480; tc.height = Math.round(480 * HOLO.h / HOLO.w);
    const textTex = new THREE.CanvasTexture(tc);
    Object.assign(textTex, { flipY: false, colorSpace: THREE.NoColorSpace, generateMipmaps: false, minFilter: THREE.LinearFilter });
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this._textSlot = { text: true, tex: textTex, maskTex: null, rect: new THREE.Vector4(0, 0, 1, 1), cols: 1, rows: 1 };

    const U = (v) => ({ value: v });
    const image = new THREE.Mesh(new THREE.PlaneGeometry(HOLO.w, HOLO.h), new THREE.ShaderMaterial({
      ...blend, side: THREE.DoubleSide, vertexShader: HOLO_IMAGE_VS, fragmentShader: HOLO_IMAGE_FS,
      uniforms: {
        uTexA: U(textTex), uTexB: U(textTex), uMaskA: U(blank), uMaskB: U(blank),
        uRectA: U(new THREE.Vector4(0, 0, 1, 1)), uRectB: U(new THREE.Vector4(0, 0, 1, 1)),
        uSheetA: U(new THREE.Vector3(1, 1, 0)), uSheetB: U(new THREE.Vector3(1, 1, 0)),
        uFlagA: U(new THREE.Vector3()), uFlagB: U(new THREE.Vector3()),
        uLevelsA: U(new THREE.Vector3(0, 1, 1)), uLevelsB: U(new THREE.Vector3(0, 1, 1)),
        uMix: U(0), uReveal: U(0), uTime: U(0), uScan: U(reduceMotion ? 0 : 0.35), uCell: U(3), uGlitch: U(0), uAlpha: U(0),
        uInk: U(HOLO_INK), uSignal: U(HOLO_SIGNAL),
      },
    }));
    image.position.y = HOLO.gap + HOLO.h / 2;
    image.renderOrder = 3;
    group.add(image);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(HOLO.r1, HOLO.r0, HOLO.top, 64, 1, true).translate(0, HOLO.top / 2, 0),
      new THREE.ShaderMaterial({ ...blend, side: THREE.DoubleSide, vertexShader: HOLO_BEAM_VS, fragmentShader: HOLO_BEAM_FS,
        uniforms: { uGrow: U(0), uTime: U(0), uAlpha: U(0), uPulse: U(0), uCol: U(HOLO_INK.clone()) } }));
    beam.renderOrder = 2;
    group.add(beam);

    const N = 90, seeds = new Float32Array(N * 3);
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

    this.holo = { group, image, beam, motes, blank, a: this._textSlot, b: null, mixStart: 0 };
    this._setSlot('A', this._textSlot, false);
  }

  _entry() {
    const c = this._content, i = this.state.index;
    if (i === 4) return this.futureIndex != null ? c.futures[this.futureIndex] : null;
    return c.dates[DATES[i].label] || null;
  }

  _setSlot(which, slot, future) {
    const u = this.holo.image.material.uniforms;
    u['uTex' + which].value = slot.tex;
    u['uMask' + which].value = slot.maskTex || this.holo.blank;
    u['uRect' + which].value.copy(slot.rect);
    u['uSheet' + which].value.set(slot.cols, slot.rows, 0);
    u['uFlag' + which].value.set(slot.text || slot.invert === false ? 0 : 1, slot.maskTex ? 1 : 0, future ? 1 : 0);
    u['uLevels' + which].value.copy(slot.levels || new THREE.Vector3(0, 1, 1));
    if (which === 'A') this.holo.a = slot; else this.holo.b = slot;
  }

  // Point the hologram at the current date: cross-dissolve to its picture, or to the year.
  _holoRefresh() {
    if (!this.holo) return;
    const e = this._entry(), next = e?.ready ? e : this._textSlot, future = this.state.index === 4, h = this.holo;
    const shown = h.b || h.a;
    if (shown === next && (h.b ? h.futureB : h.futureA) === future) return;
    if (h.b) { this._setSlot('A', h.b, h.futureB); h.futureA = h.futureB; h.b = null; }
    if (h.a === next && next.text) { this._setSlot('A', next, future); h.futureA = future; this.glitch = Math.max(this.glitch, 0.45); return; }
    this._setSlot('B', next, future);
    h.futureB = future;
    h.mixStart = performance.now();
    h.image.material.uniforms.uMix.value = 0;
    this.glitch = Math.max(this.glitch, 0.5);
  }

  _holoText(text) {
    const slot = this._textSlot;
    if (!slot) return;
    const c = slot.tex.image, g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    if (text) {
      const word = /\D/.test(text);
      g.font = `${word ? 500 : 400} ${word ? 92 : 168}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      if ('letterSpacing' in g) g.letterSpacing = word ? '10px' : '0px';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#fff';
      g.fillText(text, c.width / 2, c.height * 0.5);
    }
    slot.tex.needsUpdate = true;
  }

  _tickHologram(dt, now) {
    const h = this.holo, u = h.image.material.uniforms, bu = h.beam.material.uniforms, mu = h.motes.material.uniforms;
    this.holoSpring.step(dt);
    const k = THREE.MathUtils.clamp(this.holoSpring.v, 0, 1);
    const grow = THREE.MathUtils.clamp(k * 1.7, 0, 1), reveal = THREE.MathUtils.clamp((k - 0.3) / 0.7, 0, 1);
    const t = reduceMotion ? 0 : now / 1000;
    // the image turns to face the camera around its vertical axis
    const cam = this.camera.position;
    if (this.table) h.image.quaternion.copy(this.rig.quaternion).invert().multiply(this.camera.quaternion);   // a fixed view: face the camera squarely
    else h.image.rotation.y = Math.atan2(cam.x - HOLO.lens.x, cam.z - HOLO.lens.z);
    if (h.b) {
      const m = Math.min(1, (now - h.mixStart) / (reduceMotion ? 1 : 520));
      u.uMix.value = m * m * (3 - 2 * m);
      if (m >= 1) { this._setSlot('A', h.b, h.futureB); h.futureA = h.futureB; h.b = null; u.uMix.value = 0; }
    }
    // sprite sheets play at their own frame rate
    for (const [which, slot] of [['A', h.a], ['B', h.b]]) {
      if (slot?.fps && slot.cols * slot.rows > 1) u['uSheet' + which].value.z = reduceMotion ? 0 : (now / 1000 * slot.fps) % (slot.cols * slot.rows);
    }
    if (!reduceMotion && this.state.power && Math.random() < dt * 0.25) this.glitch = Math.max(this.glitch, 0.3);   // the odd stray flicker
    this.glitch = Math.max(0, this.glitch - dt * 2.6);
    const future = (h.b ? h.futureB : h.futureA) ? 1 : 0;
    const flicker = reduceMotion ? 1 : 1 - 0.05 * Math.random() * (this.state.power ? 1 : 0);
    const pulse = this.pulse || 0;
    u.uReveal.value = reveal;
    u.uTime.value = t;
    u.uGlitch.value = reduceMotion ? 0 : this.glitch;
    u.uAlpha.value = Math.min(1, k * 2.5) * flicker;
    // dither cell: about 95 rows across the image, so a small hologram keeps its face; never finer than 1.5 CSS px
    const top = this.rig.localToWorld(HOLO.lens.clone().setY(HOLO.lens.y + HOLO.top)).project(this.camera);
    const bottom = this.rig.localToWorld(HOLO.lens.clone().setY(HOLO.lens.y + HOLO.gap)).project(this.camera);
    const imgPx = Math.abs(top.y - bottom.y) / 2 * this.clientHeight;
    u.uCell.value = THREE.MathUtils.clamp(imgPx / 95, 1.5, 2.8) * this.renderer.getPixelRatio();
    bu.uGrow.value = grow;
    bu.uTime.value = t;
    bu.uAlpha.value = Math.min(1, k * 3) * flicker;
    bu.uPulse.value = pulse;
    bu.uCol.value.lerpVectors(HOLO_INK, HOLO_SIGNAL, future * 0.85);
    mu.uTime.value = t;
    mu.uGrow.value = grow;
    mu.uAlpha.value = Math.min(1, k * 2);
    mu.uSize.value = 2.6 * this.renderer.getPixelRatio();
    mu.uCol.value.copy(bu.uCol.value);
    h.group.visible = k > 0.001;
    this.lensGlow.material.opacity = 0.85 * grow * (1 + pulse);

    // caption above the image, in page type
    const cap = this.caption, label = this.state.label;
    if (cap.dataset.text !== this.state.projected + label) {
      cap.dataset.text = this.state.projected + label;
      cap.querySelector('b').textContent = label ? this.state.projected : '';
      cap.querySelector('span').textContent = label;
    }
    cap.classList.toggle('future', !!future);
    const p = this.rig.localToWorld(HOLO.lens.clone().add(new THREE.Vector3(0, HOLO.top + 0.004, 0))).project(this.camera);
    cap.style.transform = `translate(${((p.x + 1) / 2 * this.clientWidth).toFixed(1)}px, ${((1 - p.y) / 2 * this.clientHeight).toFixed(1)}px)`;
    cap.style.opacity = label ? String(reveal * reveal * flicker) : '0';
  }

  _project(text, ms) {
    this.state.projected = text;
    this.state.label = this._entry()?.label || '';
    this._holoRefresh();
    clearInterval(this._scramble);
    const finish = () => {
      this._drawProjection(text);
      this.dispatchEvent(new CustomEvent('datechange', {
        detail: { date: DATES[this.state.index].label, projected: text, label: this.state.label,
          future: this.state.index === 4 ? this.futureIndex : null }, bubbles: true, composed: true }));
      this._announce();
    };
    if (reduceMotion || !this.state.power) return finish();
    const t0 = performance.now();
    this._scramble = setInterval(() => {
      const p = (performance.now() - t0) / ms;
      if (p >= 1) { clearInterval(this._scramble); return finish(); }
      const shown = /\D/.test(text) ? text : [...text].map((ch, k) =>
        (k / text.length < p * 1.2 - 0.2 ? ch : String(Math.floor(Math.random() * 10)))).join('');
      this._drawProjection(shown, 1 - p);
    }, 45);
  }

  _announce() {
    const label = this.state.label ? `, ${this.state.label}` : '';
    this.live.textContent = this.state.power ? `Projecting ${this.state.projected}${label}` : 'Powered off';
  }

  // ---------------------------------------------------------------- frame
  _applyDial(angle) { this.dial.rotation.y = THREE.MathUtils.degToRad(angle - BAKED_POINTER); }

  _applyLights(k) {
    const pulse = this.pulse || 0;
    this.M.led_green.emissiveIntensity = 6 * k;
    this.M.projector_core.emissiveIntensity = 1.2 * k * (1 + pulse * 5);
    this.M.front_core.emissiveIntensity = 5 * k;
    this.ledGlow.material.opacity = 0.9 * k;
    this.frontGlow.material.opacity = 0.75 * k;
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.25);
    this.dialSpring.step(dt);
    this._applyDial(this.dialSpring.v);
    const det = this._nearest(this.dialSpring.v);
    if (Math.abs(DATES[det].angle - this.dialSpring.v) < 6 && det !== this.lastDetent) {
      this.lastDetent = det;
      this.clicker.play(0.18, 3600);
    }
    this.keySpring.step(dt);
    this.key.position.y = this.keyY + this.keySpring.v;
    this.powerSpring.step(dt);
    this.powerBtn.position.y = this.powerY + this.powerSpring.v;
    this.lightSpring.step(dt);
    this.projFade.step(dt);
    if (this.pulse) this.pulse = Math.max(0, this.pulse - dt * 1.2);
    this._applyLights(this.lightSpring.v);
    const flicker = this.state.power ? 1 - 0.025 * Math.random() : 1;
    this.proj.material.opacity = 0.48 * this.projFade.v * flicker;
    if (!this.table) this.controls.update();
    this._tickHologram(dt, performance.now());
    for (const f of this.tickers) { try { f(dt); } catch (e) { console.error(e); } }
    this.renderer.render(this.scene, this.camera);
  }
}

customElements.define('temporal-projector', TemporalProjector);
export { TemporalProjector };
