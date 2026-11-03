// Stage generation: a point-to-point gravel road over procedural desert terrain.
import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm, smoothstep, lerp, clamp } from './noise.js';

export const TERRAIN_SIZE = 1900; // inner, detailed terrain (metres)
export const TERRAIN_SEGS = 380; // 5 m resolution
export const ROAD_HALF_WIDTH = 5;
const SAMPLE_STEP = 2; // metres between road samples
const BUCKET = 24;

export class Stage {
  constructor(seed, targetLength = 2600) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.noise = createNoise2D(mulberry32(seed * 7 + 3));
    this.noise2 = createNoise2D(mulberry32(seed * 13 + 11));
    this.buildPath(targetLength);
    this.buildIndex();
    this.buildRoadHeights();
    this.buildTerrain();
    this.buildPaceNotes();
  }

  // Raw terrain height, before the road is carved in.
  baseHeight(x, z) {
    const n = this.noise;
    let h = fbm(n, x / 520, z / 520, 3) * 30;
    h += fbm(this.noise2, x / 140, z / 140, 3) * 7;
    // a few low ridges
    const r = 1 - Math.abs(n(x / 300 + 10, z / 300 - 4));
    h += r * r * 9;
    // flatten to 0 at the terrain border so it meets the outer plain
    const half = TERRAIN_SIZE / 2;
    const edge = Math.max(Math.abs(x), Math.abs(z));
    return h * (1 - smoothstep(half - 160, half - 10, edge));
  }

  buildPath(targetLength) {
    const rand = this.rand;
    const R = 700;
    for (let attempt = 0; attempt < 60; attempt++) {
      const pts = [new THREE.Vector2(-120, -640)];
      let heading = Math.PI / 2 + (rand() - 0.5) * 0.6; // roughly +z
      let turnRate = 0;
      let len = 0;
      let ok = true;
      while (len < targetLength) {
        const last = pts[pts.length - 1];
        let placed = false;
        for (let tries = 0; tries < 24 && !placed; tries++) {
          turnRate = clamp(turnRate * 0.55 + (rand() - 0.5) * 1.15, -0.95, 0.95);
          let h = heading + turnRate;
          // steer back towards the centre near the edge
          const toC = Math.atan2(-last.y, -last.x);
          const d = last.length();
          if (d > R * 0.75) {
            let diff = toC - h;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            h += diff * smoothstep(R * 0.75, R, d) * 0.8;
          }
          const step = 46 + rand() * 30;
          const np = new THREE.Vector2(last.x + Math.cos(h) * step, last.y + Math.sin(h) * step);
          if (np.length() > R) continue;
          let clear = true;
          for (let i = 0; i < pts.length - 3; i++) {
            if (pts[i].distanceTo(np) < 85) { clear = false; break; }
          }
          if (!clear) continue;
          pts.push(np);
          heading = h;
          len += step;
          placed = true;
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) {
        this.controlPoints = pts;
        break;
      }
    }
    if (!this.controlPoints) throw new Error('Could not generate stage path');

    const curve = new THREE.CatmullRomCurve3(
      this.controlPoints.map((p) => new THREE.Vector3(p.x, 0, p.y)),
      false,
      'centripetal'
    );
    const approxLen = curve.getLength();
    const count = Math.floor(approxLen / SAMPLE_STEP);
    const spaced = curve.getSpacedPoints(count);
    this.samples = spaced.map((p) => new THREE.Vector2(p.x, p.z));
    this.length = (this.samples.length - 1) * SAMPLE_STEP;
    this.step = SAMPLE_STEP;

    // tangents & curvature
    const n = this.samples.length;
    this.tangents = new Array(n);
    this.curvature = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.samples[Math.max(0, i - 1)];
      const b = this.samples[Math.min(n - 1, i + 1)];
      this.tangents[i] = new THREE.Vector2().subVectors(b, a).normalize();
    }
    const K = 6;
    for (let i = 0; i < n; i++) {
      const t0 = this.tangents[Math.max(0, i - K)];
      const t1 = this.tangents[Math.min(n - 1, i + K)];
      const ang = Math.atan2(t0.x * t1.y - t0.y * t1.x, t0.dot(t1));
      this.curvature[i] = ang / (2 * K * SAMPLE_STEP); // rad per metre, > 0 bends right
    }
  }

  buildIndex() {
    this.buckets = new Map();
    this.samples.forEach((p, i) => {
      const key = `${Math.floor(p.x / BUCKET)},${Math.floor(p.y / BUCKET)}`;
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push(i);
    });
  }

  // Nearest road sample. Returns {index, dist, side} or null when far away (> ~BUCKET*1.5).
  nearest(x, z) {
    const bx = Math.floor(x / BUCKET);
    const bz = Math.floor(z / BUCKET);
    let best = -1;
    let bestD = Infinity;
    for (let ix = bx - 1; ix <= bx + 1; ix++) {
      for (let iz = bz - 1; iz <= bz + 1; iz++) {
        const list = this.buckets.get(`${ix},${iz}`);
        if (!list) continue;
        for (const i of list) {
          const p = this.samples[i];
          const d = (p.x - x) ** 2 + (p.y - z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    if (best < 0) return null;
    return { index: best, dist: Math.sqrt(bestD) };
  }

  // True when no road sample lies within `radius` metres (searches as many buckets as needed).
  isClear(x, z, radius) {
    const r2 = radius * radius;
    const span = Math.ceil(radius / BUCKET);
    const bx = Math.floor(x / BUCKET);
    const bz = Math.floor(z / BUCKET);
    for (let ix = bx - span; ix <= bx + span; ix++) {
      for (let iz = bz - span; iz <= bz + span; iz++) {
        const list = this.buckets.get(`${ix},${iz}`);
        if (!list) continue;
        for (const i of list) {
          const p = this.samples[i];
          if ((p.x - x) ** 2 + (p.y - z) ** 2 < r2) return false;
        }
      }
    }
    return true;
  }

  // Nearest sample searched locally around a hint index (for tracking the car).
  nearestLocal(x, z, hint, window = 40) {
    let best = hint;
    let bestD = Infinity;
    const n = this.samples.length;
    for (let i = Math.max(0, hint - window); i <= Math.min(n - 1, hint + window); i++) {
      const p = this.samples[i];
      const d = (p.x - x) ** 2 + (p.y - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, dist: Math.sqrt(bestD) };
  }

  buildRoadHeights() {
    const n = this.samples.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = this.baseHeight(this.samples[i].x, this.samples[i].y);
    // smooth along the road so crests stay drivable but still give a little air
    const W = 14;
    this.roadHeights = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -W; k <= W; k++) {
        const j = clamp(i + k, 0, n - 1);
        const w = 1 - Math.abs(k) / (W + 1);
        s += raw[j] * w;
        c += w;
      }
      this.roadHeights[i] = s / c;
    }
  }

  // Height including the carved road (analytic; used to build the mesh).
  carvedHeight(x, z, near = this.nearest(x, z)) {
    const base = this.baseHeight(x, z);
    if (!near) return base;
    const rh = this.roadHeights[near.index];
    // flat shoulder wider than one terrain cell so no triangle pokes through the road ribbon
    const t = smoothstep(ROAD_HALF_WIDTH + 7.5, ROAD_HALF_WIDTH + 24, near.dist);
    return lerp(rh - 0.06, base, t);
  }

  buildTerrain() {
    const segs = TERRAIN_SEGS;
    const size = TERRAIN_SIZE;
    const verts = segs + 1;
    this.heights = new Float32Array(verts * verts);
    this.roadDist = new Float32Array(verts * verts);
    const half = size / 2;
    const cell = size / segs;
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = -half + i * cell;
        const z = -half + j * cell;
        const near = this.nearest(x, z);
        this.heights[j * verts + i] = this.carvedHeight(x, z, near);
        this.roadDist[j * verts + i] = near ? near.dist : 999;
      }
    }
    this.cell = cell;
    this.verts = verts;
  }

  // Height of the terrain mesh exactly (matches PlaneGeometry triangulation).
  heightAt(x, z) {
    const half = TERRAIN_SIZE / 2;
    const fx = (x + half) / this.cell;
    const fz = (z + half) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.verts - 1 || fz >= this.verts - 1) return 0;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const V = this.verts;
    const h00 = this.heights[j * V + i];
    const h10 = this.heights[j * V + i + 1];
    const h01 = this.heights[(j + 1) * V + i];
    const h11 = this.heights[(j + 1) * V + i + 1];
    // PlaneGeometry splits each quad along (i, j+1)-(i+1, j)
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 1.2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // Corner list for the co-driver: {start, end, dir:'L'|'R', grade:1..6, long}
  buildPaceNotes() {
    const n = this.samples.length;
    const notes = [];
    let i = 0;
    const threshold = 0.006; // rad/m
    while (i < n) {
      const k = this.curvature[i];
      if (Math.abs(k) < threshold) { i++; continue; }
      const sign = Math.sign(k);
      let j = i;
      let peak = 0;
      let turn = 0;
      while (j < n && Math.sign(this.curvature[j]) === sign && Math.abs(this.curvature[j]) >= threshold * 0.7) {
        peak = Math.max(peak, Math.abs(this.curvature[j]));
        turn += Math.abs(this.curvature[j]) * SAMPLE_STEP;
        j++;
      }
      if (turn > 0.25) {
        const radius = 1 / peak;
        // rally-style grade: 6 = fast/slight, 1 = slowest/hairpin
        let grade;
        if (radius < 18) grade = 1;
        else if (radius < 30) grade = 2;
        else if (radius < 45) grade = 3;
        else if (radius < 65) grade = 4;
        else if (radius < 95) grade = 5;
        else grade = 6;
        // sign > 0 means the road bends to the driver's right (see Stage.curvature)
        notes.push({
          start: i,
          end: j,
          sign,
          grade,
          long: turn > 1.4,
          hairpin: turn > 2.4 && radius < 30,
        });
      }
      i = j + 1;
    }
    this.paceNotes = notes;
  }
}
