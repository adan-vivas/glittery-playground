// <temporal-projector> — interactive three.js web component.
//
//   <script type="importmap">{ "imports": {
//     "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
//     "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }</script>
//   <script type="module" src="temporal-projector.js"></script>
//   <temporal-projector date="2026"></temporal-projector>
//
// Attributes: date (1996|2006|2016|2026|FUTURE), power (on|off), zoom (boolean), muted (boolean),
//             src (GLB url), shadow (shadow PNG url)
// Events:     "datechange"  detail { date, projected }
//             "powerchange" detail { on }
// Methods:    setDate(label), randomFuture(), togglePower()

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

function studioEnvironment(renderer) {
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

class TemporalProjector extends HTMLElement {
  static observedAttributes = ['date', 'power', 'zoom', 'muted'];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
    this.canvas = this.shadowRoot.querySelector('canvas');
    this.live = this.shadowRoot.querySelector('.sr');
    this.clicker = new Clicker();
    this.state = { power: true, index: 3, projected: '2026' };
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
    if (name === 'zoom') this.controls.enableZoom = val !== null;
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
    scene.environment = studioEnvironment(renderer);
    scene.environmentIntensity = 1.0;

    const camera = this.camera = new THREE.PerspectiveCamera(22, 1, 0.01, 5);
    const controls = this.controls = new OrbitControls(camera, this.canvas);
    controls.target.set(0.004, 0.012, 0.012);
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
    scene.add(shadow);

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
    scene.add(device);
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
      scene.add(s);
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
    scene.add(this.proj);

    // animation state
    this.dialSpring = new Spring(DATES[this.state.index].angle, 240, 0.55);
    this.keySpring = new Spring(0, 900, 0.7);
    this.powerSpring = new Spring(0, 900, 0.7);
    this.lightSpring = new Spring(this.state.power ? 1 : 0, 60, 1);
    this.projFade = new Spring(this.state.power ? 1 : 0, 80, 1);
    this.lastDetent = this.state.index;
    this._applyDial(this.dialSpring.v);
    this._drawProjection(this._labelFor(this.state.index));
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
    // keep the whole device + projection in frame at any aspect ratio
    const r = 0.072, vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = r / Math.sin(Math.min(vfov, hfov) / 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.maxDistance = Math.max(dist * 1.6, 0.4);
    this.camera.updateProjectionMatrix();
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
      return THREE.MathUtils.radToDeg(Math.atan2(-(hitPoint.z - DIAL_C.z), hitPoint.x - DIAL_C.x));
    };

    let drag = null, pressed = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      const target = pick(e);
      if (!target) return;
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
      if (!pressed && e.pointerType === 'mouse') this.canvas.style.cursor = pick(e) ? 'pointer' : 'grab';
    });

    const end = () => {
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
      this.controls.enabled = true;
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
    if (i !== 4) this.futureYear = null;
    if (changed || !this.futureYear) this._project(this._labelFor(i), 260);
  }

  randomFuture() {
    if (!this.state.power) return;
    // plausible: near futures more likely than far ones
    this.futureYear = 2026 + Math.round(4 + Math.pow(Math.random(), 1.7) * 70);
    this.state.index = 4;
    this.dialSpring.t = DATES[4].angle;
    this._project(String(this.futureYear), 900);
    this.pulse = 1;
  }

  togglePower() { this._setPower(!this.state.power); }

  _setPower(on) {
    if (on === this.state.power) return;
    this.state.power = on;
    this.lightSpring.t = on ? 1 : 0;
    this.projFade.t = on ? 1 : 0;
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
  }

  _project(text, ms) {
    this.state.projected = text;
    clearInterval(this._scramble);
    const finish = () => {
      this._drawProjection(text);
      this.dispatchEvent(new CustomEvent('datechange', {
        detail: { date: DATES[this.state.index].label, projected: text }, bubbles: true, composed: true }));
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
    this.live.textContent = this.state.power ? `Projecting ${this.state.projected}` : 'Powered off';
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

customElements.define('temporal-projector', TemporalProjector);
export { TemporalProjector };
