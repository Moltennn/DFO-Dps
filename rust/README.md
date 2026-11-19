# dfo-core (Rust), milestones R1 and R2

## R6a: whole fights and Cast When Strikes

`fight` and `fight_relay` return the JS result records (including the full analysis snapshot and relay run).
The JS `.with(edit)` closures are explicit `fight_with` and `fight_relay_with` calls. Relay fights reuse
the existing allowance simulator and evaluate each claim at the current pool share.

`cws` takes the spellbook and roll stream explicitly. Casts and ticks take a mutable target and optional
mutable hurt sink. The sink gets metadata on DoT rounds only. Equipment overlay callers borrow the actual
worn entry for object identity, and supply an evaluated live magicka accessor if there is one. Condition
bills use the existing mutable durability owner and item, after the cast; no stochastic fight host is added here.

`tools/rust-fight-vectors.mjs` requires the real `SPELLS.STD` and compares full ordered results by f64 bits.
The fixture also includes narrowly constructed mixed spells and script overrides at individual roll indices.
Every replay checks the draw count, and every vector family has a minimum of 2,000 cases. The indexed probes
share identical inputs and expected results by reference; the generated fixture is still several hundred MB.

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

## R3b: the builders, gearEnemy and the enemy equipment (written; the lead runs the gates)

Written without a shell: the generator, the vectors and the crate are unrun. The gate order is in "Run (R3b)".

### Files

- `dfo-core/src/mint.rs`: `mint_row` (target.js:640), `make_target` (:713, `MakeFields`), `enemy_target` (:758, `EnemyOpts`),
  `stand_in_target` (:803), the private `minted_body` (:669), `skills_at_level` (enemyEntity.js:111-114 over every skill),
  `material_requirement_multiplier` (:574), `target_group_of` (:595), `enemy_row_of` (:607), `career_index_of` (:709),
  `is_class_enemy_of` (:710).
- `dfo-core/src/gear.rs`: `gear_enemy` (target.js:555), `assign_enemy_equipment` (enemyEquipment.js:228),
  `roll_enemy_equipment` (:238), `equipment_variant_for` (:397), `assign_rri_enemy_equipment` (rriEnemyEquipment.js:240,
  reached through the Enemy Expansion delegate, dexEquipment.js:104), `roll_enemy_weapon_poison` (poisons.js:250),
  `convert_orcish` (rriEnemyEquipment.js:434, private), the DEX copy's reads (`dex_class_table` dexEquipment.js:39,
  `dex_armour_template` :83), the equip table (characters/equipTable.js:33-129; systems/equip.js:404), `mint_armour`
  (target.js:489 `armourPiece` over `armorOfMaterial`, combat/enemyEquipment.js:210).
- `dfo-core/src/boot.rs`: `Boot` and `RriSwitches` (below).
- `dfo-core/src/rolls.rs`: the `Rolls` trait (`roll() -> f64`, one call per JS `rolls()`), and the blanket impl for closures.
- `dfo-core/src/vectors_canon.rs`: the token forms the vectors compare (`f`, `b`, `s`, `list`, `opt`, `join`).
- `dfo-core/src/vendored.rs` (extended): `CustomClass` and `custom_item_class` (rriItems.js:626), gate-aware
  `armor_body_parts_with`, `enemy_armor_values_with`, `piece_body_part` (enemyEquipment.js:290). The R3a names are
  wrappers with the RRI gate off, so the R3a vectors are unchanged.
- `dfo-core/src/target.rs` (extended): `Career` gains `weapon_armor_shields_bitfield` and `stats`; `Target` gains
  `has_career`, `mobile_type`, `affinity`, `group`, `skills`, `min_metal_to_hit`, `spare_gear`, `health`, `max_health`,
  `relay_body`, `level_source`, `basics`; `Effect::Other` gains `ended` (liveStat skips an ended effect of any kind,
  save.js:171). `equip_armour_with` takes the RRI gate. `math_round` moved to `round.rs` (pub).
- `dfo-core/src/round.rs`: `math_round` (JS `Math.round`: ties toward +Infinity, `-0` for `-0.5 <= x < 0`), with a
  `math_round` vector family and tests.
