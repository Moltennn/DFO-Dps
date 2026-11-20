//! Manual Firmament editing for a GUI (`DFO Forge`): preview an allocation, preview a refund, judge a tree, apply a
//! tree to a character, and decode a saved allocation. Plain typed functions over [`Tree`], no ambient state, and no
//! input is mutated: every preview returns the tree it would leave.
//!
//! The rules are the vendored law's (`vendor/firmament/firmamentLaw.js`), ported in [`crate::firmament_law`]:
//! `pathTo`, `treeFault`, `fits`, `pointsLeft`, `refundTakes`, `cleanKeys`, `treeDiff`, `totals`, `starsFor`,
//! `craftPointsFor` and `refundSilver`. Application is the chain `src/realBuild.js` uses: `planFromTree` then
//! `applyFirmament` (a new character; the original is untouched), whose `_mods` and `firmamentDamagePct` the analysis
//! reads.
//!
//! Gear editing lives beside it: [`build_item`] mints a player item from explicit parts (a template, a material and
//! either a rarity with its lines or a Legendary record id), and [`preview_equip_main_hand`] answers the character a
//! main-hand wear would leave and the pieces it takes off. Both are the game's own rules (the legal-line validator, the
//! condition mint, the hand law and `wearLeavers`), and neither mutates its input. See `rust/FORGE-API.md`.

pub use crate::forge_gear::{
    build_item, can_wear_main_hand, preview_equip_main_hand, EquipPreview, GearFault, GearSpec,
};

use crate::firmament::{build_by_id, plan_from_tree};
use crate::firmament_law::{
    self as law, clean_keys, firm_cost_of, fits, is_start, node, path_to, points_left, reach_from,
    refund_silver, refund_takes, tree_fault, Tree, TreeFault, ATTRS,
};
use crate::real_build::apply_firmament;
use crate::value::Value::{self, Arr, Null, Num, Obj, Str};

/// The two purses an allocation is judged against: the Stars a Renown level brings, and the Craft points the
/// character's profession ranks give. `firmament_law::stars_for` and `craft_points_for` build each half.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Budget {
    pub stars: f64,
    pub craft: f64,
}

impl Budget {
    pub fn new(stars: f64, craft: f64) -> Self {
        Self { stars, craft }
    }

    /// The Stars a Renown level brings (0 at Renown 1, 98 at 50), and no Craft points.
    pub fn renown(renown: f64) -> Self {
        Self {
            stars: law::stars_for(renown),
            craft: 0.0,
        }
    }

    /// No Stars, and the Craft points a character's profession ranks give (one per eight ranks over the ten tracks).
    pub fn ranks(ranks: impl IntoIterator<Item = f64>) -> Self {
        Self {
            stars: 0.0,
            craft: law::craft_points_for(ranks),
        }
    }

    /// Both purses from a Renown level and the profession ranks.
    pub fn of(renown: f64, ranks: impl IntoIterator<Item = f64>) -> Self {
        Self {
            stars: law::stars_for(renown),
            craft: law::craft_points_for(ranks),
        }
    }

    pub fn to_value(self) -> Value {
        let mut out = Obj(vec![]);
        out.set("stars", Num(self.stars));
        out.set("craft", Num(self.craft));
        out
    }
}

/// A tree as the JS shapes it (`{ start, keys }`); `start` is `null` for the empty sky.
pub fn tree_to_value(tree: &Tree) -> Value {
    let mut out = Obj(vec![]);
    out.set("start", tree.start.as_deref().map_or(Null, s));
    out.set("keys", Arr(tree.keys.iter().map(|k| s(k)).collect()));
    out
}

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

// ─── (1) AN ALLOCATION ──────────────────────────────────────────────

/// What allocating one star would do: the path it takes (nearest first, ending with the star), its cost in stars, the
/// purses left afterwards, and the tree that would result. Nothing is mutated.
#[derive(Debug, Clone, PartialEq)]
pub struct AllocatePreview {
    pub path: Vec<String>,
    /// The stars the path adds (one point each; a start is free and never on a path).
    pub cost: f64,
    pub points_left: Budget,
    pub resulting_tree: Tree,
}

