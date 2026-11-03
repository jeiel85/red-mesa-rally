// Procedural rally hatchback. The shell is lofted from cross-sections (curved roof,
// tumblehome, flared arches with real cut-outs) and the livery is painted onto it via UVs.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp, lerp, smoothstep } from './noise.js';

const WHEEL_Z = 1.27;
const WHEEL_R = 0.34;
const ARCH_R = 0.45;
const Z_REAR = -2.0;
const Z_FRONT = 2.02;
const U_SPAN = 4.12; // texture u covers z = -2.06 .. 2.06

// Stations along the car (rear -> front):
// z, cab (1 = full greenhouse, 0 = hood/hatch only), roof/hood height, roof half-width, body half-width, beltline
const STATIONS = [
  [-2.0, 0.3, 1.1, 0.7, 0.84, 0.96],
  [-1.85, 0.62, 1.31, 0.67, 0.86, 0.97],
  [-1.55, 1.0, 1.465, 0.64, 0.87, 0.98],
  [-0.6, 1.0, 1.48, 0.645, 0.875, 0.985],
  [0.0, 1.0, 1.47, 0.64, 0.875, 0.985],
  [0.45, 0.55, 1.22, 0.7, 0.875, 0.985],
  [0.92, 0.0, 1.0, 0.76, 0.875, 0.975],
  [1.4, 0.0, 0.94, 0.76, 0.875, 0.93],
  [1.85, 0.0, 0.86, 0.72, 0.845, 0.845],
  [2.02, 0.0, 0.72, 0.62, 0.77, 0.7],
];

function station(z) {
  const S = STATIONS;
  let i = 0;
  while (i < S.length - 2 && z > S[i + 1][0]) i++;
  const t = clamp((z - S[i][0]) / (S[i + 1][0] - S[i][0]), 0, 1);
  const p0 = S[Math.max(0, i - 1)];
  const p1 = S[i];
  const p2 = S[i + 1];
  const p3 = S[Math.min(S.length - 1, i + 2)];
  const out = [];
  for (let k = 1; k < 6; k++) {
    // uniform Catmull-Rom
    const a = p0[k], b = p1[k], c = p2[k], d = p3[k];
    out.push(0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t));
  }
  const [cab, yTop, wTop, wBody, belt] = out;
  return { cab: clamp(cab, 0, 1), yTop, wTop, wBody, belt };
}

// Underside height of the body: sill line, lifted into round arches over the wheels.
function sillHeight(z) {
  let y = 0.3;
  for (const wz of [WHEEL_Z, -WHEEL_Z]) {
    const dz = z - wz;
    if (Math.abs(dz) < ARCH_R) y = Math.max(y, 0.34 + Math.sqrt(ARCH_R * ARCH_R - dz * dz) * 0.98);
  }
  return y;
}

function flare(z) {
  let f = 0;
  for (const wz of [WHEEL_Z, -WHEEL_Z]) f = Math.max(f, 1 - smoothstep(0.35, 0.62, Math.abs(z - wz)));
  return f * 0.035;
}

// Half cross-section, bottom -> crown: [p0 sill, p1, p2 (widest), p3 belt, p4 window top/hood edge, p5 roof rail, q]
function halfRing(z) {
  const s = station(z);
  const yb = sillHeight(z);
  const fl = flare(z);
  const h = s.belt - yb;
  return [
    [s.wBody - 0.07 + fl * 0.5, yb],
    [s.wBody - 0.005 + fl, yb + h * 0.2],
    [s.wBody + 0.012 + fl, yb + h * 0.6],
    [s.wBody, s.belt],
    [lerp(s.wBody - 0.04, s.wTop + 0.1, s.cab), lerp(Math.min(s.belt + 0.03, s.yTop - 0.02), s.yTop - 0.1, s.cab)],
    [lerp(s.wBody - 0.14, s.wTop, s.cab), s.yTop - 0.015],
    [lerp(s.wBody - 0.14, s.wTop, s.cab) * 0.5, s.yTop + 0.012],
  ]; // the crown point (0, yTop + 0.02) is added by the caller
}

// v coordinate of each ring point: left side (x > 0) 0..0.5, right side 0.5..1
const V_LEFT = [0.02, 0.1, 0.2, 0.3, 0.38, 0.44, 0.47];

