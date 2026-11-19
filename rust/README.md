# dfo-core (Rust), milestones R1 and R2

A Cargo workspace with one library crate, `dfo-core`: edition 2021, **no dependencies** (std only).
It is a bit-exact port of a few pure rule modules of the JS in `../src/`. The JS and the vendored
upstream (`../vendor/upstream/a3eb1605`) stay the source of truth; this crate changes no mechanic.
Nothing here is wired into the CLI or the reports.

## Scope of R1

Pure functions and small state machines only: plain numbers in, numbers out, no `fs`, no clock,
no ambient randomness. Rounding is kept as the JS has it (`floor`/`trunc`/`fround`/half-to-even,
`Math.min/max` with JS NaN and `-0` behaviour, JS `%`). `f64` is the JS number.

| Module | JS source | Rust file |
|---|---|---|
| `round`: `unity_round`, `fround`, `trunc`, `floor`, JS `%`/`min`/`max`/clamp, `ToUint32`/`ToInt32`, `imul`, `Number(x)\|\|d` | `src/model.js:49-63` (+ the JS builtins the other modules use) | `dfo-core/src/round.rs` |
| `rng`: FNV-1a, SplitMix32, xoshiro128**, named streams, `float`/`int`, snapshot/restore, seed folding, validation | `src/rng.js:1-182` (all of it) | `dfo-core/src/rng.rs` |
| `damage`: `damage_modifier`, `pcaao_damage_modifier`, `apply_pct`, `carried_pct`, `carried_firmament`, `condition_multiplier` | `src/model.js:171-173`, `:182-184`, `:632-634`, `:642`, `:646`, `:651-674` | `dfo-core/src/damage.rs` |
| `allowance`: `ref_of`, `allowance_law`, `allowance_spec`, `claim_streams`, `simulate_allowance`, `steady_state`, `run_allowance` | `src/allowance.js:34-296` (whole file; it has no imports) | `dfo-core/src/allowance.rs` |
| `relay_claim`: the claim engine (constructor, `claim`, `summary`) | `src/relayClaim.js:29-283` | `dfo-core/src/relay_claim.rs` |

Boundaries with JS (also in the module docs): stream names are `&[u16]` (UTF-16 units, so lone
surrogates work); a JS value that is not a number is modelled as `NaN`; JS `TypeError`/`RangeError`
are `Result` errors; `perClaimAt` is a closure; counters are `u64`; `Rng::draws` is in creation
order (JS `draws()` is an object, so integer-like names such as `"10"` would sort first there).

### Not ported in R1, on purpose

- `swingFrameSeconds`, `swingHeft`, `swingHandling`, `classicStrength`: moved to R2 (`swing.rs`, see
  the R2 section below).
- `rng.js` `_initialStateForTests` is ported as `rng::initial_state` (and tested through it);
  `fnv1a`/`splitmix32` are module-private in JS and are ported as pub helpers (checked through the
  initial states and against the public FNV-1a test vectors).
- Everything else in `src/` (target, model analysis, blow outcomes, cws, fight loops, relay fight,
  objectives, CLI, reports): see the plan below.

## Run

```
node tools/rust-vectors.mjs        # from the repository root: writes rust/tests/vectors/*.txt
node tools/rust-data.mjs --check   # from the repository root: rust/dfo-core/src/generated is up to date
cd rust && cargo test
cd rust && cargo fmt --check
cd rust && cargo clippy --all-targets -- -D warnings
```

The vector tests **fail** (they never skip) if a vector file is missing, lacks its header, or has
fewer cases of a kind than a stated floor. The vector files are generated, about 7 MB, and not
committed (`rust/.gitignore`): run the generator first on a fresh checkout.

## Vectors: what is proven

`tools/rust-vectors.mjs` imports the real JS modules and writes one text file per module
(`round`, `rng`, `damage`, `allowance`, `relay_claim`, and from R2 `swing`). Format: one case per line, `kind token...`,
f64 as 16 hex digits of IEEE bits, integers decimal, `=>` between inputs and outputs; documented in
the generator's header. Output is deterministic (fixed local PRNG, no `Math.random`, no clock;
a second run is byte-identical). `applyPct`, `carriedPct`, `carriedFirmament` are not exported by
`src/model.js`, so the generator cuts their exact source text out of the file and evaluates it
(it fails loudly if the text moves).