/// Why a star cannot be allocated. Every case is the law's own: `treeFault`'s reasons, `pathTo`'s empty answer, and
/// `fits`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AllocateFault {
    /// The tree itself is not whole (`treeFault`): a key the sky has not, a start among the stars, a disconnected star.
    Tree(TreeFault),
    /// No sign is allotted yet, so there is nothing to join a star to (`EMPTY_TREE`).
    NoStart,
    /// The key is not a star of the sky.
    UnknownNode,
    /// The key names a birthsign, which is chosen and never allocated (`isStart`).
    StartKey,
    /// The star is the start, or is allocated already.
    AlreadyAllocated,
    /// No way is open: another sign's start, a keystone's far side, or a star in another sign's corner.
    NotReachable,
    /// The path would cost more than the purses hold (`fits`).
    OverBudget {
        /// The resulting allocation's combat stars.
        combat: f64,
        /// The Stars purse.
        stars: f64,
        /// The resulting allocation's combat and life stars together.
        total: f64,
        /// The Stars and Craft purses together.
        purse: f64,
    },
}

impl AllocateFault {
    /// A one-line reason a player can read.
    pub fn message(&self) -> String {
        match self {
            AllocateFault::Tree(fault) => format!(
                "the tree is not whole: {}",
                match fault {
                    TreeFault::Key => "a key is not a star of the sky, is a sign, or repeats",
                    TreeFault::Start => "no sign the sky has is chosen",
                    TreeFault::Path => "a star is not joined to the sign through the stars allocated",
                    TreeFault::Points => "the allocation costs more than the purses hold",
                }
            ),
            AllocateFault::NoStart => "choose a birthsign first: there is nothing to join a star to".to_owned(),
            AllocateFault::UnknownNode => "that key is not a star of the sky".to_owned(),
            AllocateFault::StartKey => "a birthsign is chosen, not allocated".to_owned(),
            AllocateFault::AlreadyAllocated => "that star is allocated already".to_owned(),
            AllocateFault::NotReachable => {
                "no open path reaches that star from what is allocated".to_owned()
            }
            AllocateFault::OverBudget {
                combat,
                stars,
                total,
                purse,
            } => format!(
                "over budget: {combat} combat stars (the Stars purse holds {stars}) and {total} stars in all (both purses hold {purse})"
            ),
        }
    }
}

/// (1) Preview allocating `key` on `tree` within `budget`. On success the preview is the JS `pathTo` path, its cost,
/// `pointsLeft` after it and the tree it leaves; on failure the reason. `tree` is never mutated.
pub fn preview_allocate(
    tree: &Tree,
    key: &str,
    budget: Budget,
) -> Result<AllocatePreview, AllocateFault> {
    if let Some(fault) = tree_fault(tree, budget.stars, budget.craft) {
        return Err(AllocateFault::Tree(fault));
    }
    let Some(start) = tree.start.as_deref() else {
        return Err(AllocateFault::NoStart);
    };
    if node(key).is_none() {
        return Err(AllocateFault::UnknownNode);
    }
    if is_start(key) {
        return Err(AllocateFault::StartKey);
    }
    if key == start || tree.keys.iter().any(|k| k == key) {
        return Err(AllocateFault::AlreadyAllocated);
    }
    let path = path_to(tree, key);
    if path.is_empty() {
        return Err(AllocateFault::NotReachable);
    }
    let mut keys = tree.keys.clone();
    for k in &path {
        if !keys.iter().any(|x| x == k) {
            keys.push(k.clone());
        }
    }
    keys.sort();
    let clean = clean_keys(&keys);
    let (combat, life) = firm_cost_of(&clean);
    if !fits(&clean, budget.stars, budget.craft) {
        return Err(AllocateFault::OverBudget {
            combat,
            stars: budget.stars,
            total: combat + life,
            purse: budget.stars + budget.craft,
        });
    }
    let (stars, craft) = points_left(&clean, budget.stars, budget.craft);
    Ok(AllocatePreview {
        cost: path.len() as f64,
        path,
        points_left: Budget { stars, craft },
        resulting_tree: Tree {
            start: tree.start.clone(),
            keys: clean,
        },
    })
}

