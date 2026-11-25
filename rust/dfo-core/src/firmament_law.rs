//! The Firmament's law and sky: what a star gives, the caps, and the channel readers
//! (`vendor/firmament/firmamentTree.js`, `vendor/firmament/firmamentLaw.js`).
//!
//! Only the parts `src/firmament.js` and `src/realBuild.js` call are ported: `statDef`, `statWords`, `isPrice`,
//! `isStart`, `treeStats`/`treeParts` (via a caller-built tree), `blowPct`, `castCostPct`, `smallStats` and the sign
//! names. The powers, purses, build codes, refunds and wire rows of the vendored file are not on the planner's path.
//!
//! The sky is generated (`generated::firmament`): `FIRM_NODES` in the Map's insertion order, `FIRM_ADJ` with each
//! node's neighbours sorted (the vendored `FIRM_ADJ` sorts them), the `statDef` rows, the channel words and the build
//! presets. `FIRMAMENT_NODES` is `FIRM_NODES.size` (518).

use crate::generated::firmament::{FIRM_ADJ, FIRM_NODES, START_KEYS, STAT_DEF_ROWS, STAT_WORDS};
use crate::round::math_round;
use crate::value::Value::{self, Num};
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

pub const FIRMAMENT_NODES: usize = 518;
pub const FIRMAMENT_STARS: f64 = 98.0;
pub const BLOW_CAP: f64 = 30.0;
pub const BLOW_FLOOR: f64 = -20.0;
pub const BLOW_TOTAL_CAP: f64 = 50.0;
pub const CAST_COST_CAP: f64 = 25.0;

/// The eight attribute names (firmamentLaw.js `ATTRIBUTES`, pinned equal to firmamentTree.js's).
pub const ATTRS: [&str; 8] = [
    "strength",
    "intelligence",
    "willpower",
    "agility",
    "endurance",
    "personality",
    "speed",
    "luck",
];
pub const SKILL_PREFIX: &str = "skill.";

pub fn in_attrs(key: &str) -> bool {
    ATTRS.contains(&key)
}

/// A channel's definition (firmamentLaw.js `statDef`). `words` is spelled out for each capped value by the generator.
#[derive(Debug, Clone, Copy)]
pub struct StatDef {
    pub kind: &'static str,
    pub max: f64,
    pub min: f64,
}

pub fn stat_def(key: &str) -> Option<StatDef> {
    STAT_DEF_ROWS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, d)| StatDef {
            kind: d.kind,
            max: d.max,
            min: d.min,
        })
}

/// `statWords(key, v)` for a capped value (`treeStats` clamps to min..max, so a row is one of the generated words).
/// A key no channel is falls back to `${key} ${signed(v)}`, as the JS does.
pub fn stat_words(key: &str, v: f64) -> String {
    // The generated rows hold every integer in min..max (a capped total's only integer values); `-0` equals `0` there.
    let probe = if v == 0.0 { 0.0 } else { v };
    if let Some((_, _, w)) = STAT_WORDS
        .iter()
        .find(|(k, val, _)| *k == key && *val == probe)
    {
        return (*w).to_owned();
    }
    format!("{key} {}", signed(v))
}

fn signed(v: f64) -> String {
    let body = crate::value::number_to_string(v);
    if v >= 0.0 {
        format!("+{body}")
    } else {
        body
    }
}

/// `isPrice(key, v)`: a `*Taken` channel prices a positive value against its holder, any other a negative one.
pub fn is_price(key: &str, v: f64) -> bool {
    if key.ends_with("Taken") {
        v > 0.0
    } else {
        v < 0.0
    }
}

/// Whether `key` names a start (`isStart`).
pub fn is_start(key: &str) -> bool {
    START_KEYS.contains(&key)
}

/// `signName`: the Serpent for `sp`, a sign's name for its id, else the id itself.
pub fn sign_name(id: &str) -> String {
    if id == crate::generated::firmament::SERPENT.id {
        return crate::generated::firmament::SERPENT.name.to_owned();
    }
    crate::generated::firmament::SIGNS
        .iter()
        .find(|s| s.id == id)
        .map_or_else(|| id.to_owned(), |s| s.name.to_owned())
}