Proven, and only this: for the inputs in the vector files (seeded sweeps plus the hand-picked
edge cases listed in the generator) the Rust output equals the JS output bit for bit, NaN
compared as "both NaN" (JS NaN payloads are not meaningful). That covers ties at .5, `-0`,
`1e-9` boundary of `apply_pct`, values near 2^53, negative and limit seeds, multi-byte, astral and
lone-surrogate names, 0- and 64-unit names, 10 000-draw sequences, snapshot/restore traces,
shield/token/bucket/health clipping and kills in the claim engine, and a shield ending exactly on
a claim time (`simulate_shield_end`; the claim at the end is accepted, `t < shieldUntil`, as in
upstream `gateBrain.js:1308`; `src/allowance.js` was made strict on main and the port follows it).

Not proven: any input outside the vectors; the all-zero-state fix of `rng` (a fixed point no
(seed, name) is known to reach, so it is unreachable by vector); stream names that are not
valid Unicode inside `allowance` (names never reach a number); behaviour of the JS when given
non-number arguments (not representable).

## R2: data tables (done; the functions are still to port)

R2 adds the data the model reads and the first three functions that read it.

- `tools/rust-data.mjs` imports the real JS modules (the data modules of `src/` and the vendored
  tables that `src/*.js` import) and writes `rust/dfo-core/src/generated/*.rs`: one module per JS
  source, plus `mod.rs`, plus `mod_settings.rs`. Every file starts with `// generated by
  tools/rust-data.mjs - do not edit`. The generated files are committed; the generator is the only
  writer.
- `dfo-core/src/swing.rs`: `swing_frame_seconds` (`src/model.js:381-385`), `swing_heft`
  (`:388-393`), `swing_handling` (`:395-399`), `classic_strength` (`:179-181`, module-private in JS).
  `swing.rs` reads the tables through `crate::generated::data`.

### Regenerate, and `--check`

```
node tools/rust-data.mjs           # from the repository root: rewrites rust/dfo-core/src/generated/
node tools/rust-data.mjs --check   # regenerates in memory; exits 1 if a committed file is missing or
                                   # differs, or an unknown .rs file sits in that directory
```

`--check` prints the stale file names and the fix. Run it in CI or before a commit that touches
`src/data.js`, `src/enchantData.js`, or `vendor/upstream/a3eb1605`. The vendor hash check already
pins the vendored source; `--check` pins the Rust output to it.

### Type mapping (the generator's rule, applied to every table)