/// `allocatable`: whether `key` may be allocated next (one line from what is allocated, and allocatable at all).
pub fn allocatable(tree: &Tree, key: &str) -> bool {
    law::allocatable(tree, key)
}

// ─── (2) A REFUND ──────────────────────────────────────────────────

/// What refunding one star would do: the stars it takes with it, the tree that would result, and what the refund costs
/// in silver. `removed` is `refundTakes`' own list: the JS pushes the star, then every star that only reached the sign
/// through it, and SORTS the lot - so the refunded star is not necessarily first.
#[derive(Debug, Clone, PartialEq)]
pub struct RefundPreview {
    pub removed: Vec<String>,
    pub resulting_tree: Tree,
    /// `refundSilver(removed.length, renown)`: free below Renown 10, then ten silver a star.
    pub refund_silver: f64,
}

/// Why a star cannot be refunded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefundFault {
    /// No sign is allotted, so nothing is allocated.
    NoStart,
    /// The key is not a star of the sky.
    UnknownNode,
    /// The key is the birthsign: the law's `refundTakes` holds stars only, and a sign is taken back with the whole sky
    /// (see [`preview_respec`]).
    StartSign,
    /// The star is not allocated.
    NotAllocated,
}

impl RefundFault {
    pub fn message(&self) -> String {
        match self {
            RefundFault::NoStart => "no birthsign is chosen, so nothing is allocated".to_owned(),
            RefundFault::UnknownNode => "that key is not a star of the sky".to_owned(),
            RefundFault::StartSign => {
                "a birthsign is not refunded star by star: changing sign takes the whole sky back (respec)"
                    .to_owned()
            }
            RefundFault::NotAllocated => "that star is not allocated".to_owned(),
        }
    }
}

/// (2) Preview refunding `key` on `tree` at `renown`, exactly `refundTakes`. `tree` is never mutated.
pub fn preview_refund(tree: &Tree, key: &str, renown: f64) -> Result<RefundPreview, RefundFault> {
    let Some(start) = tree.start.as_deref() else {
        return Err(RefundFault::NoStart);
    };
    if node(key).is_none() {
        return Err(RefundFault::UnknownNode);
    }
    if key == start {
        return Err(RefundFault::StartSign);
    }
    if !tree.keys.iter().any(|k| k == key) {
        return Err(RefundFault::NotAllocated);
    }
    let removed = refund_takes(tree, key);
    let resulting_tree = Tree {
        start: tree.start.clone(),
        keys: tree
            .keys
            .iter()
            .filter(|k| !removed.iter().any(|r| r == *k))
            .cloned()
            .collect(),
    };
    Ok(RefundPreview {
        removed: removed.clone(),
        resulting_tree,
        refund_silver: refund_silver(removed.len() as f64, renown),
    })
}

/// The respec (`FIRM_RESPEC_GOLD`, firmamentLaw.js:479-482): the whole sky taken back at once - every star and the
/// birthsign, to choose again - for a flat gold fee, whatever the Renown, and no silver. The vendored law documents it
/// beside `refundTakes` but has no function of its own; this is the reading of that record, not a JS call.
#[derive(Debug, Clone, PartialEq)]
pub struct RespecPreview {
    pub removed: Vec<String>,
    pub resulting_tree: Tree,
    pub gold: f64,
    pub refund_silver: f64,
}

pub fn preview_respec(tree: &Tree) -> RespecPreview {
    RespecPreview {
        removed: clean_keys(&tree.keys),
        resulting_tree: Tree::empty(),
        gold: law::FIRM_RESPEC_GOLD,
        refund_silver: 0.0,
    }
}

// ─── THE TREE ITSELF ───────────────────────────────────────────────

/// `treeFault`: why the tree is not whole for these purses, or `None` when it is.
pub fn tree_fault_of(tree: &Tree, budget: Budget) -> Option<TreeFault> {
    tree_fault(tree, budget.stars, budget.craft)
}

