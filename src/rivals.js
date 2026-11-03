// AI rival cars: they drive the stage along a racing line with corner-speed limits and
// avoid traffic. Contact nudges them off line; a hard hit sets them sliding and spinning
// until they can rejoin the road.
import * as THREE from 'three';
import { buildCarModel } from './carmodel.js';
import { clamp, lerp } from './noise.js';
import { CAR_MASS, CAR_INERTIA } from './contact.js';

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
    this.resetContactState();
  }

  resetContactState() {
    // small knocks: a damped yaw wobble on top of the racing line
    this.yawKick = 0;
    this.yawKickVel = 0;
    // after a spin: the leftover heading error, eased out while driving off
    this.headingBlend = 0;
    // big hits: a free sliding body until it can rejoin the road
    this.loose = false;
    this.looseTimer = 0;
    this.looseVel = { x: 0, z: 0 };
    this.looseW = 0;
    this.heading = 0;
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
    this.resetContactState();
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
    const tx = lerp(ta.x, tb.x, t);
    const tz = lerp(ta.y, tb.y, t);
    const len = Math.hypot(tx, tz) || 1;
    return {
      x: lerp(a.x, b.x, t),
      z: lerp(a.y, b.y, t),
      tx: tx / len,
      tz: tz / len,
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
    if (this.loose) {
      this.updateLoose(dt);
      return;
    }
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
      let sideBias = 0;
      for (const o of ahead) {
        const ds = o.s - this.s;
        if (ds > 0 && ds < 14 && Math.abs(o.offset - this.offset) < 2.3) {
          // try to go around on the side with more room
          const side = o.offset > 0 ? -1 : 1;
          wantOffset = clamp(o.offset + side * 2.8, -3.4, 3.4);
          if (ds < 7) target = Math.min(target, o.v + 0.5);
        } else if (Math.abs(ds) < 5 && Math.abs(o.offset - this.offset) < 2.6) {
          // side by side: hold a car's width of room instead of steering into them
          sideBias += (this.offset >= o.offset ? 1 : -1) * (2.6 - Math.abs(o.offset - this.offset));
        }
      }
      // racing line: drift towards the inside of upcoming corners
      const i0 = Math.floor(this.s / st.step);
      const curvAhead = st.curvature[Math.min(st.samples.length - 1, i0 + 10)];
      wantOffset += clamp(curvAhead * 120, -2.2, 2.2);
      wantOffset += Math.sin(raceTime * 0.4 + this.wobble) * 0.4;
      wantOffset += sideBias * 1.5;
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
    // yaw wobble from knocks settles like a sprung, damped tail
    this.yawKickVel += (-40 * this.yawKick - 9 * this.yawKickVel) * dt;
    this.yawKick += this.yawKickVel * dt;
    this.headingBlend *= Math.exp(-2.2 * dt);
    this.s += this.v * dt;
    const finishS = st.finishIndex * st.step;
    if (!this.finished && this.s >= finishS && running) {
      this.finished = true;
      this.finishTime = raceTime;
    }
    this.s = Math.min(this.s, (st.samples.length - 2) * st.step);
    this.applyTransform(dt);
  }

  // Sliding after a big hit: the tyres scrub off speed and spin, then the AI takes over.
  updateLoose(dt) {
    const st = this.stage;
    this.looseTimer += dt;
    const speed = Math.hypot(this.looseVel.x, this.looseVel.z);
    if (speed > 1e-3) {
      const k = (Math.max(0, speed - 6 * dt) * Math.exp(-0.3 * dt)) / speed;
      this.looseVel.x *= k;
      this.looseVel.z *= k;
    }
    this.looseW *= Math.exp(-1.9 * dt);
    this.heading += this.looseW * dt;
    this.pos.x += this.looseVel.x * dt;
    this.pos.z += this.looseVel.z * dt;
    const near = st.nearestLocal(this.pos.x, this.pos.z, Math.floor(this.s / st.step), 30);
    this.s = near.index * st.step;
    if (this.looseTimer > 1.3 && (Math.abs(this.looseW) < 1.1 || this.looseTimer > 2.6)) this.rejoin();
    else this.place3D(this.pos.x, this.pos.z, this.heading, dt, speed);
  }

  // Back onto the racing model where the slide ended, keeping the leftover heading error.
  rejoin() {
    const st = this.stage;
    const near = st.nearestLocal(this.pos.x, this.pos.z, Math.floor(this.s / st.step), 30);
    const p = st.samples[near.index];
    const t = st.tangents[near.index];
    const dx = this.pos.x - p.x;
    const dz = this.pos.z - p.y;
    this.s = near.index * st.step + dx * t.x + dz * t.y;
    this.offset = clamp(dx * -t.y + dz * t.x, -9, 9);
    this.v = Math.max(2, this.looseVel.x * t.x + this.looseVel.z * t.y);
    this.offsetVel = clamp(this.looseVel.x * -t.y + this.looseVel.z * t.x, -6, 6);
    const slide = Math.atan2(this.offsetVel, Math.max(this.v, 3));
    const err = this.heading - (Math.atan2(t.x, t.y) - slide);
    this.headingBlend = Math.atan2(Math.sin(err), Math.cos(err));
    this.yawKick = 0;
    this.yawKickVel = 0;
    this.loose = false;
    this.applyTransform(0);
  }

  applyTransform(dt) {
    const p = this.sampleAt(this.s);
    // right vector = (-tz, tx)
    const x = p.x - p.tz * this.offset;
    const z = p.z + p.tx * this.offset;
    // yaw follows the road plus the sideways drift of the racing line
    const slide = Math.atan2(this.offsetVel, Math.max(this.v, 3));
    const heading = Math.atan2(p.tx, p.tz) - slide + this.yawKick + this.headingBlend;
    this.place3D(x, z, heading, dt, this.v);
  }

  place3D(x, z, heading, dt, speed) {
    const st = this.stage;
    this.pos.set(x, st.heightAt(x, z), z);
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const h = (f, r) => st.heightAt(x + fx * f - fz * r, z + fz * f + fx * r);
    const fl = h(1.27, -0.8), fr = h(1.27, 0.8), rl = h(-1.27, -0.8), rr = h(-1.27, 0.8);
    const f3 = new THREE.Vector3(fx, ((fl + fr) - (rl + rr)) / 2 / 2.54, fz).normalize();
    const r3 = new THREE.Vector3(-fz, ((fr + rr) - (fl + rl)) / 2 / 1.6, fx).normalize();
    const up = new THREE.Vector3().crossVectors(r3, f3).normalize();
    const left = new THREE.Vector3().crossVectors(up, f3).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, f3));
    // a spinning car must not lag behind its own heading, so follow faster while loose
    this.quat.slerp(q, dt >= 1 ? 1 : clamp(dt * (this.loose ? 30 : 12), 0, 1));
    this.heading = heading;

    const car = this.model.car;
    car.position.copy(this.pos);
    car.quaternion.copy(this.quat);
    const lean = this.loose ? clamp(-this.looseW * 0.02, -0.07, 0.07) : clamp(this.offsetVel * 0.02, -0.06, 0.06);
    this.model.body.rotation.z = lerp(this.model.body.rotation.z, lean, 0.1);
    for (const w of this.model.wheels) {
      w.spin.rotation.x += (speed / 0.34) * Math.min(dt, 0.1);
      if (w.front) w.pivot.rotation.y = this.loose ? 0 : clamp(-this.offsetVel * 0.08, -0.4, 0.4);
    }
  }

  // ---- contact interface (see contact.js) ------------------------------------------------
  body() {
    if (this.loose) {
      return {
        x: this.pos.x, z: this.pos.z, heading: this.heading,
        vx: this.looseVel.x, vz: this.looseVel.z, w: this.looseW,
        invMass: 1 / CAR_MASS, invInertia: 1 / CAR_INERTIA,
      };
    }
    const p = this.sampleAt(this.s);
    const curv = this.stage.curvature[Math.min(this.stage.samples.length - 1, p.index)];
    return {
      x: this.pos.x, z: this.pos.z, heading: this.heading,
      vx: p.tx * this.v - p.tz * this.offsetVel,
      vz: p.tz * this.v + p.tx * this.offsetVel,
      // the road bending right (curvature > 0) turns the heading the negative way
      w: -curv * this.v + this.yawKickVel,
      invMass: 1 / CAR_MASS, invInertia: 1 / CAR_INERTIA,
    };
  }

  // Velocity/spin change and positional push from a contact. `grip` scales how much it takes
  // to break traction (rivals rubbing each other hold on better than when the player hits).
  applyContact(dvx, dvz, dw, pushX, pushZ, grip = 1) {
    if (this.loose) {
      this.looseVel.x += dvx;
      this.looseVel.z += dvz;
      this.looseW += dw;
      this.pos.x += pushX;
      this.pos.z += pushZ;
      return;
    }
    const p = this.sampleAt(this.s);
    const along = dvx * p.tx + dvz * p.tz;
    const lateral = -dvx * p.tz + dvz * p.tx;
    if (this.v > 4 && (Math.abs(dw) > 1.0 * grip || Math.abs(lateral) > 4.5 * grip)) {
      // hard enough to break traction: let it slide and spin freely
      const b = this.body();
      this.loose = true;
      this.looseTimer = 0;
      this.looseVel.x = b.vx + dvx;
      this.looseVel.z = b.vz + dvz;
      this.looseW = b.w + dw;
      this.pos.x += pushX;
      this.pos.z += pushZ;
      return;
    }
    this.v = Math.max(0, this.v + along);
    this.offsetVel += lateral;
    this.yawKickVel += dw;
    this.s += pushX * p.tx + pushZ * p.tz;
    this.offset += -pushX * p.tz + pushZ * p.tx;
  }

  rearWheels(out) {
    this.model.car.updateMatrixWorld(true);
    out[0].set(-0.8, 0, -1.4).applyMatrix4(this.model.car.matrixWorld);
    out[1].set(0.8, 0, -1.4).applyMatrix4(this.model.car.matrixWorld);
    return out;
  }

  // world-space velocity, used for dust
  velocity(out = tmpV) {
    const b = this.body();
    return out.set(b.vx, 0, b.vz);
  }

  get speed() {
    return this.loose ? Math.hypot(this.looseVel.x, this.looseVel.z) : this.v;
  }

  setVisible(v) {
    this.model.car.visible = v;
  }
}