/// One star of the generated sky (firmamentTree.js's `FirmNode`, the planner's fields).
#[derive(Debug, Clone, Copy)]
pub struct Node {
    pub key: &'static str,
    pub kind: &'static str,
    pub ring: &'static str,
    pub sector: &'static str,
    pub cluster: Option<&'static str>,
    pub name: &'static str,
    pub stats: &'static [(&'static str, f64)],
    pub text: Option<&'static str>,
    pub x: f64,
    pub y: f64,
}

/// A generated table's row numbers by key, built once: the planner looks stars up millions of times.
fn rows_by_key(keys: impl Iterator<Item = &'static str>) -> HashMap<&'static str, usize> {
    keys.enumerate().map(|(row, key)| (key, row)).collect()
}

pub fn node(key: &str) -> Option<Node> {
    static ROWS: OnceLock<HashMap<&'static str, usize>> = OnceLock::new();
    let rows = ROWS.get_or_init(|| rows_by_key(node_keys()));
    let (_, n) = &FIRM_NODES[*rows.get(key)?];
    Some(Node {
        key: n.key,
        kind: n.kind,
        ring: n.ring,
        sector: n.sector,
        cluster: n.cluster,
        name: n.name,
        stats: n.stats,
        text: n.text,
        x: n.x,
        y: n.y,
    })
}

pub fn adj(key: &str) -> &'static [&'static str] {
    static ROWS: OnceLock<HashMap<&'static str, usize>> = OnceLock::new();
    let rows = ROWS.get_or_init(|| rows_by_key(FIRM_ADJ.iter().map(|(k, _)| *k)));
    rows.get(key).map_or(&[], |row| FIRM_ADJ[*row].1)
}

/// Every star's key, in the Map's insertion order (`[...FIRM_NODES.keys()]`).
pub fn node_keys() -> impl Iterator<Item = &'static str> {
    FIRM_NODES.iter().map(|(k, _)| *k)
}

/// `smallStats`: a small star's or road's stats as the game folds them (attribute/skill points become a share, Health
/// and Spell Points a percent of the maximum, Armor Rating a blow taken).
pub fn small_stats(stats: &[(&str, f64)]) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = Vec::new();
    let put = |out: &mut Vec<(String, f64)>, k: &str, v: f64| {
        if let Some(slot) = out.iter_mut().find(|(key, _)| key == k) {
            slot.1 += v;
        } else {
            out.push((k.to_owned(), v));
        }
    };
    for &(k, v) in stats {
        if in_attrs(k) {
            put(&mut out, &format!("pct.{k}"), v);
        } else if let Some(rest) = k.strip_prefix(SKILL_PREFIX) {
            put(&mut out, &format!("skillPct.{rest}"), v);
        } else if k == "hp" {
            put(&mut out, "hpPct", math_round(v / 2.0).max(1.0));
        } else if k == "mp" {
            put(&mut out, "mpPct", math_round(v / 2.0).max(1.0));
        } else if k == "armor" {
            put(&mut out, "blowTaken", -v);
        } else {
            put(&mut out, k, v);
        }
    }
    out
}

/// A tree (`{ start, keys }`), as the planner builds it. `start` is nullable, as the JS type is: a tree with no sign
/// allotted is the law's `EMPTY_TREE` (`start: null, keys: []`), which `treeFault` judges WHOLE.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tree {
    pub start: Option<String>,
    pub keys: Vec<String>,
}

impl Tree {
    /// `EMPTY_TREE`: no sign chosen.
    pub fn empty() -> Tree {
        Tree::default()
    }

    /// The typed tree a raw `{ start, keys }` record holds. `start` is kept only when it is a string (a JS tree has no
    /// sign otherwise); `keys` is empty when the record's is not a list, as `treeParts`' own reads leave it.
    pub fn from_value(v: &Value) -> Tree {
        Tree {
            start: v.get("start").as_str().map(str::to_owned),
            keys: v
                .get("keys")
                .items()
                .iter()
                .map(Value::to_js_string)
                .collect(),
        }
    }
}

/// A channel total's sum and the prices paid on it: the pair `tree_parts` returns.
pub type Parts = (Vec<(String, f64)>, Vec<(String, f64)>);

