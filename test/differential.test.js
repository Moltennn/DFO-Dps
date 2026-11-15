/*
 * test/differential.test.js - this project's combat rules against the pinned
 * game implementation, stage by stage.
 *
 * Each stage compares ONE calculation with the game's own function for the
 * same input. No stage compares DPS to DPS: a difference in one term would be
 * invisible inside a product. Inputs are seeded (test/harness/prng.mjs) so
 * every failure reproduces exactly.
 *
 * A known, audited discrepancy is declared with `waived: 'W-...'`; that case
 * must then diverge, and if it ever stops diverging the test fails (see
 * test/harness/waivers.mjs). Waivers therefore cannot hide a fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyze,
  backstabDamage,
  conditionMultiplier,
  damageModel,
  racialModifiers,
  gateTarget,
  damageModifier,
  pcaaoDamageModifier,
  referenceFoe as simReferenceFoe,
  swingFrameSeconds as simSwingFrameSeconds,
  swingHandling as simSwingHandling,
  unityRound,
  weaponOf,
  weaponToHit,
} from '../src/model.js';
import { SKILLS, WEAPONS } from '../src/data.js';
import { EFFECT_FLAGS, careerTolerance, enemyTarget, intrinsicDamage, naturalDamageResistance } from '../src/target.js';
import {
  armourConditionMultiplier, armourMaterialId, armourPiece, armourReduction, equipArmour, gearEnemy,
  leftHandShield, shieldBeatsUnderArmour, shieldBlockChance, shieldReduction,
  enemyTypeBonusRange, enemyTypeBonusValue, silverApplies, skeletalSilverDamage, targetGroupOf,
} from '../src/target.js';
import { savingChanceOutcome, savingLands, spellHasFlags } from '../src/spells.js';

import { upstream, pcaaoModules, referenceFoe } from './harness/upstream.mjs';
import { oracleEntity, upstreamBodies, upstreamBody, upstreamWear } from './harness/upstreamBodies.mjs';
import { runStage, expectClean, compareSample } from './harness/differential.mjs';
import { character, simCharacter, upstreamEntity, weapon, upstreamWeapon, fresh } from './harness/fixtures.mjs';
import { generator, seeds, summarize } from './harness/prng.mjs';
import { offHandDamage, offHandToHit } from '../src/dualWield.js';
import { WAIVERS } from './harness/waivers.mjs';

const PRESETS = ['soft', 'tough', 'armoured', 'human'];

/*
 * Stage 2.8: every upstream body below is minted by upstream itself, in its own realm booted as the client
 * boots (test/harness/upstreamBodies.mjs). The oracle is handed a test's INPUTS - a mobile, a career, a
 * player level, the pieces to wear - and never a field of the local target.
 */
const CLASS_CAREER = Object.freeze({ strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, hitPointsPerLevel: 8 });
/** Upstream bodies by mobile, for one stage. */
async function mintedBy(requests) {
  const { bodies } = await upstreamBodies(requests);
  return new Map(requests.map((r, i) => [r.mobile, bodies[i]]));
}
const TEMPLATES = [113, 115, 116, 120, 121, 122, 123, 124, 125, 126, 127, 128];
const SHORT_BLADES = [113, 114, 116, 117];

/** Deterministic fixture characters, spread over the interesting corners. */
function characterCases(count, root) {
  const out = [];
  for (const seed of seeds(root, count)) {
    const r = generator(seed);
    const stat = () => 10 + Math.floor(r() * 110);
    const skill = () => Math.floor(r() * 101);
    out.push({
      id: `c${seed >>> 0}`,
      seed,
      desc: character({
        level: 1 + Math.floor(r() * 60),
        raceId: 1 + Math.floor(r() * 8),
        stats: { strength: stat(), agility: stat(), speed: stat(), luck: stat(), endurance: stat(), willpower: stat() },
        skills: skill(),
        skillOverride: { 28: skill(), 29: skill(), 30: skill(), 32: skill(), 33: skill(), 34: skill() },
        career: { weaponArmorShieldsBitfield: (r() < 0.5 ? 0x3f : 0) << 16 },
      }),
    });
  }
  return out;
}

test('stage: critical model (chance, to-hit bonus, damage multiplier)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const cases = characterCases(60, 11).map(({ id, desc }) => ({ id, input: { desc } }));
  const report = await runStage({
    name: 'critical model',
    cases,
    waivers: WAIVERS,
    upstream: ({ desc }) => {
      const c = u.combatStats.criticalModel(upstreamEntity(desc), { overhaul: true, modules });
      return { chance: c.chance, hitBonus: c.hitBonus, damageMult: c.damageMult, kind: c.kind };
    },
    simulator: ({ desc }) => {
      const r = analyze(simCharacter(desc), { target: simReferenceFoe(desc.level, 'tough'), core: 'overhaul' });
      return { chance: r.hit.crit.chance, hitBonus: r.hit.crit.hitBonus, damageMult: r.hit.crit.damageMult, kind: r.hit.crit.kind };
    },
  });
  expectClean(assert, report);
});

test('stage: hit chance, exact expectation over the body-part table', async () => {
  const u = await upstream();
  const cases = [];
  for (const c of characterCases(18, 23)) {
    for (const t of [121, 126]) {
      for (const preset of PRESETS) cases.push({ id: `${c.id}-t${t}-${preset}`, input: { desc: c.desc, t, preset } });
    }
  }
  const report = await runStage({
    name: 'hit chance',
    cases,
    waivers: WAIVERS,
    mode: 'close',
    tolerance: 1e-12,
    upstream: ({ desc, t, preset }) => {
      const s = u.combatStats.computeCombatStats(upstreamEntity(desc), { core: 'overhaul', weapon: weapon(t, { material: 1 }), modules: pcaaoModules(u) });
      return s.head.byFoe[PRESETS.indexOf(preset)].hit;
    },
    simulator: ({ desc, t, preset }) => {
      const r = analyze(simCharacter(desc, weapon(t, { material: 1 })), { target: simReferenceFoe(desc.level, preset), core: 'overhaul' });
      return r.hit.hit;
    },
  });
  assert.ok(report.cases >= 140);
  expectClean(assert, report);
});

test('stage: weapon damage roll, range and mean (overhaul)', async () => {
  const u = await upstream();
  const cases = [];
  for (const c of characterCases(10, 37)) {
    for (const t of TEMPLATES) {
      for (const swing of ['StrikeLeft', 'StrikeDown']) {
        cases.push({ id: `${c.id}-t${t}-${swing}`, input: { desc: c.desc, t, swing } });
      }
    }
  }
  const report = await runStage({
    name: 'weapon damage',
    cases,
    waivers: WAIVERS,
    mode: 'close',
    tolerance: 1e-12,
    upstream: ({ desc, t, swing }) => {
      const s = u.combatStats.computeCombatStats(upstreamEntity(desc), { core: 'overhaul', weapon: weapon(t, { material: 1 }), modules: pcaaoModules(u) });
      const d = (s.swings.find((x) => x.key === swing) ?? s.head).byFoe[1].dmg;
      return { min: d.min, max: d.max, avg: d.avg, critAvg: d.critAvg };
    },
    simulator: ({ desc, t, swing }) => {
      const r = analyze(simCharacter(desc, weapon(t, { material: 1 })), { target: simReferenceFoe(desc.level, 'tough'), core: 'overhaul', swing });
      return { min: r.damage.min, max: r.damage.max, avg: r.damage.avg, critAvg: r.damage.critAvg };
    },
  });
  assert.ok(report.cases >= 200);
  expectClean(assert, report);
});

test('stage: a weapon elemental affix lands once, at the loot step (C5)', async () => {
  const u = await upstream();
  const cases = [];
  // Melee only: the card's bow arm omits the doubled Strength term the real hit applies
  // (combatStats.js applies no bow term; pcaao.js does), a pre-existing card/core difference outside C5.
  // The affix's own behaviour on a bow is covered by test/elemental.test.js.
  for (const t of [121, 126, 122]) {
    for (const level of [3, 6, 10]) {
      for (const swing of ['StrikeLeft', 'StrikeDown']) {
        cases.push({ id: `t${t}-el${level}-${swing}`, input: { t, level, element: 'fire', swing } });
      }
    }
  }
  const report = await runStage({
    name: 'elemental affix',
    cases,
    waivers: WAIVERS,
    upstream: ({ t, level, element, swing }) => {
      const item = { ...weapon(t, { material: 9 }), affixes: [{ id: 'elemental', param: element, value: level }] };
      const desc = character({ level: 30, raceId: 1, stats: { strength: 70 }, skills: 60 });
      const s = u.combatStats.computeCombatStats(upstreamEntity(desc), { core: 'overhaul', weapon: item, modules: pcaaoModules(u) });
      const d = (s.swings.find((x) => x.key === swing) ?? s.head).byFoe[1].dmg;
      return { min: d.min, max: d.max, avg: d.avg, critAvg: d.critAvg };
    },
    simulator: ({ t, level, element, swing }) => {
      const item = { ...weapon(t, { material: 9 }), affixes: [{ id: 'elemental', param: element, value: level }] };
      const desc = character({ level: 30, raceId: 1, stats: { strength: 70 }, skills: 60 });
      const r = analyze(simCharacter(desc, item), { target: simReferenceFoe(desc.level, 'tough'), core: 'overhaul', swing });
      return { min: r.damage.min, max: r.damage.max, avg: r.damage.avg, critAvg: r.damage.critAvg };
    },
  });
  expectClean(assert, report);
});

