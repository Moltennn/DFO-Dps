import test from 'node:test';
import assert from 'node:assert/strict';
import { ENCOUNTERS, encounterTarget, purseOf } from '../src/encounters.js';
import { simulatePurse } from '../src/purse.js';

const base = (over = {}) => ({
  health: 12000,
  ward: 0,
  cap: 600,
  cappedPerSwing: 400,
  hit: { hit: 1 },
  cadence: { aps: 1 },
  ...over,
});

test('the level-45 purse is 750 deep, 150/s, 600 a blow, 4 blows/s', () => {
  assert.deepEqual(purseOf(45), { ref: 50, depth: 750, rate: 150, cap: 600, hitHz: 4 });
});

test('the breach target is 12,000 HP with two 3 s shields', () => {
  const t = encounterTarget('breach', 45);
  assert.equal(t.health, 12000);
  assert.equal(t.hitCap, 600);
  assert.equal(t.phaseShields, 2);
  assert.equal(t.shieldSeconds, 3);
});

test('the Sky-ketch target is 30,000 HP and still uses the 600 cap', () => {
  const t = encounterTarget('skyketch', 45);
  assert.equal(t.health, 30000);
  assert.equal(t.hitCap, 600);
  assert.equal(ENCOUNTERS.skyketch.calibrated, false);
});

test('a build above the purse refill drains it, then settles at the refill rate', () => {
  const r = simulatePurse(base(), 'breach', { level: 45 });
  // 400 DPS starts 250/s over the refill, so the 750 depth drains in 3 s,
  // then the remaining 11,250 takes 75 s at 150/s.
  assert.ok(r.ttk >= 75 && r.ttk <= 80, `ttk ${r.ttk}`);
  assert.ok(r.burst5 > 0);
  assert.equal(r.calibrated, true);
});

test('a build below the refill never empties the purse', () => {
  // Sky-ketch has no phase shields, so this is the pure purse time.
  const r = simulatePurse(base({ cappedPerSwing: 100 }), 'skyketch', { level: 45 });
  assert.ok(Math.abs(r.ttk - 120) < 1e-6, `ttk ${r.ttk}`);
  assert.ok(r.burst5 > 0);
});

test('the 4 blows/s token bucket drops blows above it', () => {
  const r = simulatePurse(base({ cappedPerSwing: 100, cadence: { aps: 10 } }), 'breach', { level: 45 });
  assert.ok(r.landedShare > 0.35 && r.landedShare < 0.45, `share ${r.landedShare}`);
  assert.ok(r.hits > 0);
});

test('the per-blow cap binds above 600', () => {
  const r = simulatePurse(base({ cappedPerSwing: 1000 }), 'breach', { level: 45 });
  assert.ok(r.landed / r.hits <= 600 + 1e-9);
});

test('phase shields add their seconds to the kill', () => {
  const slow = base({ cappedPerSwing: 100 });
  const plain = simulatePurse(slow, 'skyketch', { level: 45 });
  const breach = simulatePurse(slow, 'breach', { level: 45 });
  assert.equal(breach.phases, 2);
  assert.ok(breach.ttk - plain.ttk >= 5.5, `breach ${breach.ttk}, plain ${plain.ttk}`);
});

test('an uncalibrated immunity scales the time and is flagged', () => {
  const r = simulatePurse(base(), 'skyketch', { level: 45 });
  assert.equal(r.calibrated, false);
  assert.equal(r.immunityShare, 0);
});

test('the split penalty is added only when asked for', () => {
  const a = simulatePurse(base(), 'abyss', { level: 45 });
  const b = simulatePurse(base(), 'abyss', { level: 45, splitPenaltyS: 10 });
  assert.ok(Math.abs((b.ttk - a.ttk) - 10) < 1e-9);
  assert.equal(a.calibrated, false);
});
