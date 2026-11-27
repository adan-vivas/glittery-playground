// The memory, floating above the lens: a depth video rebuilt as dots on the GPU.
//
// A memory is a greyscale video (see lib/depth-format.js). Format 2: the figures' picture on the left, their depth on
// the right; format 1: the depth alone. In the depth, black is where nobody is, and a figure's depth runs from 64
// (farthest) to 255 (nearest). A fine grid of dots samples each frame: dots over black are dropped, the rest stand at
// their depth toward the viewer, with a sparser, faint back layer so the figures have volume when they turn. Each dot
// is as bright as the picture there (format 2), lit by the shape: normals from the depth's slope give a key from the
// top left and a rim, and the thin edge glows. One dot per pixel, so the picture's detail survives. The look is a hologram's: blue, translucent, scanlines drifting up, flicker, now and then a glitch.
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
  uniform float uSize, uRise, uTime, uGlitch, uThick, uLensY, uMotion, uTexel, uFormat, uDensity, uContrast, uBack, uTouchR, uTouchK;
  uniform vec4 uTouches[8];                    // the cursor's recent path: xy in the hologram's frame, w = strength
  attribute float aRand, aCell;
  varying float vA, vY, vShade, vGlow;

  float depthAt(vec2 uv) {                     // 0..1, or -1 where nobody is
    float v = texture2D(uDepth, uFormat > 1.5 ? vec2(.5 + uv.x * .5, uv.y) : uv).r * 255.;
    return v < EMPTY_BELOW ? -1. : clamp((v - FIGURE_MIN) / FIGURE_SPAN, 0., 1.);
  }
  float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec2 uv = position.xy;                       // 0..1 across the frame, v up
    float side = position.z;                     // +1 the front surface, -1 the back
    uv += (vec2(fract(aRand * 91.7), fract(aRand * 53.3)) - .5) * aCell * .7;   // break up the grid
    float d = depthAt(uv);
    vA = 0.;
    if (d < 0. || fract(aRand * 7.31) >= uDensity) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 0.; return; }

    // slope of the shape, for light and shade (outside the figure counts as the edge, depth 0)
    float e = uTexel * 2.;
    float dl = max(depthAt(uv - vec2(e, 0.)), 0.), dr = max(depthAt(uv + vec2(e, 0.)), 0.);
    float db = max(depthAt(uv - vec2(0., e)), 0.), dt = max(depthAt(uv + vec2(0., e)), 0.);
    // the surface's real slope: depth is uThick of the frame deep, sampled 2e apart
    vec3 n = normalize(vec3((dl - dr) * uThick / (2. * e), (db - dt) * uThick / (2. * e), side));
    vec3 L = normalize(vec3(-.5, .6, .62 * side));
    float key = max(dot(n, L), 0.);
    float rim = pow(1. - abs(n.z), 3.);
    // light picks out the relief; nearer parts are denser; the back is a faint ghost that gives volume when it turns
    float relief = (.28 + 1.1 * pow(key, 1.5) + .4 * rim) * (.6 + .4 * d);
    float luma = clamp((texture2D(uDepth, vec2(uv.x * .5, uv.y)).r - .5) * uContrast + .5, 0., 1.);
    vShade = (uFormat > 1.5 ? (.32 + .78 * luma) * (.55 + .45 * min(relief, 1.3)) : relief) * (side > 0. ? 1. : uBack);   // the back: a trace
    vGlow = (1. - smoothstep(0., .18, d)) * (side > 0. ? 1. : .3);   // the thin edge of the figure glows

    // a glitch: now and then a band of the figure slips sideways
    float band = floor(uv.y * 24. + floor(uTime * 7.));
    float slip = uGlitch * uMotion * step(.86, h21(vec2(band, floor(uTime * 9.)))) * (h21(vec2(band, 3.)) - .5) * .12;

    vec3 p = vec3(uv.x - .5 + slip, uv.y, side * (.012 + d) * uThick);
    // touch: the cursor's path pushes dots aside and sets them rippling; each point fades, and the dots drift back
    for (int i = 0; i < 8; i++) {
      vec4 t = uTouches[i];
      if (t.w <= .001) continue;
      vec2 dd = p.xy - t.xy;
      float f = t.w * exp(-dot(dd, dd) / (uTouchR * uTouchR));
      p.xy += (length(dd) > 1e-4 ? normalize(dd) : vec2(0., 1.)) * f * uTouchR * .8 * uTouchK;
      p.z += f * uTouchR * uTouchK * (.6 + .6 * sin(aRand * 31. + uTime * 7.));
    }
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
  uniform float uAlpha, uTime, uMotion, uScan, uScanCount, uGain;
  varying float vA, vY, vShade, vGlow;
  void main() {
    if (vA <= 0.) discard;
    float r = length(gl_PointCoord - .5);
    if (r > .5) discard;
    float scan = 1. - uScan * (.5 + .5 * uMotion) * smoothstep(.3, 1., sin((vY * uScanCount - uTime * 1.3) * 6.2832) * .5 + .5);   // bands drifting up
    float a = clamp(vShade + vGlow * .5, 0., 1.) * scan * (1. - r * 1.2) * vA * uAlpha * uGain;
    gl_FragColor = vec4(uInk, clamp(a, 0., 1.));
  }`;

export class DepthHologram {
  /**
   * @param {{ grid?: number, frame: { w: number, h: number, gap: number }, ink: THREE.Vector3, reduceMotion?: boolean }} o
   */
  constructor({ grid = 512, frame, ink, reduceMotion = false }) {
    this.frame = frame;
    this.reduceMotion = reduceMotion;
    const back = Math.max(1, grid >> 1), n = grid * grid + back * back;   // the back layer: half as fine, faint
    const pos = new Float32Array(n * 3), rnd = new Float32Array(n), cell = new Float32Array(n);
    let i = 0;
    for (const [G, side] of [[grid, 1], [back, -1]]) {
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++, i++) {
        pos.set([(x + 0.5) / G, (y + 0.5) / G, side], i * 3);
        rnd[i] = Math.random(); cell[i] = 1 / G;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    g.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));

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
        uLensY: U(-frame.gap / frame.h), uMotion: U(reduceMotion ? 0 : 1), uTexel: U(1 / 512), uFormat: U(1), uDensity: U(1), uContrast: U(1), uBack: U(0.06),
        uTouches: U(Array.from({ length: 8 }, () => new THREE.Vector4())), uTouchR: U(0.12), uTouchK: U(1),
        uScan: U(0.5), uScanCount: U(46), uGain: U(1), uAlpha: U(0), uInk: U(ink.clone()) },
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
    video.addEventListener('loadeddata', () => {
      // the file says what it is: twice as wide as tall is format 2 (picture | depth), square is format 1 (depth only)
      this.material.uniforms.uFormat.value = video.videoWidth >= 1.5 * video.videoHeight ? 2 : 1;
      this.ready = true; tex.needsUpdate = true; this._play();
    });
    video.addEventListener('error', () => {
      if (!this.loaded) return;
      console.warn(`memory-projector: could not load memory video ${this.loaded}`);
      this.ready = false; this.failed = this.loaded;
    });
  }

  /** Show the memory at `url` (null: nothing). Resolves once it has risen, or when a newer call supersedes it. */
  show(url, { developing = false, format = 1 } = {}) {
    this.want = { url: url || null, developing, format };
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
        this.material.uniforms.uFormat.value = want.format || 1;
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
    const slow = this.reduceMotion ? 1 : 1 - (this.flickerAmount ?? 0.12) * (0.5 + 0.5 * Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1.3));
    for (const v of u.uTouches.value) v.w *= Math.exp(-dt * (this.touchRecover ?? 1.5));   // the touch fades: dots drift back
    u.uAlpha.value = power * flicker * slow;
    u.uSize.value = size;
    this.points.visible = this.rise > 0.001 && power > 0.001 && !!(this.shown && this.shown.url);
  }

  /**
   * The look, live: { dotSize, density 0..1, brightness, contrast, depth, scanlines 0..1, scanCount, flicker 0..1,
   * back 0..1, color '#rrggbb' } and touch { on, radius, strength, recover }. Missing keys stay as they are.
   */
  setLook(look = {}, touch = {}) {
    const u = this.material.uniforms;
    if (look.density != null) u.uDensity.value = look.density;
    if (look.brightness != null) u.uGain.value = look.brightness;
    if (look.contrast != null) u.uContrast.value = look.contrast;
    if (look.depth != null) u.uThick.value = look.depth;
    if (look.scanlines != null) u.uScan.value = look.scanlines;
    if (look.scanCount != null) u.uScanCount.value = look.scanCount;
    if (look.back != null) u.uBack.value = look.back;
    if (look.flicker != null) this.flickerAmount = look.flicker;
    if (look.color) { const c = new THREE.Color(look.color); u.uInk.value.set(c.r, c.g, c.b); }
    if (touch.on != null) this.touchOn = touch.on;
    if (touch.radius != null) u.uTouchR.value = touch.radius;
    if (touch.strength != null) u.uTouchK.value = touch.strength;
    if (touch.recover != null) this.touchRecover = touch.recover;
  }

  /** The cursor at a point in the hologram's own space (x across, y up, 1 = its height): disturbs the dots there. */
  touch(x, y) {
    if (this.touchOn === false) return;
    const T = this.material.uniforms.uTouches.value, last = T[this._touchI ?? 0];
    if (last.w > 0.5 && Math.hypot(last.x - x, last.y - y) < 0.02) { last.w = 1; return; }   // still: keep one point alive
    this._touchI = ((this._touchI ?? 0) + 1) % T.length;
    T[this._touchI].set(x, y, 0, 1);
  }

  /** True while the dots stand in place (not draining or rising). */
  get settled() { return this.rise >= 1; }
}
