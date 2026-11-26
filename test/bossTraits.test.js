/*
 * test/bossTraits.test.js - C2: a relay boss carries deterministic traits, and
 * they resolve the blow before the relay's cap and allowance.
 *
 * The oracle is the game's own systems/bossTraits.js (vendored): `relayBossTraits`
 * for selection and `bossStrike` for what a blow becomes. Every assertion below
 * either calls those functions or recomputes an expectation with them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateTarget, bossTarget, referenceFoe, analyze } from '../src/model.js';
import { encounterTarget } from '../src/encounters.js';
import { RELAY_BOSSES, relayTraitsFor, relayTraitsFor as _for, resistBlow, bossStrike, ELEMENT_TRAITS, RESIST_SHARE, WEAPON_RESIST_SHARE } from '../src/bossTraits.js';
import { spellDamage } from '../src/spells.js';
import { enchantDps } from '../src/enchants.js';
import { theoryCharacter } from '../src/theory.js';
import { character, simCharacter, weapon } from './harness/fixtures.mjs';
import { upstream } from './harness/upstream.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** The three online bosses, as the audit recorded them at a3eb1605. */
const AUDIT = {
  breach: ['spellproof', 'stoneskin'],
  skyketch: ['frostproof', 'stoneskin'],
  abyss: ['spellproof', 'stoneskin'],
};

// ── selection ────────────────────────────────────────────────────────────────
test('selection: each boss\'s traits are the client\'s relayBossTraits(name, mobile)', async () => {
  const u = await upstream();
  for (const [id, boss] of Object.entries(RELAY_BOSSES)) {
    const vendored = u.bossTraits.relayBossTraits(boss.name, boss.mobile);
    assert.deepEqual(relayTraitsFor(id), vendored, `${id}: ${boss.name} @ ${boss.mobile}`);
    assert.deepEqual([...relayTraitsFor(id)], AUDIT[id], `${id}: the audit's row`);
  }
  assert.equal(relayTraitsFor('nope'), null);
  assert.equal(RELAY_BOSSES.breach.name, 'Valkynaz Ruhn');
  assert.equal(RELAY_BOSSES.breach.mobile, 31);
  assert.equal(RELAY_BOSSES.skyketch.mobile, 36);
  assert.equal(RELAY_BOSSES.abyss.mobile, 36);
});

test('selection: the gate and every encounter target carry them', () => {
  assert.deepEqual(gateTarget(45).bossTraits, AUDIT.breach);
  assert.deepEqual(encounterTarget('breach', 45).bossTraits, AUDIT.breach);
  assert.deepEqual(encounterTarget('skyketch', 45).bossTraits, AUDIT.skyketch);
  assert.deepEqual(encounterTarget('abyss', 45).bossTraits, AUDIT.abyss);
  // An explicit list is an override, for experiments and for `--traits`.
  assert.deepEqual(gateTarget(45, { traits: ['curbing'] }).bossTraits, ['curbing']);
  assert.deepEqual(gateTarget(45, { traits: [] }).bossTraits, []);
  // A plain boss keeps whatever its caller asked for (curbing bosses are not relay bosses).
  assert.deepEqual(bossTarget({ traits: ['curbing'] }).bossTraits, ['curbing']);
  assert.deepEqual(bossTarget().bossTraits, []);
});

test('localization: the Warden\'s traits follow the client\'s language (an upstream quirk)', async () => {
  const u = await upstream();
  // systems/ketch/ketchWords.js:191 `tonal: () => t('ketch.kind.tonal', 'The Tonal Warden')`, and
  // relayBossTraits hashes that string. The translated names below are upstream's own locale strings
  // (locales/<locale>/Port_Strings.csv:462). The gate's and the Remnant's names are literals.
  const english = ['frostproof', 'stoneskin'];
  assert.deepEqual([...u.bossTraits.relayBossTraits('The Tonal Warden', 36)], english);
  assert.deepEqual([...relayTraitsFor('skyketch')], english);
  const localized = {
    'zh-Hant 音律守護者': ['frostproof', 'thorned'],
    'zh-Hans 音律守护者': ['stormproof', 'bladeturning'],
    'uk Тональний Страж': ['flameproof', 'bladeturning'],
    'tr Ton Muhafızı': ['flameproof', 'thorned'],
  };
  for (const [label, expected] of Object.entries(localized)) {
    const name = label.split(' ').slice(1).join(' ');
    assert.deepEqual([...u.bossTraits.relayBossTraits(name, 36)], expected, label);
  }
});

