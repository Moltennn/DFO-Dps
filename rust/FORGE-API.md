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
`ApplyFault` is `UnknownBuild`, `InvalidTree(TreeFault)`, `NotACharacter` or `AlreadyCarriesTree`.

**The empty tree is no sign, and applying is once.** Two behaviours here are deliberately NOT the JS's, because the JS
has no equivalent call and folding twice destroys the character's own numbers:

- `Tree { start: None, .. }` is the law's `EMPTY_TREE`. Its `tree_plan` carries `start: null`, `totals: {}` and no
  channels, and `apply_tree_to_character` answers the character **unchanged**. The JS `planFromTree`
  (`src/realBuild.js`) cannot express this: a missing start becomes `START_KEYS[0]`, the Serpent, so it would fold the
  Serpent's +2 luck onto an "empty" tree. A GUI that means "no stars" must send `start: null`, not an absent key with
  stars attached.
- `apply_firmament` only ADDS (stats, `statMax`, skills, blow channels). Applying a second tree to a result would stack
  it on the first, and the port cannot un-fold. So the result carries the tree it folded in under
  `FORGE_TREE_FIELD = "forgeFirmament"` (`{ start, keys }`; no rule module reads it), and a character that already has
  that field is refused with `AlreadyCarriesTree`. **A GUI changes a tree by applying the new one to the character it
  imported**, never to a previous result. A no-sign tree writes no mark, because it folds nothing.
- A character that is not a record (a `null`, a number, a string) is `NotACharacter` instead of the `Value::set` panic.

Both are Forge-layer rules with no JS call behind them (the JS never applies a tree to a character in this repository),
so they are local invariants pinned by `tests/gui_boundaries.rs`, not by the parity vectors. The `apply` vectors keep
checking `analyze`'s own answer for the JS's plan, which is why `tests/forge.rs` prices the JS path
(`firmament::plan_from_tree` + `real_build::apply_firmament`) rather than this wrapper.

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

**The spec is checked harder than `validatePlan` does.** `validatePlan` is the max-profile checker: it compares a
line's value against the band's TOP and trusts the record it is handed, and it never asks whether a template is whole or
a material belongs to the item's group. It is enough for a plan the game rolled, not for a record a GUI sends, so
`build_item` adds:

| refused | why |
|---|---|
| a template that is not a whole number (`102.5`) | it names no table row; it used to truncate onto armour 102 |
| a material not on the group's own ladder | weapons 0..=9, armour's leather/chain/chain2/iron..daedric, 0 for jewellery and clothing |
| a line that is not a record | a GUI's malformed line is a fault, not a silent drop |
| a line whose `value` is not a finite number, or is below 1 | every generated band starts at 1, so no roll makes it |

Two checks are **deliberately not** added, because the golden `gearbuild` corpus prices those shapes and the port must
keep JS parity: a line below its band's FLOOR, and a line whose affix KIND does not belong to the slot's group (the
corpus contains a MensClothing piece with an `armor` line). `GearSpec::from_value` likewise refuses a non-array `lines`
and a non-record line element instead of dropping them. The refusals are `GearFault::Illegal` (a sentence a GUI may
show) or `GearFault::Spec`; nothing here reaches `analyze`, and no legal spec's item changes.

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