function shellGeometry() {
  const zs = [];
  for (let z = Z_REAR; z < Z_FRONT; z += 0.035) zs.push(z);
  zs.push(Z_FRONT);
  const ringPts = 15;
  const pos = [];
  const uv = [];
  const pushRing = (z, scale = 1, cy = 0.68) => {
    const half = halfRing(z);
    const s = station(z);
    const crown = [0, s.yTop + 0.02 + 0.012 * s.cab];
    const pts = [...half.map(([x, y]) => [x, y]), crown, ...half.slice().reverse().map(([x, y]) => [-x, y])];
    const vs = [...V_LEFT, 0.5, ...V_LEFT.slice().reverse().map((v) => 1 - v)];
    pts.forEach(([x, y], k) => {
      pos.push(x * scale, cy + (y - cy) * scale, z);
      uv.push((z + U_SPAN / 2) / U_SPAN, 1 - vs[k]);
    });
  };
  zs.forEach((z) => pushRing(z));
  const rings = zs.length;
  // softened end rings for the tail and nose
  pushRing(Z_REAR - 0.035, 0.94, 0.7);
  pushRing(Z_FRONT + 0.025, 0.9, 0.55);

  const paint = [];
  const glass = [];
  const sideGlass = (z, cab) => cab > 0.12 && z > -1.42 && z < 0.62 && !(z > -0.66 && z < -0.52);
  const topGlass = (z) => (z > 0.04 && z < 0.9) || (z > -1.97 && z < -1.58);
  for (let r = 0; r < rings - 1; r++) {
    const zm = (zs[r] + zs[r + 1]) / 2;
    const cab = station(zm).cab;
    for (let j = 0; j < ringPts - 1; j++) {
      const a = r * ringPts + j;
      const b = (r + 1) * ringPts + j;
      // segment index from the bottom on either side: 0..6
      const seg = j < 7 ? j : ringPts - 2 - j;
      let target = paint;
      if (seg === 3 && sideGlass(zm, cab)) target = glass;
      if (seg >= 5 && topGlass(zm)) target = glass;
      // left half winds one way, right half the other, so faces point outwards
      target.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // tail: last rear ring (index 0) -> softened ring -> centre fan
  const capRing = (ringA, ringB, centre, flip) => {
    const c = pos.length / 3;
    pos.push(...centre);
    uv.push(flip ? 0.001 : 0.999, 0.5);
    for (let j = 0; j < ringPts - 1; j++) {
      const a = ringA * ringPts + j;
      const b = ringB * ringPts + j;
      if (flip) paint.push(a, b, a + 1, a + 1, b, b + 1, b, c, b + 1);
      else paint.push(a, a + 1, b, a + 1, b + 1, b, b, b + 1, c);
    }
  };
  capRing(0, rings, [0, 0.7, Z_REAR - 0.045], true);
  capRing(rings - 1, rings + 1, [0, 0.52, Z_FRONT + 0.035], false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([...paint, ...glass]);
  g.addGroup(0, paint.length, 0);
  g.addGroup(paint.length, glass.length, 1);
  g.computeVertexNormals();
  return g;
}

// --------------------------------------------------------------------------------------
// Livery painted in "car space": side panels use (z, h) with h = 0 at the belt, 1 at the sill.
function liveryTexture({ paintColor, stripeA, stripeB, number, team, sponsor }) {
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = paintColor;
  ctx.fillRect(0, 0, W, H);
  const sx = W / U_SPAN;
  const sy = 0.28 * H;

  const side = (isLeft, fn) => {
    ctx.save();
    if (isLeft) ctx.setTransform(-sx, 0, 0, -sy, W, 0.3 * H);
    else ctx.setTransform(sx, 0, 0, sy, 0, 0.7 * H);
    // car z -> viewer x (metres from the viewer's left edge of the car)
    const vx = (z) => (isLeft ? U_SPAN / 2 - z : z + U_SPAN / 2);
    fn(vx, isLeft);
    ctx.restore();
  };

  for (const isLeft of [true, false]) {
    side(isLeft, (vx) => {
      const px = 1 / sx; // one canvas pixel in panel units (x)
      const py = 1 / sy;
      // dark lower skirt
      ctx.fillStyle = '#2a2a2e';
      ctx.fillRect(0, 0.84, U_SPAN, 0.3);
      // sweeping bands from the front wheel up towards the rear quarter
      const band = (color, h0, h1) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(vx(2.1), h0 + 0.35);
        ctx.lineTo(vx(0.55), h0);
        ctx.lineTo(vx(-2.1), h0 - 0.5);
        ctx.lineTo(vx(-2.1), h1 - 0.5);
        ctx.lineTo(vx(0.55), h1);
        ctx.lineTo(vx(2.1), h1 + 0.35);
        ctx.closePath();
        ctx.fill();
      };
      band(stripeA, 0.5, 0.64);
      band(stripeB, 0.67, 0.75);
      band(paintColor, 0.64, 0.67);
      // door number roundel
      const nx = vx(0.42);
      ctx.save();
      ctx.translate(nx, 0.42);
      ctx.scale(1, sx / sy);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.025;
      ctx.strokeStyle = stripeA;
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = 'bold 0.21px Impact, "Arial Black", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(number, 0, 0.015);
      ctx.restore();
      // sponsor on the rear quarter, team on the front fender
      const text = (str, z, h, size, color, weight = 'bold') => {
        ctx.save();
        ctx.translate(vx(z), h);
        ctx.scale(1, sx / sy);
        ctx.fillStyle = color;
        ctx.font = `${weight} ${size}px Impact, "Arial Black", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, 0, 0);
        ctx.restore();
      };
      // lettering stays on the flat door skin; the arches stretch the texture
      text(sponsor, -0.2, 0.2, 0.1, '#141414');
      // panel gaps: door front/rear edge and the sill seam
      ctx.strokeStyle = 'rgba(20,20,22,0.75)';
      ctx.lineWidth = 2.2 * px;
      for (const z of [0.8, -0.56]) {
        ctx.beginPath();
        ctx.moveTo(vx(z), 0.0);
        ctx.lineTo(vx(z + (z > 0 ? -0.04 : 0.02)), 0.84);
        ctx.stroke();
      }
      ctx.lineWidth = 2 * py;
      ctx.beginPath();
      ctx.moveTo(vx(0.78), 0.84);
      ctx.lineTo(vx(-0.54), 0.84);
      ctx.stroke();
      // door handle + key slot
      ctx.fillStyle = '#1c1c1f';
      ctx.fillRect(Math.min(vx(-0.3), vx(-0.48)), 0.07, 0.18, 0.045);
      // fuel cap (right side only in reality, both here for symmetry of rivals)
      ctx.save();
      ctx.translate(vx(-1.18), 0.12);
      ctx.scale(1, sx / sy);
      ctx.strokeStyle = 'rgba(20,20,22,0.6)';
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(0, 0, 0.07, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });
  }

  // Top band (v 0.38..0.62): hood stripes, cowl seam, roof number
  const vy = (v) => (1 - v) * H;
  const zx = (z) => ((z + U_SPAN / 2) / U_SPAN) * W;
  ctx.fillStyle = stripeA;
  ctx.fillRect(zx(0.92), vy(0.535), zx(2.06) - zx(0.92), vy(0.5) - vy(0.535));
  ctx.fillStyle = stripeB;
  ctx.fillRect(zx(0.92), vy(0.5), zx(2.06) - zx(0.92), vy(0.475) - vy(0.5));
  ctx.strokeStyle = 'rgba(20,20,22,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(zx(0.93), vy(0.4));
  ctx.lineTo(zx(0.93), vy(0.6));
  ctx.moveTo(zx(0.93), vy(0.405));
  ctx.lineTo(zx(2.06), vy(0.405));
  ctx.moveTo(zx(0.93), vy(0.595));
  ctx.lineTo(zx(2.06), vy(0.595));
  ctx.stroke();
  // roof number, readable from above with the nose pointing up
  ctx.save();
  ctx.translate(zx(-0.75), vy(0.5));
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-90, -70, 180, 140);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 120px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(number, 0, 6);
  ctx.restore();

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function grilleTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0b0c';
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = '#3a3a3e';
  ctx.lineWidth = 2;
  for (let y = 0; y < 70; y += 10) {
    for (let x = (y / 10) % 2 ? 6 : 0; x < 260; x += 12) {
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const px = x + Math.cos(a) * 5;
        const py = y + Math.sin(a) * 5;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tyreGeometry() {
  // lathe profile: tread with rounded shoulders and a bulging sidewall
  const pts = [];
  const w = 0.125;
  const r = WHEEL_R;
  const rim = 0.21;
  pts.push(new THREE.Vector2(rim, -w * 0.92));
  pts.push(new THREE.Vector2(r - 0.06, -w * 1.02));
  for (let k = 0; k <= 6; k++) {
    const a = -Math.PI / 2 + (k / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - 0.035 + Math.cos(a) * 0.035, -w + 0.035 + Math.sin(a) * 0.035));
  }
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - 0.035 + Math.cos(a) * 0.035, w - 0.035 + Math.sin(a) * 0.035));
  }
  pts.push(new THREE.Vector2(r - 0.06, w * 1.02));
  pts.push(new THREE.Vector2(rim, w * 0.92));
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateZ(Math.PI / 2); // lathe axis y -> x (axle)
  return g;
}

function rimGroup(mats, side) {
  const g = new THREE.Group();
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.215, 0.2, 0.2, 24, 1, true), mats.rim);
  dish.rotation.z = Math.PI / 2;
  g.add(dish);
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), mats.rimDark);
  face.rotation.y = (side * Math.PI) / 2;
  face.position.x = side * 0.03;
  g.add(face);
  const spokeGeo = new RoundedBoxGeometry(0.03, 0.36, 0.06, 2, 0.012);
  for (let k = 0; k < 6; k++) {
    const s = new THREE.Mesh(spokeGeo, mats.rim);
    s.rotation.x = (k / 6) * Math.PI;
    s.position.x = side * 0.075;
    g.add(s);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.05, 12), mats.chrome);
  hub.rotation.z = Math.PI / 2;
  hub.position.x = side * 0.09;
  g.add(hub);
  return g;
}

// --------------------------------------------------------------------------------------
export function buildCarModel({
  paintColor = '#f4f4f2',
  stripeA = '#1d3f8f',
  stripeB = '#d42a2f',
  number = '27',
  team = 'MESA WORKS',
  sponsor = team,
} = {}) {
  const car = new THREE.Group(); // chassis frame (positioned by physics)
  const body = new THREE.Group(); // gets visual roll/pitch on top
  car.add(body);

  const paint = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    map: liveryTexture({ paintColor, stripeA, stripeB, number, team, sponsor }),
    roughness: 0.32,
    metalness: 0.05,
    clearcoat: 0.9,
    clearcoatRoughness: 0.18,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#16202a', roughness: 0.03, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.4,
  });
  const black = new THREE.MeshStandardMaterial({ color: '#161618', roughness: 0.75 });
  const plastic = new THREE.MeshStandardMaterial({ color: '#2b2b2f', roughness: 0.6 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#d8d8d8', roughness: 0.18, metalness: 1 });
  const bodyColor = new THREE.MeshPhysicalMaterial({ color: paintColor, roughness: 0.32, clearcoat: 0.9, clearcoatRoughness: 0.18 });
  const accent = new THREE.MeshStandardMaterial({ color: stripeB, roughness: 0.5 });

  const shell = new THREE.Mesh(shellGeometry(), [paint, glass]);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  // underfloor and wheel wells so nothing is see-through from low angles
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 3.9), black);
  floor.position.set(0, 0.33, 0);
  body.add(floor);
  for (const wz of [WHEEL_Z, -WHEEL_Z]) {
    const well = new THREE.Mesh(new THREE.CylinderGeometry(ARCH_R - 0.01, ARCH_R - 0.01, 1.66, 20, 1, true, 0, Math.PI), black); // upper half
    well.material = black.clone();
    well.material.side = THREE.BackSide;
    well.rotation.z = Math.PI / 2;
    well.position.set(0, 0.34, wz);
    body.add(well);
  }

  // bumpers, splitter, skid plate, tow hook
  const fb = new THREE.Mesh(new RoundedBoxGeometry(1.66, 0.27, 0.32, 3, 0.08), plastic);
  fb.position.set(0, 0.42, 1.93);
  body.add(fb);
  const splitter = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.05, 0.3, 2, 0.02), black);
  splitter.position.set(0, 0.28, 1.98);
  body.add(splitter);
  const skid = new THREE.Mesh(new RoundedBoxGeometry(1.1, 0.04, 0.9, 2, 0.015), chrome);
  skid.position.set(0, 0.255, 1.55);
  body.add(skid);
  const tow = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 6, 12), accent);
  tow.position.set(0.5, 0.33, 2.12);
  body.add(tow);
  const rb = new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.28, 0.28, 3, 0.08), plastic);
  rb.position.set(0, 0.45, -1.98);
  body.add(rb);
  const diffuser = new THREE.Mesh(new RoundedBoxGeometry(1.2, 0.06, 0.3, 2, 0.02), black);
  diffuser.position.set(0, 0.3, -1.98);
  body.add(diffuser);

  // grille
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(1.02, 0.17), new THREE.MeshStandardMaterial({ map: grilleTexture(), roughness: 0.7 }));
  grille.position.set(0, 0.64, 2.055);
  grille.rotation.x = -0.25;
  body.add(grille);

  // headlights: chrome bowl + emissive lamp behind a clear lens
  const headMat = new THREE.MeshStandardMaterial({ color: '#e9eef3', emissive: '#fff3d6', emissiveIntensity: 0.7, roughness: 0.1 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.02, transmission: 0.9, thickness: 0.02, transparent: true, opacity: 0.35 });
  for (const sx of [-1, 1]) {
    const unit = new THREE.Group();
    const housing = new THREE.Mesh(new RoundedBoxGeometry(0.44, 0.17, 0.1, 3, 0.04), black);
    unit.add(housing);
    for (const lx of [-0.1, 0.09]) {
      const bowl = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), chrome);
      bowl.position.set(lx, 0, 0.051);
      unit.add(bowl);
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.035, 16), headMat);
      lamp.position.set(lx, 0, 0.053);
      unit.add(lamp);
    }
    const lens = new THREE.Mesh(new RoundedBoxGeometry(0.43, 0.16, 0.02, 2, 0.008), lensMat);
    lens.position.z = 0.055;
    unit.add(lens);
    unit.position.set(sx * 0.53, 0.76, 1.985);
    unit.rotation.set(-0.42, sx * 0.22, 0);
    body.add(unit);
  }

  // rally light pod on the bumper
  const pod = new THREE.Group();
  const lampGeo = new THREE.CylinderGeometry(0.095, 0.1, 0.09, 20);
  lampGeo.rotateX(Math.PI / 2);
  const bar = new THREE.Mesh(new RoundedBoxGeometry(1.08, 0.04, 0.05, 2, 0.015), black);
  bar.position.set(0, -0.09, -0.02);
  pod.add(bar);
  for (let i = 0; i < 4; i++) {
    const x = -0.42 + i * 0.28;
    const housing = new THREE.Mesh(lampGeo, black);
    housing.position.set(x, 0, 0);
    pod.add(housing);
    const reflector = new THREE.Mesh(new THREE.CircleGeometry(0.08, 18), chrome);
    reflector.position.set(x, 0, 0.046);
    pod.add(reflector);
    const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), headMat);
    lamp.position.set(x, 0, 0.048);
    pod.add(lamp);
  }
  pod.position.set(0, 0.67, 2.14);
  body.add(pod);

  // tail lights + third brake light
  const tailMat = new THREE.MeshStandardMaterial({ color: '#4a0406', emissive: '#ff1a10', emissiveIntensity: 1.2, roughness: 0.25 });
  for (const sx of [-1, 1]) {
    const unit = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.34, 0.07, 2, 0.03), tailMat);
    unit.position.set(sx * 0.66, 0.9, -2.03);
    body.add(unit);
    const rev = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.08, 0.075, 2, 0.02), new THREE.MeshStandardMaterial({ color: '#eeeeee', roughness: 0.2 }));
    rev.position.set(sx * 0.66, 0.73, -2.03);
    body.add(rev);
  }
  const third = new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.04, 0.04, 2, 0.015), tailMat);
  third.position.set(0, 1.43, -1.7);
  body.add(third);

  // hatch panel: team plate + number plate
  const plateTex = (() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f2f0e6';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 122);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 82px "Arial Black", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`RM ${number.padStart(2, '0')} DX`, 256, 68);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.125), new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.5 }));
  plate.position.set(0, 0.66, -2.075);
  plate.rotation.y = Math.PI;
  body.add(plate);
  const hatchTex = (() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 512, 96);
    ctx.fillStyle = '#141414';
    ctx.font = 'bold 60px Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(team, 256, 50);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const hatchText = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.17), new THREE.MeshStandardMaterial({ map: hatchTex, transparent: true, roughness: 0.4 }));
  hatchText.position.set(0, 0.98, -2.05);
  hatchText.rotation.y = Math.PI;
  body.add(hatchText);
  // rear wiper
  const wiper = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.02, 0.025, 1, 0.008), black);
  wiper.position.set(0.05, 1.18, -1.9);
  wiper.rotation.set(-0.6, 0, 0.35);
  body.add(wiper);

  // roof spoiler with end plates
  const wing = new THREE.Group();
  const blade = new THREE.Mesh(new RoundedBoxGeometry(1.36, 0.045, 0.36, 3, 0.02), bodyColor);
  blade.castShadow = true;
  wing.add(blade);
  for (const sx of [-1, 1]) {
    const plateW = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.16, 0.38, 2, 0.012), black);
    plateW.position.set(sx * 0.68, -0.05, 0);
    wing.add(plateW);
  }
  wing.position.set(0, 1.52, -1.63);
  wing.rotation.x = 0.2;
  body.add(wing);

  // roof scoop + antenna
  const scoop = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.08, 0.42, 2, 0.03), black);
  scoop.position.set(0, 1.5, -0.25);
  body.add(scoop);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.008, 0.4, 5), black);
  antenna.position.set(-0.3, 1.66, -1.2);
  antenna.rotation.x = -0.3;
  body.add(antenna);

  // mirrors on stalks
  for (const sx of [-1, 1]) {
    const m = new THREE.Group();
    const cap = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.13, 0.1, 2, 0.035), bodyColor);
    m.add(cap);
    const glassM = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.09), chrome);
    glassM.position.z = -0.051;
    glassM.rotation.y = Math.PI;
    m.add(glassM);
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.05), black);
    stalk.position.set(-sx * 0.1, -0.03, 0.01);
    m.add(stalk);
    m.position.set(sx * 0.93, 1.06, 0.66);
    m.rotation.y = sx * -0.12;
    body.add(m);
  }

  // mud flaps
  for (const [fx, fz] of [[-0.74, WHEEL_Z - 0.5], [0.74, WHEEL_Z - 0.5], [-0.74, -WHEEL_Z - 0.48], [0.74, -WHEEL_Z - 0.48]]) {
    const flap = new THREE.Mesh(new RoundedBoxGeometry(0.32, 0.27, 0.015, 1, 0.006), accent);
    flap.position.set(fx, 0.2, fz);
    body.add(flap);
  }
  // twin exhaust
  for (const ex of [0.42, 0.56]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 14, 1, true), chrome);
    pipe.material.side = THREE.DoubleSide;
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(ex, 0.3, -2.05);
    body.add(pipe);
  }

  // wheels
  const tyre = tyreGeometry();
  const tyreMat = new THREE.MeshStandardMaterial({ color: '#131313', roughness: 0.92, side: THREE.DoubleSide });
  const mats = {
    rim: new THREE.MeshStandardMaterial({ color: '#ececec', roughness: 0.35, metalness: 0.4 }),
    rimDark: new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.6 }),
    chrome,
  };
  const discGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.025, 20);
  discGeo.rotateZ(Math.PI / 2);
  const discMat = new THREE.MeshStandardMaterial({ color: '#6c6c70', roughness: 0.5, metalness: 0.7 });
  const caliperGeo = new RoundedBoxGeometry(0.05, 0.14, 0.1, 2, 0.02);
  const wheels = [];
  for (const [wx, wz] of [[-0.8, WHEEL_Z], [0.8, WHEEL_Z], [-0.8, -WHEEL_Z], [0.8, -WHEEL_Z]]) {
    const side = Math.sign(wx);
    const pivot = new THREE.Group(); // steering
    pivot.position.set(wx, WHEEL_R, wz);
    const spin = new THREE.Group();
    const t = new THREE.Mesh(tyre, tyreMat);
    t.castShadow = true;
    spin.add(t);
    spin.add(rimGroup(mats, side));
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.x = -side * 0.02;
    spin.add(disc);
    pivot.add(spin);
    const caliper = new THREE.Mesh(caliperGeo, accent);
    caliper.position.set(side * 0.0, 0.11, -0.08);
    pivot.add(caliper);
    car.add(pivot);
    wheels.push({ pivot, spin, front: wz > 0, x: wx, z: wz });
  }

  // bonnet camera mount
  const hoodAnchor = new THREE.Object3D();
  hoodAnchor.position.set(0, 1.42, 0.45);
  body.add(hoodAnchor);

  body.traverse((o) => {
    if (o.isMesh && o !== shell) o.castShadow = true;
  });

  return { car, body, wheels, paint, tailMat, hoodAnchor };
}