/// `treeParts`: the sums over the start and the stars allocated, the gains and the prices apart.
pub fn tree_parts(tree: &Tree) -> Parts {
    let mut gains: Vec<(String, f64)> = Vec::new();
    let mut prices: Vec<(String, f64)> = Vec::new();
    let Some(start) = &tree.start else {
        return (gains, prices);
    };
    let add = |v: &mut Vec<(String, f64)>, k: &str, x: f64| {
        if let Some(slot) = v.iter_mut().find(|(key, _)| key == k) {
            slot.1 += x;
        } else {
            v.push((k.to_owned(), x));
        }
    };
    let mut keys = vec![start.clone()];
    keys.extend(tree.keys.iter().cloned());
    for k in keys {
        let Some(n) = node(&k) else { continue };
        for &(s, v) in n.stats {
            if is_price(s, v) {
                add(&mut prices, s, v);
            } else {
                add(&mut gains, s, v);
            }
        }
    }
    (gains, prices)
}

/// A capped channel total and the price paid on it (treeStats' `[PRICES]`).
#[derive(Debug, Clone, PartialEq)]
pub struct Totals {
    /// The channels, in the JS object's key order (gains first seen, then the prices' own new keys).
    pub entries: Vec<(String, f64)>,
    pub prices: Vec<(String, f64)>,
}

impl Totals {
    pub fn get(&self, key: &str) -> Option<f64> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
    }
    pub fn price(&self, key: &str) -> f64 {
        self.prices
            .iter()
            .find(|(k, _)| k == key)
            .map_or(0.0, |(_, v)| *v)
    }
}

/// `statsFromParts` / `treeStats`: each channel's gains capped to its min..max, then its price paid under the same
/// cap. `paid[k] = v - g` rides beside the stats. A key no channel is drops.
pub fn stats_from_parts(gains: &[(String, f64)], prices: &[(String, f64)]) -> Totals {
    let mut out: Vec<(String, f64)> = Vec::new();
    let mut paid: Vec<(String, f64)> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (k, _) in gains.iter().chain(prices.iter()) {
        if !seen.contains(&k.as_str()) {
            seen.push(k);
        }
    }
    for k in seen {
        let Some(def) = stat_def(k) else { continue };
        let gain_raw = gains
            .iter()
            .find(|(key, _)| key == k)
            .map_or(0.0, |(_, v)| *v);
        let price = prices
            .iter()
            .find(|(key, _)| key == k)
            .map_or(0.0, |(_, v)| *v);
        let g = gain_raw.max(def.min).min(def.max);
        let v = (g + price).max(def.min).min(def.max);
        if v != 0.0 {
            out.push((k.to_owned(), v));
        }
        if price != 0.0 && v - g != 0.0 {
            paid.push((k.to_owned(), v - g));
        }
    }
    Totals {
        entries: out,
        prices: paid,
    }
}

/// `treeStats(tree)`.
pub fn tree_stats(tree: &Tree) -> Totals {
    let (gains, prices) = tree_parts(tree);
    stats_from_parts(&gains, &prices)
}

/// `effectiveValue`: a key star's flat points and a small star's percent fold into ONE channel, capped together.
pub fn effective_value(totals: &Totals, key: &str) -> f64 {
    let t = |k: &str| totals.get(k).unwrap_or(0.0);
    if in_attrs(key) {
        let flat = t(key);
        let pct = t(&format!("pct.{key}"));
        // mutation: equivalent - every `pct.*` total the sky makes is a whole number with |pct| <= 20 (the generator
        // asserts both), so `(100 * pct) / 100` is exactly `pct` and 101/100 would print `pct + 1` only where the
        // clamp does not hide it. The probes at -90 flat + 99 and 99.5 percent pin the JS result; a 101 mutant differs
        // only on a hand-made percent of 99.5, which is outside the plan boundary and is covered by the vector anyway.
        return 0.0f64.max(15.0f64.min(flat + (100.0 * pct / 100.0).floor()));
    }
    if let Some(name) = key.strip_prefix(SKILL_PREFIX) {
        let flat = t(key);
        let pct = t(&format!("skillPct.{name}"));
        // mutation: equivalent - same proof as the attribute arm: every `skillPct.*` total is a whole number <= 20.
        return 0.0f64.max(15.0f64.min(flat + (200.0 * pct / 100.0).floor()));
    }
    t(key)
}

