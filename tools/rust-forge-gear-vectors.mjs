/*
 * Forge gear vectors: a player item minted from explicit parts, and a main-hand wear, against the real engine.
 *
 *   gearbuild  a spec (template, material, rarity, lines, or a Legendary record id) minted: the item's own fields, its
 *              lines, its enchantment and its condition, exactly as `setItemFields` + `mintCondition` leave a Magic or
 *              Rare piece, or as `applyRarity` + `mintCondition` leave a Legendary; or `validatePlan`'s refusal.
 *   gearwear   a main-hand wear against a character built by the real `characterFromSave`: the resulting character
 *              (worn list, hands, wraps, `_mods`, `_enchantMods`, `legendaries`), the displaced pieces and the slot; or
 *              the refusal (`equipItem` answers null, the hand law says no).
 *   gearequip  the whole analysis card before and after a legal wear (the baseline is the card before), so a wear that
 *              moves no number fails the generator instead of passing.
 *
 * The JS is the oracle: the builder's contract is "the item the game mints for this spec", so the generator calls the
 * game's own minters and folds, never the Forge's Rust module. The trade `value` is not part of the contract: no battle
 * reads it and it needs the template price tables.
 */
import {
  applyRarity, legendariesFor,
} from '../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { mintCondition, setItemFields } from '../vendor/upstream/a3eb1605/src/systems/item/itemTemplates.js';
import { createEquipTable } from '../vendor/upstream/a3eb1605/src/characters/equipTable.js';
import { equipItem, equipTableOf, fillEquipTable, getItemHands } from '../vendor/upstream/a3eb1605/src/systems/equip.js';
import { EQUIP_SLOTS } from '../vendor/upstream/a3eb1605/src/characters/paperdoll/paperdoll.js';
import { validatePlan } from '../src/gearProfile.js';
import { WEAPONS } from '../src/data.js';
import { characterFromSave, rebuildEnchantMods, rebuildMods } from '../src/save.js';
import { theoryCharacter } from '../src/theory.js';
import { applyFirmament } from '../src/realBuild.js';
import { BUILDS, buildById, planBuild, planFromTree } from '../src/firmament.js';
import { analyze } from '../src/model.js';
import { encodeValue as V } from './rust-codec.mjs';

/** The group a template is built as, from the game's own tables (`forge_gear::group_of`). */
function groupOf(template) {
  if (WEAPONS[template]) return 'Weapons';
  if (template >= 133 && template <= 139) return 'Jewellery';
  if (template >= 102 && template <= 112) return 'Armor';
  return template >= 182 ? 'WomensClothing' : 'MensClothing';
}

/** `validatePlan`'s plan record for one spec. */
function planOf(spec) {
  const piece = { template: spec.template, group: groupOf(spec.template), rarity: spec.rarity, lines: spec.lines ?? [] };
  if (spec.rarity === 'legendary') piece.record = spec.record;
  return piece;
}

/**
 * The game's mint for a spec: `{ item }` or `{ refusal }`, where a refusal is the Forge's typed answer as the vector
 * writes it - `['illegal', ...sentences]` or `'unknown-record'`. An unknown record is checked first, the way
 * `build_item` does; the sentence `validatePlan` gives for it would be the same condition, but the typed answer is the
 * registry's own "none fits" (a Legendary's record list is `legendariesFor`).
 */
function mintOf(spec) {
  const group = groupOf(spec.template);
  if (spec.rarity === 'legendary') {
    const rec = legendariesFor({ group, templateIndex: spec.template }).find((r) => r.id === spec.record);
    if (!rec) return { refusal: 'unknown-record' };
    const bad = validatePlan([{ ...planOf(spec), lines: rec.affixes.filter((a) => a?.id !== 'gem') }]);
    if (bad.length) return { refusal: ['illegal', ...bad] };
    const item = mintCondition(applyRarity({ group, templateIndex: spec.template, material: spec.material }, 'legendary', () => 0, [rec]));
    delete item.value;
    return { item };
  }
  const bad = validatePlan([planOf(spec)]);
  if (bad.length) return { refusal: ['illegal', ...bad] };
  const item = mintCondition(setItemFields({
    group, templateIndex: spec.template, material: spec.material, rarity: spec.rarity, affixes: spec.lines ?? [],
  }));
  delete item.value;
  return { item };
}

