import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Stage } from './track.js';
import { buildWorld } from './world.js';
import { CarPhysics } from './car.js';
import { buildCarModel } from './carmodel.js';
import { Dust } from './dust.js';
import { CarAudio } from './audio.js';
import { Rival, RIVAL_DEFS } from './rivals.js';
import { SkillChain } from './skills.js';
import { boxContact, resolveContact } from './contact.js';
import { clamp, lerp } from './noise.js';

// ---------------------------------------------------------------------------------------
// Stage presets
const STAGES = [
  {
    id: 'canyon-run',
    name: 'Canyon Run',
    subtitle: 'Afternoon · 2.6 km',
    seed: 1207,
    length: 2600,
    sun: { elevation: 24, azimuthOffset: 140 },
    sky: { turbidity: 3.5, rayleigh: 1.3, mie: 0.004, mieG: 0.8 },
    exposure: 0.5,
    sunColor: '#fff0dc',
    sunIntensity: 4.2,
    hemi: ['#a8c8ff', '#b4643c', 1.5],
    fog: ['#cdd3d4', 420, 3600],
    palette: {
      sandA: '#b8693e', sandB: '#d08c5a', rock: '#8e3d22', roadEdge: '#c48a60', boulder: '#9c4a2a',
      shrubs: ['#6f6d36', '#7d7a3e', '#5d6430', '#8a7a48'], grass: '#b89c5c',
    },
    dust: ['#c58a62', '#fff0dc'],
  },
  {
    id: 'sundown-pass',
    name: 'Sundown Pass',
    subtitle: 'Golden hour · 3.0 km',
    seed: 3391,
    length: 3000,
    sun: { elevation: 9, azimuthOffset: 8 },
    sky: { turbidity: 4.5, rayleigh: 1.9, mie: 0.005, mieG: 0.86 },
    exposure: 0.5,
    sunColor: '#ffb066',
    sunIntensity: 6.5,
    hemi: ['#8fb0e6', '#a8502c', 1.7],
    fog: ['#e0a47a', 380, 3200],
    palette: {
      sandA: '#b25a32', sandB: '#cf8350', rock: '#83351c', roadEdge: '#c27f52', boulder: '#953f22',
      shrubs: ['#6a6232', '#7b6c38', '#5a5a2c', '#87703f'], grass: '#c49a52',
    },
    dust: ['#cf8a58', '#ffc58a'],
  },
];

// ---------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 6000);

const sky = new Sky();
sky.scale.setScalar(5500);
scene.add(sky);
// the same sky, rendered into an environment map for paint and glass reflections
const envScene = new THREE.Scene();
const envSky = new Sky();
envSky.material = sky.material;
envSky.scale.setScalar(1000);
envScene.add(envSky);
const pmrem = new THREE.PMREMGenerator(renderer);
let envTarget = null;

const sunLight = new THREE.DirectionalLight('#ffffff', 4);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
sunLight.shadow.camera.left = -70;
sunLight.shadow.camera.right = 70;
sunLight.shadow.camera.top = 70;
sunLight.shadow.camera.bottom = -70;
sunLight.shadow.camera.near = 10;
sunLight.shadow.camera.far = 500;
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.04;
scene.add(sunLight, sunLight.target);
const hemi = new THREE.HemisphereLight('#ffffff', '#ffffff', 1);
scene.add(hemi);

// Lens flare (procedural textures)
function glowTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const flareMain = glowTexture(256, [[0, 'rgba(255,255,245,1)'], [0.12, 'rgba(255,240,200,0.9)'], [0.35, 'rgba(255,180,90,0.25)'], [1, 'rgba(255,140,60,0)']]);
const flareRing = glowTexture(128, [[0, 'rgba(255,255,255,0)'], [0.75, 'rgba(255,220,160,0)'], [0.85, 'rgba(255,220,160,0.35)'], [1, 'rgba(255,200,140,0)']]);
const flareDot = glowTexture(64, [[0, 'rgba(255,230,190,0.6)'], [1, 'rgba(255,200,150,0)']]);
const flareLight = new THREE.PointLight('#ffffff', 0, 1);
const lensflare = new Lensflare();
lensflare.addElement(new LensflareElement(flareMain, 520, 0, new THREE.Color('#ffffff')));
lensflare.addElement(new LensflareElement(flareRing, 160, 0.35, new THREE.Color('#ffd9a0')));
lensflare.addElement(new LensflareElement(flareDot, 60, 0.6, new THREE.Color('#ffb070')));
lensflare.addElement(new LensflareElement(flareDot, 90, 0.75, new THREE.Color('#9fd0ff')));
lensflare.addElement(new LensflareElement(flareRing, 220, 1.0, new THREE.Color('#ffc890')));
flareLight.add(lensflare);
scene.add(flareLight);