// ── resolution: one blow, exactly as the game resolves it ────────────────────
test('resolution: every kind, weapon and trait matches the game\'s bossStrike', async () => {
  const u = await upstream();
  const traits = [[], ['stoneskin'], ['bladeturning'], ['bladeturning', 'thorned'], AUDIT.breach, ['flameproof'], ['spellproof']];
  const weapons = [null, weapon(121), weapon(126), weapon(122), weapon(129), weapon(563)];
  const kinds = ['melee', 'arrow', 'spell'];
  let checks = 0;
  for (const t of traits) {
    for (const w of weapons) {
      for (const kind of kinds) {
        for (const element of kind === 'spell' ? [0, 1, 2, 3, 4] : [null]) {
          for (const d of [1, 7, 100, 137, 599, 600, 601, 1373]) {
            const expected = u.bossTraits.bossStrike({ bossTraits: t }, d, { kind, weapon: w, element }).damage;
            assert.equal(resistBlow(t, d, { kind, weapon: w, element }), expected, `${t} ${w?.templateIndex ?? 'fist'} ${kind}/${element} ${d}`);
            checks += 1;
          }
        }
      }
    }
  }
  assert.ok(checks > 1000);
});

test('resolution: a resisted blow is max(1, round(d)) and is never reduced twice', () => {
  const t = ['stoneskin'];
  // one ×0.5, rounded once, floored at 1 - not 0.25 and not 0
  assert.equal(resistBlow(t, 100, { kind: 'melee', weapon: weapon(126) }), 50);
  assert.equal(resistBlow(t, 99, { kind: 'melee', weapon: weapon(126) }), 50); // 49.5 -> 50 (half up)
  assert.equal(resistBlow(t, 1, { kind: 'melee', weapon: weapon(126) }), 1, 'a landed blow is never 0');
  assert.equal(resistBlow(['spellproof'], 50, { kind: 'spell', element: 4 }), 13); // 12.5 -> 13
  assert.equal(resistBlow(['stoneskin', 'spellproof'], 100, { kind: 'melee', weapon: weapon(126) }), 50, 'a melee blow does not take an element proof');
  // a blade and an arrow are blades; a fist and Hand Wraps are blunt
  assert.equal(resistBlow(t, 100, { kind: 'melee', weapon: weapon(121) }), 100);
  assert.equal(resistBlow(t, 100, { kind: 'arrow', weapon: weapon(129) }), 100);
  assert.equal(resistBlow(t, 100, { kind: 'melee', weapon: null }), 50);
  assert.equal(resistBlow(t, 100, { kind: 'melee', weapon: weapon(563) }), 50);
});