/** `characterFromSave`'s reads of a new worn list, applied beside the character's existing folds. */
function refoldCharacter(ch, oldWorn, worn, bag) {
  const before = rebuildMods(oldWorn);
  const after = rebuildMods(worn);
  const add = (was, from, to) => (was ?? 0) - (from ?? 0) + (to ?? 0);
  const merge = (oldMap, beforeMap, afterMap) => {
    const out = {};
    for (const k of new Set([...Object.keys(oldMap ?? {}), ...Object.keys(beforeMap), ...Object.keys(afterMap)])) {
      const v = add(oldMap?.[k], beforeMap[k], afterMap[k]);
      // A channel that lands on 0 and is absent from the new fold is dropped: every reader is `?? 0`.
      if (v === 0 && !(k in afterMap)) continue;
      out[k] = v;
    }
    return out;
  };
  const mods = ch._mods ?? {};
  mods.stats = merge(mods.stats, before.stats, after.stats);
  mods.skills = merge(mods.skills, before.skills, after.skills);
  const ench = ch._enchantMods ?? {};
  ench.skillMods = merge(ench.skillMods, rebuildEnchantMods(oldWorn).skillMods, rebuildEnchantMods(worn).skillMods);
  const wraps = worn.find((it) => it.group === 'Weapons' && it.templateIndex === 563) ?? null;
  const right = worn.find((it) => it.group === 'Weapons' && it.templateIndex !== 563 && it.equipSlot === EQUIP_SLOTS.RightHand)
    ?? worn.find((it) => it.group === 'Weapons' && it.templateIndex !== 563 && it.equipSlot === EQUIP_SLOTS.LeftHand)
    ?? null;
  const offWeapon = worn.find((it) => it.group === 'Weapons' && it !== right && it.templateIndex !== 563
    && (it.equipSlot === EQUIP_SLOTS.LeftHand || it.equipSlot === EQUIP_SLOTS.RightHand)) ?? null;
  return {
    ...ch,
    items: bag,
    worn,
    weapon: right,
    offWeapon,
    wraps,
    legendaries: worn.filter((it) => it?.legendary).map((it) => ({ id: it.legendary, name: it.name })),
    _mods: mods,
    _enchantMods: ench,
    weaponDamagePct: after.weaponDamagePct,
    slayer: after.slayer,
  };
}

/** The build answer as the vector writes it: the item itself, or the typed refusal. */
function buildAnswer(spec) {
  const minted = mintOf(spec);
  return minted.refusal ?? minted.item;
}
function wearAnswer(ch, item) {
  if (!Array.isArray(ch.worn)) return 'no-worn-list';
  // ITEM_HANDS: RightOnly 1, LeftOnly 2, Either 3, Both 4 (characters/equipTable.js:27).
  const hands = getItemHands(item);
  if (!(hands === 1 || hands === 3 || hands === 4)) return 'not-main-hand';
  // The table the character's own worn list makes, and the item tried in the right hand (systems/equip.js:249-284).
  const wornCopies = ch.worn.map((it) => ({ ...it }));
  const entity = { equip: createEquipTable(), items: [...wornCopies, item] };
  fillEquipTable(equipTableOf(entity), entity.items);
  const displaced = equipItem(entity, item, EQUIP_SLOTS.RightHand);
  if (displaced == null) return 'not-main-hand';
  const worn = entity.items.filter((it) => it?.equipSlot != null);
  // Items stay in the bag and carry `equipSlot` when worn; a leaver's mark is deleted on the same object
  // (`unequipSlot`, systems/equip.js:120-126). `ch.items` and `ch.worn` share those objects (`characterFromSave`
  // filters a copy of the save's list), so each leaver's first matching bag entry loses its mark.
  const leavers = displaced.map((it) => structuredClone(it));
  const bag = (ch.items ?? []).map((it) => ({ ...it }));
  for (const left of leavers) {
    const at = bag.findIndex((it) => it.equipSlot != null && JSON.stringify({ ...it, equipSlot: undefined }) === JSON.stringify({ ...left, equipSlot: undefined }));
    if (at >= 0) {
      delete bag[at].equipSlot;
      bag[at] = { ...bag[at] };
    }
  }
  bag.push(item);
  return {
    slot: EQUIP_SLOTS.RightHand,
    displaced: displaced.map((it) => { const copy = { ...it }; delete copy.equipSlot; return copy; }),
    character: refoldCharacter(ch, ch.worn, worn, bag),
  };
}

