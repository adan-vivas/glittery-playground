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
import { SCENES, HOLO_DOTS, MAX_BONES } from './holo-scenes.js?v=13';   // versioned: a cached copy must never outlive a change

const DATES = [
  { label: '1996', angle: 210 },
  { label: '2006', angle: 150 },
  { label: '2016', angle: 90 },
  { label: '2026', angle: 30 },
  { label: 'FUTURE', angle: -30 },
];
// ZL 2: the "dial" is the fluted crown on the right end. Date "angles" are kept as abstract
// detent positions; the crown rolls CROWN_ROLL degrees per unit about its own (x) axis.
const CROWN_ROLL = 1.5;
const CROWN_DRAG = 0.9;             // detent units per px of vertical drag (up = later)
const MIN_A = -30, MAX_A = 210;
const TOP_Y = 0.021;                // top surface height (m)
const POWER_SLIDE = 0.0088;         // the power knob slides this far right when on
const LED_P = new THREE.Vector3(0.0255, TOP_Y - 0.0023, -0.014);    // green strip the knob uncovers
const APERTURE_P = new THREE.Vector3(0.0, 0.011, 0.0312);           // front projection lens, centred
const PROJ_P = new THREE.Vector3(0.0, 0.0002, 0.082);               // where it throws the year and its line on the table
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