test('stage: Strength damage modifier (overhaul /10; classic live /10 and stock /5)', async () => {
  const u = await upstream();
  const values = [0, 25, 40, 50, 66, 75, 80, 100, 115];
  // The live game has PCAAO installed; capture its classic term before the stock run.
  const live = new Map(values.map((s) => [s, u.formulas.damageModifier(s)]));
  u.pcaao.uninstallPcaao();
  let stock;
  try {
    stock = new Map(values.map((s) => [s, u.formulas.damageModifier(s)]));
  } finally {
    u.pcaao.installPcaao();
  }
  const cases = [];
  for (const s of values) {
    cases.push({ id: `overhaul-str${s}`, input: { s, mode: 'overhaul' } });
    cases.push({ id: `classic-live-str${s}`, input: { s, mode: 'live' } });
    cases.push({ id: `classic-stock-str${s}`, input: { s, mode: 'stock' } });
  }
  const report = await runStage({
    name: 'strength modifier',
    cases,
    waivers: WAIVERS,
    upstream: ({ s, mode }) => (mode === 'overhaul' ? u.pcaao.pcaaoDamageModifier(s) : mode === 'live' ? live.get(s) : stock.get(s)),
    simulator: ({ s, mode }) => (mode === 'overhaul' ? pcaaoDamageModifier(s) : mode === 'live' ? pcaaoDamageModifier(s) : damageModifier(s)),
  });
  assert.equal(report.cases, values.length * 3);
  expectClean(assert, report);
});

test('stage: classic Strength end-to-end (damage range)', async () => {
  const u = await upstream();
  const strengths = [0, 25, 50, 66, 80, 100, 115];
  const scenarios = [
    { t: 120, race: 1, swing: 'StrikeLeft' }, // long blade, no racial
    { t: 126, race: 1, swing: 'StrikeLeft' }, // blunt
    { t: 129, race: 1, swing: 'StrikeDown' }, // bow
    { t: null, race: 1, swing: 'StrikeLeft' }, // fists
    { t: 120, race: 4, swing: 'StrikeLeft' }, // Dark Elf level/4
    { t: 129, race: 6, swing: 'StrikeDown' }, // Wood Elf archer level/3
    { t: 129, race: 2, swing: 'StrikeDown' }, // Redguard archer: nothing
    { t: 127, race: 3, swing: 'StrikeLeft' }, // Nord axe (no classic arm)
    { t: 113, race: 6, swing: 'StrikeLeft' }, // Wood Elf short (no classic arm)
  ];
  const descOf = ({ t, race }, s) => {
    const skill = t === 120 ? 29 : t === 126 ? 32 : t === 129 ? 33 : t === 127 ? 31 : t === 113 ? 28 : 4;
    return character({
      level: 30, raceId: race,
      stats: { strength: s, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 },
      skills: 50, skillOverride: { [skill]: 80, 34: 40 },
    });
  };
  const rangeOf = (scenario, s, installed) => {
    const desc = descOf(scenario, s);
    const item = scenario.t ? weapon(scenario.t, { material: 1 }) : null;
    const stats = u.combatStats.computeCombatStats(upstreamEntity(desc), {
      core: 'classic', weapon: item ? upstreamWeapon(item) : null,
    });
    const swing = stats.swings.find((x) => x.key === scenario.swing) ?? stats.head;
    return { min: swing.byFoe[1].dmg.min, max: swing.byFoe[1].dmg.max };
  };
  const keyOf = (mode, s, scenario) => `${mode}-${s}-${scenario.t}-${scenario.race}`;
  const live = new Map();
  for (const scenario of scenarios) for (const s of strengths) live.set(keyOf('live', s, scenario), rangeOf(scenario, s, true));
  u.pcaao.uninstallPcaao();
  let stock;
  try {
    stock = new Map();
    for (const scenario of scenarios) for (const s of strengths) stock.set(keyOf('stock', s, scenario), rangeOf(scenario, s, false));
  } finally {
    u.pcaao.installPcaao();
  }
  const cases = [];
  for (const mode of ['live', 'stock']) {
    for (const s of strengths) {
      for (const scenario of scenarios) cases.push({ id: keyOf(mode, s, scenario), input: { mode, s, ...scenario } });
    }
  }
  const report = await runStage({
    name: 'classic Strength end-to-end',
    cases,
    waivers: WAIVERS,
    upstream: ({ mode, s, t, race, swing }) => (mode === 'live' ? live : stock).get(keyOf(mode, s, { t, race, swing })),
    simulator: ({ mode, s, t, race, swing }) => {
      const desc = descOf({ t, race }, s);
      const item = t ? weapon(t, { material: 1 }) : null;
      const ch = item ? simCharacter(desc, item) : simCharacter(desc);
      const r = analyze(ch, {
        target: simReferenceFoe(30, 'tough'), core: 'classic', critDamage: false, swing,
        fixedStrengthDamageModifier: mode === 'live',
      });
      return { min: r.damage.min, max: r.damage.max };
    },
  });
  assert.equal(report.cases, 2 * strengths.length * scenarios.length);
  expectClean(assert, report);
});

test('stage: weapon type, handedness and swing handling', async () => {
  const u = await upstream();
  const fps = u.fpsWeapon;
  const roster = u.techniqueRoster;
  const cases = Object.keys(WEAPONS)
    .map(Number)
    .filter((t) => !WEAPONS[t].ammo)
    .map((t) => ({ id: `t${t}`, input: { t } }));
  const report = await runStage({
    name: 'weapon type and handling',
    cases,
    waivers: WAIVERS,
    upstream: ({ t }) => {
      const item = { group: 'Weapons', templateIndex: t, material: 1 };
      const type = fps.weaponTypeForItem(item);
      const both = u.equipTable.getItemHands(item) === u.equipTable.ITEM_HANDS.Both;
      // BAL10: every short blade takes the dagger's row, whatever art draws it.
      const shortBlade = roster.techniqueFamily(item) === 'shortBlade';
      return { type, both, handling: u.weaponStates.swingHandling(type, both, shortBlade) };
    },
    simulator: ({ t }) => {
      const w = weaponOf(weapon(t, { material: 1 }));
      return { type: w.type, both: !!w.twoHanded, handling: simSwingHandling(w) };
    },
  });
  expectClean(assert, report);
});

test('stage: proficiency and racial modifiers on every arm', async () => {
  const u = await upstream();
  const cases = [];
  for (const raceId of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const t of [113, 121, 124, 127, 129, null]) {
      for (const expert of [0, 0x3f]) {
        const desc = character({ level: 30, raceId, stats: { strength: 80, agility: 70, speed: 65, endurance: 72 }, career: { weaponArmorShieldsBitfield: expert << 16 } });
        cases.push({ id: `race${raceId}-t${t}-e${expert}`, input: { desc, t } });
      }
    }
  }
  const report = await runStage({
    name: 'proficiency and racial',
    cases,
    waivers: WAIVERS,
    upstream: ({ desc, t }) => {
      const item = t ? upstreamWeapon(weapon(t, { material: 1 })) : null;
      const ent = upstreamEntity(desc);
      const prof = u.pcaao.pcaaoProficiencyModifiers(ent, item);
      const racial = u.pcaao.pcaaoRacialModifiers(ent, item, ent);
      return { profDamage: prof.damageMod, profHit: prof.toHitMod, racialDamage: racial.damageMod, racialHit: racial.toHitMod };
    },
    simulator: ({ desc, t }) => {
      const item = t ? weapon(t, { material: 1 }) : null;
      const r = analyze(simCharacter(desc, item), { target: simReferenceFoe(desc.level, 'tough'), core: 'overhaul' });
      return { profDamage: r.damage.parts.prof, profHit: r.hit.prof.toHit, racialDamage: r.damage.parts.racial, racialHit: r.hit.racial.toHit };
    },
  });
  expectClean(assert, report);
});

test('stage: target intrinsic hide and natural resistance', async () => {
  const u = await upstream();
  const mobiles = [0, 2, 9, 15, 22, 25, 26, 27, 31, 34, 36, 38];
  const damages = [1, 2, 5, 10, 17, 50, 100, 1000];
  const cases = [];
  for (const mobile of mobiles) {
    for (const blunt of [false, true]) {
      for (const damage of damages) cases.push({ id: `m${mobile}-${blunt ? 'b' : 'e'}-${damage}`, input: { mobile, blunt, damage } });
    }
  }
  const minted = await mintedBy(mobiles.map((mobile) => ({ kind: 'mint', mobile })));
  const report = await runStage({
    name: 'target intrinsic',
    cases,
    waivers: WAIVERS,
    upstream: ({ mobile, blunt, damage }) => {
      const e = oracleEntity(minted.get(mobile));
      e.spareGear = true;
      const natural = u.pcaao.pcaaoNaturalDamageResistance(e);
      return u.pcaao.pcaaoPercentageReductionCalculationForMonsters(null, e, damage, blunt, natural);
    },
    simulator: ({ mobile, blunt, damage }) => {
      const t = enemyTarget(mobile);
      return intrinsicDamage(t, damage, { weapon: { skillId: blunt ? SKILLS.BluntWeapon : SKILLS.LongBlade } });
    },
  });
  assert.ok(report.cases >= 180);
  expectClean(assert, report);
});

test('stage: target natural resistance from a career stat block', async () => {
  const u = await upstream();
  const career = { strength: 80, intelligence: 50, willpower: 90, agility: 60, endurance: 70, personality: 50, speed: 60, luck: 50 };
  const cases = [31, 36, 15, 22].map((mobile) => ({ id: `m${mobile}`, input: { mobile } }));
  const minted = await mintedBy(cases.map(({ input: { mobile } }) => ({ kind: 'mint', mobile, career })));
  const report = await runStage({
    name: 'target natural resistance',
    cases,
    waivers: WAIVERS,
    upstream: ({ mobile }) => {
      const e = oracleEntity(minted.get(mobile));
      e.spareGear = true;
      return u.pcaao.pcaaoNaturalDamageResistance(e);
    },
    simulator: ({ mobile }) => naturalDamageResistance(enemyTarget(mobile, { career })),
  });
  expectClean(assert, report);
});

