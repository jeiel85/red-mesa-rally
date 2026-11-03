// Builds the visible world for a Stage: terrain, road, mesas, vegetation, props.
import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm, smoothstep, clamp } from './noise.js';
import { TERRAIN_SIZE, TERRAIN_SEGS, ROAD_HALF_WIDTH } from './track.js';

function canvasTexture(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function speckle(ctx, w, h, rand, count, colors, maxR = 1.6) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    const r = 0.4 + rand() * maxR;
    ctx.beginPath();
    ctx.arc(rand() * w, rand() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function makeGroundDetail(rand) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#d8d0c8';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rand, 2600, ['#c4b8ac', '#e8e0d8', '#b8aa9c', '#f2ece4', '#a89888'], 1.4);
    speckle(ctx, w, h, rand, 120, ['#8c7a6a', '#7a6658'], 2.6);
  });
}

function makeRoadTexture(rand) {
  return canvasTexture(256, 512, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0.0, '#b07650');
    g.addColorStop(0.1, '#d8a47c');
    g.addColorStop(0.3, '#c9926a');
    g.addColorStop(0.5, '#e0b08a');
    g.addColorStop(0.7, '#c9926a');
    g.addColorStop(0.9, '#d8a47c');
    g.addColorStop(1.0, '#b07650');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // worn wheel ruts
    for (const cx of [0.3, 0.7]) {
      for (let k = 0; k < 6; k++) {
        ctx.strokeStyle = `rgba(110,62,38,${0.06 + rand() * 0.07})`;
        ctx.lineWidth = 6 + rand() * 14;
        ctx.beginPath();
        const x0 = cx * w + (rand() - 0.5) * 14;
        ctx.moveTo(x0, 0);
        for (let y = 0; y <= h; y += 32) ctx.lineTo(x0 + Math.sin(y * 0.02 + k) * 4, y);
        ctx.stroke();
      }
    }
    speckle(ctx, w, h, rand, 4000, ['#d29c74', '#b87a52', '#dcae88', '#c08458', '#e8c09c'], 0.9);
    speckle(ctx, w, h, rand, 160, ['#9a6444', '#f0d0b0', '#a87050'], 1.4);
  });
}

