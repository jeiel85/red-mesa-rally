// Skill chain: drifts, jumps, speed runs and overtakes stack into a multiplied chain
// that is banked after a short quiet period, or lost on a crash.
const BANK_DELAY = 3.0;

export class SkillChain {
  constructor(onEvent) {
    this.onEvent = onEvent; // (type, payload) for the HUD
    this.reset();
  }

  reset() {
    this.total = 0;
    this.pending = 0;
    this.count = 0;
    this.timer = 0;
    this.drift = 0;
    this.driftQuiet = 0;
    this.speedTime = 0;
    this.bestChain = 0;
  }

  get multiplier() {
    return Math.min(5, 1 + this.count * 0.25);
  }

  add(label, points) {
    points = Math.round(points);
    if (points <= 0) return;
    this.pending += points;
    this.count++;
    this.timer = BANK_DELAY;
    this.onEvent('skill', { label, points, pending: this.pending, multiplier: this.multiplier, count: this.count });
  }

  break(reason) {
    if (this.pending <= 0 && this.drift <= 0) return;
    this.pending = 0;
    this.count = 0;
    this.drift = 0;
    this.timer = 0;
    this.onEvent('broken', { reason });
  }

  bank() {
    const value = Math.round(this.pending * this.multiplier);
    this.total += value;
    this.bestChain = Math.max(this.bestChain, value);
    const tier = this.count >= 9 ? 'LEGENDARY STREAK' : this.count >= 5 ? 'HOT STREAK' : 'SKILL CHAIN';
    this.onEvent('banked', { value, tier, total: this.total });
    this.pending = 0;
    this.count = 0;
  }

  update(dt, car) {
    const speed = car.speed;
    // drift: angle between where the car points and where it is going
    let slipAngle = 0;
    if (speed > 3) {
      const velYaw = Math.atan2(car.vel.x, car.vel.z);
      let d = velYaw - car.heading;
      slipAngle = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    }
    const drifting = car.grounded && speed > 11 && slipAngle > 0.2 && slipAngle < 1.5;
    if (drifting) {
      this.drift += speed * slipAngle * dt * 14;
      this.driftQuiet = 0;
      this.timer = Math.max(this.timer, 1.0);
      this.onEvent('drifting', { points: Math.round(this.drift) });
    } else if (this.drift > 0) {
      this.driftQuiet += dt;
      if (this.driftQuiet > 0.35) {
        if (this.drift >= 40) this.add(this.drift > 600 ? 'GREAT DRIFT' : 'DRIFT', this.drift);
        this.drift = 0;
      }
    }

    // jumps
    if (car.landImpact > 0 && car.lastAirTime > 0.35) {
      const air = car.lastAirTime;
      this.add(air > 1.0 ? 'BIG AIR' : 'AIR', 120 + air * 260);
    }

    // sustained speed
    if (speed * 3.6 > 135 && car.grounded) {
      this.speedTime += dt;
      if (this.speedTime > 1.6) {
        this.add('SPEED', 90 + (speed * 3.6 - 135) * 4);
        this.speedTime = 0;
      }
    } else {
      this.speedTime = Math.max(0, this.speedTime - dt);
    }

    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0 && this.pending > 0 && this.drift <= 0) this.bank();
    }
  }

  // Bank whatever is pending (e.g. at the finish line).
  flush() {
    if (this.drift >= 40) this.add('DRIFT', this.drift);
    this.drift = 0;
    if (this.pending > 0) this.bank();
  }
}