// Post
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.2, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());
let useBloom = !isTouch;

// Car model
const model = buildCarModel();
scene.add(model.car);
const cleanPaint = new THREE.Color('#ffffff'); // livery lives in the paint texture
const dirtyPaint = new THREE.Color('#c99c78');

const dust = new Dust(scene);
const audio = new CarAudio();

// ---------------------------------------------------------------------------------------
// Game state
let stageDef = null;
let stage = null;
let world = null;
let physics = null;
let state = 'loading'; // menu | countdown | running | paused | finished
let raceTime = 0;
let countdown = 0;
let lastCountBeep = 0;
let progress = 0;
let splits = [];
let splitIndices = [];
let splitTimes = [];
let dirt = 0;
let camMode = 0; // 0 chase, 1 hood, 2 far chase
let voiceOn = true;
let spokenNote = -1;
let menuAngle = 0;
let shake = 0;
let mode = 'race'; // race | attack
let cinematicCam = null; // optional camera override (trailer capture)
let bestPosition = Infinity;
let finalPosition = null;
const rivalWheels = [new THREE.Vector3(), new THREE.Vector3()];
const rivals = RIVAL_DEFS.map((def) => new Rival(def, scene));

// Skill chain HUD
let skillPopTimer = 0;
const skills = new SkillChain((type, p) => {
  const pop = $('skill-pop');
  if (type === 'drifting') return; // live drift points are read straight from the chain
  if (type === 'skill') {
    $('sp-label').textContent = p.label;
    $('sp-points').textContent = `+${p.points.toLocaleString('en-US')}`;
    pop.className = 'show';
    skillPopTimer = 1.6;
    if (p.count > 1) audio.beep(700 + Math.min(p.count, 10) * 60, 0.07);
  } else if (type === 'banked') {
    $('sp-label').textContent = p.tier;
    $('sp-points').textContent = `+${p.value.toLocaleString('en-US')}`;
    pop.className = 'show banked';
    skillPopTimer = 2.2;
    audio.beep(1180, 0.15);
  } else if (type === 'broken') {
    $('sp-label').textContent = 'CHAIN BROKEN';
    $('sp-points').textContent = p.reason;
    pop.className = 'show broken';
    skillPopTimer = 1.6;
  }
});

function updateSkillHud(reset = false) {
  if (reset) {
    skillPopTimer = 0;
    $('skill-pop').className = '';
  }
  $('skill-total').textContent = skills.total.toLocaleString('en-US');
  const chain = $('skill-chain');
  const live = skills.drift > 0 ? Math.round(skills.drift) : 0;
  if (skills.pending > 0 || live > 0) {
    chain.classList.add('show');
    $('sc-mult').textContent = `×${skills.multiplier.toFixed(2)}`;
    $('sc-pending').textContent = (skills.pending + live).toLocaleString('en-US');
    $('sc-live').textContent = live > 0 ? `DRIFT ${live.toLocaleString('en-US')}` : '';
    $('sc-bar').style.transform = `scaleX(${clamp(skills.timer / 3, 0, 1).toFixed(3)})`;
  } else {
    chain.classList.remove('show');
  }
}
const sunDir = new THREE.Vector3();

const storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

function loadStage(def) {
  if (world) {
    scene.remove(world.group);
    world.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (m.map) m.map.dispose();
        if (m.alphaMap) m.alphaMap.dispose();
        m.dispose();
      });
    });
  }
  stageDef = def;
  stage = new Stage(def.seed, def.length);
  world = buildWorld(scene, stage, def.palette);
  physics = new CarPhysics(stage);

  // atmosphere
  const u = sky.material.uniforms;
  u.turbidity.value = def.sky.turbidity;
  u.rayleigh.value = def.sky.rayleigh;
  u.mieCoefficient.value = def.sky.mie;
  u.mieDirectionalG.value = def.sky.mieG;
  renderer.toneMappingExposure = def.exposure;
  // put the sun relative to the start direction so the first straight is (partly) into the light
  const t0 = stage.tangents[stage.startIndex];
  const startAz = Math.atan2(t0.x, t0.y);
  const az = startAz + THREE.MathUtils.degToRad(def.sun.azimuthOffset);
  const el = THREE.MathUtils.degToRad(def.sun.elevation);
  sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  u.sunPosition.value.copy(sunDir);
  if (envTarget) envTarget.dispose();
  envTarget = pmrem.fromScene(envScene);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.45;
  sunLight.color.set(def.sunColor);
  sunLight.intensity = def.sunIntensity;
  hemi.color.set(def.hemi[0]);
  hemi.groundColor.set(def.hemi[1]);
  hemi.intensity = def.hemi[2];
  scene.fog = new THREE.Fog(def.fog[0], def.fog[1], def.fog[2]);
  dust.setPalette(def.dust[0], def.dust[1]);
  dust.clear();

  splitIndices = [1 / 3, 2 / 3].map((f) => Math.floor(stage.startIndex + (stage.finishIndex - stage.startIndex) * f));
  drawMinimapBase();
  resetRace();
}