- `tests/maketarget.rs`: reads `tests/vectors/maketarget.txt`; `tests/round.rs` and `tests/target.rs` updated (R3a green).
- Generated (`tools/rust-data.mjs`; the generator is the only writer):
  - `mint_rows.rs`: `MINT_ROWS`, keyed `"<boot code>/<mobile id>"`, the row `mintRow` returns for every integer classic id
    (0..=42, 128..=146) under every boot code 0..7. `force`: every record field is an `Option`.
  - `dex_equipment.rs`: `DEX_EQUIPMENT_TABLE`, keyed `"<mudex 0|1>/<id>"`: the classic row's `equipmentTable` (dexRead).
  - `item_templates.rs`: `ITEM_TEMPLATE_FACTS` (hitPoints, variants) for the 288 DFU templates. Force: all Option.
  - `weapons.rs`: `WEAPON_MATERIALS`, `CONDITION_MULTIPLIERS_BY_MATERIAL`, `WEAPON_CONDITION_POOL` (weapons.js:90-123).
  - `rri_items.rs`: `RRI_CLASSES` (513..=526; `group`, `equip_slot`, `item_hands`), `RRI_CHAIN_FOLD` (a probe of each
    class's `onVariantSet`: the light set folds Chain to Leather with `message` 1), `RRI_ENABLED_DEFAULTS` (the four
    switches' shipped defaults, modSettings.js:1423-1523). Force: all Option.
  - `mobile_types.rs` (`MOBILE_TYPES`), `poisons.rs` (`POISON_START_VALUE`), `create_item_rows.rs` (the robes' indices),
    `equip_rules.rs` (now also `ITEM_GROUPS`, `WEAPON_HANDS`, `SHIELD_INDICES`).
  - `canon_rows.rs`: `canon_mint_row` and `canon_enemy_basics_row`, the token form of the two row records (generated
    from the same type tree as the tables, `canonStmt`/`recInto`; `#[rustfmt::skip]`).

### Ported functions and the JS they cite

| Rust | JS |
|---|---|
| `mint::mint_row` | `src/target.js:640-647` (the table is `mintRow` evaluated, see below) |
| `mint::make_target` | `src/target.js:713-742` |
| `mint::enemy_target` | `src/target.js:758-792` (`wholeLevel` :651, the override and `levelSource`) |
| `mint::stand_in_target` | `src/target.js:803-812` (the roll is `() => 0.5`, :804) |
| `mint::minted_body` | `src/target.js:669-707`, `characters/enemy/enemyEntity.js:160-233` (the level and the City Watch roll :207) |
| `mint::skills_at_level` | `enemyEntity.js:111-114`, `target.js:589-592` |
| `mint::material_requirement_multiplier` | `src/target.js:574-582` |
| `mint::target_group_of` | `src/target.js:595-603` |
| `mint::enemy_row_of` | `src/target.js:607` (the shipped table) |
| `mint::career_index_of`, `is_class_enemy_of` | `src/target.js:709-710` |
| `gear::gear_enemy` | `src/target.js:555-567` |
| `gear::assign_enemy_equipment`, `roll_enemy_equipment`, `equipment_variant_for` | `combat/enemyEquipment.js:228-276, :397-403` |
| `gear::assign_rri_enemy_equipment` and `assign_class` | `combat/rriEnemyEquipment.js:240-425` with `dexEquipment.js:94-99` |
| `gear::convert_orcish` | `combat/rriEnemyEquipment.js:434-466` (the armour and weapon materials; `items` not visited) |
| `gear::roll_enemy_weapon_poison` | `systems/poisons.js:250-263` |
| `gear::dex_class_table`, `dex_armour_template`, `class_by_name` | `systems/enemyExpansion/dexEquipment.js:31-90` |
| `gear::get_equip_slot`, `item_hands`, `wear_leavers`, `Table::first_slot` | `characters/equipTable.js:33-129`, `systems/equip.js:404-414` |
| `gear::mint_armour` | `src/target.js:489-494` over `combat/enemyEquipment.js:210`; the template by `itemTemplates.js:336-350` |
| `vendored::custom_item_class` | `systems/roleplayRealismItems/rriItems.js:626-631` |

### The mint row is generated, not re-run

`mintRow` reads the vendored CSV tables of Enemy Expansion (`dexRead`, the 50 mobile records and their lines) and applies
Meaner Monsters' and PCAAO's folded edits. The input domain is finite and vendored: every integer classic id under every
boot switch combination (8 codes). `tools/rust-data.mjs` evaluates the real `mintRow` over that domain (`buildMintRows`),
and the Rust looks the row up. So `dexRead`, `dexClassicRow`, `writeEnemyLine`, `applyMeanerMonsters`,
`pcaaoMeanerMonstersRow` and `DEX_VENDOR` are not ported; their output is. The generator throws if a row lacks
`minMetalToHit` (the body reads it, and a JS `undefined` there would differ). The DEX `equipmentTable` the copy reads per
mudex is generated the same way (`buildDexEquipment`).

### The boot (`Boot`)

`UPSTREAM_BOOT` (target.js:629) is the shipped boot: each mod's `Enabled` default (`shippedOn`, target.js:626), so `pcaao`,
`meanerMonsters` and `enemyExpansion` are all true (`systems/modSettings.js`). In the JS, a builder's `boot` argument is one
such set of mods, and `gearEnemy` reads the module-level `UPSTREAM_BOOT` (it has no boot argument). `Boot` replaces both:
three mod switches, the four RRI switches (`RRI_ENABLED_DEFAULTS`), and `bow_left_hand` (the settings read
`Enhancements.BowLeftHandWithSwitching`, default `False`, settingsDefaults.js:204). `Boot::code` is the row-table key.
No settings store or global is read by the port.

### Scripted rolls

Every JS `rolls` argument is an explicit input. The generator (`rollScript`) draws a script of 512 values from its PRNG
(with 0 and the largest double below 1 as edges), passes it to the JS, and writes the values the JS consumed, as f64
bits, before the `=>`. The Rust replays exactly those values through `Rolls` and asserts it drew the same number
(`rolls_done`). A case where the JS draws more or fewer than the port is a failure. An absent roll function (JS null) is
`-` (a third of the enemy cases); the City Watch knight then refuses unless `exactLevel`, as in the JS.

### gearEnemy under each boot

`gearEnemy` reads `UPSTREAM_BOOT`, so the generator loads one copy of `src/target.js` per boot code (`targetUnderBoot`): the
copy has the same source with every import rewritten to an absolute URL (so every vendored module is the same instance)
and the single `UPSTREAM_BOOT` line replaced by the boot under test. The copy is written to the OS temp directory and
removed after the import. Only that one line differs.

### Vectors: `tools/rust-vectors.mjs` writes `maketarget.txt`

Grammar (one case per line, `kind tokens... => output`; the output of a target, row or career is ONE token, its fields
joined by `,` for a target and `;` for a row; `!` is a JS RangeError, the refusal):

| Kind | Inputs | Output | Floor (cases) |
|---|---|---|---|
| `mint` | `F id`, `I code` | row token or `-` | `mint` 2000: 311 ids x 8 codes = 2488 |
| `make` | the fields in `makeTokens` order (see below) | target | `make` 2000: 2400 |
| `enemy` | `F id`, `I code`, `O playerLevel`, `O level`, career, `a` armorValues or `-`, `O health`, `O maxHealth`, `B exact`, ROLLS | target or `!` | with `stand`: `enemy` 2000: 3968 + 496 |
| `stand` | `F id`, `I code` | target or `!` | (counted with `enemy`) |
| `gear` | `F id`, `I code`, `O L` (the class's player level), `O PL` (gearEnemy's), career, ROLLS | target after gearEnemy, or `!` | `gear` 2000: 3968 |
| `mrm` | `O min`, `-` or `w O material`, `B soft` | `F` | `scalar` 2000: 1200+400+200+200+200 |
| `tgo`, `erow`, `cidx`, `iscl` | (see the generator) | `O` name, row, `F`, `B` | (counted with `scalar`) |
| `classic` | `F id`, `B isClass`, `O variant`, `F armor`, `F playerLevel`, ROLLS | GEAR_OUT | `classic` 2000: 2400 |
| `rri` | `F id`, `B isClass`, `O variant`, `F playerLevel`, `O level`, `F armor`, `B mudex`, `O team`, `O bitfield`, ROLLS | GEAR_OUT | `rri` 2000: 2400 |

ROLLS is `I n` then n f64 (the consumed values), or `K F I` (every roll is the f64 F, and I is how many the JS drew: the
constant-fill form of the boundary probes), or `-` (no roll function). GEAR_OUT is `right` (`-` or `W tmpl mat`),
`left` (`-`, `S tmpl` for a shield marker, or `W tmpl mat`), `I n` then n x `(F piece, F material, B shield)`, seven f64
armour values, and the poison (`O`). A career is `-` or `c` and fourteen opts (six flag bytes, eight stats). A make field
is `-` when the key is absent; `minMetalToHit` is `u` for a key present with `undefined`. The grammars the Rust reader
(`tests/maketarget.rs`) accepts are these, token for token.

The canonical target (`canonTarget` in the generator, `canon_target` in the test) is: `isPlayer`, `isClass`,
`careerIndex`, the career (or `-`), `level`, `combatLevel`, `mobileType`, `affinity`, `group`, the eight stats (a missing
one is NaN), `skills` (count, then id and value), `armorValues`, the worn items by slot id ascending (group Armor, template,
material, artifact, max and current condition), `minMetalToHit`, `spareGear`, `health`, `maxHealth`, `relayBody`,
`levelSource`, the effects (tag `M` disease/poison/artifact, `R` racialOverride, `F` fortify, `D` drain/transfer, `X`
other; `ended`; the payload), the eight `_mods` stats and eight `statMax` values (missing is 0), and the `basics` row.

### Not ported, and why (provably unreachable or unobservable on the target path)

- `dexRead`, `dexClassicRow`, the CSV readers, `writeEnemyLine`, `applyMeanerMonsters`, `pcaaoMeanerMonstersRow`: replaced by
  the generated mint rows and DEX tables (above). Their domain is finite and the generator covers all of it.
- `mintedBody` is private in the JS (reached only through `enemyTarget` and `standInTarget`), so the vectors test it through
  those.
- `markFound` (systems/item/foundMark.js): a mark on a piece, never read by a target field.
- The item names and values (`setItemFields`'s `name` and `value`, `itemBaseValue`): not on the target.
- A weapon's condition (`wornCondition` draws its roll, ported; the result is not read). The archer's arrow pile: its two
  draws are ported, the pile is in `items` and never worn. The loot `items` and `equipmentItems`.
- `getArmorTemplateIndex` and `RRI_READ` (rriEnemyEquipment.js:125, :227): the non-DEX reads. `gearEnemy` reaches the RRI
  arm only through the DEX delegate, so the copy's reads are the only ones on the path.
- The thunderlock, pistolet and hand-wrap rows of `getItemHands`: their templates are never minted by the enemy arms.
- `materialRequirementMultiplier`'s callers and the formula-override registry (`formulas.js` `formulaOverride`): empty on
  this path (no mod registers one; see the R3a registries section).

### The RRI class templates

The RRI rows 513..=526 are not registered in the port (the mod's ItemTemplates.json is not read), so `templateByIndex`
answers null for them and the minter gives `maxCondition` 0 (itemTemplates.js:340, `t?.hitPoints ?? 0`). `buildTemplateFacts`
asserts the null, so a registration would fail the generator instead of silently changing the port. The class's material
value is the armour ladder (`itemArmorValue`: `_customArmorValue` is never registered, armorMaterials.js:110-123).

### JS semantics decided here (review these)

- `gearEnemy` reads `UPSTREAM_BOOT`: the port takes the boot explicitly; the vectors cover all eight boots with module
  copies, so the module-level boot is exercised, not assumed.
- The DEX delegate answers first when Enemy Expansion is on (dexEquipment.js:104); it answers `null` (so ItemHelper's arm
  runs) only when `realisticEnemyEquipment` is off. The `mudex` it reads is `enemyExpansion && meanerMonsters` (target.js:539).
- `equipArmour` re-mints each armour piece from its template and material (target.js:507): a piece's condition is its
  maximum, and a Chain light piece is Leather with `message` 1 (the fold), so the target's material can differ from the arm's
  piece. `enemyArmorValues` reads the arm's own material. Both are ported.
- `enemyArmorValues` uses `itemArmorValue(a.item)` for an RRI piece; with no custom armour value registered that is the
  material ladder of the piece's material, equal to `materialArmorValue(a.material)` (the port uses the latter).
- `ARROW_TEMPLATE` is 131 (`systems/inventory.js:142`, `WEAPONS.Arrow`; `scenes/corpseMarker.js:29`), written as a Rust
  constant, not generated (`WEAPONS` in `data.js` is keyed by index). The vectors check it: only the arrow draws a roll.
- `getItemHands` reads the setting (`getBool`, default false); the port's `bow_left_hand` is false. The vectors do not vary
  it, so the `true` branch (LeftOnly bow) is unexercised by the vectors (a stated gap).
- `Math.random` defaults: every JS call in the path is passed its roll; no default is taken (checked by reading each call).
- `skillsLevel` (enemyEntity.js:111) is re-stated in `mint.rs` (`skills_at_level`), not imported, because it is a
  vendored helper that R3a did not port.
- `minMetalToHit`: the generator asserts every mint row has it, so a body always carries a number; `Target` keeps the
  `Option` so a JS `undefined` would still read as one.

### Boundary probes (R3b, second pass)

Mutation testing showed that the random sequences rarely land a roll in a threshold's narrow band (a chance of 5 with
the roll in [0.05, 0.06)). So each arm also runs with probes at the flip points of every threshold it tests.

For a decision `floor(r * N) < T` (a dice100 chance, N = 100) or `lo + floor(r * width)` (a range, N = width), the flip
points are the bucket starts `b(k)` = the least double r with `floor(r * N) >= k`. The generator (`bucketStart`,
`boundaryValues`, `indexValues`, tools/rust-vectors.mjs) takes for each threshold T the starts of buckets T-1, T, T+1
(so a +-1 change of T flips a probe), their predecessors (the just-below double), and the successor of each start.
Range widths N = 2..8 and 13 get every bucket start and predecessor; the material ladder gets the partial sums of
`MATERIALS_BY_MODIFIER` (N = 256).

Some branches are reachable only through a second roll that a constant fill cannot pass: the classic and RRI secondary
weapon (the first 50% test must fail and the second pass, and one constant does both), and the Dai-Katana's 90% re-roll
(after a range picks 123). For those bases the background is the first of 256 seeds whose run takes the branch
(`wantLeftWeapon`, `wantDaiKatana`), so the index probes overwrite a roll of that branch. The generator warns if no seed
does. The gear family cannot observe the secondary weapon (weapons are not on the target), so those are classic and RRI
only.

Two sequence kinds per base case:
- `K F I` (a constant fill): every roll is the value F, and I is how many the JS drew. One line per boundary value
  probes every decision of the base at once.
- `I n F*` with one index overwritten: a random sequence (seeded from the base's inputs) whose k-th roll is replaced by a
  boundary value, for the first 8 decisions of the bases marked `indexed`. This isolates a decision whose outcome a
  constant fill would mask (a branch the earlier decision skipped).

The bases (each a family of its own, under 10k lines each; the generator prints the counts):

| Kind | Bases | Lines per base |
|---|---|---|
| `bclassic` | 12 classic loadouts: a monster (variants null, 0, 1, 2; player level 1, 2, 9, 10, 11, 45), a class (variant 0 or 1 or 2), the city watch | ~240 constant; 8 x ~53 per indexed base |
| `brri` | 19 classes (variant 0, bitfield 0 or 256 for plate), 7 combat classes with variant 1, orcs/centaurs with their variants (Orcs convert), a monster with none | ~240; indexed for 4 |
| `borcish` | the four Orcs-team types (7 orc, 12 orc sergeant, 21 orc shaman, 24 orc warlord) at levels 1, 8, 9, 10, 45 (the Warlord 1, 5, 6, 9, 45) | ~200 constant per level; at level 9 every decision index (~20 x ~50) over an Ebony (Mithril for the Warlord) background the 80% test leaves unconverted; at level 45 the conversion roll's index alone over a Mithril background. The generator checks the last roll is the conversion roll (it flips at 0.80) |
| `bgear` | 19 classes (code 7, city watch level 9), 4 classes (code 5, DEX on and Meaner Monsters off), 7 monsters (career indices 0, 6, 7, 8, 12, 21, 24) | ~240; indexed for 4 |
| `benemy` | the City Watch knight (146) at player levels 1, 2, 9, 45, boots 0 and 7 | ~240 |
| `bpoison` | `rollEnemyWeaponPoison` (poisons.js:250) for mobs 0, 7, 8, 12, 21, 24, 135, 139, 141, 146 at player levels 1, 2, 9 | ~240 constant at levels 1 and 9; at level 9 also a PAIR per boundary value (the chance roll 0, which passes both the 5 and the 60 percent tests, then the value as the type roll) and the chance's index probes |

The poison roll is reached by the RRI arm only for monsters (a class never enters that branch), so the Assassin's 60
percent is probed through `bpoison` directly. The rolls of every base are the rolls the JS draws; the Rust replays them
and asserts it drew the same number.

Every threshold the arms test a roll against (JS line and the Rust function that ports it):

| Threshold | Where (JS / Rust) | Probed by |
|---|---|---|
| dice100 chance 0 (initial, variant null) | `enemyEquipment.js:246`, `gear.rs roll_enemy_equipment` | constants (0 edge), `bclassic` null variant |
| dice100 chance 50 (variant 0: weapon and shield chance, and the six pieces) | `enemyEquipment.js:248-273`, `roll_enemy_equipment` | constants (49, 50, 51 edges), `bclassic` |
| dice100 chance 75 (variant 1) | `enemyEquipment.js:261`, `roll_enemy_equipment` | constants (74, 75, 76), `bclassic` variant 1 |
| dice100 chance 90 (variant 2) | `enemyEquipment.js:262`, `roll_enemy_equipment` | constants (89, 90, 91), `bclassic` variant 2 |
| `range(Broadsword, Longsword)` width 3 | `enemyEquipment.js:247`, `range_incl` | N = 3 edges |
| `range(Buckler, Round_Shield)` width 2 | `enemyEquipment.js:249`, `range_incl` | N = 2 edges (prevDown of 0.5 moves the shield id) |
| `range(Dagger, Shortsword)` width 4 | `enemyEquipment.js:254`, `range_incl` | N = 4 edges |
| `range(Claymore, Battle Axe)` width 6 | `enemyEquipment.js:257`, `range_incl` | N = 6 edges |
| `floor(r x 256)` material bucket, clamp 256, ladder | `enemyEquipment.js:105-110`, `random_material` | N = 256 partial sums, `bclassic` |
| `levelModifier >= 0` (x2, else x4), `- 10` | `enemyEquipment.js:103-104`, `random_material` | `bclassic` player levels 9, 10 |
| `1 + floor(r x 100)`, `roll >= 70`, `roll >= 90` | `enemyEquipment.js:119-124`, `random_armor_material` | N = 100 edges (69, 70, 71, 89, 90, 91) |
| `variant === 0`, `=== 1` (75), `=== 2` (90) | `enemyEquipment.js:246-262` | `bclassic`, `brri`, `bgear` |
| career 7/21 -> 0, 8/12 -> 1, 24 -> 2; class `floor(r x 2)` | `enemyEquipment.js:398-401`, `equipment_variant_for` | `bgear` (monsters 0, 6, 7, 8, 12, 21, 24; classes); N = 2 edges |
| convertOrcish dice100 80 (drawn last, only for team `Orcs`) | `rriEnemyEquipment.js:435`, `convert_orcish` | constants (79, 80, 81); `borcish`: every decision at 79/80/81 (and nextUp of 0.80) over an Ebony background, and the conversion index alone over a Mithril one |
| convertOrcish `convertFrom`: Ebony 7, Warlord (24) Mithril 5; `(material & 0xff) >= convertFrom` | `rriEnemyEquipment.js:436-437`, `convert_orcish` | `borcish` (Ebony background: a Mithril one stays Mithril; Warlord's Mithril background converts), levels 8/9 and 5/6 |
| convertOrcish `orcish` target: `WM.orcish` (8) weapons, `ARMOR_MATERIAL.orcish` (520) plate | `rriEnemyEquipment.js:440, 447`, `convert_orcish` | `borcish` (every converted output carries the Orcish material) |
| Ebony reach: combined `>= 250` (ladder step 7); Mithril `>= 237` (step 5) | `enemyEquipment.js:99-112`, `random_material` | `bclassic` and `borcish` at levels 8, 9 (Ebony) and 5, 6 (Mithril) |
| poison: `playerLevel <= 1`; dice100 5; Assassin 60; `128 + floor(r x 8)` | `poisons.js:251-262`, `roll_enemy_weapon_poison` | `bpoison` (all 3 levels, mobs incl. 139), N = 8 edges |
| DEX coin `floor(r x 2) == 0`; forbidden plate/chain/leather bits | `dexEquipment.js:50-89`, `dex_armour_template` | N = 2 edges, `brri` bitfields 0 / 256 / 448 |
| class arm: dice100 chance 50 (the class's chance) | `rriEnemyEquipment.js:277`, `assign_class` | constants 49/50/51, `brri` |
| shortblade dice100 40, range 113..117 (width 5) | `rriEnemyEquipment.js:93`, `random_shortblade` | constants 39/40/41, N = 5 edges |
| secondary weapon `range(0, 4)` | `rriEnemyEquipment.js:95`, `secondary_weapon` | N = 4 edges |
| big weapon `range(122, 129)` width 7, dice100 90 for the Dai-Katana | `rriEnemyEquipment.js:88-89`, `random_big_weapon` | N = 7 edges, constants 89/90/91 |
| bow `range(129, 131)` width 2; longblade width 3; blunt width 3/4, axe width 2/3 (`oneOf`) | `rriEnemyEquipment.js:71-92`, the `range_excl` helpers | N = 2, 3, 4 edges, `brri` |
| combat-class armoured start 100/80/90/30; the head and legs `+50` (barbarian); the -10/-10/-10/-20 steps; `armored > 0` | `rriEnemyEquipment.js:278-399`, `assign_class` | constants (every BOUND_T100 edge), `brri` (classes with the 60, 80, 90, 30, 35, 65, 75 armour) |
| arrow stack `range(4, 17)` width 13 | `rriEnemyEquipment.js:296`, `assign_class` | N = 13 edges |
| robes variant `range(0, variants)` when the template has variants | `rriEnemyEquipment.js:191`, `mint_clothing` | N = 8 edges (the robes' variant count is not read here; a mismatch fails the replay) |
| city watch `3 + floor(r x 4)` | `enemyEntity.js:207`, `mint.rs minted_body` | `benemy` (N = 4 edges, levels 1, 2, 9, 45) |

### Run (R3b)

```
node tools/rust-data.mjs            # REQUIRED first: the new generated modules and the extended equip_rules.rs
node tools/rust-data.mjs --check
node tools/rust-vectors.mjs         # writes rust/tests/vectors/maketarget.txt (and round.txt with math_round)
cd rust && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Until `node tools/rust-data.mjs` runs, the crate does not compile (the new generated modules are missing). The vector
files are not committed; the maketarget file is the largest of the set (several MB; the size is not measured here).

## R4a: the value codec, the save helpers and the item readers (written; the lead runs the gates)

Written without a shell: the generator, the vectors and the crate are unrun. The gate order is in "Run (R4a)".

### Files

- `dfo-core/src/value.rs`: `Value` (`Undefined`, `Null`, `Bool`, `Num(f64)`, `Str(String)`, `Arr(Vec<Value>)`,
  `Obj(Vec<(String, Value)>)`), the JS reads (`get`, `at`, `has`, `set`, `prop`, `truthy`, `strict_eq`, `same_value_zero`,
  `finite_or`, `num_or`, `num_or_default`, `to_number`, `to_js_string`, `array_index`, `items`, `is_str`), `number_to_string`
  (`Number::toString`), `string_to_number` (`Number(string)`), the codec `parse` and `write`, and the table reads
  `obj_table_get` (a JS object keyed by integers: the key compares as its string) and `map_table_get` (a `Map`:
  SameValueZero, so `"113"` does not find 113).
- `dfo-core/src/save.rs`: the pure half of `src/save.js` over a character `Value`.
- `dfo-core/src/gear_lines.rs`: `src/gearLines.js` over `loot.rs`.
- `dfo-core/src/sockets.rs`: `src/sockets.js`.
- `dfo-core/src/loot.rs`: the lootRarity readers in the call tree of `readLines`, `validAffix`, `gemLine`, `socketGems`,
  `socketsOf`, `socketMax`, `countedPieces`, `powerIdsOf`, `powerOf`, and `foeGroup` (lootPowers.js).
- `tests/value.rs`, `tests/save.rs`, `tests/gear.rs` (gear and sockets), `tests/loot.rs`. `tests/common/mod.rs` gains
  `load_with_defs`, `Case::value` (a token, or `@<index>` for a definition) and `Case::check_out` (`=>` then the canonical
  write of the Rust value, compared as text: bit-exact, NaN canonical).
- `tools/rust-codec.mjs`: `encodeValue` (the JS side of the codec). `tools/rust-vectors.mjs` re-exports it. It lives in its
  own module because `tools/rust-data.mjs` needs it (the generated legendary-power tokens), and importing `rust-vectors.mjs`
  from there would run the whole generator. The brief named `rust-vectors.mjs`; this is the one place it differs.
- Generated (`tools/rust-data.mjs`; the generator is the only writer):
  - new `save_tables.rs`: `SLOT`, `WEAPON_SKILL`, `PROFICIENCY_FLAG` (save.js:110-129), `ENHANCE_SKILL_MOD` (save.js:189);
  - new `gem_grades.rs`: `GEM_IDS`, `GEM_GRADES`, `GEM_ROW_GRADES`, `ALL_GEM_IDS`, `GEM_GRADE_TEMPLATE_BASE`
    (`systems/loot/gemGrades.js`, a leaf);
  - new `item_facts.rs`: `WEAPON_SKILL_USED` (`weaponSkillUsed` probed over template indices 0..=700, minus the RRI classes
    513..=526), `AMMUNITION_TEMPLATES` (`isAmmunition` probed the same way), `THUNDERLOCK_TEMPLATE` (560);
  - `loot_rarity.rs` gains flat rows: `AFFIX_KIND_NAMES`, `AFFIX_PARAM_STR`, `AFFIX_PARAM_NUM`, `AFFIX_NO_PARAM` (the
    `params` of each kind), `AFFIX_RARE_TOP`, `AFFIX_LEGENDARY_TOP` (`AFFIX_RANGES` tops), `GEM_LINE_ROWS` (`GEM_GRADE_LINES`,
    one row per kind and side: `(kind, side, id, param?, values)`), `SOCKET_GROUPS`, `SOCKET_EMPTY`, `WEAPON_SOCKETS`;
  - `loot_powers.rs` gains `LEGENDARY_POWER_TOKENS` (each `LEGENDARY_POWERS` record) and `LEGENDARY_OWN_POWER_TOKENS` (the
    own `power` of each legendary: nine shipped records, one per id, the first record of an id as `legendaryById` finds
    it, a null power skipped). Each record is a codec token, because the records have different field sets (`alikr-robes`
    has `heat`, `wrothgar-mantle` has `cold`, `pilgrims-sandals` has `fatigue` and `fall`, ...) and a typed struct would
    need field names the generator cannot fix. The generator prints the overlap of the two tables (none shipped today;
    the vectors cover every id of both regardless).
  - `js_prototypes.rs` (new): `OBJECT_PROTOTYPE_KEYS`, `ARRAY_PROTOTYPE_KEYS`, `STRING_PROTOTYPE_KEYS`,
    `NUMBER_PROTOTYPE_KEYS`, `BOOLEAN_PROTOTYPE_KEYS`: the own property names of each built-in prototype, read from the
    engine. They are the names a read can inherit (see "Inherited reads" below).
  - Generator assertions: `powerOf` answers `null` for a made-up id (`no-such-gilded-id-for-the-rust-port`). That detects a
    gilded registry that answers every id; a registry that answers only some ids is not detected.

### The codec (grammar: one token per value, no spaces)

| Token | Value |
|---|---|
| `u` | `undefined` |
| `n` | `null` |
| `b1` / `b0` | `true` / `false` |
| `d` + 16 lowercase hex | an f64: its IEEE bits. Every NaN is written `d7ff8000000000000` (the payload is not meaningful in JS) |
| `s` + 4 lowercase hex per UTF-16 unit + `;` | a string (`s;` is `""`) |
| `[` v (`,` v)* `]` | an array (`[]` is empty); an `undefined` item is `u` |
| `{` (`s`key `;` `:` v)(`,` ...)* `}` | an object, own enumerable keys in JS key order; a key present with `undefined` is `u` |

A Map is its `[key, value]` pairs (an array). A function as an object key is skipped (as `tools/rust-data.mjs`'s
`normalize` skips it); a function anywhere else, a symbol, a bigint, a circular reference, and a lone surrogate throw (in
`encodeValue`) or fail (in `parse`, since a Rust `String` holds no lone surrogate). `parse` is strict: lowercase hex, no
spaces, no trailing text, no duplicate key. `Obj` keeps the order written; `Value::set` places an array-index key among
the index keys in ascending order, and any other new key last, as a JS object does.

### JS reads the port mirrors (review these)

- `get(k)`: `obj[k]`; a missing key reads `Undefined`, and `has(k)` tells it from an explicit `undefined`.
- `prop(k)`: `o[k]` for any key (ToPropertyKey = `to_js_string`): an array reads its elements and `length`; a string reads
  its units and `length`; any other primitive reads `undefined` (JS optional chaining). Owned: the read is a copy.
- `finite_or(d)`: `Number.isFinite(v) ? v : d`, no coercion (a string is not finite): save.js `NUM`.
- `num_or(d)`: `v ?? d` for a number. A non-number is NaN here: the JS would concatenate or coerce it in `+`, which the port
  never reads (out of domain; the vectors pass numbers, `undefined`, `null`, and for a skill raw value a string).
- `to_number`: `Number(v)`. A string follows StringToNumber: whitespace (JS's set, not U+0085, plus U+FEFF) trimmed; empty is
  0; `0x`/`0o`/`0b` integers with no sign (rounded to nearest-even at any length: the top 64 significant bits, with a sticky
  bit folded into the lowest, scaled by an exact power of two; overflow is Infinity); `Infinity` with an optional sign; else a
  decimal literal (`1.`, `.5`, `1.e2` and an exponent accepted; `e5`, `1e`, `1_000`, `inf` are NaN).
- `to_js_string`: `String(v)`, the template literal, and a property key. An array joins with `,` (an `undefined` or `null`
  item is empty); an object is `[object Object]`; numbers follow `Number::toString` (`number_to_string`, shortest round-trip
  digits with JS's exponent thresholds).
- `same_value_zero` (`includes`, `Map`, `Set`): NaN equals NaN and `+0` equals `-0`. `strict_eq` (`===`): objects are never
  equal (identity is not modelled; the port never compares two objects).
- `array_index`: an integer number in `0..=2^32-2` (`-0` is 0), or a canonical index string: `arr[v]` reads an element.
- `truthy` (`!!v`): `undefined`, `null`, `false`, `+0`, `-0`, `NaN`, `""` are false.

### Ported functions (Rust | JS file:line)

| Rust | JS |
|---|---|
| `save::weapon_skill`, `proficiency_flag` | `src/save.js:116-123`, `:126-129` (tables: `save_tables.rs`) |
| `save::effective_skill` | `src/save.js:132-137` (SOFTCAP1) |
| `save::master_skills_active` | `src/save.js:140-142` (SOFTCAP3) |
| `save::master_capped_skill` | `src/save.js:145-149` (SOFTCAP4) |
| `save::skill_mod_of` | `src/save.js:152-158` |
| `save::skill_value` | `src/save.js:161-164` |
| `save::live_stat` | `src/save.js:167-181` (the character form; `target::live_stat` is the R3a typed form over `Live`) |
| `save::rebuild_enchant_mods` | `src/save.js:192-204` (with `addMap`, `:183-186`, not used here) |
| `save::rebuild_mods` | `src/save.js:207-230` |
| `save::character_label` | `src/save.js:309-313` |
| `save::skill_name` | `src/save.js:315-317` (`SKILL_NAMES` is an array: an index names it) |
| `gear_lines::laid_lines` | `src/gearLines.js:33-37` (`layGemLines`, lootRarity.js:2085) |
| `gear_lines::read_item_lines` | `src/gearLines.js:40` (`readLines`, lootRarity.js:2155) |
| `gear_lines::valid_item_lines` | `src/gearLines.js:43` |
| `gear_lines::weapon_damage_pct` | `src/gearLines.js:46` (`affixWeaponDamage` :2475) |
| `gear_lines::blade_lines` | `src/gearLines.js:53-64` |
| `gear_lines::fold_lines` | `src/gearLines.js:67-78` |
| `gear_lines::sockets_for` | `src/gearLines.js:81` (`socketMax`, lootRarity.js:2004) |
| `sockets::perfect_gem` | `src/sockets.js:16` |
| `sockets::socket_count` | `src/sockets.js:19` |
| `sockets::socket_affixes` | `src/sockets.js:25-28` |
| `sockets::perfect_sockets` | `src/sockets.js:31-33` |
| `loot::valid_affix` | `lootRarity.js:839-848` |
| `loot::gem_piece_cap` | `lootRarity.js:2151` |
| `loot::read_lines`, `read_lines_list` | `lootRarity.js:2155-2166` |
| `loot::gem_kind`, `gem_grade`, `is_gem_id` | `systems/loot/gemGrades.js:64-67` |
| `loot::sockets_of` | `lootRarity.js:2020-2023` |
| `loot::socket_gems` | `lootRarity.js:2037` |
| `loot::gem_line` | `lootRarity.js:2040-2043` (`gradeLine` :1988) |
| `loot::socket_max`, `is_ammunition` | `lootRarity.js:2004-2011`; `systems/item/itemTemplates.js:134` |
| `loot::counted_pieces` | `lootRarity.js:2348-2357` |
| `loot::power_ids_of` | `lootRarity.js:1271` |
| `loot::power_of` | `lootRarity.js:1268`: `LEGENDARY_POWER_TOKENS`, then `LEGENDARY_OWN_POWER_TOKENS`, then null (see "JS semantics" below) |
| `loot::foe_group` | `systems/loot/lootPowers.js:142-155` |

Constants from the generator, not re-typed: `ENHANCE_SKILL_MOD` (15), the `SKILL_NAMES`/`RACE_NAMES` of `src/data.js`,
the affix bands, the gem rows, `THUNDERLOCK_TEMPLATE` (560, `characters/thunderlockIds.js`).

### Field lists (what the ported code reads)

- `save.js` (`liveStat`, `skillValue` and its helpers, `rebuildMods`, `rebuildEnchantMods`, `characterLabel`): character
  `online`, `masterSkills`, `masteredSkills`, `skills`, `stats`, `activeEffects` (each entry `kind`, `ended`, `statMods`,
  `stat`, `magnitude`, `skillMods`), `_mods` (`stats`, `statMax`, `skills`), `_enchantMods` (`skillMods`), `name`, `raceId`,
  `race`, `career.name`, `level`. Items: `equipSlot`, `group`, `enchantments` (`type`, `param`), and the item fields of the
  lines below.
- The lines and sockets (`gearLines.js`, `sockets.js`, lootRarity): an item's `affixes` (each line `id`, `param`, `value`,
  `gem`), `sockets` (a list) or `socket` (one string), `group`, `templateIndex`, `rarity`, `legendary` (a string on a
  Legendary), `imprint` (a Rare's), `gilded`. `foeGroup` reads a target's `isPlayer`, `affinity`, `careerIndex`.
- `model.js` and `blowOutcomes.js` (a grep survey of `ch.` reads, not a line-by-line read): `career.weaponArmorShieldsBitfield`,
  `level`, `raceId`, `martialPath`, `_mods`, `_enchantMods.chanceToHitMod`, `skills`, `online`, `weapon`, `offWeapon`,
  `wraps`, `firmamentDamagePct`. The weapon's `skillId`, `templateIndex`, `affixes`, `item` are read there too.
- `dualWield.js` and `durability.js`: not surveyed in this round (the grep matched no character field in them); not ported.

### Not ported, and why

- `save.js` file and launcher I/O: `userDataDir`, `configPath`, `arena2Dir`, `savesDir`, `listSaves`, `resolveSave`,
  `loadSave`. They read the file system and the launcher's config. `characterFromSave` is pure (no I/O), but the model's
  inputs are built characters (the vectors build them with `theoryCharacter`, which calls it), so the port does not
  re-derive a character from a save file in this round. Say if the model needs it before R5.
- `lootRarity.js` beyond the call tree above: the rarity and pool draws (`rollRarity`, `rollAffixes`, `pickByLines`), the
  kinds' params for techniques (`kindParams`, `techniquesFor`), the setters (`setGem`, `unsetGem`, `socketPass`,
  `weaponSocketPass`), `affixFold`, `affixWeaponDamage` (the cap-free sum of `readLines`, ported as `weapon_damage_pct`).
- `lootPowers.js` beyond `foeGroup`: the blow, the strike, the fold through `equipTableOf` (`wornPieces`, `wornSum`).
- The RRI custom classes 513..=526 (`customItemClass`): not registered in the port (see R3b). `WEAPON_SKILL_USED` and
  `AMMUNITION_TEMPLATES` are probed with those ids excluded, so an RRI weapon's skill is not read here.
- The registries: `_gilded` (`registerGildedRecords`, module-private) is unset on this path, so `powerOf`'s third step is
  `undefined`; `registerLegendary` (custom legendaries) is empty. `allLegendaries()` is the shipped list (`LEGENDARIES`,
  `WARDROBE_LEGENDARIES`, `ARCANE_LEGENDARIES`), 39 records, and `legendaryById` is its first match per id.

### JS semantics decided here (review these)

- `Value::Str` is a Rust `String`: a lone surrogate is refused by the codec and the generator. A JS field that holds one would
  need a `Vec<u16>` variant; none of the vectors does. The one read that makes one is `prop` on a string at an index that
  is half of an astral character (`'😀'[0]`): the port gives `undefined` for it, and the generator skips that case rather
  than write it (`genValueFamily`, the `prop` loop). The `prop` count is therefore 2500 cases the Rust side sees.
- Inherited reads (settled): a JS read of a name the receiver does not own, but a built-in prototype does, yields a function
  or an object (`({}).constructor` is `Object`, `[].map` a function, `'a'.length` a number). A `Value` cannot hold a
  function, so the port refuses those names by panicking (`value::refuse_inherited`, the lists in `js_prototypes.rs`):
  `Value::prop` on an object, array, string, number or boolean; `obj_table_get`/`obj_table_has` on the object tables
  (`WEAPON_SKILL`, `PROFICIENCY_FLAG`, `RACE_NAMES`, `WEAPON_HANDS`, `WEAPONS`); `powerOf`; `skillName`. Two exceptions are
  exact, not refused: an array's `length` is its length (`skillName('length')` is 35, a number), and a Map read
  (`map_table_get`, `WEAPON_SKILL_USED`) never sees a prototype. The vectors never pass an inherited name (the generator
  filters them with the engine's own list), and the unit tests pin the refusal.
- `skillName`: `SKILL_NAMES` is an array: an index names a skill; `length` is 35; any other inherited name refuses; anything
  else is its string. (Returns a `Value`, since `length` is a number.)
- `powerOf` (settled, see `loot::power_of`): `LEGENDARY_POWERS[id]` first, then the legendary's own `power` (nine records), then
  null. `_gilded` is unset on this path. An inherited name in `LEGENDARY_POWERS` is the Object.prototype member (a function,
  or for `__proto__` the prototype object): refused. Reachable from a save whose legendary item carries such an id.
- `foeGroup` reads no object table.
- `addMap`'s guard (`save.js:184`): a `null` or `''` key, or a non-finite value, is skipped; `rebuildEnchantMods` keys by the
  number's string form (`number_to_string`, so `-0` is `"0"`).
- A stat or skill key is the property key of its param (`to_js_string`): an `undefined` param makes the key `"undefined"`, as
  the JS does (the valid lines always carry a param for these kinds).
- `readLines`: the gem-cap sum is kept per kind and param in the list's order; a line whose value does not change is the same
  record (the JS returns the same object).
- `laidLines` drops falsy entries only in the socketed case (the JS `.filter(Boolean)` runs on the concatenation); the
  unsocketed list is returned as it is (falsy entries kept).
- `skillValue` and `masterCappedSkill` coerce a raw skill with `Math.min` (a numeric string gives a number) but return a
  mastered raw unchanged (a string then reads 0 in `effectiveSkill`, as `Number.isFinite` says). Both are in the vectors.
- `socketCount` takes a number as a template and anything else as an item (`typeof itemOrTemplate === 'number'`): a string
  template reads as an item with no `templateIndex`, so 0 sockets (the vectors cover it).

### Vectors (`tools/rust-vectors.mjs`, R4a)

Every family is at least 2000 cases (the Rust tests assert it per kind; the generator prints the counts).

| File | Kinds (cases) | Inputs |
|---|---|---|
| `value.txt` | `value` 3000, `tonum` 2500, `tostr` 2500, `truthy` 2000, `prop` 2500 | random nested values (depth 3): undefined, null, booleans, the number pool (signed zeros, NaN, infinities, 5e-324, 2^53+2, 1e21, 1e-7, random bits), string pool (numeric forms, whitespace, astral, surrogate-free unicode, separators), keys (integer-like, the index limit, `ünï`, `x;y`) |
| `save.txt` | `eff` `msa` `mcs` `smo` `sv` `ls` `rem` `rm` `cl` `sn` `wsk` `pf`, 2000 each | defs: 40 characters from `theoryCharacter` over the grid (levels 1/2/9/45, races 1..8, blades, gear and star lines, vampirism, mastery switches varied, mastered lists with odd entries) and 60 synthetic characters (effects of every kind with `ended`, missing and string fields); 80 item lists |
| `gear.txt` | `laid` `ril` `vil` `wdp` `bl` `fl` `sf`, 2000 each | defs: 400 items (every group and rarity, templates from the weapon table and the armour, sockets, gem lines with values past the cap, legendaries, imprints, enchantments with type 10); 80 lists with null entries |
| `sockets.txt` | `scount` `saff` `pgem` `psock`, 2000 each | the same items; templates and string templates |
| `loot.txt` | `rl` `va` `gl` `sg` `so` `sm` `cp` `pio` `po` `fg`, 2000 each | the same items and lists; affixes at each band's edges (`1`, `max-1`, `max`, `max+1`, the Rare top and its neighbours, `0`, `-1`, `1.5`, `NaN`, `'5'`, `undefined`), gem ids and junk, legendary ids; targets with odd affinity and career indices |

Inputs that are not in the vectors (a stat name outside the eight, a skill id above 35 with a `masteredSkills` hit, an RRI
template, a Map keyed by a string) are not proven.

### Run (R4a)

```
node tools/rust-data.mjs            # REQUIRED first: save_tables.rs, gem_grades.rs, item_facts.rs, the extended loot_rarity.rs
                                    # and loot_powers.rs (LEGENDARY_POWER_TOKENS)
node tools/rust-data.mjs --check
node tools/rust-vectors.mjs         # writes value.txt, save.txt, gear.txt, sockets.txt, loot.txt (and the earlier modules)
cd rust && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Until `node tools/rust-data.mjs` runs, the crate does not compile (the new generated modules are missing).

## R4b: combat cards and per-blow resolution

`model_blow.rs` builds weapon descriptors, cadence, hit and damage cards, and resolves the
damage distribution of one landed blow. `dual_wield.rs` supplies the two-hand timing and damage
law; `durability.rs` supplies wear and the fight-local break operation. This milestone does not
port `analyze`, its target builders, rankers or marginals (R5), or `blowOutcomes.js` and
`createBlowSampler` (R4c). `blow_distribution` is the deterministic, per-part landed-blow
distribution; it does not sample a hit, choose a struck part, or run a fight.

| Rust functions | JS source |
|---|---|
| `unity_round`, `swing_directions` | `model.js:57-63,77-78` (`round.rs`, generated click directions and direction map) |
| `weapon_of`, `synthetic_weapon`, `is_blade`, `is_blunt`, `weapon_to_hit` | `model.js:107-169` |
| `adrenaline`, `proficiency`, `racial`, `racial_modifiers`, `combat_stat`, `skill` | `model.js:186-378` |
| `martial_pace`, `mastery_pace`, `cadence`, `ranged_cadence`, `weapon_resist_factor`, `expected_capped` | `model.js:402-502`; Thunderlock reload `data.js:192` |
| `crit_model`, `hit_model` | `model.js:504-585` |
| `martial_blow_pct`, `mastery_pct` | `model.js:598-630` |
| `create_carry_state`, `carried_amount`, `finish_blow`, `condition_multiplier` | `model.js:642-673,690-713`; existing `damage.rs` implements the condition bands |
| `weapon_blow`, `loot_power_terms` | `model.js:725-831`; existing `loot::foe_group` supplies the target classification |
| `strikes_net`, `payload_rows`, `mobile_affinity_matches` | `model.js:838-846`, `enchants.js:49-70`, `systems/enchantments.js:414-423` |
| `bow_of`, `bow_blow`, `bow_fast_damage`, `backstab_damage` | `model.js:850-860`; `combat/bowBloom.js:73-79` |
| `resolve_blow`, `after_share`, `resist_blow` | `model.js:868-918`, `src/bossTraits.js:89-92`, `systems/bossTraits.js:192-224` (landed damage only) |
| `additions_to`, `weapon_powers`, `echo_chances`, `blow_distribution`, `damage_model` | `model.js:924-1051` |
| `average_off_hand_hold`, `dual_schedule`, `swings_ratio`, `damage_ratio` | `dualWield.js:46,58,78,84` |
| `strike_hand_of`, `off_hand_to_hit`, `off_hand_burden`, `off_hand_hold`, `off_hand_damage` | `combat/twoHands/handsLaw.js:144,253,261,273,281` |
| `wear_amount`, `dice100`, `blow_wear`, `cws_bill`, `make_owner`, `wear_item`, `condition_pct`, `clone_item` | `durability.js:41,44,51,58,65,73,78,81`; `itemTemplates.js:277-279` |
| `lower_condition`, `mint_condition` | `systems/equip.js:570-608,117-140`; `systems/item/itemTemplates.js:336-350` |

**Boundary.** Characters, descriptors, items and scenarios are `Value` records; hit math also
reads its target as `Value` for skill/passive/health fields. Damage, element, shield and armour
reuse the R3 typed `Target` and `Weapon` projection; `Target.warded` holds the live ward flag.
The damage card reads base/live STR, AGI, END, SPD, LUC and WIL, level, race, career bits, mastery,
martial path, skill and enchant deltas, health/maxHealth, item affixes, sockets, flags, condition
and damage limits. The target stages read armour by part, affinity/mobile ids, career, group,
relay and ward state. Carry and durability use caller-supplied stable item keys, not value
equality; a distinct but identical item needs its own key. `Carry` separates weapon and loot
identities and never mutates live remainders in the exact-share pricing pass. Backstab math
takes the already drawn `roll01`; the only draw in the durability module uses `Rolls`.

**Vendored scope.** No host callbacks, localised break text, collection removal or item hooks in
the synthetic owner's break operation. `repoolWeapon` is inert on the vendored graph:
`QUALITY_EFFECTS` is a poisoned proxy, so each old-row pool is `NaN` and cannot match by `===`.
The mint probes cover IDs 0..700 (the shipped combat equipment domain). `Value` represents an
owned clone and does not represent frozen records, functions, custom runtime registrations, or
JS prototype effects. String or object coercion on fields that normally carry numeric addends
is not a supported substitute for a game record.

**Vectors.** `tools/rust-blow-vectors.mjs` runs the real JS, called by `rust-vectors.mjs`, with
`encodeValue` for exact numeric bits and object order. It covers theory builds, test fixture
characters, R3 enemies and relay stand-ins, armour and shields, weapon classes, sockets,
affixes, powers, enchantment abort order, swing directions, carry across distinct identities,
and single/dual/fist/bow/gun paths. There are at least 2,000 cases per model family (`weapon`,
`scalar`, `cadence`, `hit`, `damage`, `live`, `loot`, `outcomes`, `misc`, `resist`), dual timing (`hands`),
and durability (`wear`, `break`). The wear vectors assert exact scripted roll consumption.

Mutation checks (seed 1, count 1000): model blow killed 708 of 731 (22 equivalent, 1 did not
compile); dual wield killed 43 of 45 (2 equivalent); durability killed 39 of 43 (4 equivalent).
The surviving changes have proofs at the affected code. The tool still prints `FAIL` for
proven-equivalent survivors.

## R4c: exact joint blow outcomes and sampling

`blow_outcomes.rs` ports `src/blowOutcomes.js:60–470`: full enumeration, fight and carry merges,
moments, and the cumulative sampler. It calls R4b's `damage_model` and `echo_chances`;
`blow_distribution` remains a separate R4b API. Nothing here runs the fight, schedules hands or
draws randomness. The sampler takes a roll; `outcome_at` checks `[0, 1)`, whereas `sample` trusts
the caller just like the JS stream entry point.

- Enumeration follows direction → facing/backstab → crit → part → whole → roll → defence/echo
  branch, then misses after the rolls of that whole branch. Each product keeps JS's left
  association and uses the reciprocal of the card count, not division of the final product.
  The full total is an ordinary left fold; the two merges, means, and CDF each use the JS
  Neumaier accumulator in their own traversal order.
- Defence uses the same per-part shield/armour functions as R3 only for geared overhaul targets;
  all other targets use intrinsic defence. The target projection preserves raw hit inputs and
  folds live stats only for defence. The omitted-target path constructs the fields read from
  the tough `referenceFoe` preset. Explicit null weapon and omitted weapon do not coincide.
- Merge keys are exact, not tolerance bins. Numeric keys identify both signs of zero and all
  NaNs, like JS string keys. Groups retain the first atom's non-key fields and insertion order
  before stable sorting. Sort fields are the JS lexicographic chain (never `p`); when subtraction
  yields NaN, skip that comparison as JS's `||` does. An inconsistent comparator on fabricated
  mixtures of NaN and finite damage has no specified cross-engine JS order.
- Carry retains the part, pre-percentage base, and defence branch; `CarryResolve::resolve`
  reruns the percentage channels with the caller's `Carry` item identities, then the finish and
  defence pipeline. It leaves a miss/nonpositive base unchanged and falls back to the original
  atom if the branch disappears. Rust represents the JS closure as an owned context and the
  frozen records as owned atoms; direction is held once in the tier and referenced by index.
- The CDF excludes nonpositive and NaN probabilities, uses its own total rather than the
  tier's, and binary-searches with strict `cdf[mid] > roll * total`. It returns the last live
  atom if rounding puts the product at or beyond the last prefix. `TOLERANCE` is an error
  bound on probability drift, not a rule that discards small probabilities or nearby damage.

`tools/rust-outcome-vectors.mjs` uses the real JS tier and sampler functions over the R4b
character/target grid. The streamed `blow_outcomes.txt` encodes every ordered atom, tier metadata,
means, and live carry traces. Each generated fight/carry CDF is checked at all normalized prefix
edges and neighboring doubles, plus the first representable roll whose product reaches the edge.
Synthetic tiers probe compensated prefixes, zero/NaN weights, short and empty CDFs, tolerance-scale
damage keys, signed-zero and NaN merge keys, stable ties, and invalid rolls. Tests enforce the
2,000-case floor per main family and fail on a missing file. Regenerate with `node tools/rust-vectors.mjs`.

Mutation gate (seed 1, count 1000): 146 candidates, 124 killed, 19 equivalent survivors
documented at the mutated expressions, and 3 invalid (did not compile). The gate reports `FAIL`
for equivalent survivors too.

## R5a: spells, enchantments and boss traits

- `spells.rs` ports `src/spells.js`: record decoding, effect/cast cost, saving throws, damage,
  cast rate, spell cards and rotations. `read_spells_std(&bytes)` emits records in file order;
  `spells_by_index_map(records)` makes a caller-owned `Spellbook` with first-record-wins lookup.
  Pass it explicitly to spell resolution and strikes calculations. The Rust core never reads
  launcher config, opens a game file, or keeps an ambient spellbook.
- The parser follows `DataView`: signed type/subtype bytes, unsigned element, range, effect
  parameters, icon and index, a **little-endian** `u16` cost, and up to 25 byte-valued name units
  terminated by NUL. The JS stride is **89 bytes**, including its unused suffix; a partial chunk
  (including 88 bytes) is not a record. The index-10 Free Action correction belongs to the file
  reader, not the single-record reader.
- `enchants.rs` ports the expected strikes walk, per-proc direct cap, aggregate DoT cap, affinity
  flat terms and condition bill capacity. It reuses R4's held fold, payload order and mobile
  affinity helper. `enchantData.js`'s parameter domains, price rows, and template enchantment
  points are generated by `tools/rust-data.mjs`; item-picker display helpers are not model inputs.
- `boss_traits.rs` ports the relay identity's deterministic trait draw, element proof mapping,
  and boss-strike/thorns adapter, reusing R4b's landed-blow resistance. The server/host ward
  scheduler is not part of this module. Race lookup and the vendored fighting climb share
  existing race and skill data; fighting climb is distinct from the report's raw-skill potency.
  Loot power lookup and target grouping still use `loot.rs`; the `cws.js` fight-local power and
  proc state machines remain R6.

`tools/rust-spell-vectors.mjs` writes `spells.txt` through `tools/rust-vectors.mjs`. It requires
the game installation: it uses `arena2Dir()` to find `SPELLS.STD`, prints the resolved path and
record count, and fails if the file cannot be read. The Steam copy used here has 7,921 bytes
and 89 complete records. Tests compare every raw stock record, every decoded book entry, the
ordered model outputs over theory builds, synthetic effect/range/flag cases, and weapons with
every catalogue parameter and stock spell index. They compare raw f64 bits and do not skip a
missing file or a family below 2,000 cases. APIs take game-shaped `Value` records (including
missing fields); arbitrary JS prototype effects and malformed string arithmetic are outside
the model boundary.

```
node tools/rust-data.mjs
node tools/gate.mjs rust
node tools/gate.mjs mutate spells.rs --tests spells --count 1000 --seed 1 --timeout 120
node tools/gate.mjs mutate enchants.rs --tests spells --count 1000 --seed 1 --timeout 120
node tools/gate.mjs mutate boss_traits.rs --tests spells --count 1000 --seed 1 --timeout 120
node tools/gate.mjs mutate generated/spell_tables.rs --tests spells --count 1000 --seed 1 --timeout 120
```

## R5b: analysis cards, target builders and what-if ranks

`dfo_core::analyze::analyze(&character, &scenario, &spellbook)` returns an `Analysis`.
`Analysis::to_value()` writes its enumerable shape in JS insertion order. The existing hit,
damage, cadence and proc records retain their `Value` encoding. The Rust `analyze_with` function
takes the original inputs and an edit, including appending an imprint; it is the equivalent of
JS's non-enumerable `with` closure, not part of the vector output.

| `src/model.js` | Field list (JS names) |
|---|---|
| 1583 | `core`, `weapon`, `target`, `swing`, `swingDirections`, `swingMix`, `hit`, `damage`, `cadence` |
| 1584–1585 | `perSwing`, `perSwingMin`, `perSwingMax`, `dps`, `dpsMin`, `dpsMax`, `cappedPerSwing`, `cappedPerSwingMin`, `cappedPerSwingMax`, `cappedDps`, `cappedDpsMin`, `cappedDpsMax`, `cap`, `capSource`, `capLoss` |
| 1586 | `enchantPerSwing`, `enchantDps`, `enchantDpsMin`, `enchantDpsMax`, `totalDps`, `totalDpsMin`, `totalDpsMax`, `enchantProcs`, `enchantDotDps`, `enchantDotDpsMin`, `enchantDotDpsMax`, `procsBeforeBreak`, `procsBeforeBreakBasis` |
| 1587 | `resist`, `health`, `ward`, `shields`, `ttk`, `ttkCapOnly`, `totalTtkCapOnly`, `allowance`, `wrath`, `wrathAt` |
| 1588 / 1386–1395 | `targetDefense` (`careerIndex`, `mobileType`, `natural`, `material`, `hideAt100`, `wornArmour`, `shield`, `combatLevel`) |
| 1589–1602 | `backstab` (`skill`, `chance`, `probability`, `toHit`, `multiplier`, `uptime`, `expectedMult`, `watchful`, `min`, `max`, `critMin`, `critMax`) |
| 1603–1609 | `traits`, `healthShare`, `notes` (`preWornArmor`, `targetIntrinsic`, `condition`, `softMaterial`) |
| 1246–1252 / 1287–1303 | Optional `dual`, `offHand` (a nested card), `schedule`; or `pair`. The cadence retains its original fields with the appropriate dual/pair overrides. |
| 1121–1135 | `carriedPerSwing`, `carriedCappedPerSwing`, `carriedDps`, `carriedCappedDps`, `ceilingTotalDps`, `ceilingTotalDpsMin`, `ceilingTotalDpsMax`, `ceilingTotalTtk`, `claimTotalTtk`, `claimSustainedDps`, `totalTtk` |

The single card keeps the exact order of the JS reductions: per outcome, roll, body part,
direction, then ordinary/back-facing blends. `patch_allowance` (1064–1089) runs the existing
claim and allowance engine separately for the weapon and combined proc lanes; when an allowance
run exists, sustained DPS replaces the reported total DPS, but the old band is still in the
ceiling fields. The dual card sequences the lead and off lanes, weighting direct off-hand procs
and assigning the DoT to one host. The pair card keeps the separate JS claim law. No call reaches
`src/fight.js`, so `fight`, `fightRelay` and `healthThresholds` remain out of scope.

`reference_foe`, `boss_target`, `GATE_BODY_LEVEL` and `gate_target` port 1614–1716. Stand-in
combat fields come from the R3 typed mint at the shipped boot; the `basics` object echoed by
the analysis uses ordered raw rows from `tools/rust-data.mjs`, which also probes `GATE_BODY_LEVEL`.
`marginals`, `rank_weapons`, `rank_affixes` and `current_weapon_row` port 1719–1842, keeping JS
weapon table order and stable ties. The two JSON-clone sites (1722,1782) use a recursive owned
clone over plain `Value`: undefined object keys are omitted, undefined array entries and
non-finite numbers become null, and both signs of zero become positive zero. Finite nonzero
numbers round-trip unchanged. Functions, custom prototypes and `toJSON` hooks are outside the
plain game-record boundary, as in R4a.

`tools/rust-analysis-vectors.mjs` generates `analysis.txt` using the actual JS functions, with a
required stock `SPELLS.STD` and three explicit proc probes. Reference, boss, gate and relay
families each have 2,048 cases, comparing the whole ordered card (including nested off cards,
cap-only and allowance numbers, target, hit/damage arrays and proc streams) as f64 bits.
The 525 focused probes cover adjacent doubles at the backstab, cap/curb/ward, material,
condition, and TTK boundaries, plus paired proc lanes with instant-only, DoT-only, and mixed
payloads. The generator asserts the stock book is nonempty and the strike probes actually
proc. The 28 what-if cases compare the full ordered rank results and `with` cards. Tests fail
on missing files, a missing book or missing families.

```
node tools/gate.mjs rust
node tools/gate.mjs mutate analyze.rs --tests analyze --count 1000 --seed 1 --timeout 120 --jobs 8
```

Mutation result (seed 1): 323 candidates, 303 killed, 7 invalid, and 13 equivalent survivors
with local proofs in `analyze.rs`. The mutation gate reports `FAIL` for equivalent survivors too.

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
