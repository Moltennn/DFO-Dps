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