function resetRace() {
  physics.reset(stage.startIndex);
  progress = stage.startIndex;
  raceTime = 0;
  splits = [];
  splitTimes = [];
  dirt = 0;
  spokenNote = -1;
  shake = 0;
  dust.clear();
  skills.reset();
  bestPosition = Infinity;
  finalPosition = null;
  // rolling grid: the rivals line up ahead of the player in two staggered columns
  rivals.forEach((r, k) => {
    r.place(stage, stage.startIndex * stage.step + 16 + k * 9, k % 2 ? -2.2 : 2.2);
    r.setVisible(mode === 'race');
  });
  updateSkillHud(true);
  hideAll();
}

const raceRivals = () => (mode === 'race' ? rivals : []);

function playerRoadFrame() {
  const i = physics.roadIndex;
  const p = stage.samples[i];
  const t = stage.tangents[i];
  const dx = physics.pos.x - p.x;
  const dz = physics.pos.z - p.y;
  return {
    s: i * stage.step + dx * t.x + dz * t.y,
    offset: dx * -t.y + dz * t.x, // along the road's right vector
  };
}

function racePosition(playerS) {
  if (mode !== 'race') return null;
  let ahead = 0;
  for (const r of rivals) if (r.finished || r.s > playerS) ahead++;
  return ahead + 1;
}

// Car-to-car contact with oriented boxes: where the cars connect decides how they are
// pushed and spun. Returns the player's worst velocity change this frame (m/s).
function playerBody() {
  return {
    x: physics.pos.x,
    z: physics.pos.z,
    heading: physics.heading,
    vx: physics.vel.x,
    vz: physics.vel.z,
    w: -physics.yawRate, // physics.yawRate > 0 turns right, i.e. the heading decreases
    invMass: 1 / physics.mass,
    invInertia: 1 / physics.inertia,
  };
}

