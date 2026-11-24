// The memory, floating above the lens: a depth video rebuilt as dots on the GPU.
//
// A memory is a square greyscale video (see lib/depth-format.js): black where nobody is, and for the figures a depth
// from 64 (farthest) to 255 (nearest). A fixed grid of dots samples each frame. Dots over black are dropped; the rest
// stand at their depth toward the viewer, with a mirrored back layer so the figures have volume when they turn. Light
// and shade come only from that shape: normals from the depth's slope give a soft key from the top left, a rim, and
// thin parts glow. The look is a hologram's: blue, translucent, scanlines drifting up, flicker, now and then a glitch.
// On a light page the light is ink: brighter dots are denser blue.
//
// Switching memories: the dots drain down into the lens (0.6 s), the next memory loads, and its dots rise into place
// (0.9 s; 2.4 s the first time a memory is shown, while it "develops"). A newer show() always wins.
import * as THREE from 'three';
import { EMPTY_BELOW, FIGURE_MIN, FIGURE_SPAN } from './lib/depth-format.js';

const DRAIN_S = 0.6, RISE_S = 0.9, DEVELOP_S = 2.4;

const VS = /* glsl */ `
  #define EMPTY_BELOW ${EMPTY_BELOW.toFixed(1)}
  #define FIGURE_MIN ${FIGURE_MIN.toFixed(1)}
  #define FIGURE_SPAN ${FIGURE_SPAN.toFixed(1)}
  uniform sampler2D uDepth;
  uniform float uSize, uRise, uTime, uGlitch, uThick, uLensY, uMotion, uCell;
  attribute float aRand;
  varying float vA, vY, vShade, vGlow;

  float depthAt(vec2 uv) {                     // 0..1, or -1 where nobody is
    float v = texture2D(uDepth, uv).r * 255.;
    return v < EMPTY_BELOW ? -1. : clamp((v - FIGURE_MIN) / FIGURE_SPAN, 0., 1.);
  }
  float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec2 uv = position.xy;                       // 0..1 across the frame, v up
    float side = position.z;                     // +1 the front surface, -1 the back
    uv += (vec2(fract(aRand * 91.7), fract(aRand * 53.3)) - .5) * uCell;   // break up the grid
    float d = depthAt(uv);
    vA = 0.;
    if (d < 0.) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 0.; return; }

    // slope of the shape, for light and shade (outside the figure counts as the edge, depth 0)
    float e = uCell * 1.5;
    float dl = max(depthAt(uv - vec2(e, 0.)), 0.), dr = max(depthAt(uv + vec2(e, 0.)), 0.);
    float db = max(depthAt(uv - vec2(0., e)), 0.), dt = max(depthAt(uv + vec2(0., e)), 0.);
    // the surface's real slope: depth is uThick of the frame deep, sampled 2e apart
    vec3 n = normalize(vec3((dl - dr) * uThick / (2. * e), (db - dt) * uThick / (2. * e), side));
    vec3 L = normalize(vec3(-.5, .6, .62 * side));
    float key = max(dot(n, L), 0.);
    float rim = pow(1. - abs(n.z), 3.);
    // light picks out the relief; nearer parts are denser; the back is a faint ghost that gives volume when it turns
    vShade = (.28 + 1.1 * pow(key, 1.5) + .4 * rim) * (.6 + .4 * d) * (side > 0. ? 1. : .22);
    vGlow = (1. - smoothstep(0., .18, d)) * (side > 0. ? 1. : .3);   // the thin edge of the figure glows

    // a glitch: now and then a band of the figure slips sideways
    float band = floor(uv.y * 24. + floor(uTime * 7.));
    float slip = uGlitch * uMotion * step(.86, h21(vec2(band, floor(uTime * 9.)))) * (h21(vec2(band, 3.)) - .5) * .12;

    vec3 p = vec3(uv.x - .5 + slip, uv.y, side * (.012 + d) * uThick);
    // rising out of the lens (and draining back into it): each dot a beat after the last, spiralling a little
    float k = clamp((uRise - aRand * .45) / .55, 0., 1.);
    k = k * k * (3. - 2. * k);
    float a = aRand * 40. + uTime * .8 * uMotion;
    vec3 lens = vec3(cos(a) * .03, uLensY, sin(a) * .03);
    p = mix(lens, p, k);
    vA = k;
    vY = uv.y;

    vec4 mv = modelViewMatrix * vec4(p, 1.);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize / -mv.z;
  }`;

const FS = /* glsl */ `
  uniform vec3 uInk;
  uniform float uAlpha, uTime, uMotion;
  varying float vA, vY, vShade, vGlow;
  void main() {
    if (vA <= 0.) discard;
    float r = length(gl_PointCoord - .5);
    if (r > .5) discard;
    float scan = 1. - (.25 + .25 * uMotion) * smoothstep(.3, 1., sin((vY * 46. - uTime * 1.3) * 6.2832) * .5 + .5);   // bands drifting up
    float a = clamp(vShade + vGlow * .5, 0., 1.) * scan * (1. - r * 1.2) * vA * uAlpha;
    gl_FragColor = vec4(uInk, clamp(a, 0., 1.));
  }`;