/// `blowPct`: the percent the sky adds to one weapon blow, the group's gains capped then its prices paid.
pub fn blow_pct(
    c: &Totals,
    skill: Option<&str>,
    group: Option<&str>,
    unaware: bool,
    wounded: bool,
) -> f64 {
    let mut chans: Vec<&str> = vec!["weaponDmg"];
    if let Some(s) = skill {
        if s != "Archery" {
            chans.push("meleeDmg");
        }
    }
    let fam = skill.and_then(family_of_skill);
    if let Some(f) = fam {
        chans.push(f);
    }
    let g = group.and_then(group_key);
    if let Some(g) = g {
        chans.push(g);
    }
    let mut gain = 0.0;
    let mut price = 0.0;
    for k in chans {
        gain += c.get(k).unwrap_or(0.0) - c.price(k);
        price += c.price(k);
    }
    let mut pct = BLOW_FLOOR.max(BLOW_CAP.min(gain) + price);
    if unaware {
        pct += c.get("unawareDmg").unwrap_or(0.0);
    }
    if wounded {
        pct += c.get("rageDmg").unwrap_or(0.0);
    }
    BLOW_TOTAL_CAP.min(pct)
}

fn family_of_skill(skill: &str) -> Option<&'static str> {
    match skill {
        "ShortBlade" => Some("shortDmg"),
        "LongBlade" => Some("longDmg"),
        "Axe" => Some("axeDmg"),
        "BluntWeapon" => Some("bluntDmg"),
        "Archery" => Some("bowDmg"),
        "HandToHand" => Some("fistDmg"),
        _ => None,
    }
}

fn group_key(group: &str) -> Option<&'static str> {
    match group {
        "undead" => Some("undeadDmg"),
        "daedra" => Some("daedraDmg"),
        "animal" => Some("beastDmg"),
        _ => None,
    }
}

/// `castCostPct`: the percent the sky takes off one spell's price; a school's own channel counts only where one
/// school names it all.
pub fn cast_cost_pct(c: &Totals, schools: &[&str]) -> f64 {
    let mut chans: Vec<String> = vec!["castCost".to_owned()];
    let set: BTreeSet<&str> = schools.iter().copied().collect();
    if set.len() == 1 {
        chans.push(format!("castCost.{}", set.iter().next().unwrap()));
    }
    let mut gain = 0.0;
    let mut price = 0.0;
    for k in &chans {
        // mutation: equivalent - the generator asserts no authored star prices a `castCost` channel (a negative
        // castCost value), so on every reachable tree `pricesOf(c)` is empty for these channels, `price` is 0, and
        // `gain - price` equals `gain + price`. The 160 castCost tree vectors pin the real answer.
        gain += c.get(k).unwrap_or(0.0) - c.price(k); // mutation: equivalent - `price` is 0 on every reachable tree, so `-` and `+` agree here too.
        price += c.price(k);
    }
    CAST_COST_CAP.min(gain) + price // mutation: equivalent - `price` is 0 on every reachable tree (see above), so `+` and `-` agree.
}

/// The attribute totals the tree adds, as `applyFirmament` reads them (`effectiveValue` of each attribute).
pub fn attribute_values(totals: &Totals) -> Vec<(&'static str, f64)> {
    ATTRS
        .iter()
        .map(|a| (*a, effective_value(totals, a)))
        .collect()
}

/// The skill names the totals mention (`skill.X` or `skillPct.X`), in the order the totals' keys first name them.
pub fn skill_names(totals: &Totals) -> Vec<String> {
    let mut out = Vec::new();
    for (k, _) in &totals.entries {
        let name = if let Some(n) = k.strip_prefix(SKILL_PREFIX) {
            n
        } else if let Some(n) = k.strip_prefix("skillPct.") {
            n
        } else {
            continue;
        };
        if !out.iter().any(|x| x == name) {
            out.push(name.to_owned());
        }
    }
    out
}

/// A `Totals` from a JS object of numbers (a plan's serialized totals). Non-numeric entries are ignored.
pub fn totals_from_value(v: &Value) -> Totals {
    let entries = v
        .entries()
        .iter()
        .map(|(k, x)| (k.clone(), x.to_number()))
        .collect();
    Totals {
        entries,
        prices: Vec::new(),
    }
}

/// A channel's raw value (`totals[key] ?? 0`).
pub fn channel(totals: &Value, key: &str) -> f64 {
    match totals.get(key) {
        Num(n) => *n,
        _ => 0.0,
    }
}

// ─── THE PURSES (firmamentLaw.js:36-57) ─────────────────────────────

