# The Forge API: manual Firmament and gear editing for `DFO Forge`

`dfo_core::forge` (re-exported from `dfo_core::lib`) is the Rust-core API a GUI uses to let a player spend and take
back Firmament stars, and to build and wear gear. It is plain data in, plain data out: `Tree` and `Value` records,
typed errors, no ambient state, and **no input is mutated**. Every preview answers the tree or character it would leave,
so the GUI can hold the player's build and show the result without applying it.

There are two halves. Firmament editing is sections (1)–(4); gear is section (5) ([`build_item`],
[`preview_equip_main_hand`], [`can_wear_main_hand`]).

The rules are the game's own, ported verbatim from `vendor/firmament/firmamentLaw.js` into
`dfo_core::firmament_law` (`pathTo`, `treeFault`, `fits`, `pointsLeft`, `refundTakes`, `cleanKeys`, `treeDiff`,
`totals`, `starsFor`, `craftPointsFor`, `refundSilver`). The GUI must not restate them: call these.

## Types

```rust
pub struct Tree { pub start: Option<String>, pub keys: Vec<String> }   // the JS `{ start, keys }`; None = no sign
pub struct Budget { pub stars: f64, pub craft: f64 }                  // the two purses
```

`Tree` is the law's own type (`dfo_core::firmament_law::Tree`): `Tree::empty()` is the JS `EMPTY_TREE`,
`Tree::from_value(&v)` reads a `{ start, keys }` record (e.g. from `planFromTree` or a save), and
`firmament::plan_tree(&plan)` reads one out of a plan.

`Budget` has the two builders the JS has: `Budget::renown(renown)` = `starsFor`, `Budget::ranks(ranks)` =
`craftPointsFor`, and `Budget::of(renown, ranks)` for both. `Budget::to_value()` writes `{ stars, craft }` for a GUI.

## (1) Preview an allocation

```rust
use dfo_core::forge::{preview_allocate, Budget, AllocateFault};
use dfo_core::firmament_law::Tree;

let tree = Tree { start: Some("sp.start".into()), keys: vec!["sp.bt".into(), "mg.bt".into()] };
match preview_allocate(&tree, "mg.s1", Budget::new(98.0, 0.0)) {
    Ok(p) => {
        // p.path          ["mg.s1"]        nearest first, ending with the star
        // p.cost          1.0              stars the path adds
        // p.points_left   Budget { .. }    what is left in each purse after it
        // p.resulting_tree                 the tree it would leave (also on a multi-star path)
    }
    Err(e) => println!("{}", e.message()),   // a sentence that states the reason
}
```

`AllocateFault` (from `pathTo`, `treeFault` and `fits`, in the order checked):

| arm | when |
|---|---|
| `Tree(TreeFault)` | the tree itself is not whole: `Key`, `Start`, `Path` or `Points` |
| `NoStart` | no birthsign chosen yet |
| `UnknownNode` | the key is not a star of the sky |
| `StartKey` | the key is a birthsign (chosen, not allocated) |
| `AlreadyAllocated` | the star is the sign or allocated already |
| `NotReachable` | no open path: another sign's start, a keystone's far side |
| `OverBudget { combat, stars, total, purse }` | the path would not fit |

`allocatable(&tree, key)` is the law's own guard ("one line away, and allocatable").

## (2) Preview a refund

```rust
use dfo_core::forge::preview_refund;

match preview_refund(&tree, "mg.bt", 12.0) {
    Ok(p) => {
        // p.removed       every star the refund takes with it, INCLUDING the star itself (the JS sorts the list)
        // p.resulting_tree
        // p.refund_silver  refundSilver(removed.len(), renown): free below Renown 10, then 10 silver a star
    }
    Err(e) => println!("{}", e.message()),
}
```

`RefundFault` is `NoStart`, `UnknownNode`, `StartSign` (a birthsign is not refunded star by star) or `NotAllocated`.