test('stage: weapon material to-hit term', async () => {
  const u = await upstream();
  const cases = Array.from({ length: 10 }, (_, material) => ({ id: `mat${material}`, input: { material } }));
  const report = await runStage({
    name: 'material to-hit',
    cases,
    waivers: WAIVERS,
    upstream: ({ material }) => u.pcaao.pcaaoWeaponToHit({ material }),
    simulator: ({ material }) => weaponToHit(weaponOf(weapon(121, { material }))),
  });
  expectClean(assert, report);
});

test('stage: swing law (frame seconds)', async () => {
  const u = await upstream();
  const cases = [];
  for (const speed of [0, 20, 50, 75, 98, 100]) {
    for (const heft of [1, 1.12, 1.3]) {
      for (const handling of [0.9, 1, 1.113]) cases.push({ id: `s${speed}-h${heft}-x${handling}`, input: { speed, heft, handling } });
    }
  }
  const report = await runStage({
    name: 'swing law',
    cases,
    waivers: WAIVERS,
    upstream: ({ speed, heft, handling }) => u.weaponStates.swingFrameSeconds(speed, { heft, handling }),
    simulator: ({ speed, heft, handling }) => simSwingFrameSeconds(speed, { heft, handling }),
  });
  expectClean(assert, report);
});

test('stage: real hit resolution, sampled through the game\'s own roll code', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({ level: 30, raceId: 1, stats: { strength: 80, agility: 60, speed: 60, luck: 50 }, skillOverride: { 29: 70, 34: 40 } });
  const draws = 6000;
  const rng = generator(0xc0ffee);
  const sample = [];
  for (let i = 0; i < draws; i++) {
    sample.push(
      u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), referenceFoe(u, desc.level, 'tough'), {
        weapon: fresh(upstreamWeapon(weapon(121, { material: 9 }))),
        rolls: rng,
        modules,
        backstabChance: 0,
      }),
    );
  }
  const s = summarize(sample);
  const r = analyze(simCharacter(desc, weapon(121, { material: 9 })), { target: simReferenceFoe(desc.level, 'tough'), core: 'overhaul' });
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(
    cmp.ok,
    `per swing: simulator ${r.perSwing.toFixed(4)} vs upstream ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)} (n=${draws}, hit ${(sample.filter((d) => d > 0).length / draws).toFixed(4)})`,
  );
});

test('stage: material requirement and target hide end-to-end (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 0, 34: 0 },
  });
  const item = weapon(121, { material: 2 });
  const target = referenceFoe(u, 45, 'tough');
  target.minMetalToHit = 5;
  const rng = generator(0x2a17);
  const sample = [];
  for (let i = 0; i < 6000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
    }));
  }
  const localTarget = { ...simReferenceFoe(45, 'tough'), minMetalToHit: 5, spareGear: true };
  const r = analyze(simCharacter(desc, item), { target: localTarget, core: 'overhaul' });
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `material/hide per swing ${r.perSwing.toFixed(4)} vs ${summarize(sample).mean.toFixed(4)} (n=${sample.length})`);
});

test('stage: worn armour material and condition', async () => {
  const u = await upstream();
  const templates = [102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
  const materials = [0, 256, 259, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521];
  const conditions = [1, 0.92, 0.75, 0.5, 0.2, 0.05, 0];
  const cases = [];
  for (const tpl of templates) {
    for (const mat of materials) {
      for (const cond of conditions) {
        for (const sharp of [false, true]) cases.push({ id: `t${tpl}-m${mat}-c${cond}-${sharp}`, input: { tpl, mat, cond, sharp } });
      }
    }
  }
  const item = ({ tpl, mat, cond }) => {
    const it = u.enemyEquipment.armorOfMaterial(tpl, mat);
    it.maxCondition = 1000;
    it.currentCondition = Math.round(cond * 1000);
    return it;
  };
  const report = await runStage({
    name: 'armour material and condition',
    cases,
    waivers: WAIVERS,
    upstream: ({ tpl, mat, cond, sharp }) => {
      const it = item({ tpl, mat, cond });
      return [u.pcaao.pcaaoArmorMaterialIdentifier(it), u.pcaao.pcaaoAlterArmorReducBasedOnItemCondition(it, sharp)];
    },
    simulator: ({ tpl, mat, cond, sharp }) => {
      const it = item({ tpl, mat, cond });
      return [armourMaterialId(it), armourConditionMultiplier(it, { sharpEdge: sharp })];
    },
  });
  assert.equal(report.cases, templates.length * materials.length * conditions.length * 2);
  expectClean(assert, report);
});

test('stage: worn armour and blocking-shield reduction rows', async () => {
  const u = await upstream();
  const modules = { conditionBasedEffectiveness: true, equipmentDamageEnhanced: false };
  const templates = [102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];
  const materials = [0, 256, 512, 519, 521];
  const conditions = [1, 0.92, 0.75, 0.5, 0.2, 0.05, 0];
  const naturals = [0, 0.05, -0.03, 0.2];
  const damages = [1, 2, 3, 5, 10, 37, 100, 501];
  const cases = [];
  for (const tpl of templates) {
    for (const mat of materials) {
      for (const cond of conditions) {
        for (const blunt of [false, true]) {
          for (const unarmed of [false, true]) {
            for (const natural of naturals) {
              for (const damage of damages) {
                cases.push({ id: `t${tpl}-m${mat}-c${cond}-${blunt ? 'b' : 'e'}-${unarmed ? 'u' : 'w'}-n${natural}-d${damage}`, input: { tpl, mat, cond, blunt, unarmed, natural, damage } });
              }
            }
          }
        }
      }
    }
  }
  const item = ({ tpl, mat, cond }) => {
    const it = u.enemyEquipment.armorOfMaterial(tpl, mat);
    it.maxCondition = 1000;
    it.currentCondition = Math.round(cond * 1000);
    return it;
  };
  const report = await runStage({
    name: 'armour and shield rows',
    cases,
    waivers: WAIVERS,
    upstream: ({ tpl, mat, cond, blunt, unarmed, natural, damage }) => {
      const it = item({ tpl, mat, cond });
      const n = natural;
      const armour = unarmed
        ? u.pcaao.pcaaoPercentageReductionCalculationWithUnarmed(it, armourMaterialId(it), 0, damage, false, n, modules)
        : u.pcaao.pcaaoPercentageReductionCalculationWithWeapon(it, armourMaterialId(it), 0, damage, blunt, 1, false, n, modules);
      const shield = unarmed
        ? u.pcaao.pcaaoPercentageReductionCalculationWithUnarmed(it, armourMaterialId(it), 0, damage, true, n, modules)
        : u.pcaao.pcaaoPercentageReductionCalculationWithWeapon(it, armourMaterialId(it), 0, damage, blunt, 1, true, n, modules);
      return [armour, shield];
    },
    simulator: ({ tpl, mat, cond, blunt, unarmed, natural, damage }) => {
      const it = item({ tpl, mat, cond });
      return [
        armourReduction(it, damage, { natural, blunt, unarmed }),
        shieldReduction(it, damage, { natural, blunt, unarmed }),
      ];
    },
  });
  assert.equal(report.cases, templates.length * materials.length * conditions.length * 2 * 2 * naturals.length * damages.length);
  expectClean(assert, report);
});

test('stage: shield block chance and the under-armour comparison', async () => {
  const u = await upstream();
  const modules = { conditionBasedEffectiveness: true, equipmentDamageEnhanced: false };
  const statsSets = [
    {},
    { agility: 90, speed: 80, strength: 70, endurance: 60, willpower: 80, luck: 100 },
    { agility: 10, speed: 20, strength: 10, endurance: 10, willpower: 0, luck: 0 },
  ];
  const rolls = [0, 0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999999];
  const blockCases = [];
  for (const tpl of [109, 110, 111, 112]) {
    for (const stats of statsSets) {
      for (const strong of [false, true]) {
        for (const roll of rolls) blockCases.push({ id: `t${tpl}-${strong ? 's' : 'w'}-${roll}`, input: { tpl, stats, strong, roll } });
      }
    }
  }
  const blockReport = await runStage({
    name: 'shield block chance',
    cases: blockCases,
    waivers: WAIVERS,
    upstream: ({ tpl, stats, strong, roll }) => {
      const shield = armourPiece(tpl, { material: 0 });
      const target = { stats: { strength: 50, willpower: 50, agility: 50, endurance: 50, speed: 50, luck: 50, ...stats } };
      return u.pcaao.pcaaoShieldBlockChanceCalculation(target, strong, shield, () => roll);
    },
    simulator: ({ tpl, stats, strong, roll }) => {
      const shield = armourPiece(tpl, { material: 0 });
      const target = { stats: { strength: 50, willpower: 50, agility: 50, endurance: 50, speed: 50, luck: 50, ...stats } };
      return Math.floor(roll * 100) < shieldBlockChance(target, strong, shield);
    },
  });
  expectClean(assert, blockReport);

  const compareCases = [];
  for (const shieldTpl of [109, 110, 111, 112]) {
    for (const shieldMat of [0, 512, 521]) {
      for (const underTpl of [null, 102, 107]) {
        for (const underCond of [1, 0.5, 0.05]) {
          for (const natural of [0, 0.05, -0.03, 0.2]) {
            for (const part of [0, 1, 2, 3, 4, 5, 6]) {
              compareCases.push({ id: `s${shieldTpl}-${shieldMat}-u${underTpl}-c${underCond}-n${natural}-p${part}`, input: { shieldTpl, shieldMat, underTpl, underCond, natural, part } });
            }
          }
        }
      }
    }
  }
  const shieldCareer = { ...CLASS_CAREER, strength: 60 };
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career: shieldCareer });
  const compareReport = await runStage({
    name: 'shield vs under armour',
    cases: compareCases,
    waivers: WAIVERS,
    upstream: ({ shieldTpl, shieldMat, underTpl, underCond, natural, part }) => {
      const pieces = [{ templateIndex: shieldTpl, material: shieldMat, condition: 0.6 }];
      if (underTpl != null) pieces.push({ templateIndex: underTpl, material: underTpl === 102 ? 519 : 512, condition: underCond });
      const target = upstreamWear(u, oracleEntity(lord), pieces, { armorValues: false });
      return u.pcaao.pcaaoCompareShieldToUnderArmor(target, part, natural, modules);
    },
    simulator: ({ shieldTpl, shieldMat, underTpl, underCond, natural, part }) => {
      const target = enemyTarget(31, { career: shieldCareer });
      const pieces = [{ templateIndex: shieldTpl, material: shieldMat, condition: 0.6 }];
      if (underTpl != null) pieces.push({ templateIndex: underTpl, material: underTpl === 102 ? 519 : 512, condition: underCond });
      equipArmour(target, pieces);
      return shieldBeatsUnderArmour(target, part, natural);
    },
  });
  expectClean(assert, compareReport);
});

