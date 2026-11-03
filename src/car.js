// Arcade bicycle-model car physics tuned for gravel (the model lives in carmodel.js).
import * as THREE from 'three';
import { clamp, lerp } from './noise.js';

const G = 9.81;

// --------------------------------------------------------------------------------------
export class CarPhysics {
  constructor(stage) {
    this.stage = stage;
    this.mass = 1150;
    this.inertia = 1650;
    this.a = 1.27; // cg -> front axle
    this.b = 1.27; // cg -> rear axle
    this.cgHeight = 0.5;
    this.halfTrack = 0.8;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3(); // world, xz + y
    this.heading = 0; // rotation.y; forward = (sin h, cos h)
    this.yawRate = 0; // rad/s, > 0 turns right
    this.steer = 0;
    this.grounded = true;
    this.airTime = 0;
    this.landImpact = 0;
    this.lastAirTime = 0;
    this.hitImpact = 0;
    this.normal = new THREE.Vector3(0, 1, 0);
    this.quat = new THREE.Quaternion();
    this.localVel = new THREE.Vector2(); // x = forward, y = right
    this.accLong = 0;
    this.accLat = 0;
    this.gear = 1;
    this.rpm = 900;
    this.shiftTimer = 0;
    this.surface = 'gravel';
    this.roadIndex = 0;
    this.roadDist = 0;
    this.rearSlip = 0;
    this.wheelSpin = 0;
    this.gearTop = [0, 13, 21, 29, 37, 44, 52]; // m/s at redline per gear
  }

  reset(index) {
    const s = this.stage;
    const i = clamp(index, 2, s.samples.length - 3);
    const p = s.samples[i];
    const t = s.tangents[i];
    this.pos.set(p.x, s.heightAt(p.x, p.y) + 0.02, p.y);
    this.vel.set(0, 0, 0);
    this.heading = Math.atan2(t.x, t.y);
    this.yawRate = 0;
    this.steer = 0;
    this.gear = 1;
    this.roadIndex = i;
    this.grounded = true;
    this.updateOrientation(1, 1);
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  update(dt, input, colliders) {
    const s = this.stage;
    const fwd = new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading));
    const right = new THREE.Vector2(-fwd.y, fwd.x);
    const vx = this.vel.x * fwd.x + this.vel.z * fwd.y; // forward speed
    const vy = this.vel.x * right.x + this.vel.z * right.y; // rightward speed
    this.localVel.set(vx, vy);
    const speed = Math.hypot(vx, vy);

    // surface
    const near = s.nearestLocal(this.pos.x, this.pos.z, this.roadIndex, 30);
    if (near.dist > 30) {
      const g = s.nearest(this.pos.x, this.pos.z);
      if (g) Object.assign(near, g);
    }
    this.roadIndex = near.index;
    this.roadDist = near.dist;
    const onRoad = near.dist < 5.6;
    this.surface = onRoad ? 'gravel' : 'sand';
    const mu = onRoad ? 1.0 : 0.72;

    // steering: faster input response, less lock at speed
    const maxSteer = 0.62 / (1 + Math.abs(vx) / 26);
    const target = input.steer * maxSteer;
    const rate = (Math.sign(target - this.steer) === Math.sign(this.steer) || target === 0 ? 3.2 : 5.0) * dt;
    this.steer += clamp(target - this.steer, -rate, rate);
    const delta = this.steer;

    // gears
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const top = this.gearTop[this.gear];
    const prevTop = this.gearTop[this.gear - 1] || 0;
    this.rpm = clamp(1000 + (Math.abs(vx) / top) * 6600, 900, 7800);
    if (this.wheelSpin > 0) this.rpm = Math.min(7900, this.rpm + this.wheelSpin * 2500);
    if (this.rpm > 7300 && this.gear < 6 && vx > 0) { this.gear++; this.shiftTimer = 0.18; }
    else if (this.gear > 1 && Math.abs(vx) < prevTop * 0.78) { this.gear--; this.shiftTimer = 0.12; }