// The hologram's subjects as clouds of soft dots (see holo-scenes.js). Two slots, A and B: changing the date flies every
// dot from its place in A to its place in B along a little arc toward you, each dot a beat after the last. Bones animate
// rigid parts, the wind moves what has sway, and the dots breathe along their normals. Shading follows the point-cloud
// portraits this is modelled on: an even, scan-like tone, a soft key from the top left, a rim, ridges catching light,
// creases falling into shadow, loose strands glowing. On a light page the "light" is ink: brighter dots are denser blue.
const HOLO_CLOUD_VS = `
  attribute vec3 aPosA, aPosB, aNrmA, aNrmB;
  attribute vec4 aSkinA, aSkinB;   // bone, bone, weight of the first, sway (+ wind, − a mote drifting up)
  attribute vec4 aMatA, aMatB;     // brightness, orange accent, ridge, thin
  attribute float aRand;
  uniform mat4 uBonesA[${MAX_BONES}], uBonesB[${MAX_BONES}];
  uniform float uFadeA[${MAX_BONES}], uFadeB[${MAX_BONES}];
  uniform float uMorph, uTime, uReveal, uSize, uGlitch, uShine, uWind, uCenterZ, uDepth, uLit, uLensY;
  uniform vec3 uInk, uSignal, uPale;
  varying vec3 vCol;
  varying float vA;
  float hash(vec2 p){ p = fract(p * vec2(.1031, .1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
  vec3 rest(vec3 p, float sw, out float fade){
    fade = 1.;
    if (sw < 0.) {                                                     // a mote: drifts up, sways, fades in and out
      float ph = fract(uTime * -sw * .07 + aRand * 13.);
      fade = sin(3.14159 * ph);
      return p + vec3(sin(uTime * .7 + aRand * 40.) * .03 * ph, ph * .34 * uWind, cos(uTime * .6 + aRand * 31.) * .03 * ph);
    }
    return p + vec3(sin(uTime * 1.7 + p.y * 11. + p.z * 6.) * .010 + sin(uTime * .9 + p.x * 4.) * .007, 0.,
                    cos(uTime * 1.3 + p.y * 9. + p.x * 5.) * .008) * sw * uWind;
  }
  void main(){
    float r2 = fract(sin(aRand * 91.7) * 43758.5453);
    int a0 = int(aSkinA.x + .5), a1 = int(aSkinA.y + .5), b0 = int(aSkinB.x + .5), b1 = int(aSkinB.y + .5);
    mat4 MA = uBonesA[a0] * aSkinA.z + uBonesA[a1] * (1. - aSkinA.z);   // linear blend skinning
    mat4 MB = uBonesB[b0] * aSkinB.z + uBonesB[b1] * (1. - aSkinB.z);
    float fA, fB;
    vec3 pA = (MA * vec4(rest(aPosA, aSkinA.w, fA), 1.)).xyz, pB = (MB * vec4(rest(aPosB, aSkinB.w, fB), 1.)).xyz;
    fA *= mix(uFadeA[a1], uFadeA[a0], aSkinA.z); fB *= mix(uFadeB[b1], uFadeB[b0], aSkinB.z);
    vec3 nA = mat3(MA) * aNrmA, nB = mat3(MB) * aNrmB;
    // a switch: every dot pours back down into the lens, then shoots up into its place in the next subject, spiralling
    vec3 L = vec3(0., uLensY, 0.), jit = (fract(vec3(aRand * 91.7, aRand * 47.3, aRand * 13.1) * 43.7) - .5) * vec3(.07, .02, .07);
    float dir = r2 > .5 ? 1. : -1., t = clamp((uMorph - aRand * .35) / .65, 0., 1.), fly, k;
    vec3 p, n; vec4 m; float fade;
    if (t < .5) { k = t * 2.; k = k * k * k; p = mix(pA, L + jit, k); n = nA; m = aMatA; fade = fA; fly = k; }
    else { k = (t - .5) * 2.; k = 1. - pow(1. - k, 3.); p = mix(L + jit, pB, k); n = nB; m = aMatB; fade = fB; fly = 1. - k; }
    float sa = fly * 2.2 * dir, cs = cos(sa), sn = sin(sa); vec3 d = p - L; p = L + vec3(cs * d.x + sn * d.z, d.y, -sn * d.x + cs * d.z);
    n = normalize(n + vec3(0., 0., 1e-4));
    // the projector keeps feeding it: one dot in twelve is always on its way up out of the lens to its place
    if (aRand < .085 && uMorph == 0.) {
      float f = fract(uTime * (.16 + r2 * .12) + aRand * 53.), g = smoothstep(0., .9, f);
      p = mix(L + jit * .4, p, g); fly = max(fly, 1. - g);
      fade *= smoothstep(0., .08, f);
    }
    p += n * sin(uTime * 1.4 + aRand * 60.) * .002;                  // breathing
    float rv = clamp((uReveal * 1.35 - p.y * .85 - aRand * .3) / .3, 0., 1.);   // out of the lens, lowest first
    rv = rv * rv * (3. - 2. * rv);
    p = mix(vec3(p.x * .08, -.12, p.z * .08), p, rv);
    float band = floor(p.y * 40.), tg = floor(uTime * 16.);
    p.x += (hash(vec2(band, tg)) - .5) * .08 * uGlitch * step(.7, hash(vec2(band * 1.7, tg + 3.)));
    vec4 mv = modelViewMatrix * vec4(p, 1.);
    gl_Position = projectionMatrix * mv;
    vec3 vn = normalize(normalMatrix * n);
    float key = max(dot(vn, normalize(vec3(-.45, .65, .6))), 0.), facing = vn.z, rim = pow(1. - abs(facing), 2.5);
    float lit = (.36 + key * .6 + rim * .32) * mix(.42, 1., smoothstep(-.35, .2, facing));   // the far side falls away
    lit *= m.z > 0. ? 1. + m.z * .6 : 1. + m.z * .5;                  // ridges catch light, creases sink
    float b = m.x * mix(1., lit, uLit) + m.w * (.18 + key * .2) * uLit;   // uLit: how much of the light is ours (art brings its own)
    b = mix(b, 1.1, fly * .6);                                         // in flight they glow like the beam
    b *= clamp(.8 + (mv.z - uCenterZ) / uDepth * .5, .4, 1.2);        // nearer is crisper: depth reads on a light page
    b *= .88 + .12 * sin(p.y * 260. - uTime * 3.);                     // scanlines
    float shine = exp(-pow(p.y - uShine, 2.) * 70.);
    b += shine * .6;
    b *= .75 + r2 * .45;
    vA = clamp(b, 0., 1.15) * rv * fade;
    vec3 ink = mix(uPale, uInk, clamp(b * .8, 0., 1.));
    vCol = mix(mix(ink, uSignal, clamp(m.y, 0., 1.)), uPale, fly * .5);
    gl_PointSize = uSize * (.55 + r2 * r2 * 1.) * (1. + shine * .4) / -mv.z;
  }`;