Note `removed` is **sorted**: `refundTakes` pushes the star, then every star that only reached the sign through it, and
sorts the lot — so the refunded star is not necessarily first.

Changing sign is the respec, and is its own call: `preview_respec(&tree)` answers
`RespecPreview { removed, resulting_tree: empty, gold: FIRM_RESPEC_GOLD, refund_silver: 0 }`. The vendored law
documents that record beside `refundTakes` but has no function for it, so this is the reading of the record, not a
ported JS call — the one place here that is not bit-checked against a JS function (its vectors compare against the
same reading, so the parity test pins the shape and the constants, not an independent implementation).

## (3) A tree on a character

```rust
use dfo_core::forge::{apply_tree_to_character, tree_plan};

let plan = tree_plan(&"longblade".into(), &tree)?;        // planFromTree: { build, tree, totals, ... }
let applied = apply_tree_to_character(&character, &"longblade".into(), &tree)?;  // a NEW character
let card = dfo_core::analyze::analyze(&applied, &scenario, &book);               // attributes, DPS, everything
```

`apply_tree_to_character` is the **same** `apply_firmament` the real-build chain uses
(`dfo_core::real_build::apply_firmament`), so `analyze` on the result reflects the stars' attribute, skill and
weapon-blow effects exactly as the planner's own trees do. `build` is a preset id (`"longblade"`, `"bow"`,
`"destruction"`, …) or a preset-shaped `Value`. The character is untouched; only the returned value carries the tree.
`ApplyFault` is `UnknownBuild` or `InvalidTree(TreeFault)`.

`attribute_values(&tree)` gives the eight attribute totals the tree adds; `attribute_keys()` names them.

## (4) The readers beside the previews

`tree_fault_of(&tree, budget)`, `totals(&tree)`, `difference(prev, next)`, `tree_to_value(&tree)` — each the port of
`treeFault`, `totals`, `treeDiff` and the `{ start, keys }` record. `firmament_law`'s own `clean_keys`,
`firm_cost_of`, `fits`, `points_left`, `tree_fault`, `tree_fault_value`, `path_to`, `allocatable`, `refund_takes`,
`tree_diff`, `totals`, `stars_for`, `craft_points_for` and `refund_silver` are public too.

## (5) Gear: a player item, and a main-hand wear

The same module edits gear, under the same contract: plain data, typed answers, no ambient state, **no input mutated**.
The rules are the game's own, reused rather than restated — [`crate::gear_profile::validate_plan`] (the `validatePlan`
the max profile is checked with), [`crate::durability::mint_condition`], the game's template-name table, the hand law
[`crate::gear::can_hold_main_hand`] and `leavers_for`, and `characterFromSave`'s own reads of the worn list rebuilt by
[`crate::save::rebuild_mods`] / [`crate::save::rebuild_enchant_mods`].

```rust
use dfo_core::forge::{build_item, preview_equip_main_hand, can_wear_main_hand, GearSpec};
use dfo_core::value::Value::{Num, Obj, Str};

// A Magic or Rare piece: a template, a material, a rarity and the lines the player picked (`{ id, param?, value }`).
let damage = Obj(vec![("id".into(), Str("damage".into())), ("value".into(), Num(25.0))]);
let item = build_item(&GearSpec::lines_of(123.0, 9.0, "rare", vec![damage]))?;   // a NEW item, never the spec

// Or a Legendary record, whose lines, enchantment and name are its own.
let dragon = build_item(&GearSpec::legendary(123.0, 9.0, "wyrmbane"))?;

// Wear it in the main hand: the character it would leave, and the pieces it takes off.
if can_wear_main_hand(&item) {
    let preview = preview_equip_main_hand(&character, &item)?;
    println!("{} piece(s) displaced", preview.displaced.len());
    let card = dfo_core::analyze::analyze(&preview.character, &scenario, &book);
}
```

