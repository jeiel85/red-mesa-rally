// Contact math checks. Run from the repo root: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxContact, resolveContact, CAR_MASS, CAR_INERTIA } from '../src/contact.js';

const body = (x, z, heading, vx, vz, w = 0) => ({ x, z, heading, vx, vz, w, invMass: 1 / CAR_MASS, invInertia: 1 / CAR_INERTIA });

test('cars far apart do not touch', () => {
  assert.equal(boxContact(body(0, 0, 0, 0, 0), body(0, 10, 0, 0, 0)), null);
});

test('head-on hit bounces both cars back without spin and keeps momentum', () => {
  const a = body(0, 0, 0, 0, 10);
  const b = body(0, 3.9, Math.PI, 0, -10);
  const c = boxContact(a, b);
  assert.ok(c && c.nz < -0.99, 'normal points from b to a (-z)');
  assert.ok(Math.abs(c.depth - 0.2) < 1e-6);
  const r = resolveContact(a, b, c);
  assert.ok(r.dvaz < -5 && r.dvbz > 5);
  assert.ok(Math.abs(r.dwa) < 1e-6 && Math.abs(r.dwb) < 1e-6);
  assert.ok(Math.abs(r.dvaz + r.dvbz) < 1e-9);
});

test('a hit on the rear quarter spins the car', () => {
  // b on a's left (+x) pushes a's tail to the right, so a's nose swings left (heading grows)
  const a = body(0, 0, 0, 0, 20);
  const b = body(1.75, -1.9, 0, -6, 20);
  const c = boxContact(a, b);
  assert.ok(c && c.nx < -0.9);
  const r = resolveContact(a, b, c);
  assert.ok(r.dvax < 0, 'pushed to the right');
  assert.ok(r.dwa > 0.3, `spins nose-left, got ${r.dwa}`);
});

test('separating cars get no impulse', () => {
  const a = body(0, 0, 0, 0, 5);
  const b = body(0, 3.9, Math.PI, 0, 15);
  assert.equal(resolveContact(a, b, boxContact(a, b)).impulse, 0);
});

test('door-to-door scrub trades forward speed through friction', () => {
  const a = body(0, 0, 0, 0, 30);
  const b = body(1.8, 0, 0, -2, 20);
  const r = resolveContact(a, b, boxContact(a, b));
  assert.ok(r.dvaz < 0 && r.dvbz > 0);
});
