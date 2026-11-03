// AI rival cars: they drive the stage along a racing line with corner-speed limits,
// avoid each other and the player, and get bumped around on contact.
import * as THREE from 'three';
import { buildCarModel } from './carmodel.js';
import { clamp, lerp } from './noise.js';

export const RIVAL_DEFS = [
  { name: 'Okafor', paintColor: '#f2a518', stripeA: '#151515', stripeB: '#ffffff', number: '4', team: 'DUSTLINE', aLat: 7.6, vmax: 43, accel: 5.4 },
  { name: 'Lindqvist', paintColor: '#2a6fd6', stripeA: '#ffe14a', stripeB: '#ffffff', number: '11', team: 'NORDKAPP', aLat: 7.2, vmax: 42, accel: 5.6 },
  { name: 'Haruki', paintColor: '#e9e4d8', stripeA: '#e01e37', stripeB: '#151515', number: '8', team: 'KAZE SPORT', aLat: 7.0, vmax: 41, accel: 5.2 },
  { name: 'Moreau', paintColor: '#1f8a4c', stripeA: '#f4f4f2', stripeB: '#f2a518', number: '19', team: 'VERT AUTO', aLat: 6.6, vmax: 40, accel: 5.0 },
  { name: 'Reyes', paintColor: '#1b1b1f', stripeA: '#ff5a1f', stripeB: '#ffd23f', number: '33', team: 'SOL NEGRO', aLat: 6.2, vmax: 39, accel: 4.8 },
];

const tmpV = new THREE.Vector3();

export class Rival {
  constructor(def, scene) {
    this.def = def;
    this.name = def.name;
    const m = buildCarModel(def);
    this.model = m;
    scene.add(m.car);
    this.quat = new THREE.Quaternion();
    this.pos = new THREE.Vector3();
    this.s = 0;
    this.v = 0;
    this.offset = 0;
    this.offsetVel = 0;
    this.lane = 0;
    this.finished = false;
    this.finishTime = null;
    this.wobble = Math.random() * 10;
  }

  place(stage, s, lane) {
    this.stage = stage;
    this.s = s;
    this.v = 0;
    this.lane = lane;
    this.offset = lane;
    this.offsetVel = 0;
    this.finished = false;
    this.finishTime = null;
    this.bump = 0;
    this.applyTransform(1);
  }

  sampleAt(s) {
    const st = this.stage;
    const f = clamp(s / st.step, 0, st.samples.length - 1.001);
    const i = Math.floor(f);
    const t = f - i;
    const a = st.samples[i];
    const b = st.samples[i + 1];
    const ta = st.tangents[i];
    const tb = st.tangents[i + 1];
    return {
      x: lerp(a.x, b.x, t),
      z: lerp(a.y, b.y, t),
      tx: lerp(ta.x, tb.x, t),
      tz: lerp(ta.y, tb.y, t),
      index: i,
    };
  }

  // Corner-speed limit for the road ahead (m/s).
  targetSpeed(scale) {
    const st = this.stage;
    const def = this.def;
    const i0 = Math.floor(this.s / st.step);
    const look = Math.min(90, 20 + (this.v * this.v) / (2 * 7) / st.step);
    let target = def.vmax * scale;
    for (let k = 0; k < look; k += 2) {
      const j = Math.min(st.samples.length - 1, i0 + k);
      const curv = Math.abs(st.curvature[j]);
      if (curv < 1e-4) continue;
      const vCorner = Math.sqrt((def.aLat * scale) / curv);
      // allow for braking distance to that corner
      const dist = k * st.step;
      const vAllowed = Math.sqrt(vCorner * vCorner + 2 * 7.5 * dist);
      target = Math.min(target, vAllowed);
    }
    return target;
  }