// --------------------------------------------------------------------------------------
// Rock formation geometry: a strata-banded, noise-deformed lathe (mesa / butte / spire).
function makeFormation(rand, noise, { radius, height, kind }) {
  const radial = 22;
  const rings = 16;
  const pos = [];
  const col = [];
  const idx = [];
  const bandColors = [
    new THREE.Color('#a8492a'), new THREE.Color('#b85a33'), new THREE.Color('#c46c3e'),
    new THREE.Color('#9a4026'), new THREE.Color('#cf7d4c'), new THREE.Color('#b05230'),
  ];
  const off = rand() * 100;
  const profile = (t) => {
    // t: 0 bottom .. 1 top. Returns radius multiplier.
    if (kind === 'spire') return 1.0 - 0.55 * t + (t < 0.18 ? (0.18 - t) * 2.6 : 0);
    if (kind === 'butte') return t < 0.25 ? 1.45 - t * 1.8 : 1.0 - (t - 0.25) * 0.08;
    // mesa: wide talus skirt, steep cliff band
    return t < 0.35 ? 1.6 - t * 1.7 : 1.0 - (t - 0.35) * 0.05;
  };
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const y = t * height;
    // step the cliff into ledges
    const ledge = Math.floor(t * 6) % 2 === 0 ? 1.0 : 0.94;
    for (let s = 0; s <= radial; s++) {
      const a = (s / radial) * Math.PI * 2;
      const n = fbm(noise, Math.cos(a) * 1.6 + off, Math.sin(a) * 1.6 + t * 2.5, 3);
      const rr = radius * profile(t) * ledge * (1 + n * 0.32);
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
      const band = bandColors[Math.floor((t * 9 + n * 1.5 + 9) % bandColors.length)];
      const c = band.clone().multiplyScalar(0.85 + rand() * 0.2);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < radial; s++) {
      const a = r * (radial + 1) + s;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // cap
  const capCenter = pos.length / 3;
  const topC = bandColors[2];
  pos.push(0, height, 0);
  col.push(topC.r, topC.g, topC.b);
  const top = rings * (radial + 1);
  for (let s = 0; s < radial; s++) idx.push(top + s + 1, capCenter, top + s);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}

function makeBoulderGeometry(rand, noise, detail = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const off = rand() * 50;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const n = fbm(noise, v.x * 1.3 + off, v.z * 1.3 + v.y * 0.7, 2);
    v.multiplyScalar(1 + n * 0.35);
    v.y *= 0.75;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}

// --------------------------------------------------------------------------------------
export function buildWorld(scene, stage, palette) {
  const rand = mulberry32(stage.seed * 31 + 5);
  const noise = createNoise2D(mulberry32(stage.seed * 17 + 1));
  const group = new THREE.Group();
  scene.add(group);
  const colliders = []; // {x, z, r}

  // ---- inner terrain ----------------------------------------------------------------
  const tg = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
  tg.rotateX(-Math.PI / 2);
  const tp = tg.attributes.position;
  const colors = new Float32Array(tp.count * 3);
  const sandA = new THREE.Color(palette.sandA);
  const sandB = new THREE.Color(palette.sandB);
  const rockC = new THREE.Color(palette.rock);
  const roadEdge = new THREE.Color(palette.roadEdge);
  const tmp = new THREE.Color();
  const V = stage.verts;
  for (let i = 0; i < tp.count; i++) {
    const gx = i % V;
    const gz = Math.floor(i / V);
    // PlaneGeometry rows go from +y to -y; after rotateX(-90deg) that is -z .. +z
    const h = stage.heights[gz * V + gx];
    tp.setY(i, h);
    const x = tp.getX(i);
    const z = tp.getZ(i);
    const n = fbm(noise, x / 60, z / 60, 3);
    tmp.copy(sandA).lerp(sandB, clamp(0.5 + n * 0.9, 0, 1));
    // darker, rockier on higher ground
    tmp.lerp(rockC, smoothstep(14, 34, h) * 0.45);
    // dusty wash around the road
    const rd = stage.roadDist[gz * V + gx];
    tmp.lerp(roadEdge, (1 - smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + 5, rd)) * 0.45);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  tg.computeVertexNormals();
  const detail = makeGroundDetail(rand);
  detail.repeat.set(TERRAIN_SIZE / 7, TERRAIN_SIZE / 7);
  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: detail,
    roughness: 0.97,
    metalness: 0,
  });
  const terrain = new THREE.Mesh(tg, terrainMat);
  terrain.receiveShadow = true;
  group.add(terrain);

  // ---- outer plain (low res, fades into fog) -----------------------------------------
  // 100 m cells aligned with the inner terrain border, with the inner square cut out so the
  // plain never pokes through low ground inside the stage.
  const outer = new THREE.PlaneGeometry(9500, 9500, 95, 95);
  outer.rotateX(-Math.PI / 2);
  const op = outer.attributes.position;
  const ocol = new Float32Array(op.count * 3);
  const halfT = TERRAIN_SIZE / 2;
  for (let i = 0; i < op.count; i++) {
    const x = op.getX(i);
    const z = op.getZ(i);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const n = fbm(noise, x / 400, z / 400, 3);
    op.setY(i, n * 18 * smoothstep(halfT, halfT + 600, edge));
    tmp.copy(sandA).lerp(sandB, clamp(0.5 + n, 0, 1));
    ocol[i * 3] = tmp.r;
    ocol[i * 3 + 1] = tmp.g;
    ocol[i * 3 + 2] = tmp.b;
  }
  const insideV = (i) => Math.max(Math.abs(op.getX(i)), Math.abs(op.getZ(i))) <= halfT + 0.5;
  const oidx = outer.index.array;
  const kept = [];
  for (let k = 0; k < oidx.length; k += 3) {
    if (insideV(oidx[k]) && insideV(oidx[k + 1]) && insideV(oidx[k + 2])) continue;
    kept.push(oidx[k], oidx[k + 1], oidx[k + 2]);
  }
  outer.setIndex(kept);
  outer.setAttribute('color', new THREE.BufferAttribute(ocol, 3));
  outer.computeVertexNormals();
  const outerMesh = new THREE.Mesh(outer, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  outerMesh.receiveShadow = false;
  group.add(outerMesh);

  // ---- road ribbon ---------------------------------------------------------------------
  const S = stage.samples;
  const rp = new Float32Array(S.length * 2 * 3);
  const ruv = new Float32Array(S.length * 2 * 2);
  const ridx = [];
  for (let i = 0; i < S.length; i++) {
    const t = stage.tangents[i];
    const rx = -t.y; // right vector (x,z) = (-tz, tx)
    const rz = t.x;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const x = S[i].x + rx * side * (ROAD_HALF_WIDTH + 0.6);
      const z = S[i].y + rz * side * (ROAD_HALF_WIDTH + 0.6);
      const k = (i * 2 + s) * 3;
      rp[k] = x;
      rp[k + 1] = stage.heightAt(x, z) + 0.05;
      rp[k + 2] = z;
      ruv[(i * 2 + s) * 2] = s;
      ruv[(i * 2 + s) * 2 + 1] = (i * stage.step) / 14;
    }
    if (i < S.length - 1) {
      const a = i * 2;
      ridx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // counter-clockwise seen from above
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
  roadGeo.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
  roadGeo.setIndex(ridx);
  roadGeo.computeVertexNormals();
  const roadMat = new THREE.MeshStandardMaterial({
    map: makeRoadTexture(rand),
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    alphaMap: canvasTexture(64, 4, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#000');
      g.addColorStop(0.1, '#fff');
      g.addColorStop(0.9, '#fff');
      g.addColorStop(1, '#000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }, { srgb: false }),
    transparent: true,
    depthWrite: false,
  });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  road.renderOrder = 1;
  group.add(road);

  // helper: is (x, z) far enough from the road?
  const clearOfRoad = (x, z, min) => stage.isClear(x, z, min);
  const inTerrain = (x, z, margin = 40) =>
    Math.abs(x) < TERRAIN_SIZE / 2 - margin && Math.abs(z) < TERRAIN_SIZE / 2 - margin;

  // ---- distant mesas & spires ---------------------------------------------------------
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
  const formationCount = 34;
  for (let i = 0; i < formationCount; i++) {
    const a = (i / formationCount) * Math.PI * 2 + rand() * 0.3;
    const dist = 1150 + rand() * 1500;
    const kindR = rand();
    const kind = kindR < 0.3 ? 'spire' : kindR < 0.6 ? 'butte' : 'mesa';
    const radius = kind === 'spire' ? 30 + rand() * 35 : kind === 'butte' ? 70 + rand() * 80 : 140 + rand() * 180;
    const height = kind === 'spire' ? 160 + rand() * 160 : kind === 'butte' ? 130 + rand() * 120 : 100 + rand() * 110;
    const m = new THREE.Mesh(makeFormation(rand, noise, { radius, height, kind }), rockMat);
    m.position.set(Math.cos(a) * dist, -6, Math.sin(a) * dist);
    m.rotation.y = rand() * Math.PI * 2;
    m.scale.x = 0.7 + rand() * 0.8;
    m.castShadow = false;
    group.add(m);
  }

  // ---- mid-range rock outcrops inside the stage (with colliders) -----------------------
  for (let i = 0, placed = 0; i < 400 && placed < 46; i++) {
    const x = (rand() - 0.5) * (TERRAIN_SIZE - 160);
    const z = (rand() - 0.5) * (TERRAIN_SIZE - 160);
    const big = rand() < 0.35;
    const radius = big ? 16 + rand() * 18 : 6 + rand() * 8;
    // the talus skirt and noise push the silhouette out to ~2x the nominal radius
    if (!clearOfRoad(x, z, radius * 2.1 + 10)) continue;
    const kind = big ? (rand() < 0.5 ? 'butte' : 'mesa') : 'spire';
    const height = big ? 18 + rand() * 30 : 9 + rand() * 18;
    const m = new THREE.Mesh(makeFormation(rand, noise, { radius, height, kind }), rockMat);
    m.position.set(x, stage.heightAt(x, z) - 2.5, z);
    m.rotation.y = rand() * Math.PI * 2;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    colliders.push({ x, z, r: radius * (kind === 'spire' ? 1.5 : 1.75) });
    placed++;
  }

  // ---- boulders (instanced, some near the road edge) -----------------------------------
  const boulderGeo = makeBoulderGeometry(rand, noise, 1);
  const boulderMat = new THREE.MeshStandardMaterial({ color: palette.boulder, roughness: 0.95, flatShading: true });
  const boulderCount = 900;
  const boulders = new THREE.InstancedMesh(boulderGeo, boulderMat, boulderCount);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const ps = new THREE.Vector3();
  const bc = new THREE.Color();
  let bi = 0;
  for (let i = 0; i < 6000 && bi < boulderCount; i++) {
    let x, z;
    if (rand() < 0.45) {
      // scatter along the road edges
      const k = Math.floor(rand() * S.length);
      const t = stage.tangents[k];
      const side = rand() < 0.5 ? -1 : 1;
      const off = ROAD_HALF_WIDTH + 2.5 + rand() * 18;
      x = S[k].x - t.y * side * off;
      z = S[k].y + t.x * side * off;
    } else {
      x = (rand() - 0.5) * (TERRAIN_SIZE - 80);
      z = (rand() - 0.5) * (TERRAIN_SIZE - 80);
    }
    if (!inTerrain(x, z)) continue;
    const s = rand() < 0.9 ? 0.3 + rand() * 0.9 : 1.4 + rand() * 1.8;
    if (!clearOfRoad(x, z, ROAD_HALF_WIDTH + 1.5 + s)) continue;
    ps.set(x, stage.heightAt(x, z) - s * 0.25, z);
    q.setFromEuler(new THREE.Euler(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4));
    sc.set(s * (0.8 + rand() * 0.5), s, s * (0.8 + rand() * 0.5));
    m4.compose(ps, q, sc);
    boulders.setMatrixAt(bi, m4);
    boulders.setColorAt(bi, bc.set(palette.boulder).multiplyScalar(0.75 + rand() * 0.45));
    if (s > 1.2) colliders.push({ x, z, r: s * 0.9 });
    bi++;
  }
  boulders.count = bi;
  boulders.castShadow = true;
  boulders.receiveShadow = true;
  group.add(boulders);

  // ---- shrubs & dry grass ----------------------------------------------------------------
  const shrubGeo = new THREE.IcosahedronGeometry(1, 0);
  shrubGeo.translate(0, 0.6, 0);
  const shrubMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true });
  const shrubCount = 2600;
  const shrubs = new THREE.InstancedMesh(shrubGeo, shrubMat, shrubCount);
  const shrubColors = palette.shrubs.map((c) => new THREE.Color(c));
  let si = 0;
  for (let i = 0; i < 12000 && si < shrubCount; i++) {
    const x = (rand() - 0.5) * (TERRAIN_SIZE - 60);
    const z = (rand() - 0.5) * (TERRAIN_SIZE - 60);
    const veg = fbm(noise, x / 120 + 40, z / 120, 2);
    if (veg < -0.15 && rand() < 0.7) continue;
    if (!clearOfRoad(x, z, ROAD_HALF_WIDTH + 2)) continue;
    const s = 0.4 + rand() * 1.1;
    ps.set(x, stage.heightAt(x, z) - 0.2, z);
    q.setFromEuler(new THREE.Euler(0, rand() * Math.PI, 0));
    sc.set(s * (1 + rand() * 0.6), s * (0.6 + rand() * 0.5), s * (1 + rand() * 0.6));
    m4.compose(ps, q, sc);
    shrubs.setMatrixAt(si, m4);
    shrubs.setColorAt(si, bc.copy(shrubColors[Math.floor(rand() * shrubColors.length)]).multiplyScalar(0.8 + rand() * 0.35));
    si++;
  }
  shrubs.count = si;
  shrubs.castShadow = true;
  shrubs.receiveShadow = true;
  group.add(shrubs);

  // dry grass tufts: two crossed cards with a blade texture
  const tuftTex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {
      const x0 = w * (0.3 + rand() * 0.4);
      const lean = (rand() - 0.5) * w * 0.9;
      const top = h * (0.05 + rand() * 0.45);
      const l = 150 + rand() * 70;
      ctx.strokeStyle = `rgb(${l}, ${l * 0.8}, ${l * 0.45})`;
      ctx.lineWidth = 1.5 + rand() * 2;
      ctx.beginPath();
      ctx.moveTo(x0, h);
      ctx.quadraticCurveTo(x0 + lean * 0.3, h * 0.6, x0 + lean, top);
      ctx.stroke();
    }
  }, { repeat: false });
  const grassGeo = (() => {
    const a = new THREE.PlaneGeometry(1.2, 1);
    a.translate(0, 0.5, 0);
    const b = a.clone().rotateY(Math.PI / 2);
    const merged = new THREE.BufferGeometry();
    const pos = [...a.attributes.position.array, ...b.attributes.position.array];
    const uv = [...a.attributes.uv.array, ...b.attributes.uv.array];
    const nrm = [];
    for (let i = 0; i < pos.length / 3; i++) nrm.push(0, 1, 0); // light like the ground
    merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    const ia = a.index.array;
    merged.setIndex([...ia, ...Array.from(ia, (v) => v + 4)]);
    return merged;
  })();
  const grassMat = new THREE.MeshStandardMaterial({
    color: palette.grass, map: tuftTex, alphaTest: 0.4, roughness: 1, side: THREE.DoubleSide,
  });
  const grassCount = 5000;
  const grass = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
  let gi = 0;
  for (let i = 0; i < 20000 && gi < grassCount; i++) {
    let x, z;
    if (rand() < 0.55) {
      const k = Math.floor(rand() * S.length);
      const t = stage.tangents[k];
      const side = rand() < 0.5 ? -1 : 1;
      const off = ROAD_HALF_WIDTH + 1.2 + rand() * 12;
      x = S[k].x - t.y * side * off;
      z = S[k].y + t.x * side * off;
    } else {
      x = (rand() - 0.5) * (TERRAIN_SIZE - 60);
      z = (rand() - 0.5) * (TERRAIN_SIZE - 60);
    }
    if (!inTerrain(x, z, 30)) continue;
    if (!clearOfRoad(x, z, ROAD_HALF_WIDTH + 0.9)) continue;
    const s = 0.45 + rand() * 0.7;
    ps.set(x, stage.heightAt(x, z) - 0.05, z);
    q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.3, rand() * Math.PI, (rand() - 0.5) * 0.3));
    sc.set(s * 1.4, s, s * 1.4);
    m4.compose(ps, q, sc);
    grass.setMatrixAt(gi, m4);
    grass.setColorAt(gi, bc.set(palette.grass).multiplyScalar(0.75 + rand() * 0.5));
    gi++;
  }
  grass.count = gi;
  group.add(grass);

  // ---- fences along some straights --------------------------------------------------------
  const postGeo = new THREE.CylinderGeometry(0.06, 0.08, 1.3, 5);
  postGeo.translate(0, 0.65, 0);
  const postMat = new THREE.MeshStandardMaterial({ color: '#6b4a32', roughness: 1 });
  const posts = new THREE.InstancedMesh(postGeo, postMat, 1200);
  const wirePts = [];
  let pi = 0;
  for (let k = 40; k < S.length - 40 && pi < 1150; ) {
    if (rand() < 0.012) {
      const side = rand() < 0.5 ? -1 : 1;
      const run = 60 + Math.floor(rand() * 120);
      const off = ROAD_HALF_WIDTH + 4 + rand() * 3;
      let prev = null;
      for (let j = k; j < Math.min(S.length - 1, k + run) && pi < 1150; j += 3) {
        const t = stage.tangents[j];
        const x = S[j].x - t.y * side * off;
        const z = S[j].y + t.x * side * off;
        if (!clearOfRoad(x, z, ROAD_HALF_WIDTH + 2)) { prev = null; continue; }
        const y = stage.heightAt(x, z);
        ps.set(x, y, z);
        q.setFromEuler(new THREE.Euler((rand() - 0.5) * 0.12, 0, (rand() - 0.5) * 0.12));
        m4.compose(ps, q, sc.set(1, 0.9 + rand() * 0.2, 1));
        posts.setMatrixAt(pi++, m4);
        const top = new THREE.Vector3(x, y + 1.05, z);
        const mid = new THREE.Vector3(x, y + 0.6, z);
        if (prev) wirePts.push(prev[0], top, prev[1], mid);
        prev = [top, mid];
      }
      k += run;
    } else {
      k += 4;
    }
  }
  posts.count = pi;
  posts.castShadow = true;
  group.add(posts);
  if (wirePts.length) {
    const wg = new THREE.BufferGeometry().setFromPoints(wirePts);
    group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: '#4a3a30', transparent: true, opacity: 0.6 })));
  }

  // ---- chevron boards at tight corners ----------------------------------------------------
  const chevronTex = (dir) =>
    canvasTexture(128, 64, (ctx, w, h) => {
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#c8202a';
      for (let i = 0; i < 3; i++) {
        const x = 18 + i * 34;
        ctx.beginPath();
        if (dir > 0) {
          ctx.moveTo(x, 8); ctx.lineTo(x + 16, 8); ctx.lineTo(x + 34, 32); ctx.lineTo(x + 16, 56); ctx.lineTo(x, 56); ctx.lineTo(x + 18, 32);
        } else {
          ctx.moveTo(x + 34, 8); ctx.lineTo(x + 18, 8); ctx.lineTo(x, 32); ctx.lineTo(x + 18, 56); ctx.lineTo(x + 34, 56); ctx.lineTo(x + 16, 32);
        }
        ctx.fill();
      }
    }, { repeat: false });
  const chevMatR = new THREE.MeshStandardMaterial({ map: chevronTex(1), roughness: 0.6 });
  const chevMatL = new THREE.MeshStandardMaterial({ map: chevronTex(-1), roughness: 0.6 });
  const boardGeo = new THREE.PlaneGeometry(2.2, 1.1);
  const legGeo = new THREE.BoxGeometry(0.08, 1.2, 0.08);
  const legMat = new THREE.MeshStandardMaterial({ color: '#555', roughness: 0.8 });
  for (const note of stage.paceNotes) {
    if (note.grade > 3) continue;
    const mid = Math.floor((note.start + note.end) / 2);
    // place on the outside of the corner, facing the approaching car
    const apex = Math.min(S.length - 1, mid);
    const t = stage.tangents[note.start];
    const side = note.sign > 0 ? -1 : 1; // outside of the bend
    const rx = -stage.tangents[apex].y * side;
    const rz = stage.tangents[apex].x * side;
    const off = ROAD_HALF_WIDTH + 3;
    const x = S[apex].x + rx * off;
    const z = S[apex].y + rz * off;
    const y = stage.heightAt(x, z);
    const board = new THREE.Group();
    const face = new THREE.Mesh(boardGeo, note.sign > 0 ? chevMatR : chevMatL);
    face.position.y = 1.55;
    board.add(face);
    const back = new THREE.Mesh(boardGeo, legMat);
    back.position.y = 1.55;
    back.rotation.y = Math.PI;
    back.position.z = -0.01;
    board.add(back);
    for (const lx of [-0.8, 0.8]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lx, 0.6, -0.02);
      board.add(leg);
    }
    board.position.set(x, y, z);
    board.lookAt(x - t.x * 10, y + 1.5, z - t.y * 10);
    board.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    group.add(board);
    colliders.push({ x, z, r: 1.0 });
  }

  // ---- start & finish gantries --------------------------------------------------------------
  const gantry = (index, label, color) => {
    const p = S[index];
    const t = stage.tangents[index];
    const y = stage.roadHeights[index];
    const g = new THREE.Group();
    const poleGeo = new THREE.BoxGeometry(0.5, 6.5, 0.5);
    const poleMat = new THREE.MeshStandardMaterial({ color: '#2b2b2f', roughness: 0.5, metalness: 0.4 });
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(sx * (ROAD_HALF_WIDTH + 1.6), 3.25, 0);
      pole.castShadow = true;
      g.add(pole);
    }
    const bannerTex = canvasTexture(1024, 128, (ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 74px "Bebas Neue", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, w / 2, h / 2 + 4);
      // checker ends
      for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) {
        if ((i + j) % 2) continue;
        ctx.fillStyle = '#111';
        ctx.fillRect(i * 16, j * 32, 16, 32);
        ctx.fillRect(w - 128 + i * 16, j * 32, 16, 32);
      }
    }, { repeat: false });
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry((ROAD_HALF_WIDTH + 1.6) * 2 + 0.5, 1.4, 0.2),
      [poleMat, poleMat, poleMat, poleMat,
        new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 }),
        new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.6 })]
    );
    banner.position.y = 6.2;
    banner.castShadow = true;
    g.add(banner);
    g.position.set(p.x, y, p.y);
    g.rotation.y = Math.atan2(t.x, t.y);
    group.add(g);
    for (const sx of [-1, 1]) {
      colliders.push({ x: p.x - t.y * sx * (ROAD_HALF_WIDTH + 1.6), z: p.y + t.x * sx * (ROAD_HALF_WIDTH + 1.6), r: 0.6 });
    }
  };
  stage.startIndex = 10;
  stage.finishIndex = S.length - 12;
  gantry(stage.startIndex + 4, 'RED MESA RALLY  ·  START', '#c8202a');
  gantry(stage.finishIndex, 'FINISH', '#1f4fa8');

  return { group, colliders, road, terrain };
}
