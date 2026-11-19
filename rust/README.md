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

ROLLS is `I n` then n f64 (the consumed values), or `-` (no roll function). GEAR_OUT is `right` (`-` or `W tmpl mat`),
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

### Run (R3b)

```
node tools/rust-data.mjs            # REQUIRED first: the new generated modules and the extended equip_rules.rs
node tools/rust-data.mjs --check
node tools/rust-vectors.mjs         # writes rust/tests/vectors/maketarget.txt (and round.txt with math_round)
cd rust && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Until `node tools/rust-data.mjs` runs, the crate does not compile (the new generated modules are missing). The vector
files are not committed; the maketarget file is the largest of the set (several MB; the size is not measured here).

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