function collideCars() {
  const list = raceRivals();
  let worst = 0;
  for (const r of list) {
    if (Math.abs(physics.pos.y - r.pos.y) > 2 || !physics.grounded) continue;
    const a = playerBody();
    const b = r.body();
    const c = boxContact(a, b);
    if (!c) continue;
    const res = resolveContact(a, b, c);
    physics.vel.x += res.dvax;
    physics.vel.z += res.dvaz;
    physics.yawRate -= res.dwa;
    physics.pos.x += c.nx * c.depth * 0.5;
    physics.pos.z += c.nz * c.depth * 0.5;
    r.applyContact(res.dvbx, res.dvbz, res.dwb, -c.nx * c.depth * 0.5, -c.nz * c.depth * 0.5);
    worst = Math.max(worst, Math.hypot(res.dvax, res.dvaz));
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ra = list[i];
      const rb = list[j];
      const a = ra.body();
      const b = rb.body();
      const c = boxContact(a, b);
      if (!c) continue;
      // AI drivers lean on each other less: softer bounce, less scrub, harder to unsettle
      const res = resolveContact(a, b, c, { restitution: 0.1, friction: 0.2 });
      ra.applyContact(res.dvax, res.dvaz, res.dwa, c.nx * c.depth * 0.5, c.nz * c.depth * 0.5, 2.2);
      rb.applyContact(res.dvbx, res.dvbz, res.dwb, -c.nx * c.depth * 0.5, -c.nz * c.depth * 0.5, 2.2);
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------------------
// Input
const keys = new Set();
const touch = { left: false, right: false, gas: false, brake: false, hb: false };
const input = { steer: 0, throttle: 0, brake: 0, handbrake: false };
let gamepadIndex = null;

addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  audio.start();
  switch (e.code) {
    case 'KeyC': camMode = (camMode + 1) % 3; break;
    case 'KeyR': if (state === 'running') resetToRoad(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyV': toggleVoice(); break;
    case 'KeyP':
    case 'Escape': togglePause(); break;
    case 'Enter':
      if (state === 'finished' || state === 'paused') startCountdown();
      else if (state === 'menu') startCountdown();
      break;
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('gamepadconnected', (e) => { gamepadIndex = e.gamepad.index; });

function bindTouch(id, prop) {
  const el = $(id);
  const on = (e) => { e.preventDefault(); touch[prop] = true; el.classList.add('down'); audio.start(); };
  const off = (e) => { e.preventDefault(); touch[prop] = false; el.classList.remove('down'); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
}
bindTouch('t-left', 'left');
bindTouch('t-right', 'right');
bindTouch('t-gas', 'gas');
bindTouch('t-brake', 'brake');
bindTouch('t-hb', 'hb');
if (isTouch) document.body.classList.add('touch');

function readInput() {
  const k = (...codes) => codes.some((c) => keys.has(c));
  let steer = (k('ArrowRight', 'KeyD') || touch.right ? 1 : 0) - (k('ArrowLeft', 'KeyA') || touch.left ? 1 : 0);
  let throttle = k('ArrowUp', 'KeyW') || touch.gas ? 1 : 0;
  let brake = k('ArrowDown', 'KeyS') || touch.brake ? 1 : 0;
  let handbrake = k('Space') || touch.hb;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = gamepadIndex !== null ? pads[gamepadIndex] : null;
  if (gp) {
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.12) steer = ax;
    throttle = Math.max(throttle, gp.buttons[7]?.value || 0);
    brake = Math.max(brake, gp.buttons[6]?.value || 0);
    handbrake = handbrake || gp.buttons[0]?.pressed || gp.buttons[2]?.pressed;
  }
  input.steer = clamp(steer, -1, 1);
  input.throttle = throttle;
  input.brake = brake;
  input.handbrake = !!handbrake;
}

function resetToRoad() {
  physics.reset(Math.max(progress, stage.startIndex));
  dust.clear();
  flash('Car reset to the road');
}

function toggleMute() {
  audio.setMuted(!audio.muted);
  $('btn-mute').textContent = audio.muted ? '🔇' : '🔊';
}
function toggleVoice() {
  voiceOn = !voiceOn;
  $('btn-voice').classList.toggle('off', !voiceOn);
  if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
  flash(voiceOn ? 'Co-driver voice on' : 'Co-driver voice off');
}
function togglePause() {
  if (state === 'running' || state === 'countdown') {
    state = 'paused';
    show('pause');
  } else if (state === 'paused') {
    state = countdown > 0 ? 'countdown' : 'running';
    hide('pause');
  }
}

// ---------------------------------------------------------------------------------------
// UI helpers
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');
function hideAll() {
  for (const id of ['menu', 'pause', 'results']) hide(id);
}
let flashTimer = 0;
function flash(text, secs = 1.6) {
  const el = $('flash');
  el.textContent = text;
  el.classList.add('show');
  flashTimer = secs;
}
function fmt(t) {
  if (t == null || !isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
function fmtDelta(d) {
  const sign = d < 0 ? '−' : '+';
  return `${sign}${Math.abs(d).toFixed(2)}`;
}

const bestKey = (def) => `rmr.best.${def.id}.${mode}`;

function buildMenu() {
  document.querySelectorAll('#mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const list = $('stage-list');
  list.innerHTML = '';
  STAGES.forEach((def, i) => {
    const best = storage.get(bestKey(def));
    const b = document.createElement('button');
    b.className = 'stage-card' + (def === stageDef ? ' active' : '');
    b.innerHTML = `<span class="num">SS${i + 1}</span><span class="name">${def.name}</span><span class="sub">${def.subtitle}</span><span class="best">Best ${best ? fmt(best.time) : '—'}</span>`;
    b.addEventListener('click', () => {
      audio.start();
      if (def !== stageDef) {
        $('loading').classList.remove('hidden');
        // let the loading label paint before the heavy generation
        setTimeout(() => {
          loadStage(def);
          $('loading').classList.add('hidden');
          state = 'menu';
          show('menu');
          buildMenu();
        }, 30);
      }
    });
    list.appendChild(b);
  });
}

function startCountdown() {
  audio.start();
  resetRace();
  state = 'countdown';
  countdown = 3.0;
  lastCountBeep = 4;
}

document.querySelectorAll('#mode-toggle button').forEach((b) =>
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    storage.set('rmr.mode', mode);
    resetRace();
    state = 'menu';
    buildMenu();
    show('menu');
  })
);
$('btn-start').addEventListener('click', startCountdown);
$('btn-retry').addEventListener('click', startCountdown);
$('btn-menu').addEventListener('click', () => { resetRace(); state = 'menu'; buildMenu(); show('menu'); });
$('btn-resume').addEventListener('click', togglePause);
$('btn-restart').addEventListener('click', startCountdown);
$('btn-quit').addEventListener('click', () => { resetRace(); state = 'menu'; buildMenu(); show('menu'); });
$('btn-mute').addEventListener('click', toggleMute);
$('btn-voice').addEventListener('click', toggleVoice);
$('btn-cam').addEventListener('click', () => { camMode = (camMode + 1) % 3; });
$('btn-reset').addEventListener('click', () => { if (state === 'running') resetToRoad(); });
$('btn-pause').addEventListener('click', togglePause);

// ---------------------------------------------------------------------------------------
// Minimap
const mini = $('minimap');
const miniCtx = mini.getContext('2d');
const miniBase = document.createElement('canvas');
let miniXf = null;
function drawMinimapBase() {
  const size = (mini.width = miniBase.width = 360);
  mini.height = miniBase.height = size;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of stage.samples) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.y); maxZ = Math.max(maxZ, p.y);
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  const sc = (size - 50) / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // top-down view with +z up on the canvas; that puts +x on the left
  miniXf = (x, z) => [size / 2 - (x - cx) * sc, size / 2 - (z - cz) * sc];
  const ctx = miniBase.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    stage.samples.forEach((p, i) => {
      const [x, y] = miniXf(p.x, p.y);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
  };
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 12;
  path();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,240,225,0.9)';
  ctx.lineWidth = 5;
  path();
  ctx.stroke();
  const dot = (i, col) => {
    const [x, y] = miniXf(stage.samples[i].x, stage.samples[i].y);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
  };
  dot(stage.startIndex, '#3ccf6e');
  for (const si of splitIndices) dot(si, '#ffd23f');
  dot(stage.finishIndex, '#ffffff');
}
function drawMinimap() {
  const size = mini.width;
  miniCtx.clearRect(0, 0, size, size);
  miniCtx.drawImage(miniBase, 0, 0);
  // driven part
  miniCtx.strokeStyle = '#ff6b2c';
  miniCtx.lineWidth = 5;
  miniCtx.lineCap = 'round';
  miniCtx.beginPath();
  for (let i = stage.startIndex; i <= progress; i += 2) {
    const [x, y] = miniXf(stage.samples[i].x, stage.samples[i].y);
    if (i === stage.startIndex) miniCtx.moveTo(x, y); else miniCtx.lineTo(x, y);
  }
  miniCtx.stroke();
  for (const r of raceRivals()) {
    const [rx, ry] = miniXf(r.pos.x, r.pos.z);
    miniCtx.fillStyle = r.def.paintColor;
    miniCtx.strokeStyle = 'rgba(0,0,0,0.6)';
    miniCtx.lineWidth = 2;
    miniCtx.beginPath();
    miniCtx.arc(rx, ry, 7, 0, Math.PI * 2);
    miniCtx.fill();
    miniCtx.stroke();
  }
  const [x, y] = miniXf(physics.pos.x, physics.pos.z);
  const h = physics.heading;
  miniCtx.save();
  miniCtx.translate(x, y);
  // world forward (sin h, cos h) maps to canvas (-sin h, -cos h), i.e. a rotation of -h
  miniCtx.rotate(-h);
  miniCtx.fillStyle = '#ffffff';
  miniCtx.strokeStyle = '#1d3f8f';
  miniCtx.lineWidth = 3;
  miniCtx.beginPath();
  miniCtx.moveTo(0, -13);
  miniCtx.lineTo(9, 10);
  miniCtx.lineTo(0, 5);
  miniCtx.lineTo(-9, 10);
  miniCtx.closePath();
  miniCtx.fill();
  miniCtx.stroke();
  miniCtx.restore();
}

// ---------------------------------------------------------------------------------------
// Pace notes
function upcomingNote() {
  const notes = stage.paceNotes;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.end < progress) continue;
    const dist = (n.start - physics.roadIndex) * stage.step;
    if (dist > 170) return null;
    return { note: n, i, dist: Math.max(0, dist) };
  }
  return null;
}
function noteText(n) {
  const dir = n.sign > 0 ? 'RIGHT' : 'LEFT';
  if (n.hairpin) return { main: `HAIRPIN ${dir}`, extra: '' };
  return { main: `${dir} ${n.grade}`, extra: n.long ? 'LONG' : n.grade <= 2 ? 'CAUTION' : '' };
}
function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window) || audio.muted) return;
  const u = new SpeechSynthesisUtterance(text.toLowerCase());
  u.rate = 1.25;
  u.pitch = 0.9;
  u.volume = 0.9;
  u.lang = 'en-GB';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------------------------------