    const W = this.mass * G;
    const L = this.a + this.b;
    // longitudinal weight transfer (from last frame's acceleration)
    const transfer = (this.mass * this.accLong * this.cgHeight) / L;
    let Nf = clamp(W * (this.b / L) - transfer, W * 0.15, W * 0.85);
    let Nr = W - Nf;

    let Fx = 0; // forward drive/brake at the wheels
    const throttle = input.throttle;
    const brake = input.brake;
    const reversing = vx < 0.5 && brake > 0 && throttle === 0;
    if (throttle > 0 && this.shiftTimer === 0) {
      const ratio = 1.55 - this.gear * 0.12;
      Fx += throttle * 7800 * ratio * clamp(1 - (vx / 54) ** 2, 0, 1) * (onRoad ? 1 : 0.8);
    }
    if (brake > 0) {
      if (vx > 0.5) Fx -= brake * 11500;
      else if (reversing) Fx -= brake * 4200 * clamp(1 + vx / 8, 0, 1);
    }
    if (input.handbrake && Math.abs(vx) > 0.5) Fx -= Math.sign(vx) * 3500;

    // wheelspin estimate (for sound/dust): drive force beyond rear traction
    this.wheelSpin = clamp((Math.abs(Fx) - mu * Nr * 1.1) / 6000, 0, 1) * (throttle > 0 ? 1 : 0);

    // lateral tyre forces (bicycle model)
    const vxs = Math.max(Math.abs(vx), 2.5);
    const slipF = Math.atan2(vy + this.yawRate * this.a, vxs) - Math.sign(vx || 1) * delta;
    const slipR = Math.atan2(vy - this.yawRate * this.b, vxs);
    const Cf = 52000;
    const Cr = 50000;
    const muR = mu * (input.handbrake ? 0.38 : 0.94) * (1 - this.wheelSpin * 0.35);
    let Fyf = clamp(-Cf * slipF, -mu * Nf * 1.05, mu * Nf * 1.05);
    let Fyr = clamp(-Cr * slipR, -muR * Nr, muR * Nr);
    // fade lateral forces at very low speed so the car can sit still
    const lowFade = clamp(speed / 2, 0, 1);
    Fyf *= lowFade;
    Fyr *= lowFade;
    this.rearSlip = Math.abs(slipR) * clamp(speed / 10, 0, 1);

    // resistances
    const drag = 0.42 * vx * Math.abs(vx);
    const rolling = (onRoad ? 55 : 260) * vx;

    let fxLocal = Fx - drag - rolling - Fyf * Math.sin(delta);
    let fyLocal = Fyf * Math.cos(delta) + Fyr;
    let torque = this.a * Fyf * Math.cos(delta) - this.b * Fyr;
    // a little yaw damping keeps slides catchable
    torque -= this.yawRate * 900 * (input.handbrake ? 0.3 : 1);

    if (!this.grounded) {
      fxLocal = -drag * 0.5;
      fyLocal = 0;
      torque = -this.yawRate * 300;
    }

    const ax = fxLocal / this.mass;
    const ay = fyLocal / this.mass;
    this.accLong = lerp(this.accLong, ax, 0.2);
    this.accLat = lerp(this.accLat, ay, 0.15);

    // integrate in world space
    this.vel.x += (fwd.x * ax + right.x * ay) * dt;
    this.vel.z += (fwd.y * ax + right.y * ay) * dt;
    this.yawRate += (torque / this.inertia) * dt;
    this.heading -= this.yawRate * dt; // yawRate > 0 turns right; heading grows to the left

    // sideways scrub on sand bleeds speed
    if (!onRoad && this.grounded) {
      const k = Math.exp(-0.25 * dt);
      this.vel.x *= k;
      this.vel.z *= k;
    }

    // stop creeping
    if (speed < 0.3 && throttle === 0 && !reversing) {
      this.vel.x *= 0.8;
      this.vel.z *= 0.8;
      this.yawRate *= 0.8;
    }

    // slope gravity
    if (this.grounded) {
      s.normalAt(this.pos.x, this.pos.z, this.normal);
      this.vel.x += this.normal.x * G * dt * 0.9;
      this.vel.z += this.normal.z * G * dt * 0.9;
    }

