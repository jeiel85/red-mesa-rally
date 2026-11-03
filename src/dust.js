// Soft, sun-tinted dust plume particles (single Points draw call).
import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;
  varying float vAlpha;
  varying float vSeed;
  uniform float uScale;
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float depth = -mvPosition.z;
    gl_PointSize = min(aSize * uScale / depth, uScale * 0.12);
    // fade out puffs that drift close to the camera so they never wall off the view
    vAlpha = aAlpha * smoothstep(3.0, 11.0, depth);
    vSeed = aSeed;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uLight;
  varying float vAlpha;
  varying float vSeed;
  #include <fog_pars_fragment>
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    // lumpy edge + fake lighting from the top
    float lump = 0.85 + 0.15 * sin(atan(p.y, p.x) * 5.0 + vSeed * 6.28);
    float a = smoothstep(1.0, 0.0, r / lump) * vAlpha;
    vec3 col = mix(uColor * 0.75, uColor * uLight, 0.5 - p.y * 0.5);
    gl_FragColor = vec4(col, a);
    #include <fog_fragment>
  }
`;

export class Dust {
  constructor(scene, max = 900) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.startSize = new Float32Array(max);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: new THREE.Color('#c88a5e') },
          uLight: { value: new THREE.Color('#ffd9a8') },
          uScale: { value: 400 },
        },
      ]),
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
    this.accum = 0;
  }

  setPalette(color, light) {
    this.material.uniforms.uColor.value.set(color);
    this.material.uniforms.uLight.value.set(light);
  }

  setViewportHeight(h) {
    this.material.uniforms.uScale.value = h * 0.9;
  }

  emit(x, y, z, vx, vy, vz, size, life) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.startSize[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.seed[i] = Math.random();
  }

  // rate: particles per second
  spawnFromWheels(dt, points, carVel, rate, intensity) {
    this.accum += rate * dt;
    while (this.accum >= 1) {
      this.accum -= 1;
      const p = points[Math.floor(Math.random() * points.length)];
      const spread = 1.2 + intensity * 1.5;
      this.emit(
        p.x + (Math.random() - 0.5) * 0.6,
        p.y + 0.15,
        p.z + (Math.random() - 0.5) * 0.6,
        carVel.x * 0.25 + (Math.random() - 0.5) * spread,
        0.4 + Math.random() * 0.9 * (0.5 + intensity),
        carVel.z * 0.25 + (Math.random() - 0.5) * spread,
        0.8 + Math.random() * 1.0 + intensity * 0.7,
        1.2 + Math.random() * 1.2 + intensity * 0.6
      );
    }
  }

  burst(x, y, z, count, power) {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = power * (0.5 + Math.random());
      this.emit(x, y + 0.2, z, Math.cos(a) * s, 0.8 + Math.random() * power * 0.5, Math.sin(a) * s, 1.5 + Math.random() * 2, 1.8 + Math.random() * 1.5);
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i]; // 0..1
      const drag = Math.exp(-1.6 * dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - 0.15 * dt;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt + 0.3 * dt; // light breeze
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.startSize[i] * (1 + t * 2.2);
      this.alpha[i] = Math.min(1, t * 8) * (1 - t) * (1 - t) * 0.26;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}