const HOLO_CLOUD_FS = `
  uniform float uAlpha;
  varying vec3 vCol;
  varying float vA;
  void main(){
    vec2 d = gl_PointCoord - .5;
    float r = dot(d, d);
    if (r > .25) discard;
    gl_FragColor = vec4(vCol, clamp(exp(-14. * r) * vA * 1.1 * uAlpha, 0., .92));
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
    coated_glass: P({ color: 0xffffff, metalness: 0, roughness: 0, transmission: 1,
      thickness: 0.002, ior: 1.52, iridescence: 1, iridescenceIOR: 1.38,
      iridescenceThicknessRange: [260, 420], specularIntensity: 1 }),
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
    const all = [...Object.values(this._content.dates), ...this._content.futures].filter((e) => e.image && !e.scene);   // subjects build their own dots
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
    const src = this.getAttribute('src') || new URL('zeitlinse.glb', base).href;
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
    this.dial = device.getObjectByName('dial');
    this.key = device.getObjectByName('prf_key');
    this.powerBtn = device.getObjectByName('power_button');
    this.interactive = [this.dial, this.key, this.powerBtn];
    // generous invisible hit areas, so the controls are easy to catch with a finger or cursor
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    for (const [o, grow] of [[this.dial, 1.7], [this.key, 1.6], [this.powerBtn, 1.6]]) {
      const b = new THREE.Box3();
      o.traverse((c) => { if (c.isMesh) { c.geometry.computeBoundingBox(); b.union(c.geometry.boundingBox); } });
      const size = b.getSize(new THREE.Vector3()).multiplyScalar(grow).max(new THREE.Vector3(0.012, 0.008, 0.012));
      const hit = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), hitMat);
      b.getCenter(hit.position);
      hit.castShadow = hit.receiveShadow = false;
      o.add(hit);
    }
    this.keyY = this.key.position.y;
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
    this.frontGlow = sprite(0xffc98a, 0.016, APERTURE_P);

    // the year, thrown onto the table by the front lens
    this.projCanvas = document.createElement('canvas');
    this.projCanvas.width = 1024;
    this.projCanvas.height = 560;
    this.projTex = new THREE.CanvasTexture(this.projCanvas);
    this.projTex.colorSpace = THREE.SRGBColorSpace;
    this.projTex.anisotropy = 8;
    this.proj = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1 * 560 / 1024),   // the year, and the line under it, cast on the floor in the beam's blue
      new THREE.MeshBasicMaterial({ map: this.projTex, transparent: true, depthWrite: false, toneMapped: false,
        color: new THREE.Color(0.06, 0.1, 0.8), opacity: 1 }));
    this.proj.rotation.x = -Math.PI / 2;
    this.proj.position.copy(PROJ_P);
    this.floorRig.add(this.proj);

    this._buildHologram(scene);
    this._buildMist();
    this.lensGlow = sprite(0x6f8cff, 0.038, HOLO.lens);

    // animation state
    this.dialSpring = new Spring(DATES[this.state.index].angle, 240, 0.55);
    this.keySpring = new Spring(0, 900, 0.7);
    this.powerSpring = new Spring(this.state.power ? POWER_SLIDE : 0, 520, 0.85);
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

    let drag = null, pressed = null, move = null;
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
      if (target === this.dial) {
        // roll the crown: drag up for later years, down for earlier
        drag = { start: this.dialSpring.v, x: e.clientX, y: e.clientY, moved: false };
      } else {
        pressed = target;
        if (target === this.key) this.keySpring.t = -0.0011;
        this.clicker.play(0.22, 2400);
      }
    }, { capture: true });

    this.canvas.addEventListener('pointermove', (e) => {
      if (move) {
        // It only comes up a little, straight up where it stands: moving up raises it toward MAX_LIFT, never sideways.
        const H = this._hold, hit = holdHit(e, H.anchor); if (!hit) return;
        H.target = H.anchor.clone().setY(THREE.MathUtils.clamp(hit.y + H.off.y, 0.012, 0.04));
        return;
      }
      if (drag) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        const v = THREE.MathUtils.clamp(drag.start + (e.clientY - drag.y) * CROWN_DRAG, MIN_A, MAX_A);
        this.dialSpring.t = v;
        this.dialSpring.v = v;
        this.dialSpring.vel = 0;
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
      if (drag) {
        if (!drag.moved) this.setDate(DATES[(this.state.index + 1) % DATES.length].label);
        else this.setDate(DATES[this._nearest(this.dialSpring.v)].label);
        drag = null;
      }
      if (pressed) {
        this.keySpring.t = 0;
        this.clicker.play(0.16, 1800);
        if (pressed === this.key) this.randomFuture();
        if (pressed === this.powerBtn) this.togglePower();
        pressed = null;
      }
      this.controls.enabled = !this.table;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    // scroll over the crown rolls it one year per notch (trackpads accumulate)
    let wheelAcc = 0;
    this.canvas.addEventListener('wheel', (e) => {
      if (pick(e) !== this.dial) { wheelAcc = 0; return; }
      e.preventDefault();
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) < 40) return;
      const i = this.state.index, step = wheelAcc < 0 ? 1 : -1;   // scroll up = later
      wheelAcc = 0;
      this.setDate(DATES[THREE.MathUtils.clamp(i + step, 0, DATES.length - 1)].label);
    }, { passive: false });

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
    this.powerSpring.t = on ? POWER_SLIDE : 0;
    this.projFade.t = on ? 1 : 0;
    this.holoSpring.t = on ? 1 : 0;
    if (on) this._project(this._labelFor(this.state.index), 500);
    this.dispatchEvent(new CustomEvent('powerchange', { detail: { on }, bubbles: true, composed: true }));
    this._announce();
  }

  // ---------------------------------------------------------------- projection
  _drawProjection(text, jitter = 0) {
    const c = this.projCanvas, g = c.getContext('2d'), label = this.state.label || '';
    g.clearRect(0, 0, c.width, c.height);
    if (!text) { this.projTex.needsUpdate = true; return; }
    const W = c.width, x0 = W / 2 + (Math.random() - 0.5) * 14 * jitter, font = '"Helvetica Neue", Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff'; g.globalAlpha = 1 - jitter * 0.5;
    // the description, wrapped to at most three lines under the year
    g.font = `400 56px ${font}`;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const lines = [];
    for (const word of label.split(/\s+/).filter(Boolean)) {
      const last = lines[lines.length - 1];
      if (last && g.measureText(last + ' ' + word).width < W * 0.9) lines[lines.length - 1] = last + ' ' + word; else lines.push(word);
    }
    lines.length = Math.min(lines.length, 3);
    const yearH = 200, lineH = 70, total = yearH + lines.length * lineH, top = (c.height - total) / 2;
    g.font = `400 ${yearH}px ${font}`;
    if ('letterSpacing' in g) g.letterSpacing = '6px';
    g.fillText(text, x0, top + yearH * 0.82);
    g.font = `500 56px ${font}`;
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    lines.forEach((l, i) => g.fillText(l, x0, top + yearH + 18 + (i + 0.75) * lineH));
    this.projTex.needsUpdate = true;
    this._holoText(text);
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

    // the subjects: one pool of dots that every subject is made of
    const cg = new THREE.BufferGeometry(), ND = HOLO_DOTS, rnd = new Float32Array(ND);
    for (let i = 0; i < ND; i++) rnd[i] = Math.random();
    for (const [name, size] of [['aPosA', 3], ['aPosB', 3], ['aNrmA', 3], ['aNrmB', 3], ['aSkinA', 4], ['aSkinB', 4], ['aMatA', 4], ['aMatB', 4]])
      cg.setAttribute(name, new THREE.BufferAttribute(new Float32Array(ND * size), size));
    cg.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    cg.setAttribute('position', cg.attributes.aPosA);
    const bones = () => Array.from({ length: MAX_BONES }, () => new THREE.Matrix4());
    const cloud = new THREE.Points(cg, new THREE.ShaderMaterial({ ...blend, vertexShader: HOLO_CLOUD_VS, fragmentShader: HOLO_CLOUD_FS,
      uniforms: { uBonesA: U(bones()), uBonesB: U(bones()), uFadeA: U(new Array(MAX_BONES).fill(1)), uFadeB: U(new Array(MAX_BONES).fill(1)), uCenterZ: U(-1), uDepth: U(HOLO.h * 0.5), uLit: U(1), uLensY: U(-HOLO.gap / HOLO.h), uPale: U(new THREE.Vector3(0.55, 0.64, 1)), uMorph: U(0), uTime: U(0), uReveal: U(0), uSize: U(1), uGlitch: U(0),
        uShine: U(99), uWind: U(reduceMotion ? 0 : 1), uAlpha: U(0), uInk: U(HOLO_INK), uSignal: U(HOLO_SIGNAL), uGlow: U(new THREE.Vector3(0.45, 0.6, 1)) } }));
    cloud.frustumCulled = false;
    cloud.renderOrder = 3;
    cloud.scale.setScalar(HOLO.h);
    cloud.position.y = HOLO.gap;
    cloud.rotation.order = 'YXZ';
    cloud.visible = false;
    group.add(cloud);
    this.cloud = { pts: cloud, A: null, B: null, start: 0, on: 0, want: null, cache: new Map() };

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
    const se = this._entry();
    this.cloud.want = se?.scene && SCENES[se.scene] ? se.scene : null;
    if (this.cloud.want) this._showScene(se);
    const e = se, next = e?.ready ? e : this._textSlot, future = this.state.index === 4, h = this.holo;
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

  // A subject's dots, built once (in code) and cached. Building is quick, except the face, which waits for its photo.
  _sceneData(entry) {
    const c = this.cloud, key = entry.scene;
    if (c.cache.has(key)) return c.cache.get(key);
    // built in a worker (off the main thread); where workers can't, at idle time here
    const local = () => new Promise((ok) => (window.requestIdleCallback ? requestIdleCallback : (f) => setTimeout(f, 50))(() => ok(SCENES[key].build(entry))));
    let p;
    try {
      if (!this._worker) {
        this._worker = new Worker(new URL('./holo-worker.js?v=13', import.meta.url), { type: 'module' });
        this._jobs = new Map();
        this._worker.onmessage = ({ data }) => { const j = this._jobs.get(data.key); if (!j) return; this._jobs.delete(data.key); data.error ? j.fail(new Error(data.error)) : j.ok(data.d); };
        this._worker.onerror = () => { for (const j of this._jobs.values()) j.fail(new Error('worker failed')); this._jobs.clear(); this._worker = null; this._noWorker = true; };
      }
      if (this._noWorker) throw new Error('no worker');
      p = new Promise((ok, fail) => { this._jobs.set(key, { ok, fail }); this._worker.postMessage({ key, entry: { scene: entry.scene, image: entry.image, mask: entry.mask } }); })
        .catch(() => local());
    } catch { p = local(); }
    p = p.catch((err) => { console.error(err); c.cache.delete(key); return null; });
    c.cache.set(key, p);
    return p;
  }

  _showScene(entry) {
    const key = entry.scene;
    this._sceneData(entry).then((data) => {
      const c = this.cloud;
      if (!data || c.want !== key) return;
      const g = c.pts.geometry.attributes, put = (slot, d) => { g['aPos' + slot].array.set(d.pos); g['aNrm' + slot].array.set(d.nrm); g['aSkin' + slot].array.set(d.skin); g['aMat' + slot].array.set(d.mat);
        for (const n of ['aPos', 'aNrm', 'aSkin', 'aMat']) g[n + slot].needsUpdate = true; };
      if (!c.A) { put('A', data); c.A = key; c.dataA = data; return; }   // (each subject's fit rides along in data.fit)
      if ((c.B || c.A) === key) return;
      if (c.B) { put('A', c.dataB); c.A = c.B; c.dataA = c.dataB; }      // a new date mid-flight: land the last one at once
      put('B', data); c.B = key; c.dataB = data; c.start = performance.now();
      this._prebuildScenes();
    });
  }

  // after the first subject, build the rest when the page is idle, so changing the date never stalls
  _prebuildScenes() {
    if (this._prebuilt) return;
    this._prebuilt = true;
    const all = [...Object.values(this._content.dates), ...this._content.futures].filter((e) => e.scene && SCENES[e.scene]);
    const idle = (f) => (window.requestIdleCallback ? requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 200));
    const next = () => { const e = all.shift(); if (!e) return; this._sceneData(e).then(() => idle(next)); };
    idle(next);
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
    bu.uAlpha.value = Math.min(1, k * 3) * flicker * 0.55;   // the beam stays quiet behind the subject
    bu.uPulse.value = pulse;
    bu.uCol.value.lerpVectors(HOLO_INK, HOLO_SIGNAL, future * 0.85);
    mu.uTime.value = t;
    mu.uGrow.value = grow;
    mu.uAlpha.value = Math.min(1, k * 2);
    mu.uSize.value = 2.2 * this.renderer.getPixelRatio();
    mu.uCol.value.copy(bu.uCol.value);
    h.group.visible = k > 0.001;

    // the subject's dots
    const c = this.cloud, cu = c.pts.material.uniforms;
    c.on += ((c.want && c.A ? 1 : 0) - c.on) * (1 - Math.exp(-dt * 6));
    if (c.B) {
      const m = Math.min(1, (now - c.start) / (reduceMotion ? 1 : 1500));
      cu.uMorph.value = m;
      if (m >= 1) {
        const g = c.pts.geometry.attributes;
        for (const n of ['aPos', 'aNrm', 'aSkin', 'aMat']) { g[n + 'A'].array.set(g[n + 'B'].array); g[n + 'A'].needsUpdate = true; }
        c.A = c.B; c.dataA = c.dataB; c.B = null; cu.uMorph.value = 0;
      }
    }
    if (c.A) {
      cu.uFadeA.value.fill(1); cu.uFadeB.value.fill(1);
      const fit = (bones, d) => { const f = d?.fit; if (!f) return; const M = new THREE.Matrix4().makeTranslation(f[1], f[2], f[3]).multiply(new THREE.Matrix4().makeScale(f[0], f[0], f[0])); for (const b of bones) b.premultiply(M); };
      SCENES[c.A].anim(t, cu.uBonesA.value, cu.uFadeA.value); fit(cu.uBonesA.value, c.dataA);
      if (c.B) { SCENES[c.B].anim(t, cu.uBonesB.value, cu.uFadeB.value); fit(cu.uBonesB.value, c.dataB); }
      else { cu.uBonesB.value.forEach((b, i) => b.copy(cu.uBonesA.value[i])); cu.uFadeB.value.set ? cu.uFadeB.value.set(cu.uFadeA.value) : cu.uFadeA.value.forEach((v, i) => (cu.uFadeB.value[i] = v)); }
    }
    c.pts.visible = c.on > 0.003 && !!c.A;
    // it turns to you around its vertical axis, and leans a little toward your eye (more for faces)
    const eye = h.group.worldToLocal(this.camera.position.clone()), lean = (SCENES[c.B || c.A]?.lean ?? 0.2);
    c.pts.rotation.y = Math.atan2(eye.x, eye.z);
    c.pts.rotation.x = -Math.atan2(eye.y - (HOLO.gap + HOLO.h / 2), Math.hypot(eye.x, eye.z)) * lean;
    const dist = this.camera.position.distanceTo(c.pts.getWorldPosition(new THREE.Vector3()));
    cu.uSize.value = THREE.MathUtils.clamp(imgPx / 210, 0.9, 2.4) * this.renderer.getPixelRatio() * dist;
    const cz = c.pts.localToWorld(new THREE.Vector3(0, 0.5, 0)).applyMatrix4(this.camera.matrixWorldInverse).z;
    cu.uLit.value = SCENES[c.B || c.A]?.lit ?? 1;
    cu.uCenterZ.value = cz; cu.uDepth.value = HOLO.h * 0.45;
    cu.uTime.value = t;
    cu.uReveal.value = reveal;
    cu.uGlitch.value = reduceMotion ? 0 : this.glitch;
    const sp = (t % 7) / 1.8;                                            // a band of light sweeps up the subject every 7 s
    cu.uShine.value = reduceMotion || sp > 1 ? 99 : -0.15 + sp * 1.3;
    cu.uAlpha.value = Math.min(1, k * 2.5) * flicker * c.on;
    u.uAlpha.value *= 1 - c.on;                                          // the flat picture (or the year) gives way to the dots
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
    cap.style.opacity = '0';                                            // the year and its line are cast on the floor instead
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
  _applyDial(angle) { this.dial.rotation.x = THREE.MathUtils.degToRad(angle * CROWN_ROLL); }

  _applyLights(k) {
    const pulse = this.pulse || 0;
    this.M.led_green.emissiveIntensity = 6 * k;
    this.M.projector_core.emissiveIntensity = 1.2 * k * (1 + pulse * 5);
    this.M.front_core.emissiveIntensity = 2.4 * k;
    this.M.power_on.emissiveIntensity = 3 * k;
    this.ledGlow.material.opacity = 0.5 * k;
    this.frontGlow.material.opacity = 0.1 * k;
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
    this.powerBtn.position.x = this.powerX + this.powerSpring.v;
    this.lightSpring.step(dt);
    this.projFade.step(dt);
    if (this.pulse) this.pulse = Math.max(0, this.pulse - dt * 1.2);
    this._applyLights(this.lightSpring.v);
    const flicker = this.state.power ? 1 - 0.025 * Math.random() : 1;
    this.proj.material.opacity = 0.42 * this.projFade.v * flicker;
    if (!this.table) this.controls.update();
    this._tickHologram(dt, performance.now());
    this._tickMist(dt);
    if (this.table) this._tickRig(dt);
    for (const f of this.tickers) { try { f(dt); } catch (e) { console.error(e); } }
    this.renderer.render(this.scene, this.camera);
  }
}

customElements.define('temporal-projector', TemporalProjector);
export { TemporalProjector };