    // vertical motion with airtime over crests
    const prevGround = s.heightAt(this.pos.x, this.pos.z);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const ground = s.heightAt(this.pos.x, this.pos.z);
    const groundVy = (ground - prevGround) / dt;
    this.landImpact = 0;
    if (this.grounded) {
      this.vel.y = groundVy;
      this.pos.y = ground;
      // leave the ground when the terrain falls away faster than gravity can pull us down
      const nextGround = s.heightAt(this.pos.x + this.vel.x * dt, this.pos.z + this.vel.z * dt);
      const nextGroundVy = (nextGround - ground) / dt;
      if (this.vel.y - G * dt > nextGroundVy + 1.2 && speed > 12) {
        this.grounded = false;
        this.airTime = 0;
      }
    } else {
      this.vel.y -= G * dt;
      this.pos.y += this.vel.y * dt;
      this.airTime += dt;
      if (this.pos.y <= ground) {
        this.landImpact = clamp((groundVy - this.vel.y) / 8, 0, 1.5) || 0.01;
        this.lastAirTime = this.airTime;
        this.pos.y = ground;
        this.vel.y = groundVy;
        this.grounded = true;
      }
    }

    // obstacles
    this.hitImpact = 0;
    const carR = 1.5;
    for (const c of colliders) {
      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const min = c.r + carR;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d;
        const nz = dz / d;
        this.pos.x = c.x + nx * min;
        this.pos.z = c.z + nz * min;
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          this.hitImpact = Math.max(this.hitImpact, -vn);
          this.vel.x -= nx * vn * 1.35;
          this.vel.z -= nz * vn * 1.35;
          this.vel.x *= 0.6;
          this.vel.z *= 0.6;
          this.yawRate += (Math.random() - 0.5) * Math.min(3, -vn * 0.15);
        }
      }
    }
    // world bounds
    const lim = 900;
    for (const k of ['x', 'z']) {
      if (Math.abs(this.pos[k]) > lim) {
        this.pos[k] = Math.sign(this.pos[k]) * lim;
        this.vel[k] *= -0.3;
      }
    }

    this.updateOrientation(dt, this.grounded ? 1 : 0);
  }

  updateOrientation(dt, groundFollow) {
    const s = this.stage;
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (groundFollow) {
      // fit a plane through the four contact patches
      const h = (f, r) =>
        s.heightAt(this.pos.x + fwd.x * f + right.x * r, this.pos.z + fwd.z * f + right.z * r);
      const fl = h(this.a, -this.halfTrack);
      const fr = h(this.a, this.halfTrack);
      const rl = h(-this.b, -this.halfTrack);
      const rr = h(-this.b, this.halfTrack);
      const pitchSlope = ((fl + fr) - (rl + rr)) / 2 / (this.a + this.b);
      const rollSlope = ((fr + rr) - (fl + rl)) / 2 / (this.halfTrack * 2);
      const f3 = fwd.clone().setY(pitchSlope).normalize();
      const r3 = right.clone().setY(rollSlope).normalize();
      const up = new THREE.Vector3().crossVectors(r3, f3).normalize(); // right x forward = up
      const left = new THREE.Vector3().crossVectors(up, f3).normalize();
      const m = new THREE.Matrix4().makeBasis(left, up, f3);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.quat.slerp(q, dt >= 1 ? 1 : clamp(dt * 18, 0, 1));
      // keep chassis height consistent with the plane
      this.pos.y = Math.max(this.pos.y, (fl + fr + rl + rr) / 4);
    } else {
      // in the air: keep heading, nose slowly follows the trajectory
      const pitch = Math.atan2(this.vel.y, Math.max(this.speed, 1)) * 0.6;
      const f3 = fwd.clone().setY(Math.tan(pitch)).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const r3 = new THREE.Vector3().crossVectors(up, f3).normalize(); // = +x local (left)
      const u3 = new THREE.Vector3().crossVectors(f3, r3).normalize();
      const m = new THREE.Matrix4().makeBasis(r3, u3, f3);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      this.quat.slerp(q, clamp(dt * 3, 0, 1));
    }
  }
}