**`firmament_layer`'s `totals` must be a record.** The vendor reads the live tree's totals object, so a `totals` that
is `undefined`, `null`, a number, a string or an array is *no tree's totals at all*, and every channel is
`Fact::Unknown` — the same as any other absent fact. Only a present object's absent channel reads 0, and an explicit
empty object is the law's own zero sky (a sign with no stars). A GUI that has not loaded a tree passes `Value::Undefined`
and shows "unknown", never a zero sky; `Value::Obj(vec![])` is for a tree it knows has no stars.

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
baseHp  = rawMaxHealth, or maxHealth - renownHp when rawMaxHealth is not set
floored = baseHp + (evenHpOf(entity, stats.endurance + end) when rawMaxHealth is set, else 0)
hp      = capAt("hp", totals.hp + pctOf(floored, totals.hpPct))
baseMp  = maxMagicka - renownMp
mp      = capAt("mp", totals.mp + pctOf(baseMp, totals.mpPct))
```

`pctOf` is `floor(base x pct / 100)`, and **both reads use the PERMANENT `entity.stats`**, never `liveStat`
(`firmamentPowers.js:128`, `renownLayer.js:84`), so a fortify effect cannot move the floor or the share.

**Armour** is the item rule, not a total: each part's value is what the game's hit chance reads (`armorValues[part]`), a
shield covers every part it protects, and the gear affixes and the Firmament's `armor` star both land on parts. The
paperdoll's number is `(100 - value) / 5 + Decreased - Increased + fold[part]`, where `fold` is `armor_fold_parts`,
passed **once**. The enchantment-and-fold term is `armor_display_mod` = `entityArmorDisplayMod`
(`systems/entityMods.js:200-204`); the `(100 - value) / 5` term is a **C# cite** in a vendored comment
(`systems/equip.js:422-423`), so it is DOCUMENTED, not executable here - `armor_display` composes it as documentation and
the differential proves only `armor_display_mod`. There is no single "armour" total, because the game has none. The
affix fold counts the pieces in the vendor's own order - the equip table's slot rule first, then slot order, then the
affix filter, then one copy per Legendary record (`lootRarity.js:2356-2362` over `equip.js:360-367`; see (9)).

**What this is not, and what is unknown.** No movement, regeneration, leech or ordered route: those need units and
triggers and their own verification, and they are deliberately absent rather than stubbed. Renown's own HP/SP per Renown
level cannot be read in this repository (`net/renown.js` is a vendored stub), so the `Layer` fields are the caller's.
Firmament's tree is the account service's. The vendored `firmamentTree` is an inert stub, but `firmamentLive` is real
code: it takes the tree from the host and reports no stats until a tree is set and the page is online
(`systems/firmamentLive.js:35-36, :81-83`). So a GUI passes the law's capped totals for the tree it knows is in force;
absent totals are `Unknown`, not 0.

**How it is proven.** `tests/sidebar.rs` runs `tests/sidebar_oracle.mjs` and replays every case through
`import_save` (with a `character_from_save`-normalized build) + `firmament_layer` + `vitals`. The oracle drives what this
repository can execute - `levelEven.js`, `chargen.js`'s multiplier/clamp, `equip.js`'s armour table, `lootRarity.js`'s
affix fold, `entityMods.js`'s display term, `renownLayer.js`'s setters - and its header lists what it CANNOT drive (the
stubbed `firmamentTree`, the C# paperdoll rating, `renownBonus`). Composition, not a table of constants. The unit tests
also pin a **real upstream save shape** (`items[]`+`equipSlot`, no `worn`), the before/after wear path, the
unknown-propagation cases, and no mutation of either input.

## (8) The shipped build a card is priced under

A GUI that shows damage numbers must pick the game build it prices under. `dfo_core::model_blow` reads it from the
card's own scenario, as the CLI's `--game-build` does:

```rust
use dfo_core::model_blow::{DEFAULT_GAME_BUILD, GAME_BUILDS};   // ["14512", "14631"]; the default is 14631

