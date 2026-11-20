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
use std::collections::BTreeSet;

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

pub fn node(key: &str) -> Option<Node> {
    FIRM_NODES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, n)| Node {
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
    FIRM_ADJ
        .iter()
        .find(|(k, _)| *k == key)
        .map_or(&[], |(_, v)| *v)
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

/// A tree (`{ start, keys }`), as the planner builds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub start: String,
    pub keys: Vec<String>,
}

/// A channel total's sum and the prices paid on it: the pair `tree_parts` returns.
pub type Parts = (Vec<(String, f64)>, Vec<(String, f64)>);

/// `treeParts`: the sums over the start and the stars allocated, the gains and the prices apart.
pub fn tree_parts(tree: &Tree) -> Parts {
    let mut gains: Vec<(String, f64)> = Vec::new();
    let mut prices: Vec<(String, f64)> = Vec::new();
    let add = |v: &mut Vec<(String, f64)>, k: &str, x: f64| {
        if let Some(slot) = v.iter_mut().find(|(key, _)| key == k) {
            slot.1 += x;
        } else {
            v.push((k.to_owned(), x));
        }
    };
    let mut keys = vec![tree.start.clone()];
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
        gain += c.get(k).unwrap_or(0.0) - c.price(k);
        price += c.price(k);
    }
    // mutation: equivalent - `price` is 0 on every reachable tree (see above), so `+` and `-` agree.
    CAST_COST_CAP.min(gain) + price
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