test('resolution: analyze() applies it once, before the per-hit cap', async () => {
  const u = await upstream();
  const cases = [
    { name: 'breach katana', traits: AUDIT.breach, t: 121 },
    { name: 'breach warhammer', traits: AUDIT.breach, t: 126 },
    { name: 'bladeturning katana', traits: ['bladeturning'], t: 121 },
    { name: 'curbing warhammer', traits: ['curbing'], t: 126 },
  ];
  for (const c of cases) {
    const ch = theoryCharacter({ blade: c.t, gearLB: 240, gearCS: 540, damagePct: 40 });
    ch.skills[c.t === 126 ? 32 : 29] = 200;
    const r = analyze(ch, { target: gateTarget(45, { traits: c.traits }), health: 12000, rri: true, traits: c.traits, swing: 'StrikeLeft' });
    const strike = (d) => u.bossTraits.bossStrike({ bossTraits: c.traits }, d, { kind: 'melee', weapon: r.weapon }).damage;
    // pcaao.js:1815-1817: the target's hide/natural resistance resolves before the host's traits.
    const natural = u.pcaao.pcaaoNaturalDamageResistance(r.target);
    const defended = (d) => u.pcaao.pcaaoPercentageReductionCalculationForMonsters(null, r.target, d, c.t === 126, natural);
    const clip = (v) => (r.cap > 0 ? Math.min(v, r.cap) : v);
    const expectCapped = (1 - r.hit.crit.chance) * r.hit.hitPlain * mean(r.damage.plainRolls.map((d) => clip(strike(defended(d)))))
      + r.hit.crit.chance * r.hit.hitCrit * mean(r.damage.critRolls.map((d) => clip(strike(defended(d)))));
    assert.ok(near(r.cappedPerSwing, expectCapped, 1e-9), `${c.name}: ${r.cappedPerSwing} vs ${expectCapped}`);
    // and the uncapped per-swing figure is resisted too (it used to escape the traits entirely)
    const expectPlain = (1 - r.hit.crit.chance) * r.hit.hitPlain * mean(r.damage.plainRolls.map((d) => strike(defended(d))))
      + r.hit.crit.chance * r.hit.hitCrit * mean(r.damage.critRolls.map((d) => strike(defended(d))));
    assert.ok(near(r.perSwing, expectPlain, 1e-9), `${c.name} uncapped: ${r.perSwing} vs ${expectPlain}`);
  }
});

// ── each trait's effect, through analyze() against the real bosses ──────────
const BLADE = () => theoryCharacter({ blade: 121, gearLB: 240, gearCS: 540, damagePct: 40 });
const HAMMER = () => {
  const c = theoryCharacter({ blade: 126, gearLB: 240, gearCS: 540, damagePct: 40 });
  c.skills[32] = 200;
  c.masteredSkills = [32, 34];
  c._mods.skills[32] = 240;
  c.career.weaponArmorShieldsBitfield = 16 << 16;
  return c;
};
const FISTS = () => {
  const c = simCharacter(character({ level: 45, stats: { strength: 100, agility: 100, speed: 100, luck: 50 }, skillOverride: { 30: 200, 34: 200 } }));
  return c;
};
/** The vendored cut's gate maths: these are a3eb1605 numbers, so every case prices 14512 explicitly. */
const at = (ch, target, extra = {}) => analyze(ch, { target, health: target.maxHealth, rri: true, gameBuild: '14512', ...extra });

test('stoneskin: blunt weapons and fists are halved at the Breach, a blade is not', () => {
  const gate = gateTarget(45);
  const blade = at(BLADE(), gate);
  const bladeNeutral = at(BLADE(), gate, { traits: [] });
  assert.ok(near(blade.perSwing, bladeNeutral.perSwing, 1e-9), 'spellproof + stoneskin do not touch a blade');

  const hammer = at(HAMMER(), gate);
  const hammerNeutral = at(HAMMER(), gate, { traits: [] });
  const ratio = hammer.perSwing / hammerNeutral.perSwing;
  assert.ok(ratio > 0.49 && ratio < 0.51, `warhammer ${hammer.perSwing.toFixed(1)} vs neutral ${hammerNeutral.perSwing.toFixed(1)} (x${ratio.toFixed(3)})`);

  const fists = at(FISTS(), gate);
  const fistsNeutral = at(FISTS(), gate, { traits: [] });
  assert.ok(near(fists.perSwing / fistsNeutral.perSwing, 0.5, 0.01), 'fists are a blunt blow');
  assert.deepEqual(fists.traits, AUDIT.breach);
});

