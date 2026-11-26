/*
 * test/objectives.test.js - Stage 2.12b, Parts A and C: what each metric means and which objective a ranking used.
 *
 * Part A (metric semantics): the walk uses E[damage] per blow, so `health / ttk` is a KILL RATE, not the damage actually
 * dealt - the last blow overshoots. `outputDps` (dealt / ttk) and `expectedPerSwing` (dealt / blows) are the figures
 * that describe the damage; `killDps`/`ttk` describe the kill. They are kept apart instead of one number wearing two
 * names.
 *
 * Part C (objectives): snapshot, whole fight, relay and relay-ceiling are separate, named objectives; a ranking says
 * which one it used and against what target, never switches silently, and refuses to mix target conditions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { OBJECTIVES, OBJECTIVE_IDS, evaluateObjective, rankBuilds, targetAssumptions } from '../src/objectives.js';
import { fight } from '../src/fight.js';
import { gateTarget, referenceFoe } from '../src/model.js';
import { maxCharacter } from '../src/maxprofile.js';

const gate = () => gateTarget(45);
const foe = () => referenceFoe(45, 'tough');
// The recorded orders in this file are a3eb1605's, so the scenario and every character name the cut.
const OPTS = { core: 'overhaul', rri: true, passiveOn: true, stacks: 5, gameBuild: '14512' };
const max = (t) => ({ id: t, ch: maxCharacter(t, { gameBuild: '14512' }) });

test('1. metric semantics: kill rate, output rate and the expected blow are distinct and consistent', () => {
  const f = fight(maxCharacter(127, { gameBuild: '14512' }), { ...OPTS, target: foe(), health: 12000 });
  assert.ok(f);
  // the kill rate is health / ttk; the output rate is the damage actually dealt / ttk, which is larger by the overkill
  assert.equal(f.killDps, f.dps, 'killDps is the 2.12a `dps`');
  assert.ok(Math.abs(f.killDps - f.health / f.ttk) < 1e-9);
  assert.ok(Math.abs(f.overkill - (f.expectedPerSwing * f.blows - f.health)) < 1e-9, 'overkill is dealt - health');
  assert.ok(f.outputDps > f.killDps, 'the damage rate is above the kill rate by the last blow');
  assert.ok(Math.abs(f.outputDps / f.killDps - (1 + f.overkill / f.health)) < 1e-9, 'exactly the overkill share');
  assert.ok(f.overkill > 0 && f.overkill < f.expectedPerSwing * 2, 'the overshoot is a blow or two, never more');
  // a bigger pool: the same blow, less relative overkill - the two rates converge
  const big = fight(maxCharacter(127, { gameBuild: '14512' }), { ...OPTS, target: foe(), health: 120000 });
  assert.ok(big.overkill / big.health < f.overkill / f.health / 5);
  assert.ok(big.outputDps / big.killDps < 1.01);
});

test('2. every objective is named, and every result says which target it was computed against', () => {
  const target = gate();
  for (const objective of OBJECTIVE_IDS) {
    const r = evaluateObjective(maxCharacter(121, { gameBuild: '14512' }), { ...OPTS, objective, target, health: target.maxHealth });
    assert.equal(r.objective, objective);
    assert.equal(r.direction, 'max');
    assert.equal(r.unit, 'dps');
    assert.equal(r.assumptions.objective, objective);
    assert.equal(r.assumptions.target.kind, target.allowance ? 'relay' : 'foe');
    assert.equal(r.assumptions.target.mobileType, 31);
    assert.equal(r.assumptions.target.allowance?.level, 45);
    assert.ok(Number.isFinite(r.value) && r.value > 0);
    assert.ok(r.assumptions.basis.length > 10, 'the basis is stated');
  }
  // the target's own identity: a relay body says so, a foe does not
  assert.equal(targetAssumptions(foe()).kind, 'foe');
  assert.equal(targetAssumptions(gate()).kind, 'relay');
  // a name that is not an objective is refused, and so is a relay objective on a body that has no allowance
  assert.throws(() => evaluateObjective(maxCharacter(121, { gameBuild: '14512' }), { objective: 'boss-dps', target }), /unknown objective/);
  assert.throws(() => evaluateObjective(maxCharacter(121, { gameBuild: '14512' }), { objective: 'relay', target: foe() }), /not a relay body/);
  assert.throws(() => evaluateObjective(maxCharacter(121, { gameBuild: '14512' }), { objective: 'snapshot' }), /a declared target is required/);

});

test('3. no implicit switching: snapshot and whole-fight orderings can differ, and the ranking names the objective', () => {
  const entries = [max(126), max(117), max(121)];
  const snap = rankBuilds(entries, { ...OPTS, objective: 'snapshot', target: foe() });
  const walk = rankBuilds(entries, { ...OPTS, objective: 'fight', target: foe(), health: 12000 });
  assert.equal(snap.objective, 'snapshot');
  assert.equal(walk.objective, 'fight');
  assert.equal(snap.health, foe().maxHealth, 'the ranking records the pool it was declared against (the foe\'s own)');
  const order = (r) => r.rows.map((x) => x.id);
  // the warhammer (126) is ahead of the short blade (117) on the full-health card, behind it over the fight:
  // blunt mastery pays only while the foe is at or above half, so its low half is slower
  assert.ok(order(snap).indexOf(126) < order(snap).indexOf(117), `snapshot order ${order(snap)}`);
  assert.ok(order(walk).indexOf(117) < order(walk).indexOf(126), `fight order ${order(walk)}`);
  // each row carries the ranking's assumptions, and they are all the same
  for (const row of walk.rows) assert.deepEqual(row.assumptions, walk.rows[0].assumptions);
  assert.deepEqual(walk.rows.map((r) => r.rank), walk.rows.map((_, i) => i + 1));
});

test('4. relay-aware and uncapped orderings differ: the cap reorders, and the ceiling separates what the relay ties', () => {
  const entries = [563, 121, 117, 116, 113, 126, 123].map(max);
  const target = gate();
  const uncapped = rankBuilds(entries, { ...OPTS, objective: 'snapshot', target, health: target.maxHealth });
  const ceiling = rankBuilds(entries, { ...OPTS, objective: 'relay-ceiling', target, health: target.maxHealth });
  const relay = rankBuilds(entries, { ...OPTS, objective: 'relay', target, health: target.maxHealth });
  const order = (r) => r.rows.map((x) => x.id);
  const byId = (r) => new Map(r.rows.map((x) => [x.id, x.value]));
  // the per-hit cap reorders: the dai-katana leads the uncapped card and is not first at the relay
  assert.equal(order(uncapped)[0], 123, `uncapped ${order(uncapped)}`);
  assert.equal(order(ceiling)[0], 117, `ceiling ${order(ceiling)}`);
  assert.ok(order(uncapped).join(',') !== order(ceiling).join(','), 'the two objectives rank differently');
  // the relay's kill rate collapses: the top few are within a couple of per cent ...
  const top = relay.rows.slice(0, 4).map((r) => r.value);
  const spread = (Math.max(...top) - Math.min(...top)) / Math.max(...top);
  assert.ok(spread < 0.02, `relay top-4 spread ${(spread * 100).toFixed(2)}%`);
  assert.ok(relay.rows.every((r) => r.detail.saturated), 'every max profile saturates the gate');
  // ... while the ceiling keeps them apart: 117 and 126 are within 2% at the relay and 2x on the ceiling
  const rv = byId(relay); const cv = byId(ceiling);
  assert.ok(Math.abs(rv.get(117) / rv.get(126) - 1) < 0.02, `relay 117 ${rv.get(117).toFixed(1)} vs 126 ${rv.get(126).toFixed(1)}`);
  assert.ok(cv.get(117) > cv.get(126) * 2, `ceiling 117 ${cv.get(117).toFixed(0)} vs 126 ${cv.get(126).toFixed(0)}`);
  // and every row reports the saturation, the margin and the cap the objective was read from
  for (const r of relay.rows) {
    assert.equal(typeof r.detail.saturated, 'boolean');
    assert.ok(Number.isFinite(r.detail.marginDps));
    assert.equal(r.detail.cap, target.hitCap);
  }
  // ordering by relay kill rate differs from the uncapped one
  assert.ok(order(relay).join(',') !== order(uncapped).join(','), 'relay and uncapped differ');
});

test('5. a ranking is deterministic and refuses mixed target conditions', () => {
  const a = rankBuilds([max(121), max(126)], { ...OPTS, objective: 'fight', target: foe(), health: 12000 });
  const b = rankBuilds([max(121), max(126)], { ...OPTS, objective: 'fight', target: foe(), health: 12000 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // one row against another target is a different comparison: refused rather than silently mixed
  assert.throws(() => rankBuilds([
    { id: 'a', ch: maxCharacter(121) },
    { id: 'b', ch: maxCharacter(121), scenario: { target: gate() } },
  ], { ...OPTS, objective: 'snapshot', target: foe() }), /different target assumptions/);
});

test('6. a row that cannot be evaluated is kept and marked, never silently dropped', () => {
  // a relay objective on a body with no allowance: every row fails, and the ranking says so instead of dropping them
  const rows = rankBuilds([max(121), max(126)], { ...OPTS, objective: 'relay', target: foe() });
  assert.equal(rows.rows.length, 2);
  for (const r of rows.rows) {
    assert.match(r.error ?? '', /not a relay body/);
    assert.equal(r.rank, null);
  }
  assert.equal(OBJECTIVES.relay.unit, 'dps');
});
