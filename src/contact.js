// Car-to-car contact: oriented-box overlap (SAT) and a rigid-body impulse with friction,
// so hits push, scrub speed and spin cars depending on where they connect.
// Bodies live on the ground plane: x/z position, heading (three.js rotation.y, forward =
// (sin h, cos h)) and w = angular velocity about +y (dh/dt).

export const CAR_HALF_LENGTH = 2.05;
export const CAR_HALF_WIDTH = 0.92;
export const CAR_MASS = 1150;
export const CAR_INERTIA = (CAR_MASS * ((2 * CAR_HALF_LENGTH) ** 2 + (2 * CAR_HALF_WIDTH) ** 2)) / 12;

const dot = (ax, az, bx, bz) => ax * bx + az * bz;
// z component of r x J on the ground plane, i.e. torque about +y
const cross = (rx, rz, jx, jz) => rz * jx - rx * jz;

function frame(h) {
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  return { fx, fz, rx: -fz, rz: fx };
}

function corners(b, f) {
  const out = [];
  for (const sl of [-1, 1]) {
    for (const sw of [-1, 1]) {
      out.push([
        b.x + f.fx * CAR_HALF_LENGTH * sl + f.rx * CAR_HALF_WIDTH * sw,
        b.z + f.fz * CAR_HALF_LENGTH * sl + f.rz * CAR_HALF_WIDTH * sw,
      ]);
    }
  }
  return out;
}

// Returns null when the boxes don't overlap, else the contact normal (pointing from b to a),
// penetration depth and an approximate contact point.
export function boxContact(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const reach = 2 * Math.hypot(CAR_HALF_LENGTH, CAR_HALF_WIDTH);
  if (dx * dx + dz * dz > reach * reach) return null;
  const fa = frame(a.heading);
  const fb = frame(b.heading);
  let depth = Infinity;
  let nx = 0;
  let nz = 0;
  let refIsA = true; // whose face the separating axis belongs to
  let refAlong = 0; // reference box half-extent across the contact face
  const axes = [
    [fa.fx, fa.fz, true, CAR_HALF_WIDTH],
    [fa.rx, fa.rz, true, CAR_HALF_LENGTH],
    [fb.fx, fb.fz, false, CAR_HALF_WIDTH],
    [fb.rx, fb.rz, false, CAR_HALF_LENGTH],
  ];
  for (const [ax, az, ownA, across] of axes) {
    const ra = CAR_HALF_LENGTH * Math.abs(dot(fa.fx, fa.fz, ax, az)) + CAR_HALF_WIDTH * Math.abs(dot(fa.rx, fa.rz, ax, az));
    const rb = CAR_HALF_LENGTH * Math.abs(dot(fb.fx, fb.fz, ax, az)) + CAR_HALF_WIDTH * Math.abs(dot(fb.rx, fb.rz, ax, az));
    const dist = dot(dx, dz, ax, az);
    const pen = ra + rb - Math.abs(dist);
    if (pen <= 0) return null; // separating axis found
    if (pen < depth) {
      depth = pen;
      const s = dist >= 0 ? 1 : -1;
      nx = ax * s;
      nz = az * s;
      refIsA = ownA;
      refAlong = across;
    }
  }

  // Contact point: the other ("incident") box's corners that reach past the reference face,
  // each clipped to that face's extent and weighted by how deep it reaches. A lone corner
  // poking a side lands where it pokes, flush faces land mid-overlap, and the point slides
  // smoothly between the two as the cars' angle changes (no sudden spin from a tiny angle).
  const ux = -nz; // along the contact face
  const uz = nx;
  const ref = refIsA ? a : b;
  const inc = refIsA ? corners(b, fb) : corners(a, fa);
  // incident corners reach into the reference box along +n (b's) or -n (a's)
  const sign = refIsA ? 1 : -1;
  let best = -Infinity;
  for (const c of inc) best = Math.max(best, sign * dot(c[0], c[1], nx, nz));
  const face = best - depth; // the reference face, in the same signed units
  const uRef = dot(ref.x, ref.z, ux, uz);
  let wSum = 0;
  let uSum = 0;
  for (const c of inc) {
    const reach = sign * dot(c[0], c[1], nx, nz) - face;
    if (reach <= 0) continue;
    const u = Math.min(uRef + refAlong, Math.max(uRef - refAlong, dot(c[0], c[1], ux, uz)));
    wSum += reach;
    uSum += reach * u;
  }
  const u = wSum > 0 ? uSum / wSum : uRef;
  const n = sign * (best - depth / 2); // halfway between the incident tip and the reference face
  return { nx, nz, depth, px: ux * u + nx * n, pz: uz * u + nz * n };
}

// Impulse between two bodies { x, z, vx, vz, w, invMass, invInertia }.
// Returns velocity/spin changes for both, plus the impulse size (N·s).
export function resolveContact(a, b, c, { restitution = 0.2, friction = 0.35 } = {}) {
  // closing: approach speed along the normal at the contact point (m/s), a measure of how hard
  // the hit was that doesn't depend on mass or spin
  const out = { dvax: 0, dvaz: 0, dwa: 0, dvbx: 0, dvbz: 0, dwb: 0, impulse: 0, closing: 0 };
  const rax = c.px - a.x;
  const raz = c.pz - a.z;
  const rbx = c.px - b.x;
  const rbz = c.pz - b.z;
  // point velocity: v + w (y-axis) x r = (vx + w rz, vz - w rx)
  const rvx = a.vx + a.w * raz - (b.vx + b.w * rbz);
  const rvz = a.vz - a.w * rax - (b.vz - b.w * rbx);
  const vn = dot(rvx, rvz, c.nx, c.nz);
  if (vn >= 0) return out; // already separating
  out.closing = -vn;

  const ran = cross(rax, raz, c.nx, c.nz);
  const rbn = cross(rbx, rbz, c.nx, c.nz);
  const kn = a.invMass + b.invMass + ran * ran * a.invInertia + rbn * rbn * b.invInertia;
  const jn = (-(1 + restitution) * vn) / kn;

  // Coulomb friction along the sliding direction (door-to-door scrubbing)
  let tx = rvx - vn * c.nx;
  let tz = rvz - vn * c.nz;
  const tl = Math.hypot(tx, tz);
  let jt = 0;
  if (tl > 1e-4) {
    tx /= tl;
    tz /= tl;
    const rat = cross(rax, raz, tx, tz);
    const rbt = cross(rbx, rbz, tx, tz);
    const kt = a.invMass + b.invMass + rat * rat * a.invInertia + rbt * rbt * b.invInertia;
    jt = Math.max(-friction * jn, Math.min(friction * jn, -tl / kt));
  } else {
    tx = 0;
    tz = 0;
  }
  const jx = jn * c.nx + jt * tx;
  const jz = jn * c.nz + jt * tz;
  out.dvax = jx * a.invMass;
  out.dvaz = jz * a.invMass;
  out.dwa = cross(rax, raz, jx, jz) * a.invInertia;
  out.dvbx = -jx * b.invMass;
  out.dvbz = -jz * b.invMass;
  out.dwb = -cross(rbx, rbz, jx, jz) * b.invInertia;
  out.impulse = Math.hypot(jx, jz);
  return out;
}