export class DepthHologram {
  /**
   * @param {{ grid?: number, frame: { w: number, h: number, gap: number }, ink: THREE.Vector3, reduceMotion?: boolean }} o
   */
  constructor({ grid = 160, frame, ink, reduceMotion = false }) {
    this.frame = frame;
    this.reduceMotion = reduceMotion;
    const n = grid * grid, pos = new Float32Array(n * 2 * 3), rnd = new Float32Array(n * 2);
    for (let side = 0, i = 0; side < 2; side++) {
      for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++, i++) {
        pos.set([(x + 0.5) / grid, (y + 0.5) / grid, side ? -1 : 1], i * 3);
        rnd[i] = Math.random();
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));

    const video = this.video = document.createElement('video');
    Object.assign(video, { muted: true, loop: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
    video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
    const tex = this.texture = new THREE.VideoTexture(video);
    Object.assign(tex, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      colorSpace: THREE.NoColorSpace });
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.blank = blank;

    const U = (v) => ({ value: v });
    this.material = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      uniforms: { uDepth: U(blank), uSize: U(1), uRise: U(0), uTime: U(0), uGlitch: U(0), uThick: U(0.32),
        uLensY: U(-frame.gap / frame.h), uMotion: U(reduceMotion ? 0 : 1), uCell: U(1 / grid), uAlpha: U(0), uInk: U(ink.clone()) },
    });
    const pts = this.points = new THREE.Points(g, this.material);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    pts.scale.setScalar(frame.h);
    pts.position.y = frame.gap;
    pts.rotation.order = 'YXZ';
    this.object3d = pts;

    this.rise = 0;                 // 0 = in the lens, 1 = standing in place
    this.shown = null;             // { url, developing } the dots belong to
    this.want = null;              // what show() asked for last
    this.loaded = null;            // url whose frames are in the video
    this.ready = false;            // the video has a frame to show
    this._waiters = [];
    video.addEventListener('loadeddata', () => { this.ready = true; tex.needsUpdate = true; this._play(); });
    video.addEventListener('error', () => {
      if (!this.loaded) return;
      console.warn(`memory-projector: could not load memory video ${this.loaded}`);
      this.ready = false; this.failed = this.loaded;
    });
  }

  /** Show the memory at `url` (null: nothing). Resolves once it has risen, or when a newer call supersedes it. */
  show(url, { developing = false } = {}) {
    this.want = { url: url || null, developing };
    if (this.shown && this.shown.url === this.want.url) this._play();   // same memory again: just make sure it plays
    return new Promise((resolve) => this._waiters.push({ want: this.want, resolve }));
  }

  _play() {
    if (this.reduceMotion || !this.ready) return;
    const p = this.video.play();
    if (p && p.catch) p.catch(() => { /* autoplay refused: the first frame stays up; the next show() tries again */ });
  }

  _load(url) {
    this.ready = false;
    this.failed = null;
    this.loaded = url;
    this.material.uniforms.uDepth.value = url ? this.texture : this.blank;
    if (!url) { this.video.removeAttribute('src'); this.video.load(); return; }
    this.video.src = url;
    this.video.load();
  }

  _settle(done) {
    this._waiters = this._waiters.filter((w) => {
      if (w.want !== this.want || done) { w.resolve(); return false; }
      return true;
    });
  }

  /** Every frame: dt and t in seconds; power 0..1; glitch 0..1; flicker ~1. */
  update(dt, t, { power = 1, glitch = 0, flicker = 1, size = 1 } = {}) {
    const u = this.material.uniforms, want = this.want;
    if (want && (!this.shown || this.shown.url !== want.url)) {
      // draining the last memory into the lens, then swapping in the next
      this.rise = this.reduceMotion ? 0 : Math.max(0, this.rise - dt / DRAIN_S);
      if (this.rise === 0) {
        this.shown = want;
        if (this.loaded !== want.url) this._load(want.url);
        else this._play();
        this._settle(false);
      }
    } else if (this.shown) {
      const hasFigure = this.shown.url && this.ready && this.failed !== this.shown.url;
      if (hasFigure) {
        const dur = this.shown.developing ? DEVELOP_S : RISE_S;
        this.rise = this.reduceMotion ? 1 : Math.min(1, this.rise + dt / dur);
        if (this.rise >= 1) this._settle(true);
      } else if (!this.shown.url || this.failed === this.shown.url) this._settle(true);
    }
    u.uRise.value = this.rise;
    u.uTime.value = this.reduceMotion ? 0 : t;
    u.uGlitch.value = this.reduceMotion ? 0 : glitch;
    // a slow, uneven flicker on top of the projector's own (±12 %)
    const slow = this.reduceMotion ? 1 : 1 - 0.12 * (0.5 + 0.5 * Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1.3));
    u.uAlpha.value = power * flicker * slow;
    u.uSize.value = size;
    this.points.visible = this.rise > 0.001 && power > 0.001 && !!(this.shown && this.shown.url);
  }

  /** True while the dots stand in place (not draining or rising). */
  get settled() { return this.rise >= 1; }
}
