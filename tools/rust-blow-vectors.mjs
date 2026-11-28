import * as M from '../src/model.js';
import * as H from '../src/dualWield.js';
import * as D from '../src/durability.js';
import { SKILLS, MARTIAL_PATHS, WEAPONS } from '../src/data.js';
import { theoryCharacter } from '../src/theory.js';
import { armourPiece, enemyTarget, equipArmour, makeTarget, standInTarget } from '../src/target.js';
import { character, simCharacter, weapon } from '../test/harness/fixtures.mjs';
import { LEGENDARY_POWERS, allLegendaries } from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { bowFastDamage } from '../vendor/upstream/a3eb1605/src/combat/bowBloom.js';
import { mobileAffinityMatches } from '../vendor/upstream/a3eb1605/src/systems/enchantments.js';
import { EQUIP_SLOTS } from '../vendor/upstream/a3eb1605/src/characters/paperdoll/paperdoll.js';
import { ELEMENT_TRAITS } from '../vendor/upstream/a3eb1605/src/systems/bossTraits.js';
import { HAND_WRAPS_TEMPLATE } from '../vendor/upstream/a3eb1605/src/characters/handWrapsIds.js';
import { resistBlow } from '../src/bossTraits.js';
import { encodeValue as V } from './rust-codec.mjs';
import { sweep } from './rust-sweep.mjs';
import { outcomeVectors } from './rust-outcome-vectors.mjs';

const bits = new DataView(new ArrayBuffer(8));
function around(x) {
  if (x === 0) return [-Number.MIN_VALUE, -0, 0, Number.MIN_VALUE];
  bits.setFloat64(0, x);
  const i = bits.getBigUint64(0);
  return [i - 1n, i, i + 1n].map(n => { bits.setBigUint64(0, n); return bits.getFloat64(0); }).sort((a, b) => a - b);
}