`GearSpec` is `{ template, material, rarity, lines, record? }`; `GearSpec::from_value` reads the record a GUI holds
(`{ template, material, rarity, lines?, record? }`). `rarity` is `magic` or `rare` for explicit lines, `legendary` with a
`record`. The material is the game's id: 0..=9 on the weapon ladder, DFU's raw armour value (0 leather, 0x0100 chain,
0x0200+ plate), 0 for jewellery and clothing.

The item a legal spec builds is what the game mints, field for field: `setItemFields` + `mintCondition` for a Magic or
Rare piece (group, template, material, rarity, lines, name, condition), and `applyRarity` + `mintCondition` for a
Legendary (its record's name, lines and enchantment). One field is deliberately absent: the trade `value`, which no battle
reads and which needs the template price tables.

`GearFault` says why not:

| arm | when |
|---|---|
| `Spec(String)` | the value is not a gear spec: no numeric template, no rarity |
| `UnknownTemplate(f64)` | the template is not one the game's slot tables hold |
| `Illegal(Vec<String>)` | the lines are not legal: `validatePlan`'s own sentences, unchanged |
| `UnknownRecord(String)` | a Legendary id that does not fit this template and group |
| `NotMainHand` | the piece cannot be held in the main hand (a shield's `LeftOnly`) |
| `NoWornList` | the character carries no worn list |

`EquipPreview` is `{ character, displaced, slot }`:

- `slot` — `EQUIP_SLOTS.RightHand`, the slot the hand law admits;
- `displaced` — every leaver, in `wearLeavers`' order (a two-hander clears both hands, a shield bumps a held two-hander,
  the destination's occupant swaps out), each without an `equipSlot` as `unequipSlot` leaves it; and
- `character` — a NEW value: `worn`, `items`, `weapon`, `offWeapon`, `wraps`, `_mods`' gear channels, `_enchantMods` and
  `legendaries`, all `src/save.js`'s own reads of the new list. The gear channels are a **delta** on the character's
  existing `_mods` (the old gear fold taken out, the new one added), so a Firmament already folded in survives — the game
  re-runs every fold on an equip change (`systems/entityMods.js:179-196`).

The boot is the shipped one (the Roleplay & Realism switches at their defaults, a bow in both hands), the same boot
`can_wear_main_hand` answers with.

**What this is not.** No rarity roll, no imprint, no optimization, no share codes, no persistence, and no game-save
export: a Forge edit acts on a build and returns a new build, and the imported save stays read-only.

## (6) A saved allocation


```rust
use dfo_core::forge::{decode_saved_firmament, decode_tree_value, SavedFirmament};

match decode_saved_firmament(&save) {
    SavedFirmament::Absent => { /* the save has never carried the field: show nothing, do not assume zero spent */ }
    SavedFirmament::EmptyTree => { /* there and explicit: no sign chosen */ }
    SavedFirmament::Tree(tree) => { /* a whole allocation */ }
}
```

**What is verified, and what is not.** `src/save.js`'s `characterFromSave` reads no Firmament field, and the vendored
upstream save carries none either: `systems/firmamentLive.js` states the tree is the ACCOUNT SERVICE's
(`server-account/src/firmament.js`, handed in by `net/firmament/firmamentBook.js`) and is in force ONLINE ALONE —
"offline the character is the save's, Daggerfall's, with no sky at all". `firmamentBook.js` is not vendored, so the
wire field's name and shape **cannot be verified in this repository**. The decoder therefore reads the one shape the
law itself serialises — the row string `packTree` writes, `"<start>|<key>,<key>"`, which `unpackTree` is the inverse of
— under the field `firmament`, and the `{ start, keys }` object `planFromTree` persists; both made clean the way
`unpackTree` does (an unknown star drops, and a star that only reached the sign through it drops with it). Anything else
reads as `Absent` only when the key is missing, and as `EmptyTree` when it is present but is not a string or object.

A GUI that knows where its own save keeps the sky should hand that value to `decode_tree_value(&value)` directly; the
same three answers apply. This is the one requirement this port cannot prove end to end against a real Daggerfall Unity
save, and the docs say so rather than inventing a field.

## (7) The sidebar's numbers: maxima, and the armour by hit location

`dfo_core::sidebar` is the read-only half a GUI shows beside the build: the effective maximum Health and Spell Points
and the worn armour, by body part. Plain records in, nothing mutated, and the current pools stay what the save held.

**Import once, then discard the documents.** A GUI calls `import_save` with the raw imported document and its
**normalized build** (`save::character_from_save`), keeps the typed facts, and never holds either again. Real upstream
saves carry `items[].equipSlot` or `equipSlots` and **no** `worn` - the build is what normalizes them (`src/save.js:251-259`)
- so the maxima and pools come from the RAW save and the worn list from the build:

```rust
use dfo_core::sidebar::{armor_display, armor_fold_parts, firmament_armor_parts, firmament_layer,
                        import_save, vitals, Layer};

let build = save::character_from_save(&save, opts);   // the normalization: builds `worn` from `items`/`equipSlots`
let facts = import_save(&save, &build);              // maxima from the raw save; worn/enchant from the build
// facts.max_health      save.maxHealth = the entity's rawMaxHealth: the stored value with NO limiter
// facts.max_magicka     save.maxMagicka = the OFFLINE accessor: career base + ExtraSpellPts, Renown/folds taken OFF
// facts.health/magicka  the saved current pools: snapshots, not maxima
// facts.endurance       PERMANENT stats.endurance, which the floor and the share read (never the live value)
// facts.worn            the build's normalized worn list; facts.enchant_mods its `_enchantMods`
let sky = firmament_layer(&facts, plan.get("totals"));   // the Firmament's shares over the floored body
let eff = vitals(&facts, &Layer::default(), &sky);       // stored + online + sky, once
// eff.health / eff.magicka                the maximum a GUI prints
// eff.stored_health / eff.stored_magicka  the save's own, before the layer
// eff.online_health / eff.online_magicka  the composed layer
// eff.snapshot                            the saved current pools

let fold = armor_fold_parts(&facts.worn, &firmament_armor_parts(&plan.get("totals"))); // affixes + sky, ONCE
let display = armor_display(&facts.worn, &facts.enchant_mods, &fold);
// display[3] is the Chest, display[0] the Head, ... in `BODY_PARTS` order (0..6)

// A gear edit stays ONE workflow: if the edited build's ExtraSpellPts rows differ from the imported ones, the effective
// base is Unknown, and the Firmament's Spell-Point share and `vitals.magicka` are Unknown with it (never stale).
let after = facts.after_gear(&edited_build.get("worn").items().to_vec());
let after_sky = firmament_layer(&after, plan.get("totals"));
let after_eff = vitals(&after, &Layer::default(), &after_sky);
```

**Nothing is defaulted.** A missing maximum is `Fact::Unknown`, never the normalized build's `max(1, health)` or `0`.
No path reads a maximum from a build's default, and no unknown becomes a zero; only `Sky::asleep()` (the sky not in
force) and *explicitly stated* online terms are legitimate zeros.

**Health's order** is the vendored one. A save writes the UNLIMITED stored value (`full:systems/save/save.js:342-346`)
and does not save the lycanthrope's limiter, so this module applies none. The live accessor caps the stored value with
the limiter only on a live entity, then adds the composed layer `renown + spire + hp-share + floor`
(`systems/renownLayer.js:83-85`). `Sky` carries `hp`, `mp` and `even` separately; pair it with the per-term `Layer`
fields for a save import, or use `Layer::laid(&entity)` with `Sky::asleep()` for a live entity whose `renownHp` already
holds the sky and the floor. There is deliberately **no example that mixes a composed live term with saved facts**: the
two are different sources, and `health_layer` refuses the mix as `Unknown`.

**Spell Points.** The save's `maxMagicka` is the **offline** accessor (`offlineVitals`, `systems/renownLayer.js:152-168`):
`floor(LiveInt x multiplier) + maxMagickaModifier`, so it **includes** the ExtraSpellPts channel and **excludes** Renown's
and the folds' terms. This module re-adds only the online terms; the stored number is never re-derived (the channel is not
saved), and `spell_points_from_career` is documented as a base explanation, not the save's read.

