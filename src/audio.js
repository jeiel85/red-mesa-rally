// Synthesised engine, gravel and impact sounds (Web Audio, no assets).
export class CarAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Must be called from a user gesture.
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(ctx.destination);

    // engine: two detuned saws + square sub through a lowpass, with a little distortion
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 4;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    this.oscs = [];
    for (const [type, mult, gain] of [['sawtooth', 1, 0.5], ['sawtooth', 1.007, 0.4], ['square', 0.5, 0.35]]) {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(shaper);
      o.start();
      this.oscs.push({ o, mult });
    }
    shaper.connect(this.engineFilter).connect(this.engineGain).connect(this.master);

    // gravel / wind: filtered noise
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const n = ctx.createBufferSource();
    n.buffer = buf;
    n.loop = true;
    this.gravelFilter = ctx.createBiquadFilter();
    this.gravelFilter.type = 'bandpass';
    this.gravelFilter.frequency.value = 1400;
    this.gravelFilter.Q.value = 0.7;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    n.connect(this.gravelFilter).connect(this.gravelGain).connect(this.master);
    n.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  update(car, throttle, running) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = car.rpm;
    const base = 28 + (rpm / 7800) * 150;
    for (const { o, mult } of this.oscs) o.frequency.setTargetAtTime(base * mult, t, 0.03);
    this.engineFilter.frequency.setTargetAtTime(500 + throttle * 1800 + rpm * 0.15, t, 0.05);
    this.engineGain.gain.setTargetAtTime(running ? 0.16 + throttle * 0.16 : 0.08, t, 0.05);
    const speed = car.speed;
    const slip = Math.min(1, car.rearSlip * 3 + car.wheelSpin);
    const g = car.grounded ? Math.min(0.5, speed / 70 + slip * 0.35) : 0.02;
    this.gravelGain.gain.setTargetAtTime(g, t, 0.06);
    this.gravelFilter.frequency.setTargetAtTime(car.surface === 'sand' ? 700 : 1500 + slip * 800, t, 0.1);
  }

  thump(strength) {
    if (!this.ctx || strength < 0.05) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(1.2, strength), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  beep(freq = 660, dur = 0.18) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur);
  }
}
