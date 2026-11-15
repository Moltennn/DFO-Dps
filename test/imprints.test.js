import test from 'node:test';
import assert from 'node:assert/strict';
import { imprintsFor, powerDps, rankAll, rankFamily, IMPRINT_FAMILIES, WEAPON_IMPRINTS } from '../src/imprints.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { gateTarget } from '../src/model.js';

const family = (key) => IMPRINT_FAMILIES.find((f) => f.key === key);

test('imprint eligibility is the Weapons group, then the power\'s own fit', () => {
  // A Weapon Legendary's power may sit on any weapon of the group: the record's
  // template list is only which base a Legendary drops as.
  assert.ok(imprintsFor(127).some((r) => r.id === 'warp-edge')); // a mace may carry Many Endings
  assert.ok(imprintsFor(117).some((r) => r.id === 'anseis-edge')); // a wakizashi may carry Way of the Sword
  assert.ok(imprintsFor(563).some((r) => r.id === 'warp-edge')); // the wraps are Weapons
  // Only the power's own fit narrows it: the chain wants a shot, the quake a melee blow.
  const bow = imprintsFor(129).map((r) => r.power.kind);
  assert.ok(bow.includes('chain'));
  assert.ok(!bow.includes('quake'));
  const melee = imprintsFor(123).map((r) => r.power.kind);
  assert.ok(melee.includes('quake'));
  assert.ok(!melee.includes('chain'));
});

test('a power is priced both unconditionally and under its trigger', () => {
  const base = maxRun(maxCharacter(123));
  const flow = { kind: 'flow', pct: 6, max: 5 };
  // Stage 2.9: a power is the same card re-run with its percentage in lootBlow's step (analyze's `with`). The share
  // is floored per blow (shareOf) and the crit, condition and defence round whole numbers after it, so the
  // result is within a point of damage per blow of the linear figure - not the exactly linear one the pre-2.9
  // shortcut gave.
  const within = (priced, linear) => Math.abs(priced / linear - 1) < 0.01;
  assert.equal(powerDps(flow, base, false), base.with({ loot: { pct: 30, flat: 0 } }).dps);
  assert.ok(within(powerDps(flow, base, false), base.dps * 1.30), `${powerDps(flow, base, false) / base.dps}`);
  const bane = { kind: 'bane', pct: 50 };
  assert.equal(powerDps(bane, base, false), base.dps);
  assert.ok(within(powerDps(bane, base, true), base.dps * 1.50), `${powerDps(bane, base, true) / base.dps}`);
});

test('the long-blade ranking keeps every weapon power, read on a long blade', () => {
  const r = rankFamily(family('LongBlade'));
  const names = r.rows.map((x) => x.power.name);
  assert.ok(names.includes('Way of the Sword'));
  assert.ok(names.includes('Dragonsbane'));
  assert.ok(names.includes('Arcane Surge'));
  assert.equal(r.rows.length, WEAPON_IMPRINTS.length - 1); // every power but the shot-only chain
  assert.ok(!names.includes('Chain Lightning'));
  assert.ok(family('LongBlade').templates.includes(r.rows.find((x) => x.power.name === 'Arcane Surge').template));
});

test('Silent Death is a double only away from the gate, where its trigger can occur', () => {
  const base = maxRun(maxCharacter(117));
  const silent = { kind: 'unaware', pct: 100 };
  assert.equal(powerDps(silent, base, true), base.with({ loot: { pct: 100, flat: 0 } }).dps);
  assert.ok(Math.abs(powerDps(silent, base, true) / base.dps - 2) < 0.02, `${powerDps(silent, base, true) / base.dps}`); // +100% is exact before the crit, condition and defence round it
  const r = rankFamily(family('ShortBlade'));
  const row = r.rows.find((x) => x.power.name === 'Silent Death');
  assert.equal(row.conditionalDps, row.baseDps);
  assert.match(row.trigger, /not at the gate/);
});

test('the boss ranking reflects the gate cap, not the uncapped ceiling', () => {
  const r = rankFamily(family('LongBlade'));
  const flow = r.rows.find((x) => x.power.name === 'Way of the Sword');
  // The legal profile is no longer saturated far above the cap, but the cap still absorbs most of the
  // power's +6%/stack (30% at five stacks): the uncapped gain is far larger than the capped one.
  assert.ok(flow.delta >= 0);
  assert.ok(flow.uncappedDelta > flow.delta * 5, `capped ${flow.delta} vs uncapped ${flow.uncappedDelta}`);
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


test('the per-hit cap is per player; the health pool scales with the group', () => {
  const solo = gateTarget(45);
  const group = gateTarget(45, { players: 4 });
  assert.equal(group.hitCap, solo.hitCap);
  assert.equal(group.maxHealth, solo.maxHealth * 4);
});

test('Many Endings is a separate hit, so it survives the main hit\'s cap', () => {
  const base = maxRun(maxCharacter(123), { target: gateTarget(45) });
  const echo = { kind: 'echo', chance: 10 };
  const boss = powerDps(echo, base, false, { capped: true });
  assert.ok(boss > base.cappedDps);
  assert.ok(Math.abs(boss - base.cappedDps * 1.1) < 1e-9);
});


test('moon adds both night and animal shares, and chain/quake are other-target only', () => {
  const base = maxRun(maxCharacter(123));
  const moon = powerDps({ kind: 'moon', pct: 35, beast: 35 }, base, true);
  assert.equal(moon, base.with({ loot: { pct: 70, flat: 0 } }).dps);
  assert.ok(Math.abs(moon / (base.dps * 1.7) - 1) < 0.01, `${moon / base.dps}`);
  assert.equal(powerDps({ kind: 'chain', share: 50 }, base, true), base.dps);
  assert.equal(powerDps({ kind: 'quake', share: 25 }, base, true), base.dps);
});


test('every weapon imprint has a live power and a readable effect', () => {
  assert.equal(WEAPON_IMPRINTS.length, 13);
  for (const rec of WEAPON_IMPRINTS) {
    assert.ok(rec.power?.name, rec.id);
    assert.ok(rec.power?.brief, rec.id);
    assert.ok(rec.templates === null || rec.templates.length > 0, rec.id);
  }
  assert.match(WEAPON_IMPRINTS.find((r) => r.id === 'tsaesci-fang').power.brief, /poison resistance/);
  assert.match(WEAPON_IMPRINTS.find((r) => r.id === 'warp-edge').power.brief, /same damage/);
  assert.match(WEAPON_IMPRINTS.find((r) => r.id === 'shalidors-brand').power.brief, /Destruction/);
});