  update(dt, ctx) {
    const st = this.stage;
    const { running, playerS, playerOffset, playerSpeed, others, raceTime } = ctx;
    if (this.finished) {
      // coast down after the finish line
      this.v = Math.max(0, this.v - 6 * dt);
    } else if (running) {
      // gentle rubber band keeps the pack within reach
      const gap = this.s - playerS;
      const scale = gap > 160 ? 0.92 : gap < -160 ? 1.06 : 1;
      let target = this.targetSpeed(scale);
      // traffic: don't drive through the car in front
      const ahead = [{ s: playerS, offset: playerOffset, v: playerSpeed }, ...others.map((o) => ({ s: o.s, offset: o.offset, v: o.v }))];
      let wantOffset = this.lane;
      for (const o of ahead) {
        const ds = o.s - this.s;
        if (ds > 0 && ds < 14 && Math.abs(o.offset - this.offset) < 2.3) {
          // try to go around on the side with more room
          const side = o.offset > 0 ? -1 : 1;
          wantOffset = clamp(o.offset + side * 2.8, -3.4, 3.4);
          if (ds < 7) target = Math.min(target, o.v + 0.5);
        }
      }
      // racing line: drift towards the inside of upcoming corners
      const i0 = Math.floor(this.s / st.step);
      const curvAhead = st.curvature[Math.min(st.samples.length - 1, i0 + 10)];
      wantOffset += clamp(curvAhead * 120, -2.2, 2.2);
      wantOffset += Math.sin(raceTime * 0.4 + this.wobble) * 0.4;
      wantOffset = clamp(wantOffset, -3.6, 3.6);
      const k = 2.5;
      this.offsetVel = lerp(this.offsetVel, (wantOffset - this.offset) * k, clamp(dt * 3, 0, 1));
      this.offset += this.offsetVel * dt;

      const dv = target - this.v;
      const accel = this.def.accel * clamp(1 - this.v / (this.def.vmax * 1.05), 0.1, 1);
      this.v += clamp(dv, -9 * dt, accel * dt);
    } else {
      this.v = 0;
    }
    this.bump = Math.max(0, this.bump - dt);
    this.s += this.v * dt;
    const finishS = st.finishIndex * st.step;
    if (!this.finished && this.s >= finishS && running) {
      this.finished = true;
      this.finishTime = raceTime;
    }
    this.s = Math.min(this.s, (st.samples.length - 2) * st.step);
    this.applyTransform(dt);
  }

  applyTransform(dt) {
    const st = this.stage;
    const p = this.sampleAt(this.s);
    const len = Math.hypot(p.tx, p.tz) || 1;
    const tx = p.tx / len;
    const tz = p.tz / len;
    // right vector = (-tz, tx)
    const x = p.x - tz * this.offset;
    const z = p.z + tx * this.offset;
    this.pos.set(x, st.heightAt(x, z), z);
    // yaw follows the road plus the sideways drift of the racing line
    const slide = Math.atan2(this.offsetVel, Math.max(this.v, 3));
    const heading = Math.atan2(tx, tz) - slide;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const h = (f, r) => st.heightAt(x + fx * f - fz * r, z + fz * f + fx * r);
    const fl = h(1.27, -0.8), fr = h(1.27, 0.8), rl = h(-1.27, -0.8), rr = h(-1.27, 0.8);
    const f3 = new THREE.Vector3(fx, ((fl + fr) - (rl + rr)) / 2 / 2.54, fz).normalize();
    const r3 = new THREE.Vector3(-fz, ((fr + rr) - (fl + rl)) / 2 / 1.6, fx).normalize();
    const up = new THREE.Vector3().crossVectors(r3, f3).normalize();
    const left = new THREE.Vector3().crossVectors(up, f3).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, f3));
    this.quat.slerp(q, dt >= 1 ? 1 : clamp(dt * 12, 0, 1));
    this.heading = heading;

    const car = this.model.car;
    car.position.copy(this.pos);
    car.quaternion.copy(this.quat);
    this.model.body.rotation.z = lerp(this.model.body.rotation.z, clamp(this.offsetVel * 0.02, -0.06, 0.06), 0.1);
    for (const w of this.model.wheels) {
      w.spin.rotation.x += (this.v / 0.34) * Math.min(dt, 0.1);
      if (w.front) w.pivot.rotation.y = clamp(-this.offsetVel * 0.08, -0.4, 0.4);
    }
  }

  rearWheels(out) {
    this.model.car.updateMatrixWorld(true);
    out[0].set(-0.8, 0, -1.4).applyMatrix4(this.model.car.matrixWorld);
    out[1].set(0.8, 0, -1.4).applyMatrix4(this.model.car.matrixWorld);
    return out;
  }

  // world-space velocity, used for dust and collisions
  velocity(out = tmpV) {
    return out.set(Math.sin(this.heading) * this.v, 0, Math.cos(this.heading) * this.v);
  }

  setVisible(v) {
    this.model.car.visible = v;
  }
}
