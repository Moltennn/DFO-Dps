import test from 'node:test';
import assert from 'node:assert/strict';
import { imprintsFor, powerDps, rankAll, rankFamily, IMPRINT_FAMILIES } from '../src/imprints.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { gateTarget } from '../src/model.js';

const family = (key) => IMPRINT_FAMILIES.find((f) => f.key === key);

test('imprint eligibility follows the record templates and the power fit', () => {
  assert.ok(imprintsFor(123).some((r) => r.id === 'anseis-edge'));
  assert.ok(imprintsFor(123).some((r) => r.id === 'warp-edge'));
  assert.ok(!imprintsFor(123).some((r) => r.id === 'nightwhisper'));
  assert.ok(imprintsFor(117).some((r) => r.id === 'nightwhisper'));
  assert.ok(imprintsFor(129).some((r) => r.id === 'stormcaller'));
  assert.ok(!imprintsFor(127).some((r) => r.id === 'stormcaller'));
  assert.ok(!imprintsFor(129).some((r) => r.id === 'orsiniums-anvil'));
  assert.ok(imprintsFor(115).some((r) => r.id === 'direnni-staff'));
});

test('a power is priced both unconditionally and under its trigger', () => {
  const base = maxRun(maxCharacter(123));
  const flow = { kind: 'flow', pct: 6, max: 5 };
  assert.ok(Math.abs(powerDps(flow, base, false) / base.dps - 1.30) < 1e-9);
  const bane = { kind: 'bane', pct: 50 };
  assert.equal(powerDps(bane, base, false), base.dps);
  assert.ok(Math.abs(powerDps(bane, base, true) / base.dps - 1.50) < 1e-9);
});

test('the long-blade ranking keeps every long-blade imprint, on the best weapon it fits', () => {
  const r = rankFamily(family('LongBlade'));
  const names = r.rows.map((x) => x.power.name);
  assert.ok(names.includes('Way of the Sword'));
  assert.ok(names.includes('Dragonsbane'));
  assert.ok(names.includes('Arcane Surge'));
  const surge = r.rows.find((x) => x.power.name === 'Arcane Surge');
  assert.ok(['Broadsword', 'Saber', 'Longsword'].includes(surge.weapon));
});

test('Silent Death is a double only away from the gate, where its trigger can occur', () => {
  const base = maxRun(maxCharacter(117));
  const silent = { kind: 'unaware', pct: 100 };
  assert.ok(Math.abs(powerDps(silent, base, true) / base.dps - 2) < 1e-9);
  const r = rankFamily(family('ShortBlade'));
  const row = r.rows.find((x) => x.power.name === 'Silent Death');
  assert.equal(row.conditionalDps, row.baseDps);
  assert.match(row.trigger, /not at the gate/);
});

test('the boss ranking reflects the gate cap, not the uncapped ceiling', () => {
  const r = rankFamily(family('LongBlade'));
  const flow = r.rows.find((x) => x.power.name === 'Way of the Sword');
  assert.equal(flow.delta, 0);
  assert.ok(flow.uncappedDps > flow.baseDps);
});

test('every family returns rows and a base weapon', () => {
  for (const f of rankAll()) {
    assert.ok(f.rows.length >= 1, f.key);
    assert.ok(f.base.cappedDps > 0, f.key);
    assert.ok(f.rows.every((r) => r.baseDps > 0));
  }
});


test('the gate boss is a daedra, and Serpent\'s Kiss is flat poison before the cap', () => {
  assert.equal(gateTarget(45).group, 'daedra');
  const base = maxRun(maxCharacter(117), { target: gateTarget(45) });
  const venom = { kind: 'venom', flat: 8 };
  assert.ok(powerDps(venom, base, false, { capped: true }) > base.cappedDps);
  assert.ok(powerDps(venom, base, true, { capped: true }) >= powerDps(venom, base, false, { capped: true }));
});