export function genForgeGearFamilies(Out) {
  const out = new Out('forge_gear', 'R5e Forge gear: an item minted from explicit parts, and a main-hand wear', true);
  const counts = {};
  let defs = 0;
  const def = (v) => {
    out.add('def', String(defs), V(v));
    return `@${defs++}`;
  };
  const put = (kind, result, ...args) => {
    out.add(kind, ...args, '=>', V(result));
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  const mintedOrThrow = (spec) => {
    const minted = mintOf(spec);
    if (minted.refusal) throw new Error(`forge_gear: a wear probe's spec faults: ${JSON.stringify(minted.refusal)}`);
    return minted.item;
  };

  // ---- (1) an item from a spec --------------------------------------------------------------------------
  // One legal spec per group, with the game's own bands: a Rare weapon's damage line, a Magic weapon's stat line, a
  // Rare cuirass, a Magic ring, a Rare clothing piece, Hand Wraps (cloth), and three Legendary records.
  const specs = [
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 121, material: 3, rarity: 'magic', lines: [{ id: 'stat', param: 'strength', value: 5 }] },
    { template: 102, material: 521, rarity: 'rare', lines: [{ id: 'armor', value: 12 }, { id: 'stat', param: 'endurance', value: 10 }] },
    { template: 135, material: 0, rarity: 'magic', lines: [{ id: 'stat', param: 'luck', value: 3 }] },
    { template: 141, material: 0, rarity: 'rare', lines: [{ id: 'standing', param: 'merchants', value: 4 }, { id: 'warmth', value: 6 }] },
    { template: 563, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 123, material: 9, rarity: 'legendary', record: 'wyrmbane' },
    { template: 102, material: 521, rarity: 'legendary', record: 'the-warden' },
    { template: 135, material: 0, rarity: 'legendary', record: 'foxglove' },
    { template: 129, material: 0, rarity: 'rare', lines: [{ id: 'damage', value: 25 }, { id: 'skill', param: 33, value: 20 }] },
    { template: 112, material: 521, rarity: 'rare', lines: [{ id: 'armor', value: 12 }] },
  ];
  // The refusals: too many lines for a Magic, a value past the band, a skill a cuirass cannot roll, a Legendary record
  // that fits another group, an unknown rarity, a repeated skill param, and a Rare with five lines.
  const bad = [
    { template: 124, material: 0, rarity: 'magic', lines: [{ id: 'damage', value: 12 }, { id: 'stat', param: 'strength', value: 5 }, { id: 'skill', param: 34, value: 10 }] },
    { template: 124, material: 0, rarity: 'rare', lines: [{ id: 'damage', value: 26 }] },
    { template: 102, material: 521, rarity: 'rare', lines: [{ id: 'skill', param: 29, value: 20 }] },
    { template: 123, material: 9, rarity: 'legendary', record: 'the-warden' },
    { template: 102, material: 521, rarity: 'legendary', record: 'no-such-record' },
    { template: 123, material: 9, rarity: 'epic', lines: [] },
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'skill', param: 29, value: 20 }, { id: 'skill', param: 29, value: 20 }] },
    { template: 124, material: 0, rarity: 'rare', lines: Array.from({ length: 5 }, () => ({ id: 'damage', value: 25 })) },
    { template: 135, material: 0, rarity: 'rare', lines: [{ id: 'damage', value: 5 }] },
    { template: 141, material: 0, rarity: 'magic', lines: [{ id: 'armor', value: 5 }] },
  ];
  for (const spec of [...specs, ...bad]) put('gearbuild', buildAnswer(spec), def(spec));

  // Every Legendary record the long blade takes, and every one any weapon takes: each is its own spec, so the whole
  // registry's mapping is checked (a record's lines, enchantment and name).
  for (const template of [123, 124, 129, 115, 127]) {
    for (const rec of legendariesFor({ group: 'Weapons', templateIndex: template })) {
      const spec = { template, material: 9, rarity: 'legendary', record: rec.id };
      put('gearbuild', buildAnswer(spec), def(spec));
    }
  }
  for (const template of new Set([102, 107, 108, 103, 104, 105, 111, 133, 135, 137, 138, 139, 163, 155, 150, 195])) {
    const group = groupOf(template);
    for (const rec of legendariesFor({ group, templateIndex: template })) {
      const spec = { template, material: group === 'Weapons' ? 9 : group === 'Armor' ? 521 : 0, rarity: 'legendary', record: rec.id };
      put('gearbuild', buildAnswer(spec), def(spec));
    }
  }
  // A Rare line at each band's top and one past it, on a weapon and on a cuirass.
  for (const spec of [
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 24 }] },
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 26 }] },
    { template: 102, material: 521, rarity: 'rare', lines: [{ id: 'armor', value: 12 }] },
    { template: 102, material: 521, rarity: 'rare', lines: [{ id: 'armor', value: 13 }] },
    { template: 102, material: 521, rarity: 'rare', lines: [{ id: 'stat', param: 'strength', value: 10 }] },
    { template: 102, material: 521, rarity: 'rare', lines: [{ id: 'stat', param: 'strength', value: 11 }] },
  ]) put('gearbuild', buildAnswer(spec), def(spec));

  // ---- (2) a main-hand wear ---------------------------------------------------------------------------
  const blade = (template, material, slot, name, affixes = []) => ({
    group: 'Weapons', templateIndex: template, material, name, equipSlot: slot,
    maxCondition: 12800, currentCondition: 12800, affixes,
  });
  const piece = (template, material, slot, name, affixes = []) => ({
    group: 'Armor', templateIndex: template, material, name, equipSlot: slot,
    maxCondition: 4096, currentCondition: 4096, affixes,
  });
  const saved = (items) => ({
    level: 45, raceId: 5, career: { name: 'Longblade' },
    stats: { strength: 60, intelligence: 40, willpower: 40, agility: 60, endurance: 50, personality: 40, speed: 50, luck: 50 },
    skills: Array.from({ length: 35 }, () => 100), items, health: 700, maxHealth: 700,
  });
  const boards = [
    ['two-hander-and-shield', saved([blade(123, 9, 19, 'Daedric Dai-katana'), piece(112, 521, 21, 'Daedric Tower Shield')])],
    ['dual', saved([blade(121, 9, 19, 'Daedric Katana'), blade(118, 3, 21, 'Elven Broadsword')])],
    ['armour-only', saved([piece(102, 521, 18, 'Daedric Cuirass')])],
    ['buffed', saved([blade(123, 9, 19, 'Daedric Dai-katana', [{ id: 'damage', value: 12 }, { id: 'skill', param: 29, value: 10 }])])],
    // A blade that carries exactly the skill line the wear's new piece also carries: the fold's delta lands on 0 with
    // the channel still present, which is the shape a `_mods` re-fold must keep.
    ['same-skill', saved([blade(121, 9, 19, 'Daedric Katana', [{ id: 'skill', param: 29, value: 10 }])])],
    ['theory', theoryCharacter({ blade: 121 })],
  ];
  // The wear's candidates: a mace and a katana (one-handers, both displace the right-hand occupant), a Dai-katana and a
  // Rare Dai-katana (two-handers, both clear the two hands), Hand Wraps, a Legendary Dai-katana, and a shield and a ring
  // (the two refusals: their hands are LeftOnly / None).
  const wearSpecs = [
    { template: 124, material: 0, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 118, material: 3, rarity: 'magic', lines: [{ id: 'skill', param: 29, value: 10 }] },
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 563, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 112, material: 521, rarity: 'rare', lines: [{ id: 'armor', value: 12 }] },
    { template: 135, material: 0, rarity: 'magic', lines: [{ id: 'stat', param: 'luck', value: 3 }] },
    { template: 123, material: 9, rarity: 'legendary', record: 'wyrmbane' },
  ];
  // A character already carrying a Firmament tree: its `_mods` holds attribute and skill points no gear fold made, and
  // the wear must keep every one of them (a gear delta, not a fresh fold). The tree is the real `applyFirmament` on a
  // saved character, so the stars' channels are the game's own.
  const treePlan = planBuild(buildById('longblade'), { stars: 40 });
  const treeCh = applyFirmament(characterFromSave(boards[0][1]), planFromTree(buildById('longblade'), { ...treePlan.tree, stars: 40 }));
  boards.push(['firmament', treeCh]);

  let built = false;
  for (const [label, save] of boards) {
    const raw = save.worn ? save : characterFromSave(save);
    const ref = def(raw);
    def(label);
    for (const spec of wearSpecs) {
      const item = mintedOrThrow(spec);
      const itemRef = def(item);
      // A fresh copy per probe: the fold patch below writes `_mods` and `_enchantMods` in place, as the game's own
      // `computeEntityMods` seam does, and the board's character is shared across its probes.
      const answer = wearAnswer(structuredClone(raw), structuredClone(item));
      // Invariant, checked here with the game's own builder: on a character whose `_mods` is only its worn gear (a
      // save with no live fold), `characterFromSave` over the new list must agree with the wear's answer on every
      // field. This is what makes the delta a re-fold rather than a second interpretation.
      if (typeof answer !== 'string' && !built && !raw._mods?.statMax) {
        const rebuilt = characterFromSave({ ...save, items: answer.character.items });
        for (const key of ['weapon', 'offWeapon', 'wraps', 'legendaries']) {
          if (JSON.stringify(rebuilt[key]) !== JSON.stringify(answer.character[key])) {
            throw new Error(`forge_gear: ${label}: characterFromSave disagrees on ${key}`);
          }
        }
        if (JSON.stringify(rebuilt._mods.stats) !== JSON.stringify(answer.character._mods.stats)
          || JSON.stringify(rebuilt._mods.skills) !== JSON.stringify(answer.character._mods.skills)) {
          throw new Error(`forge_gear: ${label}: characterFromSave disagrees on _mods`);
        }
        if (JSON.stringify(rebuilt._enchantMods.skillMods) !== JSON.stringify(answer.character._enchantMods.skillMods)) {
          throw new Error(`forge_gear: ${label}: characterFromSave disagrees on _enchantMods`);
        }
        built = true;
      }
      put('gearwear', answer, ref, itemRef);
    }
    built = false;
  }

  // ---- (3) the analysis before and after a legal wear ---------------------------------------------------
  // The baseline is the card before; the generator fails if too few legal wears move a figure, so the family cannot
  // pass by comparing two identical cards. `analyze` is the game's own, with an empty spellbook (the theory characters
  // carry no spells).
  const book = new Map();
  const equipSpecs = [
    { template: 121, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 123, material: 9, rarity: 'rare', lines: [{ id: 'damage', value: 25 }] },
    { template: 124, material: 0, rarity: 'legendary', record: 'graveward' },
    { template: 118, material: 3, rarity: 'magic', lines: [{ id: 'skill', param: 29, value: 10 }, { id: 'stat', param: 'strength', value: 5 }] },
    { template: 123, material: 9, rarity: 'legendary', record: 'warp-edge' },
  ];
  let moved = 0;
  for (const [label, save] of boards) {
    const raw = save.worn ? save : characterFromSave(save);
    const chRef = def(raw);
    def(label);
    for (const spec of equipSpecs) {
      const item = mintedOrThrow(spec);
      const itemRef = def(item);
      const before = analyze(structuredClone(raw), { standard: book });
      const answer = wearAnswer(structuredClone(raw), structuredClone(item));
      if (typeof answer === 'string') throw new Error(`forge_gear: a legal equip probe faults (${answer}) for ${label} / ${spec.template} ${spec.record ?? spec.rarity}`);
      const after = analyze(structuredClone(answer.character), { standard: book });
      if (before.dps !== after.dps || before.totalDps !== after.totalDps) moved++;
      put('gearequip', [before, after], chRef, itemRef);
    }
  }
  if (moved < 8) throw new Error(`forge_gear: only ${moved} legal wears moved a DPS figure; the family proves nothing`);

  // A refused wear is its typed word, so the rejection path is oracle-backed too (`equipItem` answers null / the hand
  // law says LeftOnly): a shield, a ring, and a piece made for an unknown group's hands.
  const shield = mintedOrThrow({ template: 112, material: 521, rarity: 'rare', lines: [{ id: 'armor', value: 12 }] });
  const ring = mintedOrThrow({ template: 135, material: 0, rarity: 'magic', lines: [{ id: 'stat', param: 'luck', value: 3 }] });
  const [label0, save0] = boards[0];
  const raw0 = characterFromSave(save0);
  const ref0 = def(raw0);
  def(label0);
  for (const item of [shield, ring]) {
    const itemRef = def(item);
    put('gearwear', wearAnswer(structuredClone(raw0), structuredClone(item)), ref0, itemRef);
  }

  const total = out.write();
  console.log('forge_gear:', counts);
  return { forge_gear: total };
}