test('stage: enemy armour values from the worn pieces', async () => {
  const u = await upstream();
  const cases = [];
  for (const allotment of [
    { mobile: 22, variant: 0, careerIndex: 22, isClass: false },
    { mobile: 128, variant: 0, careerIndex: 26, isClass: true },
    { mobile: 128, variant: 1, careerIndex: 26, isClass: true },
    { mobile: 146, variant: 2, careerIndex: 26, isClass: true },
  ]) {
    for (const level of [1, 10, 30, 45, 60]) cases.push({ id: `m${allotment.mobile}-v${allotment.variant}-L${level}`, input: { ...allotment, level } });
  }
  const minted = await mintedBy([22, 128, 146].map((mobile) => ({ kind: 'mint', mobile, ...(mobile >= 128 ? { career: CLASS_CAREER, playerLevel: 30, exactLevel: true } : {}) })));
  const report = await runStage({
    name: 'enemy armour values',
    cases,
    waivers: WAIVERS,
    upstream: ({ mobile, variant, careerIndex, isClass, level }) => {
      const e = { mobileType: mobile, careerIndex, isClass, armor: minted.get(mobile).armor };
      const r = generator(0x77 + mobile * 31 + level * 7 + variant);
      const eq = u.enemyEquipment.assignEnemyEquipment(e, variant, level, r);
      return eq.armorValues;
    },
    simulator: ({ mobile, variant, careerIndex, isClass, level }) => {
      const local = enemyTarget(mobile, isClass ? { level, exactLevel: true } : {});
      // The game's own pieces for this roll (they depend on the career, variant and level, not the body).
      const e = { mobileType: mobile, careerIndex, isClass, armor: local.armorValues[0] };
      const r = generator(0x77 + mobile * 31 + level * 7 + variant);
      const eq = u.enemyEquipment.assignEnemyEquipment(e, variant, level, r);
      // The game's own pieces, worn through the project's placement + ArmorValues pass.
      equipArmour(local, eq.armorPieces.map((a) => ({ templateIndex: a.piece, material: a.material })), { armorValues: true });
      return local.armorValues;
    },
  });
  assert.ok(report.cases >= 20);
  expectClean(assert, report);
});

test('stage: the game\'s own enemy loadout is worn by the target', async () => {
  const u = await upstream();
  const cases = [];
  for (const mobile of [7, 128, 22]) {
    // Under the client's boot Enemy Expansion's equipment delegate rolls a class foe's kit
    // (dexInstall.js:246-247); the project's gearEnemy rolls the stock one (W-DEX-LOADOUT).
    for (const seed of [1, 2, 3]) cases.push({ id: `m${mobile}-s${seed}`, input: { mobile, seed }, ...(mobile >= 128 ? { waived: 'W-DEX-LOADOUT' } : {}) });
  }
  const { bodies: loadouts } = await upstreamBodies(cases.map(({ input: { mobile, seed } }) => ({
    kind: 'loadout', mobile, seed: 0x51 + seed, playerLevel: 45, ...(mobile >= 128 ? { career: CLASS_CAREER } : {}),
  })));
  const loadoutOf = new Map(cases.map((c, i) => [c.id, loadouts[i]]));
  const report = await runStage({
    name: 'enemy loadout',
    cases,
    waivers: WAIVERS,
    // The variant roll declines (a monster outside the game's orc/centaur table): the body keeps its
    // minted ArmorValues and wears nothing.
    // The worn kit is compared piece by piece too: a class foe's ArmorValues clamp at 60, so two
    // different kits can read the same seven numbers.
    upstream: (_input, c) => {
      const l = loadoutOf.get(c.id);
      return {
        armorValues: l.armorValues,
        shield: l.pieces.find((a) => a.shield)?.piece ?? null,
        worn: l.pieces.map((a) => [a.piece, a.material]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      };
    },
    simulator: ({ mobile, seed }) => {
      const local = enemyTarget(mobile, mobile >= 128 ? { level: 45, career: CLASS_CAREER } : {});
      gearEnemy(local, { playerLevel: 45, rolls: generator(0x51 + seed) });
      return {
        armorValues: local.armorValues,
        shield: leftHandShield(local)?.templateIndex ?? null,
        worn: Object.values(local.equip?.slots ?? {}).filter(Boolean).map((it) => [it.templateIndex, it.material]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      };
    },
  });
  expectClean(assert, report);
});

test('stage: worn armour and shield end-to-end (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const career = { strength: 70, intelligence: 50, willpower: 60, agility: 55, endurance: 65, personality: 50, speed: 55, luck: 40 };
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 60, 34: 20 },
  });
  const item = weapon(121, { material: 9, condition: 0.9 });
  const pieces = [
    { templateIndex: 102, material: 519, condition: 0.5 }, // daedric cuirass (chest)
    { templateIndex: 107, material: 512, condition: 0.9 }, // iron helm (head)
    { templateIndex: 109, material: 0, condition: 0.8 },  // leather buckler (left hand)
  ];
  // 128 is a class foe (flat 60 to hit); 7 is a monster whose row armour leaves the chest
  // better than the rest, so the struck part's hit chance and its worn armour are correlated.
  const classCareer = { ...career, hitPointsPerLevel: 8 };
  const minted = await mintedBy([
    { kind: 'mint', mobile: 128, career: classCareer, playerLevel: 45 },
    { kind: 'mint', mobile: 7, career },
  ]);
  for (const mobile of [128, 7]) {
    const local = enemyTarget(mobile, mobile >= 128 ? { level: 45, career: classCareer } : { career });
    equipArmour(local, pieces, { armorValues: true });
    const e = upstreamWear(u, oracleEntity(minted.get(mobile)), pieces);
    const rng = generator(0x1234 + mobile);
    const sample = [];
    for (let i = 0; i < 20000; i++) {
      sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), e, {
        weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
      }));
    }
    const r = analyze(simCharacter(desc, item), { target: local, core: 'overhaul' });
    const cmp = compareSample({ expected: sample, actual: r.perSwing });
    assert.ok(cmp.ok, `mobile ${mobile}: per swing ${r.perSwing.toFixed(4)} vs ${summarize(sample).mean.toFixed(4)} +/- ${(1.96 * summarize(sample).se).toFixed(4)} (n=${sample.length})`);
  }
});

test('stage: enemy-type bonus and phobia by the target career group', async () => {
  const u = await upstream();
  const groups = { Undead: [0x01, 0x10], Daedra: [0x02, 0x20], Humanoid: [0x04, 0x40], Animals: [0x08, 0x80] };
  const careers = [0, 7, 9, 15, 18, 22, 26, 31];
  const cases = [];
  for (const [group, [bonusBit, phobiaBit]] of Object.entries(groups)) {
    for (const [kind, flags] of [['bonus', bonusBit], ['phobia', phobiaBit]]) {
      for (const willpower of [0, 50, 60, 80, 100, 150]) {
        for (const level of [1, 10, 20, 21, 30, 45]) {
          for (const careerIndex of careers) {
            for (const roll of [0, 0.01, 0.3, 0.5, 0.9, 0.999]) {
              cases.push({ id: `${group}-${kind}-w${willpower}-l${level}-c${careerIndex}-r${roll}`, input: { flags, willpower, level, careerIndex, roll } });
            }
          }
        }
      }
    }
  }
  const report = await runStage({
    name: 'enemy-type bonus/phobia',
    cases,
    waivers: WAIVERS,
    upstream: ({ flags, willpower, level, careerIndex, roll }) => u.pcaao.pcaaoBonusOrPenaltyByEnemyType(
      { isPlayer: true, level: 10, stats: { willpower }, career: { attackModifierFlags: flags } },
      { isPlayer: false, careerIndex, level },
      () => roll,
    ),
    simulator: ({ flags, willpower, level, careerIndex, roll }) => enemyTypeBonusValue(
      { stats: { willpower }, career: { attackModifierFlags: flags } },
      { isPlayer: false, careerIndex, level, combatLevel: level },
      roll,
    ),
  });
  assert.equal(report.cases, 4 * 2 * 6 * 6 * 8 * 6);
  expectClean(assert, report);
});