let mut scenario = /* the scenario you would pass to analyze */;
scenario.set("gameBuild", Value::Str(build.clone()));   // "14512" | "14631"
let card = dfo_core::analyze::analyze(&ch, &scenario, &book);
```

- **`14631`** is the live game and `DEFAULT_GAME_BUILD`: a scenario with no `gameBuild` key prices it, while the
  accepted list is still `GAME_BUILDS`. It is the drift finding (`CHANGELOG-MECHANICS.md` GEAR-14631 / BRAND-14631):
  the weapon gear becomes a flat integer add on the roll (`damage.parts.gearAdd = { lo, hi, mean }`, the card
  enumerates every integer), Axe/Blunt lose their half line, and the `brand` loot power adds flat elemental damage.
  `model_blow::game_build` normalizes the value once; only that check selects the cut.
- **`14512`** is the vendored cut (`vendor/upstream/a3eb1605`) and reproduces the port's pre-flip output byte for
  byte. Only the exact string reaches it: `game_build`/`game_build_name`/`game_build_one` send every other string to
  the live build (the CLI refuses an unknown value before a formula). `CUT_GAME_BUILD` names it for the deliberate
  cut landmarks below.
- **What changes for the reader**: `damage.parts.mastery` is the climb only under `14631`, `damage.parts.gearAdd` is
  present only there, and the add widens `damage.min..max` and `perSwing` (so a cap, a fight tier or an off hand reads
  the true spread). The same key also moves the theory cap sheet (`dfo_core::theory::theory_caps`,
  `gear_mastery_points`) and the `brand` term.
- **The evidence is weaker than a `path:line`.** `14631` is only readable in the shipped build (`dist:` citations in
  `CHANGELOG-MECHANICS.md` and `test/build14631.test.js`), so parity with the JS validates the port, not the game. The
  carried-chain ratio, `duelGearAdd`, the `sigilDueling()` gate, the Gilded item that carries `brand` and the defender
  sigil set are unmodelled; a GUI must not present them as priced.
- **Which entries take the key.** Every entry that prices a card or a plan: the per-card commands (`build`,
  `objective`, `rank`, `report`, `compare`, `scale`, `tradeoff`, `theory`, `graph`, `enchant`) and the planners
  (`imprints`, `weapons`/`skills`, `enchant-plan`/`gear-plan`, `loadout`/`real-dps`). In Rust, a planner call takes
  it from the options record it already reads:
  - `dfo_core::maxprofile::Profiles::legal_gear` / `legal_frontier` / `max_character` and `max_run` read
    `opts.gameBuild`; pass `{"gameBuild": "14631"}` or omit it (the live build is the default).
  - `dfo_core::imprints::rank_family`/`rank_all` read `opts.gameBuild`; `dfo_core::enchant_plan::plan_enchants(_with)`
    and `plan_matrix(_with)` read it too.
  - `dfo_core::loadout_shortlist::ShortlistOpts` carries `game_build`, so the sampled shortlist draws at it.
  `model_blow::game_build_name`/`game_build_one` normalise a bare string.

### Signature changes a GUI must adapt to

The default moved to the live build, so three things are NOT purely additive. A caller that compiles unchanged still
gets different *numbers*, and one of them no longer compiles at all:

1. **`real_build::real_weapon_loadouts` / `real_weapon_loadouts_with` gained a required `game_build: &str`** (4th and
   5th argument, before the book/cache). Pass `DEFAULT_GAME_BUILD` for the live universe or `CUT_GAME_BUILD` to keep
   pre-flip rows. This is the one breaking *signature* change; rename-driven fixes are the intended migration.
2. **`StageOpts` gained `game_build: String`, and its `Default` and its `..Default::default()` callers are now the
   LIVE build** (before the flip a default struct was the cut). A struct literal that lists every field must add the
   field; a GUI that relied on `Default` for old numbers must now set `game_build: CUT_GAME_BUILD.to_owned()`.
   `StageOpts::from_value` reads `gameBuild` from the options record.
3. **`enchant_plan::apply_plan_dps` and `best_weapon_for_family(_with)` keep their old arities but are deliberately
   pinned to the CUT** (`CUT_GAME_BUILD`), because the golden vectors replay exactly those functions. A GUI showing
   *current* numbers must call `apply_plan_dps_at` / `best_weapon_for_family_with_build` (or
   `best_weapon_for_family_at`) with `DEFAULT_GAME_BUILD`. This is the one place where "no key" and "old wrapper"
   mean different things on purpose.

`dfo_cli::report`'s page default, the CLI help caption and every documented figure moved with the same constant;
a GUI that hard-coded `"14512"` anywhere is showing cut numbers and should switch to `DEFAULT_GAME_BUILD`.

- **One planner assumption this exposed.** `legalGear` picks the frontier point by DPS, so it is a *search over
  prices*, not a fixed allocation: at `14631` the flat add makes weapon-skill points beat Critical Strike and the
  winner moves (`250/370/25%` -> `350/252/38%` on the Dai-katana). The frontier cache keys on the build for exactly
  this reason; a GUI that caches a profile itself must key on it too.
- **A hypothetical gear line crashes, it does not loop.** `14631` enumerates every integer add, so a `--gear-lb` past
  V8's spread limit makes the JS throw a `RangeError` (exit 1). The port raises the same `RangeError`
  (`model_blow::JsRangeError`, `MAX_ENUMERATED_BLOWS`) instead of running to an OOM, so it prices exactly the cards
  the JS prices and fails the same way; a legal card (~1,620 blows at 535 points) is ~77x below the cap.

## (9) The checked entry, the caps, and the crashes a record cannot cause

A GUI hands over records it did not write. Three things stand between such a record and a Rust panic or an unbounded
loop: a checked entry for the scenario, a panic guard for whatever is left, and caps on the counts a hand-made record
controls. All three are the Rust-only side; on any input the JS prices, no number moves and the golden vectors are
unchanged.

**`analyze_checked`** is [`analyze`] with a shape check first:

```rust
use dfo_core::analyze::{analyze, analyze_checked, ScenarioFault};

