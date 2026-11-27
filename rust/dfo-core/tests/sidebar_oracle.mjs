// Focused differential for `dfo_core::sidebar`'s PUBLIC composition, against the VENDORED game code.
//
// Run by `rust/dfo-core/tests/sidebar.rs`, which replays each line through `import_save` + `firmament_layer` + `vitals`.
// What this can and cannot drive, honestly:
//
//   DRIVEN (vendored, executable here)
//     - `levelEven.js` `evenHpFloor`/`evenHpOf`                    (the LEVEL-EVEN order)
//     - `combat/formulas.js` `spellPointsFor` + the chargen multiplier table
//     - `equip.js` `UpdateEquippedArmorValues`                     (the seven struck-part values)
//     - `lootRarity.js` `affixFold`                                (the armorParts fold)
//     - `entityMods.js` `entityArmorDisplayMod`                    (the display term)
//     - `firmamentLaw.js` `statDef`/`pctOf`/`treeStats`            (the channel budget and shares)
//     - `renownLayer.js` `setRenownLayer`/`setOnlineLayerExtra`    (the layer's own composition)
//
//   NOT DRIVEN (documented, not executable in this repository)
//     - `firmamentPowers.firmamentLayer`: imports the STUB `net/firmament/firmamentTree.js`, so `treeStats` is `{}` and
//       the function composes zeros. Its ARITHMETIC is therefore exercised by replaying the law's own capped totals and
//       the documented formula, not by calling it.
//     - the doll's `(100 - av) / 5`: a C# cite in a vendored comment (`equip.js:422-423`).
//     - `renownBonus`: a vendored stub (`net/renown.js:51`), so Renown's own numbers are the caller's.
//
// Line schemas:
//   horse  <stored> <limiter|0> <hpExtra> <evenExtra>               => <maxHealth>
//   import  <json-save>                                            => not used; the Rust side builds the facts
//   even   <stored> <h> <level> <endurance>                        => <evenHpOf>
//   sky    <stored> <h> <level> <end> <hp> <hpPct> <mp> <mpPct>     => <skyHp> <skyMp> <skyEven> <maxHealth>
//   acc    <intelligence> <bitfield>                               => <careerBase>
//   armor  <inc> <skyArmor> <count> <A|M|W|X:t:m:slot:affix:legendary>...   => <seven display-mod values>
import * as chargenTables from '../../../vendor/upstream/a3eb1605/src/systems/chargen.js';
import * as renown from '../../../vendor/upstream/a3eb1605/src/systems/renownLayer.js';
import * as entityMods from '../../../vendor/upstream/a3eb1605/src/systems/entityMods.js';
import * as E from '../../../vendor/upstream/a3eb1605/src/systems/equip.js';
// The `armorParts` fold registers at IMPORT of the loot-rarity module (`lootRarity.js:2481`).
import * as loot from '../../../vendor/upstream/a3eb1605/src/systems/loot/lootRarity.js';
import { evenHpFloor, evenHpOf } from '../../../vendor/upstream/a3eb1605/src/systems/levelEven.js';
import { spellPointsFor } from '../../../vendor/upstream/a3eb1605/src/combat/formulas.js';
import * as law from '../../../vendor/firmament/firmamentLaw.js';

const out = [];
const n = (v) => (Number.isFinite(v) ? String(v) : 'NaN');
const cap = (k, v) => {
  const d = law.statDef(k);
  return d ? Math.max(d.min, Math.min(d.max, v)) : v;
};
const pctOf = (base, pct) => (Number.isFinite(base) && base > 0 && pct > 0 ? Math.floor((base * pct) / 100) : 0);

// ── The save's stored maximum, as the layer composes it (`setRenownLayer`) ────────────────────────────
for (const stored of [240, 100])
  for (const limiter of [null, 90]) {
    const ch = {
      isPlayer: true,
      career: { hitPointsPerLevel: 12 },
      level: 10,
      stats: { endurance: 60 },
      maxHealth: stored,
      health: stored,
      maxMagicka: 0,
      magicka: 0,
      _mods: { magicka: 0 },
    };
    if (limiter != null) ch.maxHealthLimiter = limiter;
    // `setRenownLayer` reads the accessor for `hpFrom`, so install it exactly as a live entity has it.
    chargenTables.defineLiveMaxHealth(ch);
    renown.setRenownLayer(ch, 1);
    renown.setOnlineLayerExtra(ch, { hp: 44, mp: 8, end: 15 });
    out.push(`horse ${stored} ${limiter ?? 0} 44 15 ${n(ch.maxHealth)}`);
  }

// ── LEVEL-EVEN: the floor and the over-stored share ──────────────────────────────────────────────────
for (const stored of [100, 240, 700])
  for (const endurance of [40, 60, 75, 100]) {
    const even = evenHpOf({ career: { hitPointsPerLevel: 12 }, level: 10, rawMaxHealth: stored }, endurance);
    out.push(`even ${stored} 12 10 ${endurance} ${n(even)}`);
  }