test('stage: foe group classification (affinity vs career)', async () => {
  const u = await upstream();
  const cases = Object.entries(u.enemyBasics.ENEMY_BASICS).map(([id, row]) => {
    const mobile = Number(id);
    return {
      id: `m${mobile}`,
      input: {
        affinity: row.affinity,
        isClass: u.enemyBasics.enemyEntityType(mobile) === 'class',
        careerIndex: u.enemyBasics.enemyCareerIndex(mobile),
      },
    };
  });
  const report = await runStage({
    name: 'foe groups',
    cases,
    waivers: WAIVERS,
    upstream: ({ affinity, careerIndex }) => u.lootPowers.foeGroup({ isPlayer: false, affinity, careerIndex }),
    simulator: ({ affinity, isClass, careerIndex }) => targetGroupOf({ careerIndex, affinity, isClass }),
  });
  assert.ok(report.cases >= 60);
  expectClean(assert, report);
});

test('stage: silver, skeletal and the enemy-type bonus in the weapon blow', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const descBase = character({
    level: 10, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50, willpower: 100 },
    skills: 50, skillOverride: { 29: 50, 32: 50, 34: 0 },
  });
  const cases = [];
  for (const tpl of [121, 126, 129]) {
    for (const mat of [0, 1, 2, 3, 9]) {
      for (const careerIndex of [9, 15, 18, 19, 23, 28, 14, 22, 31, 0]) {
        for (const flags of [0, 0x01, 0x10, 0x02]) {
          for (const targetLevel of [20, 45]) {
            cases.push({ id: `t${tpl}-m${mat}-c${careerIndex}-f${flags}-l${targetLevel}`, input: { tpl, mat, careerIndex, flags, targetLevel } });
          }
        }
      }
    }
  }
  const build = ({ tpl, mat, careerIndex, flags, targetLevel }) => {
    const desc = { ...descBase, career: { ...descBase.career, attackModifierFlags: flags } };
    const ch = simCharacter(desc);
    const item = weapon(tpl, { material: mat });
    const w = weaponOf(item);
    const target = { isPlayer: false, careerIndex, level: targetLevel, combatLevel: targetLevel };
    const dmg = damageModel(ch, w, target, 'StrikeLeft', 'overhaul', {});
    return { desc, item, w, dmg };
  };
  const report = await runStage({
    name: 'silver/skeletal weapon blow',
    cases,
    waivers: WAIVERS,
    upstream: (input) => {
      const { desc, item, w, dmg } = build(input);
      const et = dmg.parts.enemyType;
      const n = et.decoded === 1 && et.bonus > 0 ? et.bonus : 1;
      const out = [];
      for (let r = w.min; r <= w.max; r++) {
        for (let b = 0; b < n; b++) {
          const seq = [(r - w.min + 0.5) / (w.max + 1 - w.min)];
          if (et.bonus > 0) seq.push(et.decoded === 1 ? (b + 0.5) / et.bonus : 0.5);
          let i = 0;
          const rolls = () => seq[Math.min(i++, seq.length - 1)];
          // The next step in pcaaoAttackDamage is `damage = Math.max(0, damage)`; the local card
          // has already clamped, so the stage compares that same point.
          out.push(Math.max(0, u.pcaao.pcaaoWeaponAttackDamage(
            upstreamEntity(desc),
            { isPlayer: false, careerIndex: input.careerIndex, level: input.targetLevel },
            dmg.parts.dmgMods, 0, fresh(upstreamWeapon(item)), rolls, modules,
          )));
        }
      }
      return out.sort((a, b) => a - b);
    },
    simulator: (input) => [...build(input).dmg.plainRolls].sort((a, b) => a - b),
  });
  assert.equal(report.cases, 3 * 5 * 10 * 4 * 2);
  expectClean(assert, report);
});

test('stage: the Skeletal Warrior 0x10 weapon-flag exception', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const descBase = character({
    level: 10, raceId: 1,
    stats: { strength: 50, agility: 50, speed: 50, luck: 50, willpower: 50 },
    skills: 50, skillOverride: { 29: 50, 34: 0 },
  });
  const cases = [];
  for (const material of [2, 9]) {
    for (const weaponFlags of [0, 0x10]) {
      cases.push({ id: `m${material}-f${weaponFlags}`, input: { material, weaponFlags } });
    }
  }
  const build = ({ material, weaponFlags }) => {
    const desc = { ...descBase, career: { ...descBase.career, attackModifierFlags: 0 } };
    const ch = simCharacter(desc);
    const item = weapon(121, { material, flags: weaponFlags });
    const w = weaponOf(item);
    const target = { isPlayer: false, careerIndex: 15, level: 1, combatLevel: 1 };
    const dmg = damageModel(ch, w, target, 'StrikeLeft', 'overhaul', {});
    return { desc, item, w, dmg, target };
  };
  const report = await runStage({
    name: 'skeletal weapon flag',
    cases,
    waivers: WAIVERS,
    upstream: (input) => {
      const { desc, item, w, dmg, target } = build(input);
      const et = dmg.parts.enemyType;
      const n = et.decoded === 1 && et.bonus > 0 ? et.bonus : 1;
      const out = [];
      for (let r = w.min; r <= w.max; r++) {
        for (let b = 0; b < n; b++) {
          const seq = [(r - w.min + 0.5) / (w.max + 1 - w.min)];
          if (et.bonus > 0) seq.push(et.decoded === 1 ? (b + 0.5) / et.bonus : 0.5);
          let i = 0;
          const rolls = () => seq[Math.min(i++, seq.length - 1)];
          out.push(Math.max(0, u.pcaao.pcaaoWeaponAttackDamage(
            upstreamEntity(desc), target, dmg.parts.dmgMods, 0, fresh(upstreamWeapon(item)), rolls, modules,
          )));
        }
      }
      return out.sort((a, b) => a - b);
    },
    simulator: (input) => [...build(input).dmg.plainRolls].sort((a, b) => a - b),
  });
  expectClean(assert, report);
});

test('stage: silver and enemy-type end-to-end against real foes (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const career = { strength: 70, intelligence: 50, willpower: 60, agility: 55, endurance: 65, personality: 50, speed: 55, luck: 40 };
  const desc = character({
    level: 20, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 100 },
    skills: 0, skillOverride: { 29: 100, 34: 40 },
    career: { attackModifierFlags: 0x01 },
  });
  const cases = [
    { tpl: 121, mat: 2, careerIndex: 18 },
    { tpl: 121, mat: 9, careerIndex: 18 },
    { tpl: 121, mat: 2, careerIndex: 15 },
    { tpl: 121, mat: 9, careerIndex: 15 },
    { tpl: 129, mat: 2, careerIndex: 18 },
    { tpl: 126, mat: 2, careerIndex: 14 },
    { tpl: 121, mat: 2, careerIndex: 22 },
  ];
  const minted = await mintedBy([...new Set(cases.map((c) => c.careerIndex))].map((mobile) => ({ kind: 'mint', mobile, career, playerLevel: 20 })));
  for (const { tpl, mat, careerIndex } of cases) {
    const item = weapon(tpl, { material: mat, condition: 0.8 });
    // A monster's body is its minted row's, level included (enemyEntity.js:212): the enemy-type term
    // reads that level on both sides.
    const local = enemyTarget(careerIndex, { career });
    const e = oracleEntity(minted.get(careerIndex));
    e.spareGear = true;
    const rng = generator(0x1111 + careerIndex * 17 + mat * 3 + tpl);
    const sample = [];
    for (let i = 0; i < 40000; i++) {
      sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), e, {
        weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
      }));
    }
    const r = analyze(simCharacter(desc, item), { target: local, core: 'overhaul' });
    const s = summarize(sample);
    const cmp = compareSample({ expected: sample, actual: r.perSwing });
    assert.ok(cmp.ok, `career ${careerIndex}, material ${mat}, template ${tpl}: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)} (n=${sample.length})`);
  }
});

test('stage: the gate boss uses its body level for the enemy-type bonus', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const { body: boss } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 100 },
    skills: 0, skillOverride: { 29: 100, 34: 40 },
    career: { attackModifierFlags: 0x02 }, // Daedra bonus
  });
  const item = weapon(121, { material: 9, condition: 1 });
  const rng = generator(0x4411);
  const sample = [];
  for (let i = 0; i < 20000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), boss, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
    }));
  }
  const gate = gateTarget(45);
  const r = analyze(simCharacter(desc, item), { target: gate, core: 'overhaul' });
  assert.equal(gate.combatLevel, boss.level, 'the body level, not the content level');
  assert.equal(r.damage.parts.enemyType.bonus, 10, '100 Willpower at body level 21');
  const s = summarize(sample);
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `gate: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)} (n=${sample.length})`);
});

test('stage: backstab damage roll (x3 gate and threshold)', async () => {
  const u = await upstream();
  const cases = [];
  for (const damage of [0, 1, 2, 5, 17, 100]) {
    for (const chance of [0, 1, 2, 25, 50, 99, 100, 150]) {
      for (const roll of [0, 0.01, 0.49, 0.5, 0.99, 0.999]) {
        cases.push({ id: `d${damage}-c${chance}-r${roll}`, input: { damage, chance, roll } });
      }
    }
  }
  const report = await runStage({
    name: 'backstab damage',
    cases,
    waivers: WAIVERS,
    upstream: ({ damage, chance, roll }) => u.pcaao.pcaaoBackstabDamage(damage, chance, () => roll),
    simulator: ({ damage, chance, roll }) => backstabDamage(damage, chance, roll),
  });
  assert.equal(report.cases, 6 * 8 * 6);
  expectClean(assert, report);
});