| JS | Rust |
|---|---|
| number | `f64` (every JS number is a double; ids too). Keys of an integer-keyed object are `i64`. |
| boolean / string | `bool` / `&'static str` (a lone surrogate is refused) |
| `null` / `undefined` in a slot | `Option<T>`, `T` from the other values in that slot |
| array of same-length arrays | `&'static [(T0, T1, ...)]` (one tuple per element, e.g. `CastWhenUsed`'s `[id, cost, label]`) |
| other array | `&'static [T]` |
| object with integer keys | `&'static [(i64, V)]` in JS key order (integer keys first, ascending) |
| object with identifier keys | a struct, one field per key (snake_case; `type` becomes `type_`) |
| object with other string keys | `&'static [(&'static str, V)]` in JS key order |
| `Map` | its `[key, value]` pairs, insertion order |
| function | dropped (a field, or a whole export); the generator prints the dropped names |

A slot holding two kinds of value is refused, with its path. Numbers print as float literals that
parse back to the same bits (JS shortest round-trip form; `NaN`, `Infinity`, `-0` spelled out).
Scalars are `pub const`; everything else is `pub static`. Each table has `#[rustfmt::skip]`, so
`cargo fmt --check` accepts the files as written; the generated module carries
`allow(clippy::approx_constant, clippy::excessive_precision)`.

### Table list: generated file and JS source

| Generated file | JS source (exports written; functions dropped) |
|---|---|
| `data.rs` | `src/data.js`: every non-function export (`SOURCE`, `SKILLS`, `SKILL_NAMES`, `RACES`, `RACE_NAMES`, `MATERIALS`, `WEAPON_MATERIAL_MODIFIER`, `WEAPON_TYPES`, `WEAPONS`, `SWING_MODS`, `SWINGS`, `STRUCK_BODY_PARTS`, `PCAAO_BODY_PARTS`, `BODY_PARTS`, the `SWING_*` scalars and `SWING_HANDLING`, `CLASSIC_UPDATE_INTERVAL`, the bow/gun/pistolet/thunderlock constants, the boss-trait constants, `BOSS_TRAITS`, `BOSS_TRAIT_TEXT`, `MARTIAL_PATHS`, the `GATE_*` constants, `RRI_WEAPON_DAMAGE`, `RRI_SPEED_REDUCTION_FACTOR`). Dropped: `thunderlockReloadSeconds`, `gateRefDps`, `gateHealth`, `gateHitCap`. |
| `enchant_data.rs` | `src/enchantData.js`: `PARAM_NONE`, `ENCHANTMENT_COSTS`, `ITEM_ENCHANTMENT_MAX`. Dropped: the functions (`itemTemplate` reads `vendor/enchanting/itemTemplates.json`, not ported). |
| `anims.rs` | `vendor/upstream/a3eb1605/src/characters/anims.js`: `DIRECTION_TO_STRIKE` |
| `weapon_states.rs` | `characters/weaponStates.js`: `SWING_FRAME_MAX`, `HIT_FRAME_MELEE`, `HIT_FRAME_BOW`, `BOW_DRAWN_HOLD_FRAME`, `CLICK_ATTACK_DIRECTIONS`, `MELEE_NUM_FRAMES` |
| `enemy_basics.rs` | `characters/enemy/enemyBasics.js`: `ENEMY_BASICS`, `VANILLA_ENEMY_BASICS` |
| `enemy_entity.rs` | `characters/enemy/enemyEntity.js`: `KNIGHT_CITYWATCH_ID` (a re-export) |
| `races.rs` | `systems/races.js`: `FACES_PER_RACE`, `RACES`, `RACE_KEYS`, `RACE_TEMPLATES` |
| `pcaao.rs` | `combat/pcaao.js`: `PCAAO_REDUCTION_ROWS`, `SILVER_DOUBLED_CAREERS` |
| `enemy_groups.rs` | `combat/enemyGroups.js`: `ENEMY_GROUPS` |
| `enemy_equipment.rs` | `combat/enemyEquipment.js`: `ARMOR_ENUM`, `ARMOR_MATERIAL`, `MATERIALS_BY_MODIFIER`, `WEAPONS_ENUM` (no `src/` file imports them) |
| `armor_materials.rs` | `systems/armorMaterials.js`: `SHIELD_PARTS` (a `Map`, written as pairs) |
| `boss_traits.rs` | `systems/bossTraits.js`: `ELEMENT_TRAITS`, `RESIST_SHARE`, `WEAPON_RESIST_SHARE` |
| `enchantments.rs` | `systems/enchantments.js`: `ENCHANTMENT_TYPES`, `LOW_DAMAGE_VS`, `POTENT_VS_DAMAGE` |
| `paperdoll.rs` | `characters/paperdoll/paperdoll.js`: `EQUIP_SLOTS` (`systems/equip.js` re-exports the same object; the generator checks identity) |
| `level_cap.rs` | `systems/levelCap.js`: `LEVEL_CAP` |
| `loot_rarity.rs` | `systems/loot/lootRarity.js`: `AFFIX_COUNTS`, `AFFIX_IDS`, `AFFIX_KINDS` (its function fields dropped), `AFFIX_RANGES` |
| `loot_powers.rs` | `systems/loot/lootPowers.js`: `POTENCY_CAP`, `SPELL_POWER_MOST` (re-exported from `powerBlows.js`) |
| `gate_boss.rs` | `world/gate/gateBoss.js`: `BOSS_ARMOR` |
| `bow_bloom.rs` | `combat/bowBloom.js`: `BOW_FAST` |
| `hands_law.rs` | `combat/twoHands/handsLaw.js`: `DUAL`, `OFF_HAND_BLOW` (`blowShare`, a function, dropped) |
| `mod_settings.rs` | `systems/modSettings.js`: `MOD_ENABLED_DEFAULTS`, the `Enabled` default of the three mods `src/target.js` reads (`pcaao`, `meanerMonsters`, `daggerfall-enemy-expansion`). Nothing else of `MOD_SETTINGS` is generated. |

### Not ported in R2

- Every function (see the next section). Only data is generated.
- `MOD_SETTINGS` beyond the three `Enabled` defaults; the vendor name constants `MEANER_MONSTERS_VENDOR` and `DEX_VENDOR` (names only, used as keys).
- `vendor/enchanting/itemTemplates.json` and `ITEM_TEMPLATES` (used by `enchantData.js` and by vendor modules, not by a generated table).
- Vendor data that `src/*.js` does not import (for example `ENEMY_NAMES` and the `ATTACKS_*` anim tables).
- The `CLASSIC_UPDATE_INTERVAL` of `characters/weaponStates.js` (it is the same value as the one in `data.js`, which is generated).

### Vendored functions still to port

Each entry lists the functions the `src/*.js` files import from one vendored module (every import
line of `grep -n "vendor/upstream" src/*.js` was read). Data symbols are in the table above.

- `characters/enemy/enemyBasics.js`: `enemyCareerIndex`, `enemyEntityType` (`src/target.js`)
- `characters/enemy/enemyEntity.js`: `skillsLevel` (`src/target.js`)
- `characters/meanerMonsters.js`: `applyMeanerMonsters` (`src/target.js`)
- `combat/pcaaoMeanerMonsters.js`: `meanerMonstersRow` (`src/target.js`)
- `systems/enemyExpansion/dexInstall.js`: `dexClassicRow`, `dexRead` (`src/target.js`)
- `systems/enemyExpansion/dexEquipment.js`: `createDexEquipmentAssigner` (`src/target.js`)
- `combat/enemyGroups.js`: `enemyEntityGroup` (`src/target.js`)
- `combat/formulas.js`: `careerAttackModifier`, `silverDoubles` (`src/target.js`)
- `systems/armorMaterials.js`: `isShieldTemplate`, `itemArmorValue` (`src/target.js`)
- `systems/equip.js`: `slotForBodyPart`, `armorBodyParts` (`src/target.js`); `lowerCondition` (`src/durability.js`)
- `combat/enemyEquipment.js`: `armorOfMaterial`, `enemyArmorValues`, `equipmentVariantFor`, `assignEnemyEquipment` (`src/target.js`)
- `systems/item/itemTemplates.js`: `conditionPercentage` (`src/target.js`, `src/model.js`, `src/durability.js`)
- `systems/loot/lootRarity.js`: `powerIdsOf`, `powerOf`, `allLegendaries`, `legendariesFor`, `skillKin`, `readLines`, `validAffix`, `gemLine`, `socketGems`, `socketsOf`, `socketMax`, `countedPieces` (`src/simulateFight.js`, `src/gearProfile.js`, `src/gearLines.js`, `src/blowOutcomes.js`, `src/cws.js`, `src/sockets.js`, `src/model.js`)
- `systems/loot/lootPowers.js`: `foeGroup` (`src/model.js`)
- `systems/absorption.js`: `tryAbsorption` (`src/cws.js`)
- `systems/spell/spellPower.js`: `fightingClimb` (`src/cws.js`)
- `combat/bowBloom.js`: `bowFastDamage` (`src/model.js`)
- `systems/enchantments.js`: `mobileAffinityMatches` (`src/model.js`)
- `systems/races.js`: `raceById`, `raceByKey` (`src/spells.js`)
- `combat/twoHands/handsLaw.js`: `strikeHandOf`, `offHandToHit`, `offHandBurden`, `offHandDamage`, `offHandHold` (`src/dualWield.js`)
- `systems/bossTraits.js`: `bossStrike`, `bossTraitsOf`, `relayBossTraits` (`src/bossTraits.js`)
- `characters/weaponStates.js`, `characters/paperdoll/paperdoll.js`, `systems/levelCap.js`, `combat/pcaao.js`, `systems/armorMaterials.js` (partly), `systems/modSettings.js`: data only (the table above)

## R3a: the pure half of `src/target.js` (done; the builders are R3b)

Written, not yet run in this session (the author had no shell): the lead runs the gates. The generated
files must be regenerated before `cargo` builds (see below).

### Files

- `dfo-core/src/target.rs`: the target as the hit path reads it. `Target`, `Live` (base stats, `activeEffects`,
  gear `_mods`), `Effect`, `Stat`, `Career`, `Item`, `Weapon`, `Attacker`; each struct field names its JS
  property. Functions are literal ports in JS order (table below).
- `dfo-core/src/vendored.rs`: the small vendored helpers that target.js calls, ported as functions (table below).
- `tests/target.rs` with `tests/common/mod.rs`: reads `tests/vectors/target.txt`.
- Generated tables (`tools/rust-data.mjs`; the generator is the only writer):
  - new `formulas.rs` (`GROUP_BITS`, formulas.js:178);
  - new `equip.rs`: `SLOT_FOR_BODY_PART` (probed from the exported `slotForBodyPart` over the Map's keys 0..6,
    equip.js:496; the Map is the inverse of the module-private `SLOT_BODY_PART`), and `EQUIP_SLOT_NAMES` (the
    paperdoll's names with their ids, so a SLOT_RULES name can be read);
  - new `equip_rules.rs`: `SLOT_RULES` (characters/equipRules.js:44);
  - `armor_materials.rs` gains `SHIELD_VALUES`, `BODY_PARTS`, `NUMBER_BODY_PARTS`, `ARMOR_MATERIAL` (exported),
    and `PLATE_ARMOR_VALUES` (module-private, cut from the source text, armorMaterials.js:52);
  - `enemy_groups.rs` gains `ENEMY_GROUP_BY_CAREER` (module-private, cut, enemyGroups.js:18-58);
  - `enemy_equipment.rs` gains `PIECE_BODY_PART` (enemyEquipment.js:74), `SHIELD_VALUE` and `SHIELD_PARTS`
    (enemyEquipment.js:83-89; the same values as armorMaterials' copies, kept as the vendored file's own).
  - Cut literals are read with the R1 method: the text from `const NAME = ` to its closing bracket, evaluated.
    The generator throws if the text moves or the name is not unique.

### Ported (Rust function: JS file:line)

| Rust | JS |
|---|---|
| `target::career_tolerance`, `element_share` | `src/target.js:94-111` (spellcast.js:61-68; loot power :164-167) |
| `target::live_stat` | `src/save.js:167-181` (with `NUM`, save.js:107) |
| `target::natural_damage_resistance` | `src/target.js:113-120` (pcaao.js:1594-1605, float32) |
| `target::enemy_type_group`, `attack_modifier_flags_of`, `enemy_type_bonus_range`, `enemy_type_bonus_value`, `enemy_type_bonus_values` | `src/target.js:128-169` |
| `target::is_skeletal_target`, `silver_applies`, `skeletal_silver_damage` | `src/target.js:178-193` |
| `target::monster_hide_damage`, `intrinsic_damage` | `src/target.js:200-250` (pcaao.js:1447-1471) |
| `target::armour_material_id`, `armour_condition_multiplier`, `armour_reduction`, `shield_reduction` | `src/target.js:272-323` |
| `target::struck_slot_item`, `left_hand_shield`, `has_worn_equipment` | `src/target.js:326-346` |
| `target::shield_block_chance`, `shield_beats_under_armour` | `src/target.js:352-402` |
| `target::target_part_outcomes`, `target_part_damage`, `target_expected_damage` | `src/target.js:416-475` |
| `target::body_part_weights` | `src/target.js:478-485` |
| `target::equip_armour` (pieces already minted) | `src/target.js:503-523` |
| `target::armour_piece_current` (the condition half of `armourPiece`) | `src/target.js:489-493` |

Vendored helpers (`vendored.rs`): `career_attack_modifier` (combat/formulas.js:191), `silver_doubles` (:468),
`enemy_entity_group` (combat/enemyGroups.js:69), `is_shield_template` (systems/armorMaterials.js:74),
`material_armor_value` (:53), `item_armor_value` (:114), `slot_for_body_part` (systems/equip.js:496),
`armor_body_parts` (:452), with `armorSlotRule` (equip.js:436), `condition_percentage`
(systems/item/itemTemplates.js:277), `enemy_entity_type` and `enemy_career_index` (characters/enemy/enemyBasics.js:108,
:117), `enemy_armor_values` (combat/enemyEquipment.js:298).

### Not ported (R3b)

- `gearEnemy` (target.js:555) and everything that builds a target: `mintRow`, `mintedBody`, `makeTarget`,
  `enemyTarget`, `standInTarget`, `careerIndexOf`, `isClassEnemyOf`, `wholeLevel`, `targetStats`, `skillsAtLevel`.
- `materialRequirementMultiplier` (target.js:574) and `targetGroupOf` (:595): after `gearEnemy` in the file.
- The item minter behind `armourPiece`: `armorOfMaterial` (combat/enemyEquipment.js:210) is
  `mintCondition(setItemFields(...))`, which reads the 288-template data (`itemTemplates.json`), the RRI and
  weapon tables and the value ladder. `armourPiece` is therefore ported only as its condition arithmetic
  (`armour_piece_current`); `equip_armour` takes pieces that are already items. The descriptor path of
  `equipArmour` (`piece?.group === 'Armor' ? piece : armourPiece(...)`) needs the minter and is R3b.
- The enemy equipment rolls: `rollEnemyEquipment`, `assignEnemyEquipment`, `equipmentVariantFor`
  (enemyEquipment.js), and `bootedEquipmentAssigner` (target.js:538).

### Registries and domains (decisions)

- Registries are modelled EMPTY. On the import path `src/target.js` reaches, nothing registers an answer:
  `registerEnemyGroup` is called only inside `installEnemyExpansion` (dexInstall.js:241), and nothing
  calls `registerSilverDoubleVeto`, `registerCustomArmorValue`, or the custom-enemy/custom-item registries
  at import. A mod that registers one would change the port; the port has no hook for it.
- `customItemClass` (rriItems.js:626) reads the built-in `RRI_CLASSES`, whose keys are 513..=526 only.
  `armorSlotRule` and `pieceBodyPart` therefore use the classic rule table for every template outside 513..=526.
  The vectors stay outside that range. Inside it, the port is NOT exact (it would need the RRI class table).

### JS semantics decided here (review these)

- `undefined` vs `null`: `isClass` is `Option<bool>` because the JS tests `=== false`; `None` (undefined) and
  `Some(false)` differ, and `!!isClass` reads both as false. Other `?? x` reads treat `null` and `undefined` alike.
- An item is `Option<&Item>`: a JS `null` item is NOT the same as `{}` (`armourConditionMultiplier(null)` is 1,
  `armourConditionMultiplier({})` with `sharpEdge` is 0.85).
- A career: `null` and an object without the flag bytes read identically in every function here, so the
  port takes `Career` (a default is the null career).
- A missing base stat is NaN in `Live::stats` (`NUM` reads it as 0), and a missing mod is 0 (`?? 0`).
- `Weapon.item_flags` is `weapon.item?.flags` flattened: the functions read nothing else of `item`.
- `Item.is_armor` is `group === 'Armor'`: every other group name compares unequal to it.
- `Effect::Other` covers every kind that reads no stat; `ended` is read for all kinds, as liveStat does.
- `element_share`'s element is lower-cased with Rust `to_lowercase`; for the five names it equals JS
  `toLowerCase`. A prototype name (`constructor`, `__proto__`) is a truthy non-flag in JS and reads as 1, the same as a miss.
- `monster_hide_damage`'s `nat` is `Option`: `None` is the JS default parameter (`naturalDamageResistance(target)`).
- The `monsterHideDamage` switch: the JS `case 26` and the Daedra default both return `r(1)`; the port returns
  `1` for them without a separate arm (the result is the same multiplier).
- `target_expected_damage` returns `Option<f64>`: JS `null` (no part with a weight) is `None`.
- `body_part_weights`' `counts[part]++` is asserted to index 0..=6 (`debug_assert`); the data is.

### Not representable (the vectors never pass these)

A JS value that is not a number where a number is read (a string stat, a boolean flag byte, an array
where a number is read), a JS `null` for `nat` (JS would read it as 0; the port takes `None` as the default),
a `core` other than `'overhaul'` (any other string is the classic list; the vectors pass `overhaul`,
`struck` and `undef`), a `map` other than the four the vectors name, a lone surrogate in an element name,
and a `weights` value that is `null`.

### Vectors (`tools/rust-vectors.mjs`, `target.txt`)

- Targets come from the REAL builders: `enemyTarget` for every mobile id 0..=42 and the classes 128..=146 at
  player levels 1, 9 and 37 (refused rows are counted, not skipped silently), `standInTarget` (31, 36),
  `makeTarget` synthetic foes (with random stats, effects, `_mods`, careers, armour), and gear worn through the
  REAL `armourPiece` and `equipArmour`. Attackers are `makeTarget`-style records with random stats and
  effects. Each target and attacker is written once as a `tgt`/`atk` definition; cases refer to them by id.
- Ten families, each at least 2000 cases (the test asserts it): `career`, `natural`, `enemy_type`, `silver`,
  `hide`, `armour`, `shield`, `outcome`, `equip`, `scalar`. The generator prints the targets and the count of
  each kind. The floors are per family, so `body_part_weights` (three cases) counts toward `scalar`.
- Damage grids include 0, -0, 1, fractions, 2.5/3.5/4.5 ties, huge values, 5e-324, 1e-9, NaN and infinities.
  Armour covers the templates 102..112 (plate, chain and leather rows, the shields, the cuirass, both pauldrons)
  against materials and conditions, with and without sharp edge. Shield rows cover block and no-block parts.
- Format: the `=>` token separates inputs from outputs (as in the other kinds); `-` is JS null/undefined
  for an opt; `ITEMOPT` is `0` or `1` and an ITEM; `WOPT` is `0` or `1` and four opts.

### Run (R3a)

```
node tools/rust-data.mjs            # REQUIRED first: writes formulas.rs, equip.rs, equip_rules.rs and the
                                    # extended armor_materials.rs, enemy_groups.rs, enemy_equipment.rs
node tools/rust-data.mjs --check
node tools/rust-vectors.mjs         # writes rust/tests/vectors/target.txt (and the other modules)
cd rust && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Until `node tools/rust-data.mjs` is run, the crate does not compile (the new generated modules are missing).

## Plan after R2 (R2 is done; the rest is a plan)

Order chosen by dependency; each step ships only with vectors (or the upstream goldens) that fail first.

1. **R2, data tables (done, see above).** It was the main blocker: the model reads `src/data.js` and the vendored upstream
   tables (`vendor/upstream/a3eb1605/src/...`), which are JS modules. Recommended: generate Rust
   `const` tables with a generator in the same style as `tools/rust-vectors.mjs` (import the real
   JS, emit `rust/dfo-core/src/generated/*.rs`, with a header and a `--check` mode that fails if
   the committed output is stale). Why: no JS runtime and no parser at run time, tables are
   reviewable, and the vendor hash check already pins the source. Reading the JS at run time would
   need a JS interpreter or an ad-hoc parser; a second hand-copy would break "one source of truth".
   Then port `swing*` (needs the `SWING_*` tables) and `classicStrength`.
2. **R3, target** (`src/target.js`): resistances, parts, `makeTarget`; pure given R2 tables.
3. **R4, blow outcomes and rolls** (`src/blowOutcomes.js`, the roll/crit/dodge stages of
   `src/model.js`): the first place `rng` streams and `damage` meet; differential against the JS
   with the same seeds (the JS `rng.js` is the generator, so sequences already match).
4. **R5, model analysis** (`src/model.js` `analyze`, gear lines `src/gearLines.js`, enchants,
   dual wield): the biggest module; split by stage with a vector set per stage.
5. **R6, fight loops** (`src/fight.js`, `src/simulateFight.js`, `src/cws.js`,
   `src/durability.js`): stateful, depend on R3-R5 and on `rng` traces.
6. **R7, relay fight and objectives** (`src/relay*.js`, objectives): depend on R6 plus the
   already ported `allowance`/`relay_claim`.
7. **R8, CLI and reports** (`src/cli.js`, `src/report.js`, `src/graph.js`): I/O last, once the
   core is proven; keep it a thin layer over the library.

Open choices for the maintainer: whether the (6.8 MB) vector files are committed or regenerated in
CI, and whether `rust/` gets its own CI job (`cargo test`, `fmt --check`, `clippy -D warnings`).