export function genBlowFamilies(Out, makeLcg) {
  const model = new Out('model_blow', 'def <id> <value>; kind <argument values or @id> => <value>');
  const dual = new Out('dual_wield', 'hands <args> => <strike, wear and schedule>');
  const dur = new Out('durability', 'wear <damage> <rolls consumed> <item> <target> => <wear and condition>');
  const R = makeLcg(0x704b);
  const def = new Map();
  const ref = (v) => {
    if (!def.has(v)) {
      const i = def.size;
      def.set(v, `@${i}`);
      model.add('def', String(i), V(v));
    }
    return def.get(v);
  };
  const put = (out, k, args, v) => out.add(k, ...args.map(V), '=>', V(v));
  const add = (k, args, v) => put(model, k, args, v);
  const tpls = Object.keys(WEAPONS).map(Number);
  const paths = [null, ...Object.keys(MARTIAL_PATHS)];
  const edges = [undefined, NaN, -0, 0, 1, 2.5, 3.5, 4.999999999999999, 5, 5.000000000000001, 5.5, 6, 15.999, 16, 40.999, 41, 60.999, 61, 75.999, 76, 91.999, 92, 98, 99, 100, 100.00000000000001, 101, 102, 200, 1000, -1, Infinity, -Infinity];
  const shares = [undefined, NaN, -0, 0.25, 0.49999999999999994, 0.5, 0.5000000000000001, 1];
  const powers = [...Object.values(LEGENDARY_POWERS), ...allLegendaries().map(l => l.power).filter(Boolean)];
  const targets = [null, makeTarget(), makeTarget({ isPlayer: true })];
  // The shipped 39..42 records have no mintable body level.
  for (const id of [...Array.from({length: 39}, (_, i) => i), 128, 139, 146]) {
    const t = enemyTarget(id, { playerLevel: 20, level: 20, exactLevel: true, rolls: () => 0.5 });
    targets.push(t, { ...t, warded: true, relayBody: true });
  }
  targets.push(standInTarget(31), standInTarget(36));
  for (const material of [0, 256, 512, 520]) {
    const t = makeTarget({ isClass: true, stats: { strength: 90, endurance: 95, agility: 75, willpower: 76, speed: 80, luck: 65 }, skills: {[SKILLS.Dodging]: 60} });
    targets.push(equipArmour(t, [armourPiece(102, material), armourPiece(109, 512)]));
  }
  const tiers = outcomeVectors(Out);
  sweep(() => {
  for (let i = 0; i < 256; i++) {
    const blade = tpls[i % tpls.length];
    const raw = [99, 100, 101, 102, 110, 200, 1000, NaN][(i >> 1) % 8];
    const stat = [0, 15, 25, 49, 50, 65, 97, 100][(i >> 2) % 8];
    const path = paths[i % paths.length];
    const ch = i % 3 ? theoryCharacter({ blade, race: i % 8 + 1, level: i % 46, martialPath: path, rawBlade: raw, rawCrit: raw, gearLB: i % 4 ? i % 75 : 800, starStats: { strength: 5, agility: 10, speed: 15 }, sockets: i % 2 ? ['perfect-ruby'] : [], vampire: i % 2 !== 0 }) : simCharacter(character({ raceId: i % 8 + 1, level: i % 45, skills: raw, martialPath: path, online: !!(i % 2), stats: { strength: stat, speed: stat, agility: stat, luck: stat }, career: { abilityFlagsAndSpellPointsBitfield: 4, weaponArmorShieldsBitfield: (i % 64) << 16, attackModifierFlags: i % 2048 } }));
    ch.health = i % 18;
    ch.maxHealth = 96;
    ch.attackModifierFlags = [undefined, 1, 2, 5, 10, 21, 42, 85, 170, 341, 682][i % 11];
    ch.stats = { ...ch.stats, ...Object.fromEntries(['strength', 'endurance', 'luck', 'agility', 'speed', 'willpower'].map((k, j) => [k, (i * (j * 2 + 1) + j * 13) % 113])) };
    ch.career = { ...ch.career, weaponArmorShieldsBitfield: (i % 64) << 16, abilityFlagsAndSpellPointsBitfield: i % 5 };
    if (i % 3) for (const id of [SKILLS.Archery, SKILLS.Axe, SKILLS.ShortBlade, SKILLS.BluntWeapon, SKILLS.HandToHand]) { ch.skills[id] = raw; ch.masteredSkills.push(id); }
    const it = { ...(ch.weapon ?? weapon(blade)), templateIndex: blade, currentCondition: edges[i % edges.length], material: i % 12 - 1, rarity: 'rare', imprint: Object.keys(LEGENDARY_POWERS)[i % Object.keys(LEGENDARY_POWERS).length], enchantments: [{type: 4, param: i % 4}, {type: [18, 19, 99, 20, -1, '20'][i % 6], param: i % 4}, {type: 20, param: (i >> 2) % 4}], affixes: [{ id: 'damage', value: 15 }, {id: 'slayer', param: 'animal', value: 10}, {id: 'elemental', param: 'fire', value: 5}], sockets: i % 2 ? ['perfect-ruby', 'perfect-ruby'] : [], __bonusDamage: i % 4 - 1 };
    const w = M.weaponOf(it, {rri: i % 2 !== 0});
    tiers.build(i, ch, it, targets);
    const cRef = ref(ch), iRef = ref(it);
    for (let j = 0; j < 8; j++) {
      const z = i * 8 + j;
      const t = targets[(i + 7 * j) % targets.length];
      const wr = j === 0 ? null : j === 1 ? M.syntheticWeapon(tpls[(i + 3) % tpls.length]) : w;
      const wRef = ref(wr), tRef = ref(t);
      const core = ['classic', 'overhaul', 'overhaul', 'struck'][j % 4];
      const swing = [...M.SWING_DIRECTIONS, 'unknown'][z % 7];
      const opts = { passiveOn: j !== 5, critDamage: j !== 6, damagePct: z % 13 - 3, rri: !!(j & 1), pair: !!(j & 2), offHand: !!(j & 4), healthShare: shares[(i + j) % 8], attackerHealthShare: shares[(i + 3 * j) % 8], backstabBonus: z % 31 - 4, firstBlow: !!(i & 4), rhythm: !!(i & 8), cyclone: !!(j & 1), rally: !!(i & 2), unaware: !!(j & 2), night: !!(i & 16), stacks: edges[z % edges.length], flowStacks: edges[(z + 3) % edges.length], attackSpeedPct: edges[(z + 9) % edges.length], firmamentDamagePct: (z % 31) - 15, matReqMulti: [0, 0.33, 0.5, 1, NaN, -0, 0.875, 1.5][(i + j) % 8], equipmentDamageEnhanced: i % 2 === 0, fixedStrengthDamageModifier: j !== 3, carried: j === 7, carryBases: j % 3 === 0, bowSpam: !!(i & 8), bowDrawback: !!(j & 1), potentVs: (z % 3 - 1) * 5, traits: j % 3 ? ['stoneskin', 'bladeturning'] : [], echoes: [[0], [100], [10, 20], [], [100, 33], [50], [NaN], [40, 45, 50]][j], cap: [0, 1, 5.5, 50][i % 4], loot: {pct: z % 11 - 3, flat: z % 9 - 2}, wraps: j === 0 ? M.syntheticWeapon(561) : null };
      if (j === 0) opts.wraps = M.weaponOf({...M.syntheticWeapon(HAND_WRAPS_TEMPLATE).item,
        rarity:'rare', affixes:[{id:'damage',value:15}], sockets:['ruby']});
      const list = [powers[z % powers.length], powers[(z + 2) % powers.length], {kind: 'echo', chance: edges[z % edges.length]}];
      opts.imprints = [list[0], ...(wr?.powers ?? []), {foo: undefined}, {}];
      opts.imprintsExtra = list;
      const op = ref(opts);
      const emit = (k, args, got) => model.add(k, ...args, '=>', V(got));
      const variant = { ...it, minDamage: edges[(z + 1) % edges.length], maxDamage: edges[(z + 2) % edges.length], name: j % 3 ? it.name : '', ...(j === 4 ? {templateIndex: -1} : {}) };
      add('weapon', [j === 7 ? null : variant, !!(j & 1)], M.weaponOf(j === 7 ? null : variant, {rri: !!(j & 1)}));
      const mt = t ?? makeTarget();
      const name = ['agility', 'speed', 'luck', 'strength'][z % 4];
      const id = [SKILLS.Dodging, SKILLS.ShortBlade, SKILLS.LongBlade, SKILLS.CriticalStrike][i % 4];
      emit('scalar', [cRef, wRef, tRef, op, V(name), V(id), V(core), V(i % 2 === 0)], [M.combatStat(ch, name, opts), M.skill(ch, id, opts), M.racialModifiers(ch, wr, core, opts), M.martialPace(ch, opts), M.masteryPace(ch, wr, opts), M.martialBlowPct(ch, t, opts), M.masteryPct(ch, wr, t, opts), M.isBlade(wr), M.isBlunt(wr), wr && M.weaponToHit(wr), M.weaponResistFactor(wr, opts.traits), M.conditionMultiplier(wr, i % 2 === 0), M.SWING_DIRECTIONS]);
      emit('cadence', [cRef, wRef, op], [M.cadence(ch, wr, opts), M.rangedCadence(ch, wr, opts)]);
      emit('hit', [cRef, wRef, ref(mt), op, V(swing), V(core)], M.hitModel(ch, wr, mt, swing, core, opts));
      emit('damage', [cRef, wRef, tRef, op, V(swing), V(core)], M.damageModel(ch, wr, t, swing, core, opts));
      const damages = [1, 2, 3, 5.5, -0, -2, NaN, 13, 19].map((_, k, a) => a[(k + j) % a.length]);
      const state = M.createCarryState();
      const inputs = [wr, wr ? {...wr, item: {...wr.item}} : null];
      const seq = damages.map((d, k) => M.weaponBlow(ch, inputs[k % 2], d, t, {...opts, carryState: state}));
      emit('live', [cRef, wRef, tRef, op, V(damages)], seq);
      emit('loot', [cRef, wRef, tRef, op, V(list)], [M.lootPowerTerms(list, t, opts), M.weaponPowers(wr, opts), M.echoChances(list)]);
      const part = z % 7, d = damages[0];
      const ctx = {...opts, target: t, weapon: wr, bow: M.bowOf(wr, opts), relay: !!t?.relayBody, warded: t?.warded === true, strikeKind: wr?.ranged ? 'arrow' : 'melee'};
      emit('outcomes', [cRef, wRef, tRef, op, V(damages), V(part)], [M.resolveBlow(d, part, ctx), M.afterShare(d, 0.25, ctx), M.blowDistribution(damages, part, ctx)]);
      const lo = j % 4 + 0.1, hi = lo + (i % 14) / 4, cap = [NaN, 0, lo - 0.1, lo, lo + 0.1, hi - 0.2, hi, hi + 1][j];
      const rawBow = { fast: edges[z % edges.length], pull: edges[(z + 1) % edges.length] };
      const f = {core, critMult: edges[(z + 1) % edges.length], matReq: opts.matReqMulti, conditionMult: edges[(z + 5) % edges.length], hasWeapon: !!wr, carried: opts.carried};
      const chance = [1, 1.0000000000000002, 20, 20.5, 100, 0, NaN, 50][j];
      const roll = [0, 0.009999999999999998, 0.01, 0.019999999999999997, 0.02, 0.2, 0.5, R.unit()][i % 8];
      const material = edges[z % edges.length];
      emit('misc', [iRef, wRef, tRef, op, V([lo, hi, cap, d, f, chance, roll, rawBow, blade, material, j % 2 === 0, i % 4])], [M.expectedCapped(lo, hi, cap), M.finishBlow(d, f, !!wr), M.backstabDamage(d, chance, roll), M.bowOf(wr, opts), M.bowBlow(d, rawBow), bowFastDamage(rawBow, d), M.strikesNet(it, t), M.syntheticWeapon(blade, material, {rri: j % 2 === 0}), mobileAffinityMatches(t?.mobileType, i % 4)]);
      const burden = [1, 1.1, 1.25, 1.5, NaN, 0.5, 99, 1.2499999999][j];
      const tick = [0, 0.1, 0.2, 0.3, 0.4, 0.4000000000000001, -0.1, NaN][i % 8];
      const ticks = j - 1;
      const carry = edges[z % edges.length];
      const agility = i % 110 - 5 + (j - 4) * 0.000000001;
      const weight = edges[(z + 5) % edges.length];
      const mode = ['single', 'dual', 'fists', null][i % 4];
      const lead = ['R', 'L', 'foo', null][(i >> 2) % 4];
      const last = ['R', 'L', 'foo', null][(i >> 4) % 4];
      const sinceLast = [-1, 0, 0.7499999999999999, 0.75, 0.7500000000000001, Infinity, NaN, 1][j];
      const sch = H.dualSchedule({mainTick: tick, offTick: tick * 0.9, burden});
      put(dual, 'hands', [[burden, tick, ticks, carry, agility, weight, stat, mode, lead, last, sinceLast, d]], [H.offHandToHit(agility), H.offHandBurden(weight, stat), H.offHandDamage(d), H.averageOffHandHold({burden, ticks, tick}), H.offHandHold({burden, ticks, tick, carry}), H.strikeHandOf({mode, lead, last, sinceLast}), sch, H.swingsRatio(sch), H.damageRatio(sch, 5.5, d)]);
      const used = [];
      const hit = edges[z % edges.length];
      const wear = D.blowWear(hit, () => {const r = [0, 0.19999999999999998, 0.2, 0.20000000000000004, 1][i % 5]; used.push(r); return r; });
      put(dur, 'wear', [hit, used, it, !!t?.spareGear], [wear, D.cwsBill(t), D.conditionPct(it)]);
      const worn = {...it, maxCondition: [undefined, null, 0, 100, NaN, -1, 50, 100][j], currentCondition: [undefined, 4, 2, 10, 4, 2, 1, NaN][j]};
      if (i % 4 === 1) Object.assign(worn, {group:'Armor', templateIndex:102, material:[0, 256, 512, 515][i % 16 >> 2]});
      if (i % 4 === 2) Object.assign(worn, {group:'Weapons', templateIndex:131});
      if (i % 4 === 3) worn.templateIndex = 99999;
      const main = i % 5 !== 0, off = i % 3 !== 0, same = i % 7 === 0;
      const held = D.cloneItem(worn);
      const other = same ? held : D.cloneItem(worn);
      const owner = D.makeOwner(main ? held : null, off ? other : null);
      const amount = [0, 1, 2, 4, 5, 10, 99999, NaN][(i + j) % 8];
      const broke = D.wearItem(owner, held, amount);
      put(dur, 'break', [worn, main, off, same, amount], [broke, held, !!owner.equip.slots[EQUIP_SLOTS.RightHand], !!owner.equip.slots[EQUIP_SLOTS.LeftHand], !!owner.weapon, other]);
    }
  }
  });
  // Direct probes supplement the crossed cards: isolate the exact comparison from other terms.
  const scalar = (ch, w, t, opts, name, id, core, sharp) => {
    model.add('scalar', ref(ch), ref(w), ref(t), ref(opts), V(name), V(id), V(core), V(sharp), '=>', V([
      M.combatStat(ch, name, opts), M.skill(ch, id, opts), M.racialModifiers(ch, w, core, opts),
      M.martialPace(ch, opts), M.masteryPace(ch, w, opts), M.martialBlowPct(ch, t, opts), M.masteryPct(ch, w, t, opts),
      M.isBlade(w), M.isBlunt(w), w && M.weaponToHit(w), M.weaponResistFactor(w, opts.traits), M.conditionMultiplier(w, sharp), M.SWING_DIRECTIONS,
    ]));
  };
  const sw = [null, ...[113, 120, 124, 127, 129, 563].map(i => M.syntheticWeapon(i))];
  const neutral = makeTarget({isPlayer: true});
  for (const raw of [100, 104, 125, 150, 175, 200].flatMap(around)) {
    for (const bonus of [0.25, ...around(320 / 0.44)]) {
      for (const w of sw) {
        const skill = w?.skillId ?? SKILLS.HandToHand;
        const ch = {online:true, masteredSkills:[skill], skills:{[skill]:raw}, _mods:{skills:{[skill]:bonus}}, stats:{speed:95, agility:95}};
        for (const share of around(0.5)) scalar(ch, w, neutral, {healthShare:share, attackerHealthShare:share}, 'speed', skill, 'overhaul', true);
      }
    }
  }
  const traits = ['stoneskin', 'bladeturning'];
  for (const band of [5, 6, 16, 41, 61, 76, 92].flatMap(around)) {
    for (const base of [sw[1], sw[3]]) {
      for (const sharp of [false, true]) {
        scalar({stats:{}}, {...base,conditionPercent:band}, neutral, {traits}, 'agility', SKILLS.Dodging, 'overhaul', sharp);
        scalar({stats:{}}, {...base,conditionPercent:undefined, conditionPct:band / 100}, neutral, {traits}, 'agility', SKILLS.Dodging, 'overhaul', sharp);
      }
    }
  }
  const noWeapon = null;
  for (const core of ['classic', 'overhaul']) {
    const swings = ['StrikeLeft', 'StrikeRight', 'StrikeUp', 'StrikeDownRight', 'StrikeDownLeft', 'StrikeDown', 'empty'];
    for (const health of [...around(12), ...around(16)]) {
      const ch = {health, maxHealth:96, career:{abilityFlagsAndSpellPointsBitfield:4}, skills:{[SKILLS.CriticalStrike]:48}, stats:{luck:55}};
      for (const bonus of [...around(3), ...around(97)]) {
        const opt = {backstabBonus:bonus};
        for (const swing of swings) {
          const out = M.hitModel(ch, noWeapon, neutral, swing, core, opt);
          model.add('hit', ref(ch), ref(noWeapon), ref(neutral), ref(opt), V(swing), V(core), '=>', V(out));
        }
      }
    }
  }
  for (const d of [...around(0), ...around(1), ...around(2.5), ...around(3.5), NaN]) {
    for (const chance of [...around(1), ...around(20), ...around(100), NaN]) {
      for (const roll of [0, 0.01, ...around(0.2), 1, NaN]) {
        const t = targets[9];
        const w = sw[1];
        const item = w.item;
        const opt = {};
        const f = {critMult:1.5, matReq:0.5, conditionMult:0.65, hasWeapon:true};
        const bow = {pull:1.5, fast:4};
        const lo = 1.1, hi = 6.9, cap = d;
        const x = [lo, hi, cap, d, f, chance, roll, bow, undefined, undefined, false, 0];
        model.add('misc', ref(item), ref(w), ref(t), ref(opt), V(x), '=>', V([M.expectedCapped(lo, hi, cap),
          M.finishBlow(d, f, true), M.backstabDamage(d, chance, roll), M.bowOf(w, opt), M.bowBlow(d, bow), bowFastDamage(bow, d),
          M.strikesNet(item, t), M.syntheticWeapon(undefined), mobileAffinityMatches(t.mobileType, 0)]));
      }
    }
  }
  for (const carry of [...around(0), 1 - 1e-9, 1 - 5e-10, 1 - 1e-10, ...around(1)]) {
    const burden = 1, tick = 0.2, ticks = 4, stat = 50, agility = 55, weight = 3, d = 0.5;
    const mode = 'dual', lead = 'R', last = 'R', sinceLast = 0.75;
    const sch = H.dualSchedule({mainTick: tick, offTick: tick * 0.9, burden});
    put(dual, 'hands', [[burden, tick, ticks, carry, agility, weight, stat, mode, lead, last, sinceLast, d]],
      [H.offHandToHit(agility), H.offHandBurden(weight, stat), H.offHandDamage(d), H.averageOffHandHold({burden, ticks, tick}),
        H.offHandHold({burden, ticks, tick, carry}), H.strikeHandOf({mode, lead, last, sinceLast}), sch, H.swingsRatio(sch), H.damageRatio(sch, 5.5, d)]);
  }
  for (const damage of [0.5, 4.91, 4.95, 14.91, ...around(5)]) {
    for (const roll of around(0.2)) {
      const used = [];
      const wear = D.blowWear(damage, () => {used.push(roll); return roll;});
      put(dur, 'wear', [damage, used, null, false], [wear, D.cwsBill(null), D.conditionPct(null)]);
    }
  }
  const oddClothing = {group:'Clothing', templateIndex:102, material:515};
  const cloth = D.cloneItem(oddClothing);
  const clothOwner = D.makeOwner(cloth);
  const clothBroke = D.wearItem(clothOwner, cloth, 1);
  put(dur, 'break', [oddClothing, true, false, false, 1], [clothBroke, cloth, true, false, true, oddClothing]);
  const hit = (ch, w, t, opts, core) => model.add('hit', ref(ch), ref(w), ref(t), ref(opts), V('StrikeLeft'), V(core), '=>', V(M.hitModel(ch, w, t, 'StrikeLeft', core, opts)));
  for (const raceId of [undefined, 1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const stat of [0, 10, 16, 20, 22, 25, 33, 44, 50, 66, 75, 99, 100]) {
      const ch = {raceId, stats:Object.fromEntries(['strength','agility','speed','endurance','luck'].map(k => [k, stat])), level:13, career:{weaponArmorShieldsBitfield:63 << 16}};
      for (const w of sw) {
        scalar(ch, w, neutral, {traits}, 'luck', SKILLS.Dodging, 'overhaul', true);
        hit(ch, w, {skills:{}, stats:{}, career:{abilityFlagsAndSpellPointsBitfield:4}, maxHealth:96}, {}, 'overhaul');
      }
    }
  }
  for (const martialPath of paths) {
    for (const w of [null, sw[1], sw[2], sw[3]]) {
      for (const passiveOn of [undefined, false, true]) {
        const skill = w?.skillId ?? SKILLS.Dodging;
        const ch = {martialPath, online:false, masterSkills:true, masteredSkills:[skill], skills:{[skill]:104}, _mods:{skills:{[skill]:0.25}, stats:{speed:-150, agility:-150}}};
        const opts = {passiveOn, firstBlow:true, rhythm:true, rally:true, cyclone:true, unaware:true};
        for (const name of ['agility','speed']) scalar(ch, w, neutral, opts, name, SKILLS.Dodging, 'overhaul', false);
      }
    }
  }
  for (const w of [{skillId: -99}, null, sw[1]]) {
    for (const field of [undefined, 0, -2, 4.5]) {
      const ch = {level:15, career:{weaponArmorShieldsBitfield:1 << 16, abilityFlagsAndSpellPointsBitfield:4}, health:field, maxHealth:field, _enchantMods:{chanceToHitMod:field}};
      hit(ch, w, {health:-5, career:{abilityFlagsAndSpellPointsBitfield:4}}, {backstabBonus:field}, 'classic');
      hit(ch, w, {maxHealth:6, career:{abilityFlagsAndSpellPointsBitfield:5}}, {backstabBonus:field}, 'overhaul');
    }
  }
  for (const w of [{ranged:true}, {...M.syntheticWeapon(560), gun:true}, M.syntheticWeapon(562)]) {
    for (const speed of [0, 50, 98, 100, NaN]) {
      for (const opts of [{}, {bowSpam:true, attackSpeedPct:42}, {pair:true}]) {
        const ch = {stats:{speed}, _mods:{stats:{speed: speed === 98 ? NaN : 0}}};
        model.add('cadence', ref(ch), ref(w), ref(opts), '=>', V([M.cadence(ch, w, opts), M.rangedCadence(ch, w, opts)]));
      }
    }
  }
  for (const share of [undefined, NaN, ...around(0), ...around(0.5), ...around(1), ...around(1.5)]) {
    for (const below of [undefined, 0, 50, 100, 150]) {
      const list = [{kind:'flow',pct:7}, {kind:'moon',pct:2}, {kind:'venom'}, {kind:'unaware'}, {kind:'execute',pct:4,below}, {kind:'rage',pct:7,below}];
      for (const t of [targets[3], neutral]) {
        const opts = {healthShare:share, attackerHealthShare:share, night:true, unaware:true, imprints:[{n:2}, {n:1}, {n:0}, {n:NaN}, {n:null}, undefined]};
        const w = {powers:[{n:1}, {n:-0}, {n:Infinity}, {a:undefined}, {}]};
        model.add('loot', 'n', ref(w), ref(t), ref(opts), V(list), '=>', V([M.lootPowerTerms(list, t, opts), M.weaponPowers(w, opts), M.echoChances(list)]));
      }
    }
  }
  const live = (ch, w, opts, hits) => {
    const carryState = M.createCarryState();
    const copy = w && {...w, item:w.item && {...w.item}};
    model.add('live', ref(ch), ref(w), ref(neutral), ref(opts), V(hits), '=>', V(hits.map((d,i) => M.weaponBlow(ch, i%2 ? copy : w, d, neutral, {...opts,carryState}))));
  };
  for (const pct of [undefined, 0, 0.5, -0.5, 100*(1-5e-10), 100*(-1+5e-10)]) {
    for (const carried of [true, false]) {
      const ch = {online:true, _mods:{skills:{[SKILLS.ShortBlade]:0.5}}, martialPath:'blademaster'};
      const hits = [1, 5, 2, 1000, Infinity, 10, 0.5, -0, NaN];
      live(ch, null, {carried, firmamentDamagePct:pct}, hits);
      live(ch, {skillId:SKILLS.ShortBlade, elementalLines:[{param:'fire'}]}, {carried, stacks:1/6, loot:{pct}, firmamentDamagePct:pct}, hits);
      live(ch, {skillId:SKILLS.ShortBlade}, {carried, stacks:0, passiveOn:false, loot:{pct:0}, firmamentDamagePct:pct}, hits);
    }
  }
  for (const sign of [-1, 1]) {
    live({}, null, {firmamentDamagePct:sign * (10 - 5e-9)}, [10, 10, 10]);
  }
  for (const d of [NaN, -Infinity, Infinity, ...[0, 0.1, 0.5, 1, 2.5, 3.5, 7.5, 20].flatMap(around)]) {
    const f = {hasWeapon:true, conditionMult:0.75};
    const w = {ranged:true};
    const item = {enchantments:[{type:'0'}, {type:4,param:3}]};
    const t = targets[3];
    const opts = {potentVs:5};
    for (const pull of [0.5, 1]) {
      const bow = {fast:1, pull};
      model.add('misc', ref(item), ref(w), ref(t), ref(opts), V([0.1, 8, 0.1, d, f, 20, 0, bow, undefined, undefined, false, 3]), '=>',
        V([M.expectedCapped(0.1, 8, 0.1), M.finishBlow(d, f, true), M.backstabDamage(d, 20, 0), M.bowOf(w, opts), M.bowBlow(d, bow), bowFastDamage(bow, d), M.strikesNet(item,t), null, mobileAffinityMatches(t.mobileType,3)]));
    }
    for (const kind of ['melee','arrow','spell']) {
      for (const blade of [null, sw[1], sw[3], sw[6]]) {
        for (const ts of [[], ['stoneskin'], ['bladeturning'], [ELEMENT_TRAITS[0]], ['thorned'], ['stoneskin','bladeturning'], ['warded','stoneskin']]) {
          add('resist', [ts,d,kind,blade,0], resistBlow(ts,d,{kind,weapon:blade,element:0}));
        }
      }
    }
    const dst = makeTarget();
    const ds = [d];
    const ctx = {...opts, target:dst, weapon:null, strikeKind:'melee', bow:null, warded:false, relay:false};
    model.add('outcomes', 'n', 'n', ref(dst), ref(opts), V(ds), V(0), '=>', V([M.resolveBlow(d,0,ctx), M.afterShare(d,0.25,ctx),M.blowDistribution(ds,0,ctx)]));
  }
  for (const stacks of [undefined, NaN, ...around(5)]) {
    scalar({martialPath:'blademaster'}, null, neutral, {stacks}, 'strength', SKILLS.Dodging, 'overhaul', false);
  }
  // Shipped-build selection (`--game-build`, CHANGELOG-MECHANICS.md GEAR-14631 / BRAND-14631): the same cards under both
  // builds. The default IS `14631` (`src/model.js:119`), so an omitted option and an explicit `'14631'` are the same
  // card and `'14512'` is the cut; the pins below make that explicit rather than relying on the default. Appended last,
  // so the bytes of every case above are unchanged.
  const brand = { kind: 'brand', element: 'fire', flat: 8 };
  const brandPowers = [brand, { kind: 'venom', flat: 8 }, { kind: 'brand', flat: 8 }];
  const resists = [undefined, { career: {} }, { career: { resistanceFlags: 8 } }, { career: { immunityFlags: 8 } }, { career: { resistanceFlags: 8, immunityFlags: 8 } }, { isPlayer: true }];
  for (const gameBuild of ['14512', '14631', undefined]) {
    for (const t of resists) {
      // A live carry state: `brand`'s flat reads no carry, but the same cards through a carried scenario must match.
      for (const healthShare of [undefined, 0, 0.1, 0.49, 0.5, 1]) {
        const opts = { gameBuild, healthShare, unaware: true, night: true, firstBlow: true };
        model.add('loot', 'n', ref({}), ref(t), ref(opts), V(brandPowers), '=>', V([M.lootPowerTerms(brandPowers, t, opts), M.weaponPowers({}, opts), M.echoChances(brandPowers)]));
      }
    }
  }
  // The axe/blunt half line at the two ratios the 14631 law removed, with the build pinned when it matters.
  const STRUCK_TARGET = enemyTarget(5, { playerLevel: 20, level: 20, exactLevel: true, rolls: () => 0.5 });
  const gearCh = (skill, gear, extra = {}) => ({ online: true, skills: { [skill]: 104 }, _mods: { skills: { [skill]: gear } }, stats: { strength: 50, speed: 50, agility: 50 }, career: { abilityFlagsAndSpellPointsBitfield: 4 }, health: 96, maxHealth: 96, ...extra });
  for (const gameBuild of ['14512', '14631']) {
    for (const skill of [SKILLS.Axe, SKILLS.BluntWeapon]) {
      for (const share of [0.49999999999999994, 0.5, NaN, undefined]) {
        const ch = gearCh(skill, 100);
        const w = { ...M.syntheticWeapon(127, 1), skillId: skill, min: 100, max: 100 };
        const opts = { gameBuild, healthShare: share };
        model.add('scalar', ref(ch), ref(w), ref(STRUCK_TARGET), ref(opts), V('strength'), V(skill), V('overhaul'), V(true), '=>', V([
          M.combatStat(ch, 'strength', opts), M.skill(ch, skill, opts), M.racialModifiers(ch, w, 'overhaul', opts),
          M.martialPace(ch, opts), M.masteryPace(ch, w, opts), M.martialBlowPct(ch, STRUCK_TARGET, opts), M.masteryPct(ch, w, STRUCK_TARGET, opts),
          M.isBlade(w), M.isBlunt(w), M.weaponToHit(w), M.weaponResistFactor(w, opts.traits), M.conditionMultiplier(w, true), M.SWING_DIRECTIONS,
        ]));
      }
      // the gear add around 727.27 (the 14512 law's 320 / 0.44 cap boundary)
      for (const gear of [727.26, 727.27, 727.28]) {
        const ch = gearCh(skill, gear);
        const w = { ...M.syntheticWeapon(127, 1), skillId: skill, min: 100, max: 100 };
        const opts = { gameBuild };
        model.add('damage', ref(ch), ref(w), ref(STRUCK_TARGET), ref(opts), V('StrikeLeft'), V('overhaul'), '=>', V(M.damageModel(ch, w, STRUCK_TARGET, 'StrikeLeft', 'overhaul', opts)));
      }
    }
  }
  // The gear add and its guards, through the card and directly. `PLAIN`-like shapes: a real weapon skill, explicit gear.
  for (const gameBuild of ['14512', '14631', undefined]) {
    for (const skill of [SKILLS.LongBlade, SKILLS.Axe, SKILLS.BluntWeapon, SKILLS.Archery, SKILLS.ShortBlade, SKILLS.HandToHand]) {
      for (const gear of [0, 0.25, 1, 250, 700, 1000]) {
        for (const share of [undefined, 0.49, 0.9]) {
          const ch = gearCh(skill, gear);
          const w = { ...M.syntheticWeapon(skill === SKILLS.Archery ? 129 : 120, 1), skillId: skill, min: 100, max: 100 };
          const opts = { gameBuild, healthShare: share };
          model.add('scalar', ref(ch), ref(w), ref(STRUCK_TARGET), ref(opts), V('strength'), V(skill), V('overhaul'), V(true), '=>', V([
            M.combatStat(ch, 'strength', opts), M.skill(ch, skill, opts), M.racialModifiers(ch, w, 'overhaul', opts),
            M.martialPace(ch, opts), M.masteryPace(ch, w, opts), M.martialBlowPct(ch, STRUCK_TARGET, opts), M.masteryPct(ch, w, STRUCK_TARGET, opts),
            M.isBlade(w), M.isBlunt(w), M.weaponToHit(w), M.weaponResistFactor(w, opts.traits), M.conditionMultiplier(w, true), M.SWING_DIRECTIONS,
          ]));
          model.add('damage', ref(ch), ref(w), ref(STRUCK_TARGET), ref(opts), V('StrikeLeft'), V('overhaul'), '=>', V(M.damageModel(ch, w, STRUCK_TARGET, 'StrikeLeft', 'overhaul', opts)));
        }
      }
    }
  }
  const gearGuards = [
    ['offline', (ch) => ({ ...ch, online: false })],
    ['peer', (ch) => ({ ...ch, peer: true })],
    ['mentor', (ch) => ({ ...ch, _mentor: true })],
    ['beast', (ch) => ({ ...ch, isInBeastForm: true })],
    ['player target', (ch) => ch],
    ['warded target', (ch) => ch],
    ['bare fists', (ch) => ch],
  ];
  for (const gameBuild of ['14512', '14631']) {
    for (const [label, edit] of gearGuards) {
      const ch = edit(gearCh(SKILLS.LongBlade, 700));
      const w = label === 'bare fists' ? null : { ...M.syntheticWeapon(120, 1), skillId: 30, min: 100, max: 100 };
      const t = label === 'player target' ? { ...STRUCK_TARGET, isPlayer: true } : label === 'warded target' ? { ...STRUCK_TARGET, warded: true } : STRUCK_TARGET;
      const opts = { gameBuild };
      model.add('damage', ref(ch), ref(w), ref(t), ref(opts), V('StrikeLeft'), V('overhaul'), '=>', V(M.damageModel(ch, w, t, 'StrikeLeft', 'overhaul', opts)));
    }
  }
  return {model_blow: model.write(), dual_wield: dual.write(), durability: dur.write(), ...tiers.write()};
}