test('stage: backstab hit bonus and x3 mixture (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const level = 30;
  const stats = { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 };
  for (const skill of [0, 1, 25, 50, 75, 100]) {
    for (const cap of [0, 40, 60, 80]) {
      const desc = character({
        level, raceId: 1, stats, skills: 0,
        skillOverride: { 29: 100, 34: 40, 19: skill },
      });
      const item = weapon(121, { material: 9, condition: 1 });
      const target = referenceFoe(u, level, 'tough');
      const localTarget = { ...simReferenceFoe(level, 'tough'), hitCap: cap };
      const rng = generator(0x5a00 + skill * 10 + cap);
      const sample = [];
      for (let i = 0; i < 20000; i++) {
        sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
          weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: skill,
        }));
      }
      const r = analyze(simCharacter(desc, item), { target: localTarget, core: 'overhaul', backstabUptime: 1 });
      const s = summarize(sample);
      const cappedSample = cap > 0 ? sample.map((v) => Math.min(v, cap)) : sample;
      const cs = summarize(cappedSample);
      const cmp = compareSample({ expected: sample, actual: r.perSwing });
      assert.ok(cmp.ok, `skill ${skill}, cap ${cap}: per swing ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
      assert.ok(
        Math.abs(r.cappedPerSwing - cs.mean) <= 1.96 * cs.se,
        `skill ${skill}, cap ${cap}: capped ${r.cappedPerSwing.toFixed(4)} vs ${cs.mean.toFixed(4)} +/- ${(1.96 * cs.se).toFixed(4)}`,
      );
    }
  }
});

test('stage: backstab off-hand (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 100, 34: 40, 19: 50 },
  });
  const item = weapon(121, { material: 9, condition: 1 });
  const w = weaponOf(item);
  const target = referenceFoe(u, 30, 'tough');
  const localTarget = simReferenceFoe(30, 'tough');
  const rng = generator(0x0ff1ce);
  const sample = [];
  for (let i = 0; i < 30000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)),
      toHitMod: offHandToHit(60),
      blowShare: offHandDamage,
      rolls: rng, modules, backstabChance: 50,
    }));
  }
  const r = analyze(simCharacter(desc, item), {
    target: localTarget, core: 'overhaul', weapon: w, offHand: true, backstabUptime: 1,
  });
  const s = summarize(sample);
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `off hand: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)} (n=${sample.length})`);
});

test('stage: backstab ranged (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 33: 100, 34: 40, 19: 50 },
  });
  const item = weapon(129, { material: 9, condition: 1 }); // short bow
  const target = referenceFoe(u, 30, 'tough');
  const localTarget = simReferenceFoe(30, 'tough');
  const rng = generator(0x0b0b);
  const sample = [];
  for (let i = 0; i < 30000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 50,
    }));
  }
  const r = analyze(simCharacter(desc, item), { target: localTarget, core: 'overhaul', backstabUptime: 1 });
  const s = summarize(sample);
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `ranged: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)} (n=${sample.length})`);
});

test('stage: backstab with worn armour, traits and the cap (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const career = { strength: 70, intelligence: 50, willpower: 60, agility: 55, endurance: 65, personality: 50, speed: 55, luck: 40 };
  const desc = character({
    level: 30, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 100, 34: 40, 19: 50 },
  });
  const item = weapon(121, { material: 9, condition: 0.8 });
  const pieces = [
    { templateIndex: 102, material: 519, condition: 0.8 },
    { templateIndex: 107, material: 512, condition: 1 },
    { templateIndex: 112, material: 0, condition: 1 },
  ];
  const local = enemyTarget(31, { career });
  equipArmour(local, pieces, { armorValues: true });
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career });
  const e = upstreamWear(u, oracleEntity(lord), pieces);
  const traits = ['stoneskin'];
  const cap = 60;
  const rng = generator(0x2b2b);
  const sample = [];
  for (let i = 0; i < 20000; i++) {
    const raw = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), e, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 50,
    });
    sample.push(raw > 0 ? u.bossTraits.bossStrike({ bossTraits: traits }, raw, { kind: 'melee', weapon: fresh(upstreamWeapon(item)) }).damage : raw);
  }
  const r = analyze(simCharacter(desc, item), {
    target: { ...local, bossTraits: traits, hitCap: cap }, core: 'overhaul', backstabUptime: 1,
  });
  const s = summarize(sample);
  const cs = summarize(sample.map((v) => Math.min(v, cap)));
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `armour/traits: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
  assert.ok(
    Math.abs(r.cappedPerSwing - cs.mean) <= 1.96 * cs.se,
    `armour/traits/cap: ${r.cappedPerSwing.toFixed(4)} vs ${cs.mean.toFixed(4)} +/- ${(1.96 * cs.se).toFixed(4)}`,
  );
});

test('stage: weapon condition bands (integer percentage)', async () => {
  const u = await upstream();
  const pcts = [0, 5, 5.9, 6, 6.9, 15, 16, 40, 41, 60, 61, 75, 75.9, 76, 91, 92, 99, 100, 101];
  const damages = [0, 1, 2, 5, 10, 37, 100, 1001];
  const cases = [];
  for (const tpl of [121, 126]) {
    for (const pct of pcts) {
      for (const sharpEdge of [false, true]) {
        for (const damage of damages) {
          cases.push({ id: `t${tpl}-p${pct}-s${sharpEdge}-d${damage}`, input: { tpl, pct, sharpEdge, damage } });
        }
      }
    }
  }
  const build = ({ tpl, pct }) => {
    const item = weapon(tpl, { material: 9 });
    item.maxCondition = 1000;
    item.currentCondition = Math.round(pct * 10);
    return item;
  };
  const report = await runStage({
    name: 'weapon condition bands',
    cases,
    waivers: WAIVERS,
    upstream: ({ tpl, pct, sharpEdge, damage }) => u.pcaao.pcaaoAlterDamageBasedOnWepCondition(
      damage, tpl === 126, build({ tpl, pct }), sharpEdge,
    ),
    simulator: ({ tpl, pct, sharpEdge, damage }) => {
      const w = weaponOf(build({ tpl, pct }));
      const mult = conditionMultiplier(w, sharpEdge);
      return mult === 1 ? damage : unityRound(Math.fround(damage * Math.fround(mult)));
    },
  });
  assert.equal(report.cases, 2 * pcts.length * 2 * damages.length);
  expectClean(assert, report);
});

test('stage: weapon condition end-to-end (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const base = character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 100, 33: 100, 34: 40, 19: 0 },
  });
  for (const [tpl, condition] of [[121, 0.059], [121, 0.5], [121, 1], [126, 0.059], [129, 0.059]]) {
    const desc = { ...base, skillOverride: { ...base.skillOverride } };
    const item = weapon(tpl, { material: 9, condition });
    const target = referenceFoe(u, 30, 'tough');
    const rng = generator(0x1111);
    const sample = [];
    for (let i = 0; i < 200000; i++) {
      sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
        weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
      }));
    }
    const r = analyze(simCharacter(desc, item), { target: simReferenceFoe(30, 'tough'), core: 'overhaul' });
    const s = summarize(sample);
    const cmp = compareSample({ expected: sample, actual: r.perSwing });
    assert.ok(cmp.ok, `template ${tpl}, condition ${condition}: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
  }
});

test('stage: weapon condition off-hand and ranged (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 30, raceId: 1,
    stats: { strength: 70, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 100, 33: 100, 34: 40, 19: 0 },
  });
  const worn = weapon(121, { material: 9, condition: 0.059 });
  const target = referenceFoe(u, 30, 'tough');
  const rng = generator(0x0ff2ce);
  const sample = [];
  for (let i = 0; i < 30000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(worn)),
      toHitMod: offHandToHit(60),
      blowShare: offHandDamage,
      rolls: rng, modules, backstabChance: 0,
    }));
  }
  const r = analyze(simCharacter(desc, weapon(121, { material: 9 })), {
    target: simReferenceFoe(30, 'tough'), core: 'overhaul', weapon: weaponOf(worn), offHand: true,
  });
  const s = summarize(sample);
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `off hand condition: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);

  const bow = weapon(129, { material: 9, condition: 0.059 });
  const rng2 = generator(0x0b0c);
  const sample2 = [];
  for (let i = 0; i < 30000; i++) {
    sample2.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(bow)), rolls: rng2, modules, backstabChance: 0,
    }));
  }
  const r2 = analyze(simCharacter(desc, bow), { target: simReferenceFoe(30, 'tough'), core: 'overhaul' });
  const s2 = summarize(sample2);
  const cmp2 = compareSample({ expected: sample2, actual: r2.perSwing });
  assert.ok(cmp2.ok, `bow condition: ${r2.perSwing.toFixed(4)} vs ${s2.mean.toFixed(4)} +/- ${(1.96 * s2.se).toFixed(4)}`);
});