pub const STARS_PER_RENOWN: f64 = 2.0;
pub const FIRM_RENOWN_MAX: f64 = 50.0;
pub const CRAFT_RANKS_PER_POINT: f64 = 8.0;
pub const CRAFT_RANK_MAX: f64 = 100.0;
pub const REFUND_FREE_BELOW_RENOWN: f64 = 10.0;
pub const REFUND_SILVER_PER_STAR: f64 = 10.0;
pub const FIRM_RESPEC_GOLD: f64 = 10_000.0;

/// `clampInt`: `Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)))`. A NaN input is 0 (`Math.trunc(0)`); no zero
/// arm is needed, `Math.trunc(±0)` is ±0 and the clamp's own floor lifts it.
fn clamp_int(v: f64, lo: f64, hi: f64) -> f64 {
    let n = if v.is_nan() { 0.0 } else { v };
    lo.max(hi.min(n.trunc()))
}

/// `starsFor`: the Stars a Renown level gives, 0 at Renown 1 and 98 at 50.
pub fn stars_for(renown: f64) -> f64 {
    STARS_PER_RENOWN * (clamp_int(renown, 1.0, FIRM_RENOWN_MAX) - 1.0)
}

/// `craftPointsFor`: one Craft point for every eight ranks over the ten tracks, each rank clamped to 0..=100.
pub fn craft_points_for(ranks: impl IntoIterator<Item = f64>) -> f64 {
    let mut sum = 0.0;
    for r in ranks {
        sum += clamp_int(r, 0.0, CRAFT_RANK_MAX);
    }
    (sum / CRAFT_RANKS_PER_POINT).floor()
}

/// `refundSilver`: what taking `removed` stars back costs at `renown`, in silver; free below Renown 10.
pub fn refund_silver(removed: f64, renown: f64) -> f64 {
    // The clamp's floor cannot change the answer: it only moves a Renown at or below 2, all far under the free threshold.
    if clamp_int(renown, 1.0, FIRM_RENOWN_MAX) < REFUND_FREE_BELOW_RENOWN {
        // mutation: equivalent - the floor (1 or 2) only ever lifts a Renown that is already below 10, so both arms return 0; the paid arm reads 10 or more.
        0.0
    } else {
        // `removed | 0` is ToInt32; a NaN or an infinity there is 0.
        let n = crate::round::to_int32(removed).max(0) as f64;
        (n * REFUND_SILVER_PER_STAR).max(0.0)
    }
}

// ─── AN ALLOCATION (firmamentLaw.js:340-471) ────────────────────────

/// `cleanKeys`: the keys a table holds, no start, no repeat, sorted; a key no table holds is dropped (its refund).
pub fn clean_keys(keys: &[String]) -> Vec<String> {
    let mut out: BTreeSet<&str> = BTreeSet::new();
    for k in keys {
        if node(k).is_some() && !is_start(k) {
            out.insert(k);
        }
    }
    out.into_iter().map(str::to_owned).collect()
}

/// `firmCostOf`: a star's cost by purse ring, `(combat, life)`. A start is free.
pub fn firm_cost_of(keys: &[String]) -> (f64, f64) {
    let mut combat = 0.0;
    let mut life = 0.0;
    for k in keys {
        let Some(n) = node(k) else { continue };
        if n.kind == "start" {
            continue;
        }
        if n.ring == "life" {
            life += 1.0;
        } else {
            combat += 1.0;
        }
    }
    (combat, life)
}

/// `fits`: the combat stars within the Stars, all of them within both purses together.
pub fn fits(keys: &[String], stars: f64, craft: f64) -> bool {
    let (combat, life) = firm_cost_of(keys);
    combat <= stars && combat + life <= stars + craft
}

/// `pointsLeft`: what is left in each purse, the Craft purse spent on the life ring first.
pub fn points_left(keys: &[String], stars: f64, craft: f64) -> (f64, f64) {
    let (combat, life) = firm_cost_of(keys);
    let craft_used = craft.min(life);
    (stars - combat - (life - craft_used), craft - craft_used)
}

/// `passable`: a star a path may walk THROUGH (any but another sign's start, and never a keystone).
fn passable(key: &str, start: &str) -> bool {
    node(key).is_some_and(|n| n.kind != "keystone" && (n.kind != "start" || key == start))
}

