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

test('a centred rear-end hit between parallel cars does not spin either car', () => {
  // same heading, one directly behind the other: whole faces touch
  const a = body(0, 0, 0, 0, 30);
  const b = body(0, 4.05, 0, 0, 20);
  const c = boxContact(a, b);
  assert.ok(c && Math.abs(c.px) < 1e-9, `contact centred, got x=${c && c.px}`);
  const r = resolveContact(a, b, c);
  assert.ok(Math.abs(r.dwa) < 1e-9 && Math.abs(r.dwb) < 1e-9, `no spin, got ${r.dwa}, ${r.dwb}`);
  assert.ok(r.dvaz < 0 && r.dvbz > 0, 'the faster car slows, the slower one is shoved');
});

test('an offset rear-end hit puts the contact in the middle of the overlap', () => {
  const a = body(0, 0, 0, 0, 30);
  const b = body(0.5, 4.05, 0, 0, 20);
  const c = boxContact(a, b);
  // faces overlap from x = -0.42 to 0.92, so the middle is 0.25
  assert.ok(Math.abs(c.px - 0.25) < 1e-9, `got ${c.px}`);
});

test('a T-bone into the middle of a side pushes without spinning the struck car', () => {
  // a drives nose-first into b's flank; b is crosswise (heading +x) and parked
  const a = body(0, 0, 0, 0, 15);
  const b = body(0, 2.87, Math.PI / 2, 0, 0);
  const c = boxContact(a, b);
  assert.ok(c && Math.abs(c.px) < 1e-9, `contact at the middle of the flank, got x=${c && c.px}`);
  const r = resolveContact(a, b, c);
  assert.ok(Math.abs(r.dwb) < 1e-9, `struck car does not spin, got ${r.dwb}`);
  assert.ok(r.dvbz > 0 && r.closing === 15);
});

test('a corner poking a flank puts the contact at that corner', () => {
  // a is turned a little so only its front-right corner reaches b's flank
  const a = body(0.5, 0, 0.3, 0, 10);
  const b = body(0, 2.9, Math.PI / 2, 0, 0);
  const c = boxContact(a, b);
  assert.ok(c, 'overlap');
  // a's front-right corner: centre + forward * 2.05 + right * 0.92
  const h = 0.3;
  const cx = 0.5 + Math.sin(h) * 2.05 - Math.cos(h) * 0.92;
  assert.ok(Math.abs(c.px - cx) < 1e-6, `contact x ${c.px} vs corner ${cx}`);
});