test('stage: weapon condition with armour, traits and the cap (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const career = { strength: 70, intelligence: 50, willpower: 60, agility: 55, endurance: 65, personality: 50, speed: 55, luck: 40 };
  const desc = character({
    level: 30, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 100, 34: 40, 19: 0 },
  });
  const item = weapon(121, { material: 9, condition: 0.059 });
  const pieces = [
    { templateIndex: 102, material: 519, condition: 0.8 },
    { templateIndex: 107, material: 512, condition: 1 },
    { templateIndex: 112, material: 0, condition: 1 },
  ];
  const local = enemyTarget(31, { career });
  equipArmour(local, pieces, { armorValues: true });
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career });
  const e = upstreamWear(u, oracleEntity(lord), pieces);
  const traits = ['stoneskin'];
  const cap = 60;
  const rng = generator(0x2c2c);
  const sample = [];
  for (let i = 0; i < 20000; i++) {
    const raw = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), e, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
    });
    sample.push(raw > 0 ? u.bossTraits.bossStrike({ bossTraits: traits }, raw, { kind: 'melee', weapon: fresh(upstreamWeapon(item)) }).damage : raw);
  }
  const r = analyze(simCharacter(desc, item), {
    target: { ...local, bossTraits: traits, hitCap: cap }, core: 'overhaul',
  });
  const s = summarize(sample);
  const cs = summarize(sample.map((v) => Math.min(v, cap)));
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `condition armour/traits: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
  assert.ok(
    Math.abs(r.cappedPerSwing - cs.mean) <= 1.96 * cs.se,
    `condition armour/traits/cap: ${r.cappedPerSwing.toFixed(4)} vs ${cs.mean.toFixed(4)} +/- ${(1.96 * cs.se).toFixed(4)}`,
  );
});

test('stage: racial modifiers (overhaul and classic)', async () => {
  const u = await upstream();
  const statsList = [
    { strength: 50, agility: 50, speed: 50, luck: 50, endurance: 50, willpower: 50 },
    { strength: 80, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 },
    { strength: 100, agility: 100, speed: 100, luck: 100, endurance: 100, willpower: 100 },
  ];
  const overhaulCases = [];
  for (const raceId of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const stats of statsList) {
      for (const t of [113, 121, 126, 127, 129, null]) overhaulCases.push({ id: `r${raceId}-${t}-${stats.agility}`, input: { raceId, stats, t } });
    }
  }
  const descOf = ({ raceId, stats, t }) => character({
    level: 30, raceId, stats, skills: 50,
    skillOverride: t === 113 ? { 28: 70, 34: 40 } : t === 129 ? { 33: 70, 34: 40 } : t === 127 ? { 31: 70, 34: 40 } : t === 126 ? { 32: 70, 34: 40 } : t === 121 ? { 29: 70, 34: 40 } : { 4: 70, 34: 40 },
    martialPath: null,
  });
  const build = ({ raceId, stats, t }) => {
    const desc = descOf({ raceId, stats, t });
    const item = t ? weapon(t, { material: 9 }) : null;
    return { desc, item };
  };
  const overhaul = await runStage({
    name: 'racial modifiers (overhaul)',
    cases: overhaulCases,
    waivers: WAIVERS,
    upstream: (input) => {
      const { desc, item } = build(input);
      const ent = upstreamEntity(desc);
      return u.pcaao.pcaaoRacialModifiers(ent, item ? upstreamWeapon(item) : null, ent);
    },
    simulator: (input) => {
      const { desc, item } = build(input);
      const r = racialModifiers(simCharacter(desc), item ? weaponOf(item) : null, 'overhaul');
      return { damageMod: r.damage, toHitMod: r.toHit };
    },
  });
  assert.equal(overhaul.cases, 8 * 3 * 6);
  expectClean(assert, overhaul);

  const classicCases = [];
  for (const raceId of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const t of [113, 121, 126, 127, 129, null]) classicCases.push({ id: `c${raceId}-${t}`, input: { raceId, t } });
  }
  const classic = await runStage({
    name: 'racial modifiers (classic)',
    cases: classicCases,
    waivers: WAIVERS,
    upstream: ({ raceId, t }) => {
      const desc = descOf({ raceId, stats: {}, t });
      const item = t ? weapon(t, { material: 9 }) : null;
      return u.formulas.racialModifiers(upstreamEntity(desc), item ? upstreamWeapon(item) : null);
    },
    simulator: ({ raceId, t }) => {
      const desc = descOf({ raceId, stats: {}, t });
      const item = t ? weapon(t, { material: 9 }) : null;
      const r = racialModifiers(simCharacter(desc), item ? weaponOf(item) : null, 'classic');
      return { damageMod: r.damage, toHitMod: r.toHit };
    },
  });
  assert.equal(classic.cases, 8 * 6);
  expectClean(assert, classic);
});

test('stage: racial end-to-end (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const cases = [
    { raceId: 6, t: 113, skill: { 28: 80, 34: 40 } },
    { raceId: 6, t: 129, skill: { 33: 80, 34: 40 } },
    { raceId: 3, t: null, skill: { 4: 80, 34: 40 } },
    { raceId: 7, t: null, skill: { 4: 80, 34: 40 } },
    { raceId: 1, t: 113, skill: { 28: 80, 34: 40 } },
  ];
  const stats = { strength: 80, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 };
  for (const { raceId, t, skill } of cases) {
    const desc = character({ level: 30, raceId, stats, skills: 50, skillOverride: skill, martialPath: null });
    const item = t ? weapon(t, { material: 9, condition: 1 }) : null;
    const target = referenceFoe(u, 30, 'tough');
    const rng = generator(0x6a00 + raceId * 10 + (t ?? 0));
    const sample = [];
    for (let i = 0; i < 20000; i++) {
      sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
        weapon: item ? fresh(upstreamWeapon(item)) : null, rolls: rng, modules, backstabChance: 0,
      }));
    }
    const ch = item ? simCharacter(desc, item) : simCharacter(desc);
    const r = analyze(ch, { target: simReferenceFoe(30, 'tough'), core: 'overhaul' });
    const s = summarize(sample);
    const cmp = compareSample({ expected: sample, actual: r.perSwing });
    assert.ok(cmp.ok, `race ${raceId}, template ${t}: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
  }
});