match analyze_checked(&character, &scenario, &book) {
    Ok(card) => { /* exactly `analyze`'s answer */ }
    Err(fault) => { /* show `fault.message()`; nothing was priced */ }
}
```

It reports `ScenarioFault::NotAnObject` for a character or scenario that is not a record, `NotARecord` for a present but
non-record `target`/`weapon`/`wraps`, and `NotAList` for a present but non-list `traits`/`imprints`. This is the
`{"target": 5}` case: `analyze_card` writes `group`/`affinity` onto the target and would panic on a number. A **typo**
(`targt`) is simply an absent key and prices the reference foe, exactly as the JS does — only a present, wrong-shaped
value is a fault. `analyze` itself is unchanged; call it when the record's shape is already known.

**`dfo_core::fault::guard`** turns a panic into a typed answer for a boundary that cannot be pre-checked:

```rust
use dfo_core::fault::{guard, CoreFault};

match guard(|| analyze(&character, &scenario, &book)) {
    Ok(card) => { /* priced */ }
    Err(CoreFault::Range(message)) => { /* the JS's own RangeError text */ }
    Err(CoreFault::Message(text) | CoreFault::Panic(text)) => { /* a bug; show `text` and report it */ }
    Err(CoreFault::Unknown) => { /* a non-string panic payload */ }
}
```

It uses `catch_unwind` and installs ONE process-wide hook, once: the hook delegates to whatever hook was in place and
skips that call only while the **current thread** is inside a `guard` (a thread-local depth). So a host's own panic hook
is never taken away or put back, another thread's panics are still reported while this thread guards, and `guard` may be
called from a `Drop` that runs during unwinding. Install your own hook before the first `guard` if you want it under the
chain; a hook installed later replaces the chain (the panic is then reported normally, and `guard` still catches it). The
depth is restored on the panic path by an RAII guard, so a caught fault never leaves the thread quiet. `JsRangeError`
payloads arrive as `CoreFault::Range` with their JS message intact.

**The caps.** The CLI accepts any positive finite `--max-seconds` and any positive safe-integer `--max-blows`
(`dfo-cli`'s `sampled_options`), so the core never refuses the REQUEST: a fight or relay that ends early prices exactly
as the JS, however large the limit. What is bounded is WORK, and each bound sits far above anything legitimate:

| cap | value | what a hand-made record would otherwise do |
|---|---|---|
| `simulate_fight::MAX_FIGHT_BLOWS` | 1e8 blows that LAND | `maxBlows: 1e18` on a pool nothing kills keeps swinging for hours (the request is accepted; the work stops here) |
| `simulate_fight::MAX_FIGHT_ROUNDS` | 1e6 rounds (5 s each) | a continuous effect with `roundsRemaining: 1e300`, or a horizon whose rounds cannot be stepped |
| `simulate_fight::MAX_FIGHT_SEEDS` | 1,000,000 (the CLI's own `--trials` ceiling) | `seeds: 1e12` allocates until the process dies (also `loadout_shortlist`'s `trials`) |
| `analyze::MAX_MATERIAL_ROWS` | 1,000 | `rank_weapons`' `for (m = 0; m < materials; m++)` prices forever |
| `model_blow::MAX_ECHO_POWERS` | 20 | `after_share` enumerates `2^n` masks |
| `model_blow::MAX_ENUMERATED_BLOWS` | 124,500 | the `--gear-lb` spread the JS itself throws on |
| `analyze`'s array growth | 10,000 | a `skillId` of `1e9` would grow an array to a billion slots |
| `simulate_fight`'s tier cache | 4,096 entries, one fight's wear keys at a time | a long durability fight, or a shared batch cache, grows the map without bound |

Past a work cap, `simulate_fight::past_work_cap` raises the JS-shaped `RangeError` ("the fight ran past the port's blow
cap of 100000000"), which `guard` answers as `CoreFault::Range`. The drain to a horizon with no continuous effect left
to bill is jumped rather than stepped (one round still drops expired effects), so a legal `--max-seconds 100000000` on
a fight that did not kill costs no rounds at all.

**What moved in this API.** `simulate_fight::MAX_FIGHT_SECONDS` is **gone** (no horizon is refused any more); a GUI that
referenced it should drop the check. `MAX_FIGHT_BLOWS` now bounds blows that LAND, not the requested budget, and
`MAX_FIGHT_SEEDS` rose from 100,000 to 1,000,000 (the CLI's `--trials` ceiling), so `loadout_shortlist` accepts what the
CLI accepts. `MAX_FIGHT_ROUNDS`, `past_work_cap`, `TierCache::cached_tiers` and `fault::chain_hook_for_test` are new;
the last three are `#[doc(hidden)]` and exist for the tests, not for a GUI.