/// `totals` (uncapped): every channel's raw sum over the sign and the stars, `[{ key, value }]` in the JS key order.
pub fn totals(tree: &Tree) -> Vec<(String, f64)> {
    law::totals(tree)
}

/// `treeDiff`: the keys `next` adds to `prev` and the keys it takes away (both sorted); a changed sign swaps the lot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub start_changed: bool,
}

pub fn difference(prev: &Tree, next: &Tree) -> Diff {
    let d = law::tree_diff(prev, next);
    Diff {
        added: d.added,
        removed: d.removed,
        start_changed: d.start_changed,
    }
}

// ─── (3) A TREE ON A CHARACTER ────────────────────────────────────

/// Why a tree cannot be put on a character.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyFault {
    /// The build is not a preset (or a preset-shaped record), so there is no `skill` to read the blow against.
    UnknownBuild,
    /// The tree is not whole: `treeFault` at its own cost (the point test cannot fire, the purse is not known here).
    InvalidTree(TreeFault),
}

impl ApplyFault {
    pub fn message(&self) -> String {
        match self {
            ApplyFault::UnknownBuild => "no such build preset".to_owned(),
            ApplyFault::InvalidTree(_) => {
                "the tree is not whole: its keys are not stars the sky has, or are not joined to the sign".to_owned()
            }
        }
    }
}

fn resolve_build(build: &Value) -> Option<&'static Value> {
    match build {
        Str(_) => build_by_id(build),
        Obj(_) => None,
        _ => None,
    }
}

fn build_value(build: &Value) -> Result<Value, ApplyFault> {
    if let Some(preset) = resolve_build(build) {
        return Ok(preset.clone());
    }
    match build {
        Obj(_) => Ok(build.clone()),
        _ => Err(ApplyFault::UnknownBuild),
    }
}

fn checked(tree: &Tree) -> Result<(), ApplyFault> {
    // A character has no purse: `applyFirmament` never asks whether a tree fits, so the check judges the keys, the sign
    // and the path only. Infinite purses make `fits` unable to fire, which is exactly that.
    match tree_fault(tree, f64::INFINITY, f64::INFINITY) {
        None => Ok(()),
        Some(fault) => Err(ApplyFault::InvalidTree(fault)),
    }
}

/// The `planFromTree` plan a tree and a build make: `{ build, tree, totals, ... }`, what [`apply_tree_to_character`]
/// feeds `applyFirmament` and what a GUI can show before applying.
pub fn tree_plan(build: &Value, tree: &Tree) -> Result<Value, ApplyFault> {
    checked(tree)?;
    let build = build_value(build)?;
    let mut opts = Obj(vec![]);
    opts.set("start", tree.start.as_deref().map_or(Null, s));
    opts.set("keys", Arr(tree.keys.iter().map(|k| s(k)).collect()));
    opts.set("stars", Num(tree.keys.len() as f64));
    Ok(plan_from_tree(&build, &opts))
}

/// (3) The character a tree makes: the SAME `applyFirmament` the real-build chain uses, so `analyze()` on the result
/// reads the stars' attribute and blow effects. The input character is not mutated; the result is a new `Value`.
pub fn apply_tree_to_character(
    character: &Value,
    build: &Value,
    tree: &Tree,
) -> Result<Value, ApplyFault> {
    let plan = tree_plan(build, tree)?;
    Ok(apply_firmament(character, &plan))
}

/// The eight attribute totals the tree adds, in the attribute order (`effectiveValue` of each).
pub fn attribute_values(tree: &Tree) -> Vec<(&'static str, f64)> {
    law::attribute_values(&law::tree_stats(tree))
}

/// The attribute names, so a GUI can label the eight rows without its own list.
pub fn attribute_keys() -> &'static [&'static str; 8] {
    &ATTRS
}

// ─── (4) A SAVED ALLOCATION ───────────────────────────────────────