// Camera
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camYaw = 0;
let camInit = false;
function updateCamera(dt) {
  const p = physics.pos;
  const speed = physics.speed;
  if (state === 'menu' || state === 'loading') {
    menuAngle += dt * 0.12;
    const r = 7.5;
    camPos.set(p.x + Math.sin(menuAngle) * r, p.y + 2.0, p.z + Math.cos(menuAngle) * r);
    camera.position.copy(camPos);
    camera.lookAt(p.x, p.y + 0.8, p.z);
    camera.fov = 50;
    camera.updateProjectionMatrix();
    camInit = false;
    return;
  }
  if (camMode === 1) {
    model.car.updateMatrixWorld(true);
    model.hoodAnchor.getWorldPosition(camera.position);
    const fwd = new THREE.Vector3(0, 0.05, 1).applyQuaternion(model.car.quaternion);
    camera.lookAt(camera.position.clone().add(fwd));
    camera.fov = 68 + speed * 0.12;
  } else {
    // follow the direction of travel partly, so slides show the car's angle
    const velYaw = Math.atan2(physics.vel.x, physics.vel.z);
    let target = physics.heading;
    if (speed > 4) {
      let d = velYaw - physics.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      target = physics.heading + d * 0.55;
    }
    if (!camInit) { camYaw = target; camInit = true; }
    let dy = target - camYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    camYaw += dy * clamp(dt * 4.5, 0, 1);
    const far = camMode === 2;
    const dist = far ? 10.5 : 6.6;
    const height = far ? 3.8 : 2.5;
    const want = new THREE.Vector3(p.x - Math.sin(camYaw) * dist, p.y + height, p.z - Math.cos(camYaw) * dist);
    const gy = stage.heightAt(want.x, want.z) + 1.0;
    if (want.y < gy) want.y = gy;
    camPos.lerp(want, clamp(dt * 9, 0, 1));
    if (camPos.distanceTo(want) > 30) camPos.copy(want);
    camera.position.copy(camPos);
    camLook.set(p.x + Math.sin(camYaw) * 5, p.y + 1.3, p.z + Math.cos(camYaw) * 5);
    camera.lookAt(camLook);
    camera.fov = (far ? 58 : 62) + speed * 0.22;
  }
  // shake: rough sand, landings, impacts
  const rough = physics.grounded ? (physics.surface === 'sand' ? 0.035 : 0.012) * clamp(speed / 30, 0, 1) : 0;
  const s = rough + shake;
  if (s > 0) {
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
  shake = Math.max(0, shake - dt * 1.5);
  // portrait screens: widen the vertical FOV so the horizontal view stays drivable
  if (camera.aspect < 1) camera.fov = Math.min(100, camera.fov * (1 + (1 - camera.aspect) * 0.6));
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------------------
// Main loop
const clock = new THREE.Clock();
const STEP = 1 / 120;
let acc = 0;
const wheelWorld = [new THREE.Vector3(), new THREE.Vector3()];
const tmpV = new THREE.Vector3();
let fpsAcc = 0, fpsFrames = 0, lowFpsTime = 0;

function frame() {
  requestAnimationFrame(frame);
  tick(Math.min(clock.getDelta(), 0.1));
}

function tick(dt, render = true) {
  if (!stage) return;

  readInput();
  const running = state === 'running';
  const frozen = state === 'paused';

  if (state === 'countdown') {
    countdown -= dt;
    const n = Math.ceil(countdown);
    if (n !== lastCountBeep && n > 0) { audio.beep(520); lastCountBeep = n; }
    $('countdown').textContent = n > 0 ? n : 'GO!';
    $('countdown').classList.add('show');
    if (countdown <= 0) {
      state = 'running';
      audio.beep(1040, 0.35);
      setTimeout(() => $('countdown').classList.remove('show'), 600);
    }
  }

  if (!frozen) {
    acc += dt;
    const drive = running ? input : { steer: input.steer, throttle: 0, brake: 0, handbrake: true };
    while (acc >= STEP) {
      physics.update(STEP, drive, world.colliders);
      acc -= STEP;
    }
    if (running) raceTime += dt;
  } else {
    acc = 0;
  }

  // rivals
  const pf = playerRoadFrame();
  if (!frozen) {
    const list = raceRivals();
    for (const r of list) {
      r.update(dt, {
        running,
        playerS: pf.s,
        playerOffset: pf.offset,
        playerSpeed: physics.speed,
        others: list.filter((o) => o !== r),
        raceTime,
      });
      if (r.speed > 3 && r.model.car.visible) {
        r.rearWheels(rivalWheels);
        const rate = r.speed * 1.1 + (r.loose ? 40 : 0); // a sliding car kicks up more
        dust.spawnFromWheels(dt, rivalWheels, r.velocity(), Math.min(rate, 70), clamp(r.speed / 60 + (r.loose ? 0.5 : 0), 0, 1));
      }
    }
    const bump = collideCars();
    if (bump > 2) {
      shake = Math.max(shake, Math.min(0.5, bump * 0.05));
      audio.thump(Math.min(1, bump * 0.1));
      if (bump > 6 && running) skills.break('CONTACT');
    }
  }

  // skills
  if (running && !frozen) {
    skills.update(dt, physics);
    if (physics.hitImpact > 5) skills.break('CRASH');
    if (physics.roadDist > 26) skills.break('OFF STAGE');
  }
  const position = racePosition(pf.s);
  if (running && position != null) {
    if (position < bestPosition && bestPosition !== Infinity) {
      skills.add('OVERTAKE', 220 * (bestPosition - position));
    }
    bestPosition = Math.min(bestPosition, position);
  }

  // progress / splits / finish
  if (physics.roadIndex > progress && physics.roadIndex - progress < 45 && physics.roadDist < 16) progress = physics.roadIndex;
  if (running) {
    splitIndices.forEach((si, k) => {
      if (splitTimes[k] == null && progress >= si) {
        splitTimes[k] = raceTime;
        const best = storage.get(bestKey(stageDef));
        const ref = best?.splits?.[k];
        flash(`SPLIT ${k + 1}  ${fmt(raceTime)}${ref != null ? `  (${fmtDelta(raceTime - ref)})` : ''}`, 2.4);
        audio.beep(880, 0.12);
      }
    });
    if (progress >= stage.finishIndex) finish();
    if (physics.roadDist > 26) $('offroad').classList.add('show');
    else $('offroad').classList.remove('show');
  } else {
    $('offroad').classList.remove('show');
  }

  // feedback
  if (physics.landImpact > 0.15) {
    shake = Math.max(shake, physics.landImpact * 0.25);
    audio.thump(physics.landImpact * 0.8);
    dust.burst(physics.pos.x, physics.pos.y, physics.pos.z, Math.floor(6 + physics.landImpact * 10), 2.2);
  }
  if (physics.hitImpact > 2) {
    shake = Math.max(shake, Math.min(0.6, physics.hitImpact * 0.04));
    audio.thump(Math.min(1.2, physics.hitImpact * 0.08));
    dust.burst(physics.pos.x, physics.pos.y, physics.pos.z, 8, 1.8);
  }

  // car visuals
  const car = model.car;
  car.position.copy(physics.pos);
  car.quaternion.copy(physics.quat);
  model.body.rotation.z = lerp(model.body.rotation.z, clamp(-physics.accLat * 0.012, -0.07, 0.07), 0.15);
  model.body.rotation.x = lerp(model.body.rotation.x, clamp(-physics.accLong * 0.008, -0.05, 0.05), 0.15);
  model.body.position.y = lerp(model.body.position.y, -physics.landImpact * 0.12, 0.3);
  const vx = physics.localVel.x;
  for (const w of model.wheels) {
    w.spin.rotation.x += (vx / 0.34) * dt * (frozen ? 0 : 1);
    if (w.front) w.pivot.rotation.y = -physics.steer;
  }
  model.tailMat.emissiveIntensity = input.brake > 0 && running ? 4 : 1.2;
  if (running) dirt = Math.min(1, dirt + physics.speed * dt * 0.00045 + (physics.surface === 'sand' ? physics.speed * dt * 0.0006 : 0));
  model.paint.color.copy(cleanPaint).lerp(dirtyPaint, dirt * 0.7);
  model.paint.roughness = 0.35 + dirt * 0.4;
  model.paint.clearcoat = 0.8 * (1 - dirt * 0.8);

  // dust
  if (!frozen) {
    car.updateMatrixWorld(true);
    wheelWorld[0].set(-0.8, 0, -1.4).applyMatrix4(car.matrixWorld);
    wheelWorld[1].set(0.8, 0, -1.4).applyMatrix4(car.matrixWorld);
    if (physics.grounded) {
      const spd = physics.speed;
      const slip = physics.rearSlip * 2 + physics.wheelSpin;
      const sand = physics.surface === 'sand' ? 1.5 : 1;
      const rate = (spd > 2 ? spd * 1.5 : 0) * sand + slip * 45 + (physics.wheelSpin > 0 ? 20 : 0);
      dust.spawnFromWheels(dt, wheelWorld, physics.vel, Math.min(rate, 120), clamp(slip + spd / 60, 0, 1.2));
    }
    dust.update(dt);
  }

  if (cinematicCam) cinematicCam(camera, dt);
  else updateCamera(dt);

  // sun / shadows follow the car; sky and flare follow the camera
  sunLight.position.copy(physics.pos).addScaledVector(sunDir, 260);
  sunLight.target.position.copy(physics.pos);
  flareLight.position.copy(camera.position).addScaledVector(sunDir, 4000);
  sky.position.copy(camera.position);
  audio.update(physics, running ? input.throttle : 0, running || state === 'countdown');

  // HUD
  if (flashTimer > 0) {
    flashTimer -= dt;
    if (flashTimer <= 0) $('flash').classList.remove('show');
  }
  if (skillPopTimer > 0) {
    skillPopTimer -= dt;
    if (skillPopTimer <= 0) $('skill-pop').classList.remove('show');
  }
  const kmh = Math.round(physics.speed * 3.6);
  $('speed').textContent = kmh;
  $('gear').textContent = physics.localVel.x < -0.5 ? 'R' : physics.gear;
  $('rpm-fill').style.transform = `scaleX(${(physics.rpm / 7800).toFixed(3)})`;
  $('rpm-fill').classList.toggle('red', physics.rpm > 7000);
  $('timer').textContent = fmt(raceTime);
  const pct = clamp((progress - stage.startIndex) / (stage.finishIndex - stage.startIndex), 0, 1);
  $('progress-fill').style.width = `${(pct * 100).toFixed(1)}%`;
  $('dist').textContent = `${((1 - pct) * (stage.finishIndex - stage.startIndex) * stage.step / 1000).toFixed(2)} km`;
  const hudOn = state === 'running' || state === 'countdown' || state === 'paused';
  document.body.classList.toggle('racing', hudOn);
  $('position').classList.toggle('hidden', position == null);
  if (position != null) $('pos-num').textContent = `${position}/${rivals.length + 1}`;
  $('pct').textContent = `${Math.round(pct * 100)}%`;
  updateSkillHud();

  const up = hudOn ? upcomingNote() : null;
  const pn = $('pacenote');
  if (up) {
    const t = noteText(up.note);
    $('pn-arrow').className = 'arrow ' + (up.note.sign > 0 ? 'right' : 'left') + (up.note.hairpin ? ' hairpin' : '');
    $('pn-main').textContent = t.main;
    $('pn-extra').textContent = t.extra;
    $('pn-dist').textContent = `${Math.round(up.dist / 10) * 10} m`;
    pn.classList.add('show');
    pn.dataset.grade = up.note.hairpin ? 1 : up.note.grade;
    if (spokenNote !== up.i && state === 'running') {
      spokenNote = up.i;
      speak(`${t.main} ${t.extra}`.trim());
    }
  } else {
    pn.classList.remove('show');
  }
  if (hudOn) drawMinimap();

  // render
  if (!render) return;
  if (useBloom) composer.render(dt);
  else renderer.render(scene, camera);

  // auto-drop bloom when struggling
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc > 2) {
    const fps = fpsFrames / fpsAcc;
    if (fps < 30 && useBloom && document.visibilityState === 'visible') {
      lowFpsTime += fpsAcc;
      if (lowFpsTime > 4) {
        useBloom = false;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
        onResize();
      }
    } else lowFpsTime = 0;
    fpsAcc = 0;
    fpsFrames = 0;
  }
}

function finish() {
  state = 'finished';
  skills.flush();
  const key = bestKey(stageDef);
  const prev = storage.get(key);
  const isBest = !prev || raceTime < prev.time;
  if (isBest) storage.set(key, { time: raceTime, splits: splitTimes.slice() });
  if (mode === 'race') {
    finalPosition = 1 + rivals.filter((r) => r.finished).length;
    const suffix = ['th', 'st', 'nd', 'rd'][finalPosition] || 'th';
    $('res-position').textContent = finalPosition === 1 ? 'YOU WIN!' : `${finalPosition}${suffix} PLACE`;
    $('res-position').classList.toggle('win', finalPosition === 1);
  }
  $('res-position').classList.toggle('hidden', mode !== 'race');
  $('res-skill').textContent = `Skill score ${skills.total.toLocaleString('en-US')}  ·  best chain ${skills.bestChain.toLocaleString('en-US')}`;
  $('res-stage').textContent = `${stageDef.name} · ${mode === 'race' ? 'Race' : 'Time attack'}`;
  $('res-time').textContent = fmt(raceTime);
  $('res-best').textContent = isBest ? 'NEW STAGE RECORD' : `Best ${fmt(prev.time)}  (${fmtDelta(raceTime - prev.time)})`;
  $('res-best').classList.toggle('record', isBest);
  $('res-splits').innerHTML = splitTimes
    .map((t, k) => `<li><span>Split ${k + 1}</span><span>${fmt(t)}</span></li>`)
    .join('');
  audio.beep(1320, 0.4);
  setTimeout(() => { if (state === 'finished') show('results'); }, 900);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  dust.setViewportHeight(h * renderer.getPixelRatio());
}
addEventListener('resize', onResize);
onResize();

// boot
setTimeout(() => {
  mode = storage.get('rmr.mode') === 'attack' ? 'attack' : 'race';
  loadStage(STAGES[1]);
  $('loading').classList.add('hidden');
  state = 'menu';
  buildMenu();
  show('menu');
  frame();
}, 30);

// test hook for automated checks
window.__rally = {
  get state() { return state; },
  get physics() { return physics; },
  get progress() { return progress; },
  get stage() { return stage; },
  startCountdown,
  input,
  keys,
  renderOnce() {
    if (useBloom) composer.render(0.016);
    else renderer.render(scene, camera);
    renderer.getContext().finish();
  },
  setBloom(v) { useBloom = v; },
  tick,
  renderer,
  camera,
  rivals,
  setCinematic(fn) { cinematicCam = fn; },
  loadStage(id) { loadStage(STAGES.find((s) => s.id === id)); },
};