The last two change nothing observable: a `skillId` that names no index is a no-op (a JS sparse property no reader
sees), and a dropped tier is recomputed to the same distribution. The batch's per-fight clear only drops wear keys whose
`(fight, item, epoch)` can never be asked for again (the `Fixed` keys, pure functions of the shared scenario, stay), so a
batch's numbers are unchanged too.

**A malformed record that the JS itself throws on** is priced by the port where "priced" is well defined, and the
divergence is limited to that input:

- `cws::resolve_cws_cast` replaces a non-array `target.activeEffects` with an empty list (the JS `?? []` keeps the
  number and then `TypeError`s on `.find`), and answers an empty landing for a non-object target.
- `probe::fight_summary(&[], _)` is `null` (the JS reads `samples[0].t` and throws).
- `firmament::plan_summary` sorts a NaN-bearing totals record without panicking (the JS comparator is not a total order
  there; the JS sort survives it, Rust's does not). A plan's own totals are never NaN, so this only reaches a
  hand-edited plan.
- `marginals`/`rank_affixes` treat a fractional or non-numeric `skillId` as "no index" rather than panicking.

**The armour fold follows the vendor's order.** `sidebar::affix_armor_points` now applies the rules in the order
`lootRarity.js:2356-2362`'s `wornItems` does over `equip.js:360-367`'s `fillEquipTable`:

1. a second piece claiming an `equipSlot` loses its mark (the first claim wins, and an unusable slot is not in the table);
2. the survivors are the equip table's, so they are read in **slot order** (ties keep the list's order);
3. a piece with no affix list is filtered out;
4. and only then does `loot::counted_pieces` keep the **first copy** of one Legendary record.