/// What a save holds about the sky.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedFirmament {
    /// The save carries no allocation field at all: the character has never chosen a sign.
    Absent,
    /// The field is there and says none: `null`, `""`, or `EMPTY_TREE`'s `{ start: null, keys: [] }`.
    EmptyTree,
    /// A whole allocation.
    Tree(Tree),
}

/// `unpackTree`: a row's allocation (`"<start>|<key>,<key>,..."`) made clean. A start the sky has not reads as none,
/// a star the sky no longer has drops, and every star that reached the sign only through it drops with it.
pub fn unpack_tree(row: &str) -> Tree {
    if row.is_empty() {
        return Tree::empty();
    }
    let (start, rest) = match row.find('|') {
        Some(bar) => (&row[..bar], &row[bar + 1..]),
        None => (row, ""),
    };
    if !is_start(start) {
        return Tree::empty();
    }
    let keys = clean_keys(&rest.split(',').map(str::to_owned).collect::<Vec<_>>());
    let set: std::collections::BTreeSet<&str> = keys.iter().map(String::as_str).collect();
    let reached = reach_from(start, &set);
    Tree {
        start: Some(start.to_owned()),
        keys: keys.into_iter().filter(|k| reached.contains(k)).collect(),
    }
}

/// (4) Decode a save's Firmament allocation.
///
/// WHERE THE DATA IS (checked, not assumed): `src/save.js`'s `characterFromSave` reads no Firmament field (stats,
/// skills, items, `_mods`, `_enchantMods`, `activeEffects`, `martialPath` only), and the vendored upstream save
/// carries none either: `systems/firmamentLive.js` says the tree is the ACCOUNT SERVICE's (`server-account/src/
/// firmament.js`, handed in by `net/firmament/firmamentBook.js`) and is "in force ONLINE ALONE: offline the character
/// is the save's, Daggerfall's, with no sky at all". `firmamentBook.js` is not vendored, so the wire field's name is
/// not verifiable here. This decoder therefore reads the one shape the law itself serialises - the row string
/// `packTree` writes (`"<start>|<key>,<key>"`, `unpackTree`'s own input) - under the field `firmament`, and the
/// object shape `src/firmament.js` plans and `planFromTree` persists (`{ start, keys }`). Any other field name, and
/// any save that stores the sky outside `SaveData.txt`, is outside what this port can see; a GUI that knows the real
/// field should pass the value itself to [`decode_tree_value`].
///
/// The three answers are distinct on purpose: `Absent` is a save that has never carried the field (nothing to show,
/// not "the player spent nothing"), `EmptyTree` is an explicit "no sign chosen", and `Tree` is an allocation.
pub fn decode_saved_firmament(save: &Value) -> SavedFirmament {
    if !save.has("firmament") {
        return SavedFirmament::Absent;
    }
    decode_tree_value(save.get("firmament"))
}

/// The same three-way read over a bare allocation value (a row string or `{ start, keys }`), for a GUI that knows
/// where its own save keeps it.
pub fn decode_tree_value(v: &Value) -> SavedFirmament {
    match v {
        Value::Undefined | Null => SavedFirmament::EmptyTree,
        Str(row) => {
            let tree = unpack_tree(row);
            if tree.start.is_none() {
                SavedFirmament::EmptyTree
            } else {
                SavedFirmament::Tree(tree)
            }
        }
        Obj(_) => {
            let start = v.get("start");
            if start.is_nullish() {
                return SavedFirmament::EmptyTree;
            }
            let Some(start) = start.as_str() else {
                return SavedFirmament::EmptyTree;
            };
            let tree = unpack_tree(&pack_row(start, v.get("keys")));
            if tree.start.is_none() {
                SavedFirmament::EmptyTree
            } else {
                SavedFirmament::Tree(tree)
            }
        }
        _ => SavedFirmament::EmptyTree,
    }
}

/// `packTree`: the row string for a sign and its keys (`"<start>|<key>,<key>"`), used to give [`unpack_tree`] the
/// object shape back.
fn pack_row(start: &str, keys: &Value) -> String {
    let keys: Vec<String> = keys.items().iter().map(Value::to_js_string).collect();
    format!("{start}|{}", clean_keys(&keys).join(","))
}