test('bladeturning: a blade and an arrow are halved, a hammer is not', () => {
  const t = bossTarget({ level: 45, health: 12000, traits: ['bladeturning'], hitCap: 600 });
  const blade = at(BLADE(), t);
  const bladeNeutral = at(BLADE(), t, { traits: [] });
  assert.ok(near(blade.perSwing / bladeNeutral.perSwing, 0.5, 0.01));
  const hammer = at(HAMMER(), t);
  const hammerNeutral = at(HAMMER(), t, { traits: [] });
  assert.ok(near(hammer.perSwing, hammerNeutral.perSwing, 1e-9), 'blunt is full against a blade-turning boss');
  // an arrow is a blade (systems/bossTraits.js bladeBlow)
  const bow = simCharacter(character({ level: 45, stats: { strength: 100, agility: 100, speed: 100 } }), weapon(130, { material: 9 }));
  const arrow = at(bow, t);
  const arrowNeutral = at(bow, t, { traits: [] });
  assert.ok(near(arrow.perSwing / arrowNeutral.perSwing, 0.5, 0.01), 'the long bow is a blade');
});

const SPELL = (element, { dot = false, magnitude = 20 } = {}) => ({
  name: `fixture-${element}${dot ? '-dot' : ''}`,
  element,
  rangeType: 0,
  cost: 10,
  effects: [
    {
      type: dot ? 1 : 4,
      subType: 0,
      magnitudeBaseLow: magnitude,
      magnitudeBaseHigh: magnitude,
      magnitudeLevelBase: 1,
      magnitudeLevelHigh: 1,
      magnitudePerLevel: 1,
      durationBase: dot ? 5 : 0,
      durationMod: 0,
      durationPerLevel: 1,
      chanceBase: 0,
      chanceMod: 0,
      chancePerLevel: 1,
    },
  ],
});

test('spellproof: a magic spell is quartered at the Breach; fire is not resisted', () => {
  const gate = gateTarget(45);
  const neutral = { ...gate, bossTraits: [] };
  const ch = simCharacter(character({ level: 45, skillOverride: { 22: 100 } }));
  const magic = SPELL(4);
  const fire = SPELL(0);
  const m = spellDamage(magic, ch, gate);
  const mN = spellDamage(magic, ch, neutral);
  assert.ok(near(m.instant, mN.instant * RESIST_SHARE, 1e-9), `${m.instant} vs ${mN.instant}`);
  const f = spellDamage(fire, ch, gate);
  const fN = spellDamage(fire, ch, neutral);
  assert.ok(near(f.instant, fN.instant, 1e-9), 'spellproof is the MAGIC element only');
  // elements are the client's list: fire, frost, poison, shock, magic
  assert.deepEqual([...ELEMENT_TRAITS], ['flameproof', 'frostproof', 'venomproof', 'stormproof', 'spellproof']);
});

test('frostproof: frost is quartered at the Sky-ketch; magic and fire are full', () => {
  const ketch = encounterTarget('skyketch', 45);
  const neutral = { ...ketch, bossTraits: [] };
  const ch = simCharacter(character({ level: 45, skillOverride: { 22: 100 } }));
  const frost = spellDamage(SPELL(1), ch, ketch);
  const frostN = spellDamage(SPELL(1), ch, neutral);
  assert.ok(near(frost.instant, frostN.instant * RESIST_SHARE, 1e-9));
  assert.ok(near(spellDamage(SPELL(0), ch, ketch).instant, spellDamage(SPELL(0), ch, neutral).instant, 1e-9));
  assert.ok(near(spellDamage(SPELL(4), ch, ketch).instant, spellDamage(SPELL(4), ch, neutral).instant, 1e-9), 'frostproof is not spellproof');
});