/// `reachFrom`: the stars of `set` reachable from `start` through `set` alone, the start excluded.
pub fn reach_from(start: &str, set: &BTreeSet<&str>) -> BTreeSet<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    seen.insert(start.to_owned());
    let mut queue: Vec<String> = vec![start.to_owned()];
    while let Some(k) = queue.pop() {
        if k != start && !passable(&k, start) {
            continue;
        }
        for nb in adj(&k) {
            if set.contains(nb) && !seen.contains(*nb) {
                seen.insert((*nb).to_owned());
                queue.push((*nb).to_owned());
            }
        }
    }
    seen.remove(start);
    seen
}

/// Why an allocation is not whole (`treeFault`), or `None` when it is. The four reasons keep the JS words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeFault {
    /// 'firm-key': the keys are not a list, or one is not a star the sky has (or is a start, or repeats).
    Key,
    /// 'firm-start': no start chosen, or the sign chosen is not one the sky has.
    Start,
    /// 'firm-path': a star not joined to the start through the stars allocated.
    Path,
    /// 'firm-points': more than the purses hold.
    Points,
}

impl TreeFault {
    /// The JS word (`'firm-start'`, ...).
    pub fn word(self) -> &'static str {
        match self {
            TreeFault::Key => "firm-key",
            TreeFault::Start => "firm-start",
            TreeFault::Path => "firm-path",
            TreeFault::Points => "firm-points",
        }
    }
}

/// `treeFault(tree, stars, craft)`. A tree whose keys are not a list at all reads as `Key`; the typed `Tree` always
/// carries a list, so callers that hold a raw record use [`tree_fault_value`].
pub fn tree_fault(tree: &Tree, stars: f64, craft: f64) -> Option<TreeFault> {
    let Some(start) = &tree.start else {
        return if tree.keys.is_empty() {
            None
        } else {
            Some(TreeFault::Start)
        };
    };
    if !is_start(start) {
        return Some(TreeFault::Start);
    }
    let clean = clean_keys(&tree.keys);
    if clean.len() != tree.keys.len() {
        return Some(TreeFault::Key);
    }
    let set: BTreeSet<&str> = clean.iter().map(String::as_str).collect();
    if reach_from(start, &set).len() != set.len() {
        return Some(TreeFault::Path);
    }
    if !fits(&clean, stars, craft) {
        return Some(TreeFault::Points);
    }
    None
}

/// `treeFault` over a raw `{ start, keys }` record, for the two arms the typed [`Tree`] cannot hold: `keys` that is
/// not an array (`Key`), and a start that is not a string at all (`Start`). Any other start reads as its string form,
/// as the JS `START_KEYS.includes` coerces nothing: a non-string start is not a start there either.
pub fn tree_fault_value(tree: &Value, stars: f64, craft: f64) -> Option<TreeFault> {
    let keys = tree.get("keys");
    if !matches!(keys, Value::Arr(_)) {
        return Some(TreeFault::Key);
    }
    let start = tree.get("start");
    if start.is_nullish() {
        return if keys.items().is_empty() {
            None
        } else {
            Some(TreeFault::Start)
        };
    }
    let Some(start) = start.as_str() else {
        return Some(TreeFault::Start);
    };
    tree_fault(
        &Tree {
            start: Some(start.to_owned()),
            keys: keys
                .items()
                .iter()
                .map(Value::to_js_string)
                .collect::<Vec<_>>(),
        },
        stars,
        craft,
    )
}

/// `refundTakes`: the stars a refund of `key` takes with it - `key` and every star that only reached the start
/// through it, sorted; empty when the tree does not hold `key`.
pub fn refund_takes(tree: &Tree, key: &str) -> Vec<String> {
    let Some(start) = &tree.start else {
        return vec![];
    };
    if !tree.keys.iter().any(|k| k == key) {
        return vec![];
    }
    let rest: BTreeSet<&str> = tree
        .keys
        .iter()
        .filter(|k| k.as_str() != key)
        .map(String::as_str)
        .collect();
    let kept = reach_from(start, &rest);
    let mut out: Vec<String> = vec![key.to_owned()];
    out.extend(
        tree.keys
            .iter()
            .filter(|k| k.as_str() != key && !kept.contains(k.as_str()))
            .cloned(),
    );
    out.sort();
    out
}