**The Firmament's arithmetic**, exactly `systems/firmamentPowers.js:253-273`:

```text
end     = capAt("endurance", totals.endurance + pctOf(stats.endurance, totals."pct.endurance"))
floored = maxHealth + evenHpOf(maxHealth, level, stats.endurance + end)
hp      = capAt("hp", totals.hp + pctOf(floored, totals.hpPct))
mp      = capAt("mp", totals.mp + pctOf(maxMagicka, totals.mpPct))
```

`pctOf` is `floor(base x pct / 100)`, and **both reads use the PERMANENT `entity.stats`**, never `liveStat`
(`firmamentPowers.js:128`, `renownLayer.js:84`), so a fortify effect cannot move the floor or the share.

**Armour** is the item rule, not a total: each part's value is what the game's hit chance reads (`armorValues[part]`), a
shield covers every part it protects, and the gear affixes and the Firmament's `armor` star both land on parts. The
paperdoll's number is `(100 - value) / 5 + Decreased - Increased + fold[part]`, where `fold` is `armor_fold_parts`,
passed **once**. The enchantment-and-fold term is `armor_display_mod` = `entityArmorDisplayMod`
(`systems/entityMods.js:200-204`); the `(100 - value) / 5` term is a **C# cite** in a vendored comment
(`systems/equip.js:422-423`), so it is DOCUMENTED, not executable here - `armor_display` composes it as documentation and
the differential proves only `armor_display_mod`. There is no single "armour" total, because the game has none.