The order is observable: counting before the slot rule keeps a different piece, and counting before the sort picks the
wrong copy of a Legendary worn on two slots. `armor_values` already applied the table's slot rule; this is the same
order on the affix side. `tests/sidebar_oracle.mjs` now carries the review's three layouts (`[plain@18, warden@18,
warden@26]` -> chest 12 / feet 20; `[warden@26, warden@18]` -> chest 15 / feet 0; a bare warden@18 before warden@26 ->
chest 0 / feet 20), and `tests/sidebar.rs` replays them against the vendored `fillEquipTable` + `countedPieces`.

`tests/gui_boundaries.rs` and `tests/gui_faults.rs` and `tests/fault_hook.rs` pin every guard above (the hook's thread
isolation, a `guard` from a `Drop` during unwinding, the work caps' messages, the batch cache's growth, the add-count
check that a NaN roll cannot excuse). They are **local invariants**: no vendored JS function prices those inputs (the JS
throws on most of them), so they pin the guard's shape and the cap's edge, not a number the JS produces.

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

## Unverified inputs and waivers

Each item below is a value a GUI may show that no runnable game code in this repository confirms. The mechanics are
described in sections [2](#2-preview-a-refund), [6](#6-a-saved-allocation) and
[7](#7-the-sidebars-numbers-maxima-and-the-armour-by-hit-location); this list says what is not checked and what to show.

**1. Paperdoll armour rating, `(100 - av) / 5`.** Returns: the `armor_display` figure per body part (`sidebar.rs:588-596`).
Unverified: the term exists only as a C# cite in a vendored comment, `vendor/upstream/a3eb1605/src/systems/equip.js:422-423`,
and the oracle lists it as not drivable (`rust/dfo-core/tests/sidebar_oracle.mjs:19`). Only the enchantment-and-fold term
(`entityArmorDisplayMod`, `entityMods.js:200-204`) is proven. GUI: show the proven part, or label the rating "unverified";
do not present it as the game's paperdoll figure. Closes with: a paperdoll reading from the running game on a fixed build,
added to `sidebar_oracle.mjs`.

**2. `renownBonus` (Renown's Health and Spell Points).** Returns: the caller's `Layer.renown_hp` / `renown_mp`
(`sidebar.rs:229-234`). Unverified: `renownBonus` is an inert stub (`vendor/upstream/a3eb1605/src/net/renown.js:51`),
called at `systems/renownLayer.js:77`. The per-level literals are present (`renown.js:30,33`: 3 Health, 2 Spell Points),
but the function that turns a level into the bonus is not. `Layer` reads an unstated Renown term as 0
(`sidebar.rs:220-221`). GUI: pass Renown explicitly, and mark the maximum "incomplete" when it is not passed; never
show a zero as the game's value. Closes with: the un-stubbed `renownBonus` (a user-run vendor re-pin), or in-game
readings at two Renown levels.

**3. `preview_respec` and the 10,000 gold.** Returns: `RespecPreview` with `gold: 10000` and no silver (`forge.rs:291-306`;
`firmament_law.rs:460`). Unverified: there is no JS function. `vendor/firmament/firmamentLaw.js:477-480` holds the
record `FIRM_RESPEC_GOLD = 10_000` and prose, and says the gold is paid by the account service (`:478-479`, not vendored).
The vector generator uses the same reading (`tools/rust-forge-vectors.mjs:74-75`), so parity pins the shape and the
constant, not an independent result. `Budget` has no gold purse, so the GUI cannot check affordability. GUI: show
"Respec: 10,000 gold, the whole sky back" as the rule, with no balance check. Closes with: `respecFirmament` in
`server-account/src/firmament.js` (not vendored), or a captured in-game respec.

**4. Firmament allocations in a real save.** Returns: `Absent`, `EmptyTree` or `Tree` from a field named `firmament`
(`forge.rs:473-476`). Unverified: the name and shape are a guess. `src/save.js` has no reference to the Firmament, and
neither does `vendor/upstream/a3eb1605/src/systems/save/`. The tree is the account service's (`firmamentLive.js:7-8`), and
`net/firmament/firmamentBook.js`, which hands it in, is not vendored. GUI: show an allocation only when the GUI's own
source supplies one; for `Absent`, show "unknown", never "no stars". Closes with: the wire field from `firmamentBook.js`
(a user-run re-pin), or a real save fixture that carries an allocation.

**5. The sidebar's Firmament arithmetic.** Returns: `firmament_layer`'s Health and Spell Point shares, from totals the
caller passes (`sidebar.rs:63-67`). Unverified: the tree's totals. The stub is `net/firmament/firmamentTree.js` (the star
table, `vendor/upstream/a3eb1605/src/net/firmament/firmamentTree.js:1-10`), not `firmamentLive.js`, which is real code.
`firmamentLive.js` takes the tree from the host (`:35-36`), starts from `EMPTY_TREE` (`:17`), and reports no stats
until a tree is set and the page is online (`:81`, `:83`). Section 7's block follows `firmamentPowers.js:258-270`: Health
from `rawMaxHealth` (or `maxHealth - renownHp`), Spell Points from `maxMagicka - renownMp`.
GUI: pass totals only for a tree the account service confirmed; show absent totals as unknown. Closes with: the account
service's totals for a known tree.

**6. Conditional Spell Points after a gear edit.** Returns: `after_gear` keeps the saved maximum when the ExtraSpellPts
rows are unchanged, and makes it `Unknown` when they change (`sidebar.rs:340-358`). Unverified: the save records no
active rows, so the saved base is trusted to reflect the current condition (`sidebar.rs:340-342`; the condition is
`enchantments.js:604-619`). GUI: after a changing edit show Spell
Points as "unknown until re-read"; never the pre-edit number. Closes with: the condition's inputs in the save, or a
game reading of the maximum before and after an edit on a known date.

**7. The 0.1.14631 live game.** Closed for the DEFAULT: the live build is now `DEFAULT_GAME_BUILD` and is what a
caller with no `gameBuild` key prices (`dfo-core/src/model_blow.rs:803-807`). The evidence is still `dist:` citations
(`CHANGELOG-MECHANICS.md` GEAR-14631 / BRAND-14631, `test/build14631.test.js`), not a `path:line`, so it rests on the
shipped bundle being read correctly; the port's parity proves it matches the JS, not the game. `14512` remains the
vendored cut (`vendor/upstream/a3eb1605`) and reproduces the pre-flip bytes exactly. Unverified on the 14631 side:
the carried-chain ratio `e/(1+e+a)`, `duelGearAdd`, the `sigilDueling()` gate, the Gilded item carrying `brand` and
the defender sigil set are unmodelled, so a GUI must not present them as priced. Closes for those with a user-run
real-save diff on the live client (section 8's signature changes are already in).