test('all three bosses: blunt is halved by stoneskin and magic is quartered where spellproof stands', () => {
  const roster = [
    { id: 'breach', target: gateTarget(45), bluntHalf: true, magicQuarter: true },
    { id: 'skyketch', target: encounterTarget('skyketch', 45), bluntHalf: true, magicQuarter: false },
    { id: 'abyss', target: encounterTarget('abyss', 45), bluntHalf: true, magicQuarter: true },
  ];
  const ch = simCharacter(character({ level: 45, skillOverride: { 22: 100 } }));
  for (const b of roster) {
    const neutral = { ...b.target, bossTraits: [] };
    assert.deepEqual(b.target.bossTraits, AUDIT[b.id], b.id);
    const hammer = at(HAMMER(), b.target);
    const hammerN = at(HAMMER(), b.target, { traits: [] });
    if (b.bluntHalf) assert.ok(near(hammer.perSwing / hammerN.perSwing, 0.5, 0.01), `${b.id} blunt`);
    const magic = spellDamage(SPELL(4), ch, b.target).instant;
    const magicN = spellDamage(SPELL(4), ch, neutral).instant;
    assert.ok(near(magic, b.magicQuarter ? magicN * RESIST_SHARE : magicN, 1e-9), `${b.id} magic`);
    const frost = spellDamage(SPELL(1), ch, b.target).instant;
    const frostN = spellDamage(SPELL(1), ch, neutral).instant;
    assert.ok(near(frost, b.id === 'skyketch' ? frostN * RESIST_SHARE : frostN, 1e-9), `${b.id} frost`);
  }
});

test('procs and DoTs are resolved like the spells they are', () => {
  const gate = gateTarget(45);
  const neutral = { ...gate, bossTraits: [] };
  const ch = simCharacter(character({ level: 45, skillOverride: { 22: 100 } }));
  const magic = SPELL(4, { dot: true, magnitude: 40 });
  const standard = new Map([[7, magic]]);
  const item = { group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1000, currentCondition: 1000, enchantments: [{ type: 2, param: 7 }] };
  const live = enchantDps(item, ch, gate, { standard, hit: 1, aps: 1 });
  const plain = enchantDps(item, ch, neutral, { standard, hit: 1, aps: 1 });
  assert.ok(near(live.perSwing, plain.perSwing * RESIST_SHARE, 1e-9), `proc instant ${live.perSwing} vs ${plain.perSwing}`);
  assert.ok(near(live.dotDps, plain.dotDps * RESIST_SHARE, 1e-9), `DoT ${live.dotDps} vs ${plain.dotDps}`);
  // and the claim cap is applied AFTER the resistance (enchantDps caps the resisted tick)
  const capped = enchantDps(item, ch, gate, { standard, hit: 1, aps: 1, cap: 1 });
  assert.ok(capped.perSwing <= 1 && capped.dotDps <= 1, 'the cap is the last word');
});

test('a weapon\'s elemental affix is not a spell: no element proof touches it', () => {
  const base = weapon(121, { material: 9 });
  const withAffix = { ...base, affixes: [{ id: 'elemental', param: 'fire', value: 10 }] };
  const gate = gateTarget(45);
  const a = at(simCharacter(character({ level: 40, stats: { strength: 80 } }), base), gate);
  const b = at(simCharacter(character({ level: 40, stats: { strength: 80 } }), withAffix), gate);
  const bNeutral = at(simCharacter(character({ level: 40, stats: { strength: 80 } }), withAffix), gate, { traits: [] });
  assert.ok(near(b.perSwing, bNeutral.perSwing, 1e-9), 'spellproof does not quarter an affix');
  assert.ok(b.perSwing > a.perSwing, 'the affix still lands its flat damage (C5 territory, untouched)');
});

// ── ordering against the allowance (C1) ──────────────────────────────────────
test('allowance: resistance is applied before the claim, so the offered rate is the resisted one', () => {
  const gate = gateTarget(45);
  const build = () => {
    const c = theoryCharacter({ blade: 126, gearLB: 40, damagePct: 0 });
    c.skills[32] = 200;
    c.masteredSkills = [32, 34];
    c._mods.skills[32] = 40;
    c.career.weaponArmorShieldsBitfield = 16 << 16;
    return c;
  };
  const neutral = at(build(), gate, { traits: [] });
  const live = at(build(), gate);
  assert.ok(neutral.allowance.ceilingDps > 150, `neutral offers ${neutral.allowance.ceilingDps.toFixed(0)}/s`);
  assert.ok(neutral.allowance.saturated, 'and exceeds the allowance');
  assert.ok(live.allowance.ceilingDps < 150, `stoneskin leaves ${live.allowance.ceilingDps.toFixed(0)}/s`);
  assert.ok(!live.allowance.saturated, 'so the build no longer saturates the allowance');
  assert.ok(near(live.allowance.sustainedDps, live.allowance.ceilingDps, 1e-9), 'sustained = what it offers');
  // the ceiling is the resisted per-swing figure, not the raw one
  assert.ok(near(live.allowance.ceilingDps, live.perSwing * live.cadence.aps, 1e-9));
  // and the TTK is the allowance's, computed from the resisted claims
  assert.ok(live.ttk > neutral.ttk, `resisted kill ${live.ttk.toFixed(1)} s vs neutral ${neutral.ttk.toFixed(1)} s`);
});