**What this is not, and what is unknown.** No movement, regeneration, leech or ordered route: those need units and
triggers and their own verification, and they are deliberately absent rather than stubbed. Renown's own HP/SP per Renown
level cannot be read in this repository (`net/renown.js` is a vendored stub), so the `Layer` fields are the caller's.
Firmament's tree is the account service's and the vendored `firmamentTree`/`firmamentLive` are inert stubs, so a GUI
passes the law's capped totals for the tree it knows is in force; absent totals are `Unknown`, not 0.

**How it is proven.** `tests/sidebar.rs` runs `tests/sidebar_oracle.mjs` and replays every case through
`import_save` (with a `character_from_save`-normalized build) + `firmament_layer` + `vitals`. The oracle drives what this
repository can execute - `levelEven.js`, `chargen.js`'s multiplier/clamp, `equip.js`'s armour table, `lootRarity.js`'s
affix fold, `entityMods.js`'s display term, `renownLayer.js`'s setters - and its header lists what it CANNOT drive (the
stubbed `firmamentTree`, the C# paperdoll rating, `renownBonus`). Composition, not a table of constants. The unit tests
also pin a **real upstream save shape** (`items[]`+`equipSlot`, no `worn`), the before/after wear path, the
unknown-propagation cases, and no mutation of either input.

## How parity is checked

`tools/rust-forge-vectors.mjs` writes `rust/tests/vectors/forge.txt` (**41,135** cases) from the **real** vendored law
and `src/realBuild.js`/`src/model.js`, and `rust/dfo-core/tests/forge.rs` replays it:

- `allocate` — 13,668 cases: every star of thirteen trees (three planned, ten hand-made shapes) at two purses, plus  budget edges; a case is the preview (path, cost, purses left, resulting tree) or its fault word, and the
  `OverBudget` arm, its own four numbers.
- `path` / `alloc` / `takes` — 6,786 each: `pathTo`, `allocatable` and `refundTakes` directly, over every star of every
  tree (the law's own guards, which the preview answers before them).
- `refund` — 6,830: every star of the same trees, plus renown edges; `respec` for each tree.
- `apply` — 22: the whole `analyze` card (attributes, skills, per-swing and DPS figures) before and after a legal tree
  on four theory characters, and after trees the refund preview produced. The generator fails if the trees stop moving a
  DPS figure.
- `treefault` / `faultvalue` — `treeFault` on typed and raw records, every reason.
- `stars` / `craft` / `silver` / `budget` — the budget helpers at their edges (0, bounds, NaN, Infinity, null, past-cap
  ranks), including `Budget::renown`/`ranks`/`of`.
- `totals` / `diff` / `clean` / `cost` — the readers beside the previews.
- `decode` — absent, explicit `null`/`""`, `EMPTY_TREE`, row strings and objects, unknown stars, disconnected stars.

Non-mutation is asserted by the test itself: each family rewrites its input tree, character and options through the
codec before and after the call and fails if a byte differs.

Mutation gate (seed 1, count 1000): `forge.rs` 14 candidates, 13 killed, 1 invalid, **0 survivors**. `firmament_law.rs`
135 candidates, 129 killed, 1 invalid, 5 survivors — all five proven equivalent on the mutated line (`castCostPct`
prices unreachable from the sky; the refund's clamp floor; `pathTo`'s fast path and its loop bound). The gate reports
`FAIL` for proven-equivalent survivors too.

## The gear half: parity

`tools/rust-forge-gear-vectors.mjs` writes `rust/tests/vectors/forge_gear.txt` (382 cases) from the **real** engine,
and `rust/dfo-core/tests/forge_gear.rs` replays it:

- `gearbuild` — 90: legal Magic, Rare and Legendary specs across every group (weapons, armour, shields, jewellery,
  clothing, Hand Wraps), every Legendary record the long blade and every other probed template takes, and the band edges
  (a Rare line at its top and one past); plus the refusals `validatePlan` gives (too many lines, a value past the band, a
  skill a cuirass cannot roll, a repeated skill param, an unknown rarity, a Legendary record that fits another group).
  A case is the minted item, field for field, or the typed refusal.
- `gearwear` — 51: a main-hand wear on seven characters (a two-hander and a shield, a dual pair, armour only, a buffed
  blade, the same-skill blade, a theory build, and one already carrying a Firmament tree), each against seven
  candidates: a mace and a katana (one-handers that displace the right hand), a Dai-katana (a two-hander that clears
  both hands), a Rare Dai-katana, Hand Wraps, and a Legendary Dai-katana. Two more cases are the refusals (a shield, a
  ring). A case is `{ slot, displaced, character }` or the refusal, and the test asserts neither input changed.
- `gearequip` — 35: the whole `analyze` card before and after each legal wear. The generator fails if fewer than eight
  wears move a DPS figure, so the family cannot pass by comparing two identical cards.

The generator also checks, with the game's own builder, that `characterFromSave` over the wear's own bag and worn list
agrees with the wear's answer on `weapon`, `offWeapon`, `wraps`, `legendaries`, `_mods` and `_enchantMods` — the
invariant that makes the gear delta a re-fold rather than a second reading. `the_wear_corpus_keeps_its_displacements_and_refusals`
pins that the corpus keeps those shapes, and `the_main_hand_guard_matches_the_wear` pins that `can_wear_main_hand` and
the preview's refusal agree.

Mutation gate (seed 1, count 400): `forge_gear.rs` 33 candidates, **33 killed, 0 survivors**. `gear.rs` (which gained
the shared whole-item hand law, the worn-list table and `leavers_for`) has 241 of 300 killed; every new-code mutant is
killed, and each of the 47 survivors sits on a line whose text is byte-identical in the pre-change file (verified by
matching each survivor's line against `git show HEAD:rust/dfo-core/src/gear.rs`), so none is new code.