test('stage: racial with backstab, condition, armour, traits and the cap (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const career = { strength: 70, intelligence: 50, willpower: 60, agility: 55, endurance: 65, personality: 50, speed: 55, luck: 40 };
  const desc = character({
    level: 30, raceId: 6,
    stats: { strength: 80, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 },
    skills: 50, skillOverride: { 28: 80, 34: 40, 19: 50 }, martialPath: null,
  });
  const item = weapon(113, { material: 9, condition: 0.5 });
  const pieces = [
    { templateIndex: 102, material: 519, condition: 0.8 },
    { templateIndex: 107, material: 512, condition: 1 },
    { templateIndex: 112, material: 0, condition: 1 },
  ];
  const local = enemyTarget(31, { career });
  equipArmour(local, pieces, { armorValues: true });
  const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career });
  const e = upstreamWear(u, oracleEntity(lord), pieces);
  const traits = ['stoneskin'];
  const cap = 60;
  const rng = generator(0x6b6b);
  const sample = [];
  for (let i = 0; i < 20000; i++) {
    const raw = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), e, {
      weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 50,
    });
    sample.push(raw > 0 ? u.bossTraits.bossStrike({ bossTraits: traits }, raw, { kind: 'melee', weapon: fresh(upstreamWeapon(item)) }).damage : raw);
  }
  const r = analyze(simCharacter(desc, item), {
    target: { ...local, bossTraits: traits, hitCap: cap }, core: 'overhaul', backstabUptime: 1,
  });
  const s = summarize(sample);
  const cs = summarize(sample.map((v) => Math.min(v, cap)));
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `racial/backstab/condition: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
  assert.ok(
    Math.abs(r.cappedPerSwing - cs.mean) <= 1.96 * cs.se,
    `racial/backstab/condition/cap: ${r.cappedPerSwing.toFixed(4)} vs ${cs.mean.toFixed(4)} +/- ${(1.96 * cs.se).toFixed(4)}`,
  );
});

test('stage: racial off-hand (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 30, raceId: 6,
    stats: { strength: 80, agility: 70, speed: 90, luck: 60, endurance: 75, willpower: 50 },
    skills: 50, skillOverride: { 28: 80, 34: 40, 19: 0 }, martialPath: null,
  });
  const item = weapon(113, { material: 9, condition: 1 });
  const target = referenceFoe(u, 30, 'tough');
  const rng = generator(0x0ff6ce);
  const sample = [];
  for (let i = 0; i < 30000; i++) {
    sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
      weapon: fresh(upstreamWeapon(item)), toHitMod: offHandToHit(70), blowShare: offHandDamage,
      rolls: rng, modules, backstabChance: 0,
    }));
  }
  const r = analyze(simCharacter(desc, item), {
    target: simReferenceFoe(30, 'tough'), core: 'overhaul', weapon: weaponOf(item), offHand: true,
  });
  const s = summarize(sample);
  const cmp = compareSample({ expected: sample, actual: r.perSwing });
  assert.ok(cmp.ok, `racial off hand: ${r.perSwing.toFixed(4)} vs ${s.mean.toFixed(4)} +/- ${(1.96 * s.se).toFixed(4)}`);
});

test('stage: spell career tolerance and saving chance', async () => {
  const u = await upstream();
  const cases = [];
  const careers = [
    ['normal', {}],
    ['fire-res', { resistanceFlags: EFFECT_FLAGS.Fire }],
    ['fire-imm', { immunityFlags: EFFECT_FLAGS.Fire }],
    ['fire-weak', { criticalWeaknessFlags: EFFECT_FLAGS.Fire }],
    ['fire-low', { lowToleranceFlags: EFFECT_FLAGS.Fire }],
    ['magic-res', { resistanceFlags: EFFECT_FLAGS.Magic }],
    ['mixed', { resistanceFlags: EFFECT_FLAGS.Fire, lowToleranceFlags: EFFECT_FLAGS.Magic }],
  ];
  const flagSets = [0, EFFECT_FLAGS.Fire, EFFECT_FLAGS.Fire | EFFECT_FLAGS.Magic | EFFECT_FLAGS.Paralysis, EFFECT_FLAGS.Poison | EFFECT_FLAGS.Disease];
  for (const [name, career] of careers) {
    for (const element of [0, 1, 2, 3, 4]) {
      for (const flags of flagSets) {
        for (const willpower of [0, 50, 100]) {
          for (const pierce of [0, 10]) {
            cases.push({ id: `${name}-e${element}-f${flags}-w${willpower}-p${pierce}`, input: { career, element, flags, willpower, pierce } });
          }
        }
      }
    }
  }
  const report = await runStage({
    name: 'spell career tolerance',
    cases,
    waivers: WAIVERS,
    upstream: ({ career, element, flags, willpower, pierce }) => {
      const target = { isPlayer: false, career, stats: { willpower }, _mods: {}, activeEffects: [] };
      return u.spellcast.savingChance(element, flags, target, 0, pierce);
    },
    simulator: ({ career, element, flags, willpower, pierce }) => {
      const target = { isPlayer: false, career, stats: { willpower }, _mods: {}, activeEffects: [] };
      return savingChanceOutcome(target, { element, effectFlags: flags, pierce });
    },
  });
  assert.ok(report.cases >= 800);
  expectClean(assert, report);

  const racial = [];
  for (const [name, raceTemplate] of [
    ['normal', {}],
    ['fire-res', { resistanceFlags: EFFECT_FLAGS.Fire }],
    ['fire-imm', { immunityFlags: EFFECT_FLAGS.Fire }],
    ['fire-weak', { criticalWeaknessFlags: EFFECT_FLAGS.Fire }],
    ['fire-low', { lowToleranceFlags: EFFECT_FLAGS.Fire }],
  ]) {
    for (const element of [0, 1, 4]) {
      const flags = element === 0 ? EFFECT_FLAGS.Fire : element === 1 ? EFFECT_FLAGS.Frost : EFFECT_FLAGS.Magic;
      racial.push({ id: `${name}-e${element}`, input: { raceTemplate, element, flags } });
    }
  }
  const racialReport = await runStage({
    name: 'spell player-race tolerance',
    cases: racial,
    waivers: WAIVERS,
    upstream: ({ raceTemplate, element, flags }) => u.spellcast.savingChance(element, flags, { isPlayer: true, raceTemplate, stats: { willpower: 50 }, _mods: {}, activeEffects: [] }),
    simulator: ({ raceTemplate, element, flags }) => savingChanceOutcome({ isPlayer: true, raceTemplate, stats: { willpower: 50 }, _mods: {}, activeEffects: [] }, { element, effectFlags: flags }),
  });
  expectClean(assert, racialReport);
});

test('stage: saving lands and career tolerance are the game\'s own', async () => {
  const u = await upstream();
  const landing = Array.from({ length: 101 }, (_, saving) => ({ id: `s${saving}`, input: { saving } }));
  const report = await runStage({
    name: 'spell saving lands',
    cases: landing,
    waivers: WAIVERS,
    upstream: ({ saving }) => u.spellcast.savingLands(saving),
    simulator: ({ saving }) => savingLands(saving),
  });
  expectClean(assert, report);

  const flags = [EFFECT_FLAGS.Fire, EFFECT_FLAGS.Frost, EFFECT_FLAGS.Shock, EFFECT_FLAGS.Poison, EFFECT_FLAGS.Magic, EFFECT_FLAGS.Paralysis, EFFECT_FLAGS.Disease];
  const toleranceCases = [];
  for (const flag of flags) {
    for (const [name, career] of [
      ['none', {}],
      ['res', { resistanceFlags: flag }],
      ['imm', { immunityFlags: flag }],
      ['low', { lowToleranceFlags: flag }],
      ['weak', { criticalWeaknessFlags: flag }],
      ['mixed', { resistanceFlags: flag, immunityFlags: flag }],
    ]) toleranceCases.push({ id: `${name}-${flag}`, input: { flag, career } });
  }
  const toleranceReport = await runStage({
    name: 'spell career tolerance table',
    cases: toleranceCases,
    waivers: WAIVERS,
    upstream: ({ flag, career }) => u.spellcast.careerTolerance(career, flag),
    simulator: ({ flag, career }) => careerTolerance(career, flag),
  });
  expectClean(assert, toleranceReport);

  const flagCases = [
    { id: 'fire', input: { element: 0, check: EFFECT_FLAGS.Fire, spell: EFFECT_FLAGS.Fire } },
    { id: 'disease-poison', input: { element: 2, check: EFFECT_FLAGS.Disease, spell: EFFECT_FLAGS.Poison } },
    { id: 'paralysis', input: { element: 4, check: EFFECT_FLAGS.Paralysis, spell: EFFECT_FLAGS.Paralysis } },
    { id: 'wrong', input: { element: 1, check: EFFECT_FLAGS.Fire, spell: EFFECT_FLAGS.Fire } },
  ];
  const flagReport = await runStage({
    name: 'spell has flags',
    cases: flagCases,
    waivers: WAIVERS,
    upstream: ({ element, check, spell }) => u.spellcast.spellHasFlags(element, check, spell),
    simulator: ({ element, check, spell }) => spellHasFlags(element, check, spell),
  });
  expectClean(assert, flagReport);
});

test('stage: material ordering with critical and condition (sampled)', async () => {
  const u = await upstream();
  const modules = pcaaoModules(u);
  const desc = character({
    level: 45, raceId: 1,
    stats: { strength: 80, agility: 60, speed: 60, luck: 50, endurance: 50, willpower: 50 },
    skills: 0, skillOverride: { 29: 200, 34: 200 },
  });
  const target = referenceFoe(u, 45, 'tough');
  target.minMetalToHit = 5;
  for (const condition of [0.5, 0.9]) {
    const item = weapon(121, { material: 2, condition });
    const rng = generator(condition === 0.5 ? 0x2a18 : 0x2a19);
    const sample = [];
    for (let i = 0; i < 6000; i++) {
      sample.push(u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), target, {
        weapon: fresh(upstreamWeapon(item)), rolls: rng, modules, backstabChance: 0,
      }));
    }
    const localTarget = { ...simReferenceFoe(45, 'tough'), minMetalToHit: 5, spareGear: true };
    const r = analyze(simCharacter(desc, item), { target: localTarget, core: 'overhaul' });
    const cmp = compareSample({ expected: sample, actual: r.perSwing });
    assert.ok(cmp.ok, `material+crit+condition ${condition}: per swing ${r.perSwing.toFixed(4)} vs ${summarize(sample).mean.toFixed(4)} (n=${sample.length})`);
  }
});

test('stage: boss trait resistance factors', async () => {
  const u = await upstream();
  const cases = [];
  for (const traits of [[], ['bladeturning'], ['stoneskin'], ['bladeturning', 'thorned'], ['stoneskin', 'thorned']]) {
    for (const t of [121, 126]) cases.push({ id: `${traits.join('+') || 'none'}-t${t}`, input: { traits, t } });
  }
  const report = await runStage({
    name: 'boss trait resistance',
    cases,
    waivers: WAIVERS,
    upstream: ({ traits, t }) => u.bossTraits.bossStrike({ bossTraits: traits, maxHealth: 1000, health: 1000 }, 1000, { kind: 'melee', weapon: { templateIndex: t } }).damage / 1000,
    simulator: ({ traits, t }) => analyze(simCharacter(character()), { weapon: weaponOf(weapon(t, { material: 1 })), traits, target: simReferenceFoe(30, 'tough') }).resist,
  });
  expectClean(assert, report);
});

test('stage: the boss stand-in is the game\'s body', async () => {
  const { boot, body: boss } = await upstreamBody({ kind: 'standIn', mobile: 31 });
  assert.ok(boot.dexLoaded && boot.mudexLoaded, 'the realm booted as the client boots (Enemy Expansion with MUDEX)');
  assert.equal(boss.careerIndex, 31, 'career index (Daedra Lord)');
  assert.equal(boss.isClass, false, 'a monster, not a class foe');
  // ENEMY_BASICS[31].level is 20; under the client's boot MUDEX's Daedra Lord line stands at 21
  // (Meaner Monsters' own 21 stands aside beside Enemy Expansion: dexSwitches.js:28).
  assert.equal(boss.level, 21, 'level from the booted Daedra Lord row');
  assert.deepEqual(boss.armorValues, new Array(7).fill(60), 'BOSS_ARMOR on every part');
  assert.equal(boss.stats.strength, 50);
  assert.equal(boss.stats.willpower, 50);
  // An enemy entity's `skills` is the one scalar every skill reads (skillsLevel).
  assert.equal(boss.skills, 100, 'skillsLevel(21) is capped at 100');
  assert.ok(boss.spareGear, 'a blow on the Warden wears nothing');
});

test('stage: curbing is the game\'s 5% share', async () => {
  const u = await upstream();
  const health = 5000;
  const taken = u.bossTraits.bossTake({ bossTraits: ['curbing'], maxHealth: health, health }, 10000, { nowS: 0 }).damage;
  assert.equal(taken, Math.max(1, Math.round(health * u.bossTraits.CURB_SHARE)));
  const r = analyze(simCharacter(character()), { target: { ...simReferenceFoe(30, 'tough'), hitCap: 0, isBoss: true }, traits: ['curbing'], health });
  assert.equal(r.cap, Math.max(1, Math.round(health * u.bossTraits.CURB_SHARE)));
});

test('stage: the per-hit cap constant is the relay\'s HIT_CAP_X x dpsRef', async () => {
  // gateBrain.js is behind the multiplayer graph, so its constants are pinned
  // by test/golden-upstream.test.js; here the simulator's own gate target is
  // checked against the documented formula at several levels.
  const { gateHealth, gateHitCap } = await import('../src/data.js');
  for (const level of [1, 30, 45, 60]) {
    const ref = 5 + Math.max(1, Math.min(60, Math.floor(level)));
    assert.equal(gateHitCap(level), 12 * ref, `per-hit cap at level ${level}`);
    assert.equal(gateHealth(level), 240 * ref, `pool at level ${level}`);
  }
});