// ── everything else stays as it was ─────────────────────────────────────────
test('ordinary foes and curbing bosses are unchanged', () => {
  const ch = BLADE();
  for (const preset of ['soft', 'tough', 'armoured', 'human']) {
    const r = analyze(ch, { target: referenceFoe(45, preset) });
    assert.deepEqual(r.traits, [], `${preset} has no boss traits`);
    assert.equal(r.allowance, null);
    const control = analyze(ch, { target: referenceFoe(45, preset), traits: [] });
    assert.ok(near(r.perSwing, control.perSwing, 1e-12));
  }
  const curb = bossTarget({ level: 45, health: 5000, traits: ['curbing'] });
  const a = analyze(ch, { target: curb, health: 5000 });
  const b = analyze(ch, { target: curb, health: 5000, traits: ['curbing'] });
  assert.ok(near(a.perSwing, b.perSwing, 1e-12), 'the curbing boss is the same with or without the explicit override');
  assert.deepEqual(a.traits, ['curbing']);
  assert.equal(a.allowance, null, 'a curbing boss is not a relay boss');
});

test('the traits a target carries are the ones analyze uses, with or without an override', () => {
  const gate = gateTarget(45);
  const ch = HAMMER();
  const inherited = analyze(ch, { target: gate, health: 12000 });
  const explicit = analyze(ch, { target: gate, health: 12000, traits: AUDIT.breach });
  assert.deepEqual(inherited.traits, AUDIT.breach);
  assert.ok(near(inherited.perSwing, explicit.perSwing, 1e-12));
  const off = analyze(ch, { target: gate, health: 12000, traits: [] });
  assert.ok(off.perSwing > inherited.perSwing * 1.9, 'turning the traits off restores the full blow');
});

test('imprint pricing: a same-hit multiplier is resolved through the traits, in the game\'s order', () => {
  // Stage 2.9: pricing is the one card re-run (analyze's `with`), not a second calculation. The game's order -
  // the power enters lootBlow's step, THEN the crit, the defence, the boss's stoneskin, the cap - is verified
  // against upstream's own blows in test/pricing.test.js section 4 (warhammer, stoneskin, binding cap 12).
  const gate = gateTarget(45);
  const ch = HAMMER();
  const r = analyze(ch, { target: gate, health: gate.maxHealth, rri: true });
  // no change: the same card, exactly (the pre-2.9 helper needed a 1e-9 tolerance and missed it elsewhere)
  assert.equal(r.with({}).cappedDps, r.cappedDps);
  assert.equal(r.with({ loot: { pct: 0, flat: 0 } }).cappedDps, r.cappedDps);
  // a +50% imprint is the same line on the item, which the differential stages verify
  const real = analyze({ ...ch, weapon: { ...ch.weapon, affixes: [...(ch.weapon.affixes ?? []), { id: 'slayer', param: 'daedra', value: 30 }] } }, { target: gate, health: gate.maxHealth, rri: true });
  const priced = r.with({ loot: { pct: 30, flat: 0 } });
  assert.equal(priced.cappedDps, real.cappedDps);
  assert.equal(priced.dps, real.dps);
  // stoneskin halves the (scaled) blow, so the gain cannot be the raw +50% of the capped figure
  assert.ok(priced.cappedDps < r.cappedDps * 1.3 - 1e-6);
  assert.ok(priced.dps > r.dps);
});