// ── The Firmament's shares over the floored body, exactly `firmamentPowers.js:253-273` ───────────────
// The authoritative answer is the vendor's own accessor after the real setters, so the oracle does not re-sum.
for (const [stored, endurance] of [[240, 60], [100, 60], [100, 75]]) {
  const end = cap('endurance', 13 + pctOf(endurance, 9));
  const even = evenHpOf({ career: { hitPointsPerLevel: 12 }, level: 10, rawMaxHealth: stored }, endurance + end);
  const floored = stored + even;
  const hp = cap('hp', 28 + pctOf(floored, 7));
  const mp = cap('mp', 8 + pctOf(77, 0));
  // Drive the real setter over a save-shaped record with the accessors installed: its answer is whole.
  const ch = {
    isPlayer: true,
    career: { hitPointsPerLevel: 12, abilityFlagsAndSpellPointsBitfield: 0x1000 },
    level: 10,
    stats: { intelligence: 77, endurance },
    _mods: { magicka: 0 },
    _enchantMods: { maxMagicka: 0 },
    health: stored,
    maxHealth: stored,
    magicka: 0,
    maxMagicka: 77,
  };
  chargenTables.defineLiveMaxMagicka(ch);
  chargenTables.defineLiveMaxHealth(ch);
  renown.setRenownLayer(ch, 1);
  renown.setOnlineLayerExtra(ch, { hp, mp, end });
  out.push(
    `sky ${stored} 12 10 ${endurance} 28 7 8 0 ${n(ch.maxHealth)} ${n(ch.maxMagicka)} ${n(ch.evenHp)} ${n(ch.renownHp)}`,
  );
}

// ── The career Spell-Points base the accessor computes ──────────────────────────────────────────────
for (const intelligence of [77, 100, 200])
  for (const bitfield of [0x0000, 0x0400, 0x1000, 0x1400]) {
    // LiveIntelligence is `statMods.liveStat`, clamped 0..=100 (`src/save.js:167-181`).
    const live = Math.min(intelligence, 100);
    const mult = chargenTables.spellPointMultiplier(bitfield);
    out.push(`acc ${intelligence} ${bitfield} ${n(spellPointsFor(live, mult))}`);
  }

// ── Armour: the table plus the display term, with the affix fold and the sky's fold ──────────────────
const G = { A: 'Armor', M: 'MensClothing', W: 'WomensClothing', X: 'Weapons' };
// `legendary` is the record id when the piece is one (a `countedPieces` copy).
const W = (g, t, m, slot, affix = 0, legendary = null) => ({
  group: G[g],
  templateIndex: t,
  material: m,
  equipSlot: slot,
  affixes: affix ? [{ id: 'armor', value: affix }] : [],
  ...(legendary ? { rarity: 'legendary', legendary } : {}),
});
const layouts = [
  [],
  [W('A', 102, 0, 18)],
  [W('A', 102, 0, 18, 15), W('A', 109, 0, 21, 6), W('A', 112, 0, 22)],
  [W('M', 148, 0, 26, 4)],
  [W('X', 123, 9, 19, 4)],
  [W('A', 109, 0, 21), W('A', 112, 0, 21)], // a slot conflict: the first wins
  // The ORDER of `wornItems` (lootRarity.js:2356-2362 over fillEquipTable): slot losers first, then slot order, then the
  // affix filter, then `countedPieces`. These three layouts are the review's cases.
  [W('A', 102, 0, 18, 12), W('A', 102, 0, 18, 15, 'the-warden'), W('A', 108, 0, 26, 20, 'the-warden')],
  [W('A', 108, 0, 26, 20, 'the-warden'), W('A', 102, 0, 18, 15, 'the-warden')],
  [W('A', 102, 0, 18, 0, 'the-warden'), W('A', 108, 0, 26, 20, 'the-warden')],
];
for (const worn of layouts)
  for (const inc of [0, -5])
    for (const skyArmor of [0, 3]) {
      entityMods.registerEntityFold('sidebar-oracle', () => ({ armorParts: [skyArmor, skyArmor, skyArmor, skyArmor, skyArmor, skyArmor, skyArmor] }));
      const ch = {
        isPlayer: true,
        items: worn.map((it) => ({ ...it, affixes: [...(it.affixes ?? [])] })),
        _enchantMods: { increasedArmorMod: inc, decreasedArmorMod: 0 },
      };
      E.rebuildEquipState(ch);
      entityMods.computeEntityMods(ch);
      // The display TERM only; the rating is the documented C# cite.
      const display = [0, 1, 2, 3, 4, 5, 6].map((p) => entityMods.entityArmorDisplayMod(ch, p));
      const pieces = worn
        .map((it) => `${it.group === 'Armor' ? 'A' : it.group === 'MensClothing' ? 'M' : it.group === 'WomensClothing' ? 'W' : 'X'}:${it.templateIndex}:${it.material}:${it.equipSlot}:${it.affixes?.[0]?.value ?? 0}:${it.legendary ?? '-'}`)
        .join(' ');
      out.push(`armor ${inc} ${skyArmor} ${worn.length}${worn.length ? ' ' + pieces : ''} ${display.map(n).join(' ')}`);
      entityMods.registerEntityFold('sidebar-oracle', null);
    }

console.log(out.join('\n'));
