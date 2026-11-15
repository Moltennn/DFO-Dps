#!/usr/bin/env node
/*
 * tools/vendor-parity.mjs - prove the vendored subset answers exactly as the
 * full upstream checkout does.
 *
 * tools/vendor-upstream.mjs keeps only the combat import closure and replaces
 * the edges that leave it (UI, rendering, assets, network, settings plumbing)
 * with inert stubs. This tool is the gate on that pruning: it loads BOTH trees,
 * runs a fixed, seeded battery through each, and reports any answer that differs.
 *
 *   node tools/vendor-parity.mjs --from <upstream-checkout>
 *
 * Run it whenever the subset is re-pinned or a module is added to the cut list.
 * A single divergence means a stubbed edge is on a measured path: vendor the
 * module (remove it from EXCLUDE) or explain the difference before shipping.
 */
import path from 'node:path';
import { VENDOR_DIR, COMMIT } from '../test/harness/upstream.mjs';

const V = path.join(VENDOR_DIR, 'src/');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const upstreamRoot = arg('--from');
if (!upstreamRoot) {
  console.error('usage: node tools/vendor-parity.mjs --from <upstream-checkout>');
  process.exit(2);
}
const U = path.join(path.resolve(upstreamRoot), 'src/');

const MODULES = [
  'combat/combatStats.js', 'combat/pcaao.js', 'combat/formulas.js', 'combat/fpsWeapon.js',
  'combat/technique/techniqueRoster.js', 'combat/twoHands/handsLaw.js', 'combat/bowBloom.js',
  'combat/swingLaw.js', 'characters/weaponStates.js', 'characters/weapons.js', 'characters/equipTable.js',
  'characters/enemy/enemyEntity.js', 'characters/enemy/enemyBasics.js', 'characters/handWrapsIds.js',
  'combat/enemyGroups.js', 'systems/powerCeiling.js', 'systems/bossTraits.js', 'systems/weaponMastery.js',
  'systems/martialPowers.js', 'systems/statMods.js', 'systems/skills.js', 'systems/skillSoftcap.js',
  'systems/masterSkills.js', 'systems/entityMods.js', 'systems/equip.js', 'systems/armorMaterials.js',
  'systems/inventory.js', 'systems/loot/lootPowers.js', 'systems/loot/lootRarity.js', 'net/gate/gateBrain.js',
  'combat/enemyEquipment.js', 'systems/item/itemTemplates.js',
  // Stage 2.8: the minted body - Enemy Expansion's rows and boot, and the relay bodies' constructor.
  'systems/enemyExpansion/dexInstall.js', 'systems/enemyExpansion/dexSwitches.js', 'world/gate/gateBoss.js',
  // Stage 2.9: the sigil duel flag martialPowers asks first (a stub answered a truthy object).
  'systems/sigil/sigil.js', 'systems/martialPaths.js',
  // Stage 2.9: the enchantment registry and its type table (formats/magicDef.js was a stub).
  'systems/enchantments.js', 'formats/magicDef.js',
  // Stage 2.11a: the set-duel flag wornPowers asks first (a stub answered a truthy object: no worn power fired).
  'systems/sigil/sigilSets.js',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const load = async (root) => {
  const out = {};
  for (const m of MODULES) out[m] = await import(root + m);
  out['combat/pcaao.js'].installPcaao();
  return out;
};

const A = await load(V);
const B = await load(U);

let checks = 0;
const diverged = [];
const same = (label, fa, fb) => {
  checks++;
  const a = JSON.stringify(fa(A));
  const b = JSON.stringify(fb(B));
  if (a !== b) diverged.push({ label, vendored: a, full: b });
};

const weapons = [113, 114, 115, 116, 117, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 560, 562, 563];
for (const t of weapons) {
  const item = { group: 'Weapons', templateIndex: t, material: 1, maxCondition: 1000, currentCondition: 1000 };
  same(`weapon range ${t}`, (x) => [x['characters/weapons.js'].weaponMinDamage(t), x['characters/weapons.js'].weaponMaxDamage(t)], (x) => [x['characters/weapons.js'].weaponMinDamage(t), x['characters/weapons.js'].weaponMaxDamage(t)]);
  same(`hands ${t}`, (x) => x['characters/equipTable.js'].getItemHands(item), (x) => x['characters/equipTable.js'].getItemHands(item));
  same(`weapon type ${t}`, (x) => x['combat/fpsWeapon.js'].weaponTypeForItem(item), (x) => x['combat/fpsWeapon.js'].weaponTypeForItem(item));
  same(`technique family ${t}`, (x) => x['combat/technique/techniqueRoster.js'].techniqueFamily(item), (x) => x['combat/technique/techniqueRoster.js'].techniqueFamily(item));
  same(`enchanted ${t}`, (x) => x['systems/inventory.js'].isEnchanted(item), (x) => x['systems/inventory.js'].isEnchanted(item));
  same(`skill ${t}`, (x) => x['characters/weapons.js'].weaponSkillUsed(t), (x) => x['characters/weapons.js'].weaponSkillUsed(t));
}
for (const s of [0, 25, 50, 66, 80, 99, 100, 115, 125, 150, 175, 200]) {
  same(`pcaao damage modifier ${s}`, (x) => x['combat/pcaao.js'].pcaaoDamageModifier(s), (x) => x['combat/pcaao.js'].pcaaoDamageModifier(s));
  same(`classic damage modifier ${s}`, (x) => x['combat/formulas.js'].damageModifier(s), (x) => x['combat/formulas.js'].damageModifier(s));
  same(`effective skill ${s}`, (x) => x['systems/skillSoftcap.js'].effectiveSkill(s), (x) => x['systems/skillSoftcap.js'].effectiveSkill(s));
}

// The card over seeded characters: hit chance, damage range and critical model.
for (let i = 0; i < 300; i++) {
  const r = mulberry32(0x9e3779b9 + i * 7919);
  const stat = () => 10 + Math.floor(r() * 110);
  const stats = { strength: stat(), intelligence: 50, willpower: stat(), agility: stat(), endurance: stat(), personality: 50, speed: stat(), luck: stat() };
  const skills = Array.from({ length: 35 }, () => Math.floor(r() * 101));
  const t = [null, 113, 116, 120, 121, 122, 123, 124, 127, 129, 130][Math.floor(r() * 11)];
  const item = t ? { group: 'Weapons', templateIndex: t, material: Math.floor(r() * 10), maxCondition: 1000, currentCondition: 1000 } : null;
  const ent = {
    isPlayer: true, level: 1 + Math.floor(r() * 60), raceId: 1 + Math.floor(r() * 8), stats, skills,
    career: { weaponArmorShieldsBitfield: (r() < 0.5 ? 0x3f : 0) << 16, abilityFlagsAndSpellPointsBitfield: 0 },
    health: 100, maxHealth: 100, activeEffects: [], _mods: { stats: {}, skills: {} }, _enchantMods: { skillMods: {} },
  };
  const modules = { enabled: true, armorHitFormulaRedone: true, criticalStrikesIncreaseDamage: true, conditionBasedEffectiveness: true, softMaterialRequirements: true, equipmentDamageEnhanced: false, fixedStrengthDamageModifier: true };
  for (const core of ['overhaul', 'classic']) {
    for (const swing of ['StrikeLeft', 'StrikeDown']) {
      same(`card ${i} ${core} ${swing} t${t}`, (x) => {
        const s = x['combat/combatStats.js'].computeCombatStats(ent, { core, weapon: item, modules });
        const sw = s.swings.find((y) => y.key === swing) ?? s.head;
        return { crit: s.crit, hit: sw.byFoe.map((f) => f.hit), dmg: sw.byFoe.map((f) => [f.dmg.min, f.dmg.max, f.dmg.avg, f.dmg.critAvg]), per: sw.byFoe.map((f) => f.perSwing) };
      }, (x) => {
        const s = x['combat/combatStats.js'].computeCombatStats(ent, { core, weapon: item, modules });
        const sw = s.swings.find((y) => y.key === swing) ?? s.head;
        return { crit: s.crit, hit: sw.byFoe.map((f) => f.hit), dmg: sw.byFoe.map((f) => [f.dmg.min, f.dmg.max, f.dmg.avg, f.dmg.critAvg]), per: sw.byFoe.map((f) => f.perSwing) };
      });
    }
  }
}

// The real hit path: 40 seeded characters x 300 blows against the Warden's body.
for (let i = 0; i < 40; i++) {
  const r = mulberry32(0x1234 + i * 104729);
  const stats = { strength: 50 + Math.floor(r() * 60), intelligence: 50, willpower: 50, agility: 50 + Math.floor(r() * 60), endurance: 50, personality: 50, speed: 50 + Math.floor(r() * 60), luck: Math.floor(r() * 100) };
  const ent = {
    isPlayer: true, level: 30, raceId: 4, stats, skills: Array.from({ length: 35 }, () => 50 + Math.floor(r() * 60)),
    career: { weaponArmorShieldsBitfield: 0x3f << 16, abilityFlagsAndSpellPointsBitfield: 0 }, health: 100, maxHealth: 100,
    activeEffects: [], _mods: { stats: {}, skills: {} }, _enchantMods: { skillMods: {} },
  };
  const item = { group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1000, currentCondition: 1000 };
  const foe = (x) => {
    const e = x['characters/enemy/enemyEntity.js'].makeEnemyEntity(31, x['characters/enemy/enemyBasics.js'].ENEMY_BASICS[31], null, 1, () => 0.5);
    e.minMetalToHit = 0;
    e.armor = 60;
    e.armorValues = new Array(7).fill(60);
    e.spareGear = true;
    return e;
  };
  const modules = { enabled: true, armorHitFormulaRedone: true, criticalStrikesIncreaseDamage: true, conditionBasedEffectiveness: true, softMaterialRequirements: true, equipmentDamageEnhanced: false };
  same(`real hit ${i}`, (x) => {
    const target = foe(x);
    const rng = mulberry32(5000 + i);
    return Array.from({ length: 300 }, () => x['combat/pcaao.js'].pcaaoAttackDamage(ent, target, { weapon: { ...item }, rolls: rng, modules }));
  }, (x) => {
    const target = foe(x);
    const rng = mulberry32(5000 + i);
    return Array.from({ length: 300 }, () => x['combat/pcaao.js'].pcaaoAttackDamage(ent, target, { weapon: { ...item }, rolls: rng, modules }));
  });
  same(`boss traits ${i}`, (x) => x['systems/bossTraits.js'].relayBossTraits('Valkynaz Ruhn', 31), (x) => x['systems/bossTraits.js'].relayBossTraits('Valkynaz Ruhn', 31));
}

// Trait resistance and the power-ceiling rooms.
for (const traits of [[], ['bladeturning'], ['stoneskin'], ['spellproof'], ['thorned'], ['curbing', 'warded']]) {
  for (const kind of ['melee', 'arrow', 'spell']) {
    same(`bossStrike ${traits} ${kind}`, (x) => x['systems/bossTraits.js'].bossStrike({ bossTraits: traits, maxHealth: 1000, health: 1000 }, 137, { kind, weapon: { templateIndex: 121 }, element: 4 }), (x) => x['systems/bossTraits.js'].bossStrike({ bossTraits: traits, maxHealth: 1000, health: 1000 }, 137, { kind, weapon: { templateIndex: 121 }, element: 4 }));
  }
}
same('blow rooms', (x) => {
  const was = x['systems/powerCeiling.js'].openBlowCeiling();
  const out = [x['systems/powerCeiling.js'].blowRoom(300, 'loot'), x['systems/powerCeiling.js'].blowRoom(50, 'firmament'), x['systems/powerCeiling.js'].blowRoom(80, 'mastery'), x['systems/powerCeiling.js'].blowRoom(50, 'martial')];
  x['systems/powerCeiling.js'].closeBlowCeiling(was);
  return out;
}, (x) => {
  const was = x['systems/powerCeiling.js'].openBlowCeiling();
  const out = [x['systems/powerCeiling.js'].blowRoom(300, 'loot'), x['systems/powerCeiling.js'].blowRoom(50, 'firmament'), x['systems/powerCeiling.js'].blowRoom(80, 'mastery'), x['systems/powerCeiling.js'].blowRoom(50, 'martial')];
  x['systems/powerCeiling.js'].closeBlowCeiling(was);
  return out;
});
same('bow laws', (x) => [x['combat/bowBloom.js'].BOW_BLOOM, x['combat/bowBloom.js'].BOW_FAST, x['combat/bowBloom.js'].BOW_KINDS, [0, 1, 2, 3, 4].map((f) => x['combat/bowBloom.js'].bowFastDamage({ fast: f, pull: 1.5 }, 37))], (x) => [x['combat/bowBloom.js'].BOW_BLOOM, x['combat/bowBloom.js'].BOW_FAST, x['combat/bowBloom.js'].BOW_KINDS, [0, 1, 2, 3, 4].map((f) => x['combat/bowBloom.js'].bowFastDamage({ fast: f, pull: 1.5 }, 37))]);
same('hands law', (x) => [0, 50, 80, 100].map((a) => x['combat/twoHands/handsLaw.js'].offHandToHit(a)).concat([x['combat/twoHands/handsLaw.js'].offHandDamage(37), x['combat/twoHands/handsLaw.js'].DUAL]), (x) => [0, 50, 80, 100].map((a) => x['combat/twoHands/handsLaw.js'].offHandToHit(a)).concat([x['combat/twoHands/handsLaw.js'].offHandDamage(37), x['combat/twoHands/handsLaw.js'].DUAL]));
for (const sp of [0, 25, 50, 75, 100]) {
  for (const handling of [0.9, 1, 1.06, 1.113]) {
    same(`swing ${sp} ${handling}`, (x) => x['characters/weaponStates.js'].swingFrameSeconds(sp, { heft: 1.2, handling }), (x) => x['characters/weaponStates.js'].swingFrameSeconds(sp, { heft: 1.2, handling }));
  }
}
same('enemy basics', (x) => x['characters/enemy/enemyBasics.js'].ENEMY_BASICS[31], (x) => x['characters/enemy/enemyBasics.js'].ENEMY_BASICS[31]);
same('enemy groups', (x) => [0, 1, 15, 22, 31, 36, 38].map((c) => x['combat/enemyGroups.js'].enemyEntityGroup(c)), (x) => [0, 1, 15, 22, 31, 36, 38].map((c) => x['combat/enemyGroups.js'].enemyEntityGroup(c)));

// Enemy equipment construction (combat/enemyEquipment.js): the variant roll, the
// loadout, the armour-value pass and the minted pieces, on the same seeded stream.
for (const careerIndex of [1, 7, 8, 12, 21, 24, 31]) {
  for (const isClass of [false, true]) {
    same(`equipment variant ${careerIndex} ${isClass}`, (x) => {
      const r = mulberry32(0x51 + careerIndex + (isClass ? 1 : 0));
      return Array.from({ length: 40 }, () => x['combat/enemyEquipment.js'].equipmentVariantFor(careerIndex, isClass, r));
    }, (x) => {
      const r = mulberry32(0x51 + careerIndex + (isClass ? 1 : 0));
      return Array.from({ length: 40 }, () => x['combat/enemyEquipment.js'].equipmentVariantFor(careerIndex, isClass, r));
    });
    for (const level of [1, 10, 30, 45, 60]) {
      same(`enemy equipment ${careerIndex} ${isClass} L${level}`, (x) => {
        const r = mulberry32(0x91 + careerIndex * 31 + level * 7 + (isClass ? 1 : 0));
        const e = { careerIndex, isClass, mobileType: 0, armor: 0 };
        const eq = x['combat/enemyEquipment.js'].assignEnemyStartingEquipment(e, isClass ? 0 : 1, level, { rolls: r });
        return {
          armorValues: eq.armorValues,
          rightHand: eq.rightHand && [eq.rightHand.templateIndex, eq.rightHand.material, eq.rightHand.currentCondition, eq.rightHand.maxCondition],
          pieces: eq.armorPieces.map((a) => [a.piece, a.material, a.shield ?? false]),
        };
      }, (x) => {
        const r = mulberry32(0x91 + careerIndex * 31 + level * 7 + (isClass ? 1 : 0));
        const e = { careerIndex, isClass, mobileType: 0, armor: 0 };
        const eq = x['combat/enemyEquipment.js'].assignEnemyStartingEquipment(e, isClass ? 0 : 1, level, { rolls: r });
        return {
          armorValues: eq.armorValues,
          rightHand: eq.rightHand && [eq.rightHand.templateIndex, eq.rightHand.material, eq.rightHand.currentCondition, eq.rightHand.maxCondition],
          pieces: eq.armorPieces.map((a) => [a.piece, a.material, a.shield ?? false]),
        };
      });
    }
  }
}
for (const [templateIndex, material] of [[102, 0x0000], [102, 0x0200], [102, 0x0209], [107, 0x0203], [109, 0x0000], [112, 0x0209]]) {
  same(`armor mint ${templateIndex} ${material}`, (x) => {
    const it = x['combat/enemyEquipment.js'].armorOfMaterial(templateIndex, material);
    return [x['systems/armorMaterials.js'].itemArmorValue(it), it.maxCondition, it.currentCondition, it.value, it.name];
  }, (x) => {
    const it = x['combat/enemyEquipment.js'].armorOfMaterial(templateIndex, material);
    return [x['systems/armorMaterials.js'].itemArmorValue(it), it.maxCondition, it.currentCondition, it.value, it.name];
  });
}

// The relay's allowance: drive joinFight/applyHit with seeded claims at several levels.
for (const level of [1, 30, 45, 60]) {
  const run = (x) => {
    const G = x['net/gate/gateBrain.js'];
    const f = G.newFight(1, 0, 1e12, 'ruhn');
    G.joinFight(f, 'me', 'Me', level, 0, true);
    const r = mulberry32(level * 7919);
    const out = [];
    let ms = 0;
    for (let i = 0; i < 400; i++) {
      ms += 40 + Math.floor(r() * 400);
      out.push(G.applyHit(f, 'me', 50 + Math.floor(r() * 1500), G.HIT_KINDS.Melee, { x: 3, z: 0 }, ms));
    }
    return [out, f.hp, f.players.me.bucket, f.players.me.rate];
  };
  same(`relay allowance L${level}`, run, run);
}

// Stage 2.8: the body a foe is minted from (characters/enemy/enemyEntity.js makeEnemyEntity), the
// Enemy Expansion / MUDEX row (systems/enemyExpansion/dexInstall.js dexClassicRow) and the relay
// bodies' constructor (world/gate/gateBoss.js bossStandIn) - first as the modules stand, then after
// the boot the client runs at every load (scenes/shared.js:1518 installEnemyExpansion). The boot
// edits the shared table in place, so it runs last.
const CLASSIC = [...Array.from({ length: 43 }, (_, i) => i), ...Array.from({ length: 19 }, (_, i) => 128 + i)];
const bodyOf = (e) => ({
  level: e.level, skills: e.skills, armor: e.armor, armorValues: e.armorValues, minMetalToHit: e.minMetalToHit,
  affinity: e.affinity, careerIndex: e.careerIndex, isClass: e.isClass, mobileType: e.mobileType, maxHealth: e.maxHealth,
  basics: e.basics,
});
const CLASS_CAREER = { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, hitPointsPerLevel: 8 };
const mint = (x, m, level = 30) => bodyOf(x['characters/enemy/enemyEntity.js'].makeEnemyEntity(
  m, x['characters/enemy/enemyBasics.js'].ENEMY_BASICS[m], m >= 128 ? CLASS_CAREER : null, level, () => 0.5,
));
for (const m of CLASSIC) {
  same(`mint ${m}`, (x) => mint(x, m), (x) => mint(x, m));
  for (const mudex of [false, true]) {
    const row = (x) => x['systems/enemyExpansion/dexInstall.js'].dexClassicRow(m, x['characters/enemy/enemyBasics.js'].VANILLA_ENEMY_BASICS[m], { mudex });
    same(`enemy expansion row ${m} mudex ${mudex}`, row, row);
  }
}
const standIn = (m) => (x) => bodyOf(x['world/gate/gateBoss.js'].bossStandIn({ mobile: m }, 'stand-in'));
for (const m of [31, 36]) same(`boss stand-in ${m}`, standIn(m), standIn(m));
same('boss armour', (x) => [x['world/gate/gateBoss.js'].BOSS_ARMOR, x['world/gate/gateBoss.js'].STAND_IN_WHOLE], (x) => [x['world/gate/gateBoss.js'].BOSS_ARMOR, x['world/gate/gateBoss.js'].STAND_IN_WHOLE]);
// Stage 2.9: a held martial path acts (awakeMartialId -> sigilDueling), and its fold lands in _mods before liveStat clamps.
for (const [path, stat] of [['shadowdancer', 'agility'], ['windrunner', 'speed'], [null, 'agility']]) {
  for (const base of [40, 90, 95, 100]) {
    const held = (x) => {
      const e = { isPlayer: true, level: 30, stats: { strength: 50, intelligence: 50, willpower: 50, agility: 50, endurance: 50, personality: 50, speed: 50, luck: 50, [stat]: base }, skills: [], activeEffects: [], _mods: { stats: {}, skills: {}, statMax: {} } };
      if (path) { e.martialPath = path; e.masterSkills = true; e.masteredSkills = [...x['systems/martialPaths.js'].MARTIAL_BY_ID[path].skills]; }
      const mods = x['systems/entityMods.js'].computeEntityMods(e);
      return [x['systems/sigil/sigil.js'].sigilDueling(), x['systems/martialPaths.js'].martialHeld(e)?.id ?? null, mods.stats, x['systems/statMods.js'].liveStat(e, stat)];
    };
    same(`held path ${path} ${stat} ${base}`, held, held);
  }
}
// Stage 2.9: a Potent Vs row is a real registry key, and its payload adds five to a matching foe's blow.
for (const [param, mobile] of [[1, 31], [0, 31], [2, 128], [1, 36]]) {
  const strikes = (x) => {
    const E = x['systems/enchantments.js'];
    const item = { group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1000, currentCondition: 1000, enchantments: [{ type: E.ENCHANTMENT_TYPES.PotentVs, param }] };
    const target = { isPlayer: false, mobileType: mobile, careerIndex: mobile, spareGear: true };
    return [E.ENCHANTMENT_TYPES.PotentVs, E.ENCHANTMENT_TYPES.LowDamageVs, E.isEnchantedItem(item), E.doItemEnchantmentPayloads(E.PAYLOAD.Strikes, item, { entity: { isPlayer: true }, target, damage: 20, nowMinutes: 0 })];
  };
  same(`Potent Vs payload param ${param} vs ${mobile}`, strikes, strikes);
}
// Stage 2.11a: a worn piece's power is read (wornPowers -> setsDueling false) and lootBlow adds it to the blow.
for (const [rarity, field, id] of [['rare', 'imprint', 'tsaesci-fang'], ['legendary', 'legendary', 'anseis-edge'], ['rare', 'imprint', 'nightwhisper']]) {
  const worn = (x) => {
    const L = x['systems/loot/lootPowers.js'];
    const e = { isPlayer: true, level: 30, stats: {}, skills: [], equip: { slots: [] } };
    const w = { group: 'Weapons', templateIndex: 121, material: 9, maxCondition: 1000, currentCondition: 1000, rarity, [field]: id };
    x['systems/equip.js'].equipTableOf(e)[19] = w;
    const t = { isPlayer: false, mobileType: 31, careerIndex: 31, affinity: 'Daedra', health: 40, maxHealth: 100 };
    return [x['systems/sigil/sigilSets.js'].setsDueling(), L.wornPowers(e).map((p) => p.id), L.lootBlow(w, 100, e, t, { estimate: true, unaware: true })];
  };
  same(`worn power ${id}`, worn, worn);
}
const boot = (x) => {
  const r = x['systems/enemyExpansion/dexInstall.js'].installEnemyExpansion({ log: () => {} });
  const s = x['systems/enemyExpansion/dexSwitches.js'];
  return [r.loaded, r.mudex, r.enemies, s.dexLoaded(), s.mudexLoaded()];
};
same('the boot (Enemy Expansion with MUDEX)', boot, boot);
for (const m of CLASSIC) same(`booted mint ${m}`, (x) => mint(x, m), (x) => mint(x, m));
for (const m of [31, 36]) same(`booted boss stand-in ${m}`, standIn(m), standIn(m));
for (const m of [128, 140, 146]) {
  for (let seed = 1; seed <= 5; seed++) {
    const loadout = (x) => {
      const e = x['characters/enemy/enemyEntity.js'].makeEnemyEntity(m, x['characters/enemy/enemyBasics.js'].ENEMY_BASICS[m], CLASS_CAREER, 45, () => 0.5);
      const r = mulberry32(0x51 + seed);
      const v = x['combat/enemyEquipment.js'].equipmentVariantFor(e.careerIndex, e.isClass, r);
      if (v == null) return null;
      const q = x['combat/enemyEquipment.js'].assignEnemyStartingEquipment(e, v, 45, { rolls: r });
      return [q.armorValues, q.armorPieces.map((a) => [a.piece, a.material, a.shield ?? false])];
    };
    same(`booted class loadout ${m} s${seed}`, loadout, loadout);
  }
}

console.log(`vendor parity against ${U}`);
console.log(`pin: ${COMMIT}`);
console.log(`checks: ${checks}, identical: ${checks - diverged.length}, diverged: ${diverged.length}`);
for (const d of diverged.slice(0, 20)) {
  console.log(`\n✗ ${d.label}\n  vendored: ${d.vendored.slice(0, 400)}\n  full:     ${d.full.slice(0, 400)}`);
}
if (diverged.length) {
  console.log('\nA divergence means a stubbed edge is on a measured path: vendor that module or explain it in docs/SOURCES.md.');
  process.exitCode = 1;
}
