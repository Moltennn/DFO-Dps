# The Forge API: manual Firmament editing for `DFO Forge`

`dfo_core::forge` (re-exported from `dfo_core::lib`) is the Rust-core API a GUI uses to let a player spend and take
back Firmament stars. It is plain data in, plain data out: `Tree` and `Value` records, typed errors, no ambient state,
and **no input is mutated**. Every preview answers the tree it would leave, so the GUI can hold the player's tree and
show the result without applying it.

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

## The readers beside the previews

`tree_fault_of(&tree, budget)`, `totals(&tree)`, `difference(prev, next)`, `tree_to_value(&tree)` — each the port of
`treeFault`, `totals`, `treeDiff` and the `{ start, keys }` record. `firmament_law`'s own `clean_keys`,
`firm_cost_of`, `fits`, `points_left`, `tree_fault`, `tree_fault_value`, `path_to`, `allocatable`, `refund_takes`,
`tree_diff`, `totals`, `stars_for`, `craft_points_for` and `refund_silver` are public too.

## (4) A saved allocation

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