/// `pathTo`: the shortest way from what is allocated to `target`, nearest first, ending with the target; `[]` when it
/// is allocated already or no way is open. Breadth-first, every star one step. The queue's order is the JS `Set`'s
/// insertion order (the sign, then the keys as given) and each star's neighbours in the generated order, so the parent
/// a star is first found from - and therefore the path returned - is the JS's own.
pub fn path_to(tree: &Tree, target: &str) -> Vec<String> {
    let Some(start) = &tree.start else {
        return vec![];
    };
    if node(target).is_none() || is_start(target) {
        // mutation: equivalent - a fast path only: the BFS never enqueues a start (its neighbour test skips one) and never discovers an unknown key, so both arms below answer `[]` anyway.
        return vec![];
    }
    let mut have: Vec<&str> = vec![start];
    for k in &tree.keys {
        if !have.contains(&k.as_str()) {
            have.push(k);
        }
    }
    if have.contains(&target) {
        return vec![];
    }
    let mut from: Vec<(&str, Option<&str>)> = Vec::new();
    let mut queue: Vec<&str> = Vec::new();
    for &k in &have {
        if passable(k, start) {
            from.push((k, None));
            queue.push(k);
        }
    }
    let mut i = 0;
    while i < queue.len() {
        // mutation: equivalent - the walk returns the moment it discovers the target, and every non-start star is reachable from every start (the generator asserts all 512), so the queue never runs dry and the loop exits only by returning.
        let k = queue[i];
        i += 1;
        for nb in adj(k) {
            if from.iter().any(|(x, _)| *x == *nb) || is_start(nb) {
                continue;
            }
            from.push((nb, Some(k)));
            if *nb == target {
                let mut path: Vec<String> = Vec::new();
                let mut at: Option<&str> = Some(nb);
                while let Some(key) = at {
                    if have.contains(&key) {
                        break;
                    }
                    path.push(key.to_owned());
                    at = from.iter().find(|(x, _)| *x == key).and_then(|(_, p)| *p);
                }
                path.reverse();
                return path;
            }
            if passable(nb, start) {
                queue.push(nb);
            }
        }
    }
    vec![]
}

/// `allocatable`: whether `key` may be allocated next, joined to the allocation by one line.
pub fn allocatable(tree: &Tree, key: &str) -> bool {
    path_to(tree, key).len() == 1
}

/// `treeDiff`: the keys `next` adds to `prev` and the keys it takes away, both sorted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub start_changed: bool,
}

pub fn tree_diff(prev: &Tree, next: &Tree) -> TreeDiff {
    let p: BTreeSet<&str> = prev.keys.iter().map(String::as_str).collect();
    let n: BTreeSet<&str> = next.keys.iter().map(String::as_str).collect();
    let start_changed = prev.start != next.start;
    TreeDiff {
        added: n
            .iter()
            .filter(|k| start_changed || !p.contains(*k))
            .map(|k| (*k).to_owned())
            .collect(),
        removed: p
            .iter()
            .filter(|k| start_changed || !n.contains(*k))
            .map(|k| (*k).to_owned())
            .collect(),
        start_changed,
    }
}

/// `totals`: every channel's raw sum over the start and the stars allocated (uncapped).
pub fn totals(tree: &Tree) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = Vec::new();
    let Some(start) = &tree.start else {
        return out;
    };
    for k in std::iter::once(start.clone()).chain(tree.keys.iter().cloned()) {
        let Some(n) = node(&k) else { continue };
        for &(s, v) in n.stats {
            if let Some(slot) = out.iter_mut().find(|(key, _)| key == s) {
                slot.1 += v;
            } else {
                out.push((s.to_owned(), v));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Local invariant: the indexed lookups answer as a first-match scan of the generated tables does.
    #[test]
    fn indexed_star_lookups_agree_with_a_scan() {
        let keys = FIRM_NODES
            .iter()
            .map(|(k, _)| *k)
            .chain(FIRM_ADJ.iter().map(|(k, _)| *k))
            .chain(["", "no.such.star"]);
        for key in keys {
            let row = FIRM_NODES.iter().find(|(k, _)| *k == key);
            assert_eq!(
                node(key).map(|n| (n.key, n.name, n.stats, n.x, n.y)),
                row.map(|(_, n)| (n.key, n.name, n.stats, n.x, n.y)),
                "{key}"
            );
            let near = FIRM_ADJ.iter().find(|(k, _)| *k == key);
            assert_eq!(adj(key), near.map_or(&[][..], |(_, v)| *v), "{key}");
        }
    }
}
