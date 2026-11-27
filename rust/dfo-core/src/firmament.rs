//! The Firmament tree planner (`src/firmament.js`): the build presets, the channel score, the greedy 98-star walk and
//! the summary rows.
//!
//! The JS keeps a module-level `PLAN_CACHE` keyed by build id and purse; a plan costs about 0.1 s and the planners ask
//! for the same few again and again, so [`plan_build`] memoises too, keyed on the whole of its arguments.
//!
//! Sort notes: `tree.keys.sort()` and `chosen.slice().sort()` are JS default sorts over star keys, whose alphabet is
//! ASCII (`mg.c1.3`), so Rust's byte order equals JS's UTF-16 order. `planSummary` ends with
//! `abs(b.value) - abs(a.value) || a.key.localeCompare(b.key)`; every key it sorts is one of the generated channel
//! names (ASCII letters, dots, digits), and the generator checks `localeCompare` agrees with byte order over exactly
//! that set, so a byte comparison is the same order. A NaN subtraction is JS's "equal", so it falls to the key.

use crate::firmament_law::{
    self as law, blow_pct, cast_cost_pct, effective_value, is_start, node, node_keys, sign_name,
    stat_def, stat_words, stats_from_parts, Totals, ATTRS, FIRMAMENT_STARS, SKILL_PREFIX,
};
use crate::generated::firmament::BUILDS;
use crate::theory::obj;
use crate::value::{
    parse, write,
    Value::{self, Arr, Null, Num, Obj, Str, Undefined},
};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

const TOL: f64 = 1e-9;
// mutation: equivalent - the planner's gains are channel shares of the form k/def.max * weight with denormals no smaller
// than 0.15/75 and differences of two such sums; no reachable pair differs by less than 1e-9, so 1e-9 vs 1e-8 never
// changes a comparison. The plan vectors compare the whole plan at 528 purses, which would show a changed pick.

const DAMAGE_CHANNELS: [&str; 13] = [
    "weaponDmg",
    "meleeDmg",
    "shortDmg",
    "longDmg",
    "axeDmg",
    "bluntDmg",
    "bowDmg",
    "fistDmg",
    "beastDmg",
    "undeadDmg",
    "daedraDmg",
    "unawareDmg",
    "rageDmg",
];
const WEAPON_SKILLS: [&str; 7] = [
    "ShortBlade",
    "LongBlade",
    "Axe",
    "BluntWeapon",
    "HandToHand",
    "Archery",
    "Backstabbing",
];

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

pub fn builds() -> &'static [Value] {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE
        .get_or_init(|| parse(BUILDS).expect("generated firmament builds"))
        .items()
}

/// `buildById`: the preset whose id matches `String(id).toLowerCase()`, or null.
pub fn build_by_id(id: &Value) -> Option<&'static Value> {
    let key = id.to_js_string().to_lowercase();
    builds()
        .iter()
        .find(|b| b.get("id").as_str().is_some_and(|x| x == key))
}

pub fn build_ids() -> Vec<Value> {
    builds().iter().map(|b| b.get("id").clone()).collect()
}

fn family_channel(skill: &str) -> Option<&'static str> {
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

/// `channelScore`: a channel's contribution to a build's score, its share of the live cap.
fn channel_score(totals: &Totals, key: &str, invert: bool, weight: f64) -> f64 {
    let Some(def) = stat_def(key) else {
        // mutation: equivalent - every key a build channel holds is a generated statDef row (the generator writes one
        // per channel), and `spec.key.starts_with("pct.")`/`"skillPct."` channels are skipped before this call, so a
        // miss here never reaches a score.
        return 0.0;
    };
    let value = if law::in_attrs(key) || key.starts_with(SKILL_PREFIX) {
        effective_value(totals, key)
    } else {
        totals.get(key).unwrap_or(0.0)
    };
    if invert {
        return (0.0f64.max(-value) / 1.0f64.max(def.min.abs())) * weight;
    }
    (0.0f64.max(def.max.min(value)) / def.max) * weight
}

/// `scoreTree`.
fn score_tree(totals: &Totals, build: &Value) -> f64 {
    let mut score = 0.0;
    if let Some(skill) = build.get("skill").as_str() {
        score += 30.0f64
            .min(blow_pct(totals, Some(skill), None, false, false))
            .max(0.0)
            / 30.0;
    }
    if let Some(school) = build.get("school").as_str() {
        score += 25.0f64.min(cast_cost_pct(totals, &[school])).max(0.0) / 25.0 * 0.7;
    }
    for spec in build.get("channels").items() {
        let key = spec.get("key").to_js_string();
        if key.starts_with("pct.") || key.starts_with("skillPct.") {
            continue;
        }
        score += channel_score(
            totals,
            &key,
            spec.get("invert").truthy(),
            spec.get("weight").to_number(),
        );
    }
    score
}

/// `combatKeys`: the combat-ring stars except the start, in the Map's insertion order.
fn combat_keys(start: &str) -> Vec<&'static str> {
    node_keys()
        .filter(|k| *k != start && node(k).is_some_and(|n| n.ring == "combat"))
        .collect()
}

struct Paths {
    have: Vec<String>,
    /// Every reachable star and the star it is reached from.
    from: HashMap<String, Option<String>>,
}

/// `pathsFrom`: one breadth-first walk from the allocated stars to every reachable star. A keystone may be reached but
/// not walked through; another sign's start is closed.
fn paths_from(tree: &Tree) -> Paths {
    let mut have: Vec<String> = tree.start.iter().cloned().collect();
    for k in &tree.keys {
        if !have.contains(k) {
            have.push(k.clone());
        }
    }
    let mut from: HashMap<String, Option<String>> = HashMap::new();
    let mut queue: Vec<String> = Vec::new();
    for key in &have {
        let Some(n) = node(key) else { continue };
        // mutation: equivalent - `tree.keys` never holds a start (cleanKeys/planBuild drop one), so every key here is
        // either the tree's own start or a non-start star: `n.kind == "start"` implies `key == tree.start`, and the
        // `&&` arm then never fires. The `||` guard alone decides, which is what the port does.
        if n.kind == "keystone"
            || (n.kind == "start" && Some(key.as_str()) != tree.start.as_deref())
        {
            continue;
        }
        from.insert(key.clone(), None);
        queue.push(key.clone());
    }
    let mut i = 0;
    while i < queue.len() {
        let key = queue[i].clone();
        i += 1;
        for next in law::adj(&key) {
            if from.contains_key(*next) || is_start(next) {
                continue;
            }
            from.insert((*next).to_owned(), Some(key.clone()));
            if node(next).is_some_and(|n| n.kind != "keystone") {
                queue.push((*next).to_owned());
            }
        }
    }
    Paths { have, from }
}

/// `pathFor`: the stars from the allocation out to `target`, nearest last; empty when it is allocated or out of reach.
fn path_for(paths: &Paths, target: &str) -> Vec<String> {
    if paths.have.iter().any(|k| k == target) {
        return vec![];
    }
    if !paths.from.contains_key(target) {
        return vec![];
    }
    let mut out = Vec::new();
    let mut at = Some(target.to_owned());
    while let Some(key) = at {
        if paths.have.iter().any(|k| k == &key) {
            break;
        }
        out.push(key.clone());
        at = paths.from.get(&key).cloned().flatten();
    }
    out.reverse();
    out
}

/// `addParts`: sum a node's stats into the gains/prices pair the way `treeStats` reads them.
fn add_parts(gains: &mut Vec<(String, f64)>, prices: &mut Vec<(String, f64)>, key: &str) {
    let Some(n) = node(key) else { return };
    for &(s, v) in n.stats {
        // A star's stat lands in the pair its sign names (a `*Taken` positive, or a negative of any other channel).
        let to: &mut Vec<(String, f64)> = if law::is_price(s, v) { prices } else { gains };
        let at = to.iter().position(|(k, _)| k == s);
        if let Some(i) = at {
            to[i].1 += v;
        } else {
            to.push((s.to_owned(), v));
        }
    }
}

/// `sortTree`: the keys in JS default (byte) order.
fn sort_tree(tree: &mut Tree) {
    tree.keys.sort();
}

/// `offStat`: a damage channel or weapon-skill line this build does not use. Public for the vectors.
pub fn off_stat(build: &Value, key: &str) -> bool {
    let kind = build.get("kind").as_str().unwrap_or("");
    if kind == "spell" || kind == "tank" {
        if DAMAGE_CHANNELS.contains(&key) {
            return true;
        }
        if let Some(rest) = key.strip_prefix("skill.") {
            if WEAPON_SKILLS.contains(&rest) {
                return true;
            }
        }
        if let Some(rest) = key.strip_prefix("skillPct.") {
            if WEAPON_SKILLS.contains(&rest) {
                return true;
            }
        }
        return false;
    }
    let skill = build.get("skill").as_str().unwrap_or("");
    let mut allowed: Vec<String> = vec!["weaponDmg".to_owned()];
    if let Some(fam) = family_channel(skill) {
        allowed.push(fam.to_owned());
    }
    allowed.push(format!("skill.{skill}"));
    allowed.push(format!("skillPct.{skill}"));
    allowed.push("skill.CriticalStrike".to_owned());
    allowed.push("skillPct.CriticalStrike".to_owned());
    if skill != "Archery" {
        allowed.push("meleeDmg".to_owned());
    }
    if DAMAGE_CHANNELS.contains(&key) && !allowed.iter().any(|a| a == key) {
        return true;
    }
    if key.starts_with("skill.") && !allowed.iter().any(|a| a == key) {
        return true;
    }
    if key.starts_with("skillPct.") && !allowed.iter().any(|a| a == key) {
        // mutation: not proven - needs a plan whose walk meets a small star carrying a positive `skillPct.<other
        // skill>` that is not a connector; the current grid does not tell this guard from its flipped comparison.
        return true;
    }
    false
}

/// `nodeHasOff`: the star carries a positive stat this build does not use. A small star or road may be a connector.
pub fn node_has_off(key: &str, build: &Value, connector: bool) -> bool {
    let Some(n) = node(key) else { return false };
    let off = n.stats.iter().any(|&(k, v)| v > 0.0 && off_stat(build, k));
    // mutation: equivalent - no authored star carries a stat of exactly 0 (`smallStats` lifts hp/mp to at least
    // +1%), so `> 0` and `>= 0` select the same stats; the `nodehasoff` family covers every star against three builds.
    off && !(connector && (n.kind == "small" || n.kind == "road"))
}

/// `sectorAllows`: the build's sector list, or every sector when it names none.
fn sector_allows(key: &str, build: &Value) -> bool {
    let sectors = build.get("sectors").items();
    if sectors.is_empty() {
        return true;
    }
    let Some(n) = node(key) else { return false };
    sectors.iter().any(|x| x.is_str(n.sector))
}

struct Greedy {
    tree: Tree,
    totals: Totals,
    score: f64,
    stars: f64,
}

/// `greedy`: take the path with the best channel gain per star until the purse is spent.
fn greedy(start: &str, build: &Value, budget: f64) -> Greedy {
    let mut chosen: Vec<String> = Vec::new();
    let mut taken: Vec<String> = Vec::new();
    let candidates: Vec<&'static str> = combat_keys(start)
        .into_iter()
        .filter(|k| sector_allows(k, build) && !node_has_off(k, build, false))
        .collect();
    let mut tree = Tree {
        start: Some(start.to_owned()),
        keys: vec![],
    };
    let mut gains: Vec<(String, f64)> = Vec::new();
    let mut prices: Vec<(String, f64)> = Vec::new();
    add_parts(&mut gains, &mut prices, start);
    let totals = stats_from_parts(&gains, &prices);
    let mut score = score_tree(&totals, build);

    struct Best {
        path: Vec<String>,
        gain: f64,
        ratio: f64,
        score: f64,
        gains: Vec<(String, f64)>,
        prices: Vec<(String, f64)>,
    }

    while (chosen.len() as f64) < budget {
        // mutation: equivalent - every star costs one key, so `chosen.len()` reaches `budget` exactly; `<=` would only
        // add one more iteration, whose `path.len() > room` is always true at `room == 0` (a path is never empty here)
        // so the extra loop finds no candidate and breaks. The purse probes include 98 and 0.
        let room = (budget - chosen.len() as f64) as usize;
        let paths = paths_from(&tree);
        let mut best: Option<Best> = None;
        for key in &candidates {
            if taken.iter().any(|k| k == key) {
                continue;
            }
            let path = path_for(&paths, key);
            if path.is_empty()
                || path.len() > room
                || path.iter().any(|k| node_has_off(k, build, true))
            {
                continue;
            }
            let mut next_gains = gains.clone();
            let mut next_prices = prices.clone();
            for k in &path {
                add_parts(&mut next_gains, &mut next_prices, k);
            }
            let next_totals = stats_from_parts(&next_gains, &next_prices);
            let next_score = score_tree(&next_totals, build);
            let gain = next_score - score;
            // mutation: equivalent - `gain` is 0 or a sum of at least 0.15/75 (a channel weight over its cap); no
            // reachable gain lies in (0, 1e-9], so `< TOL` and `<= TOL` pick the same candidates. `gain > 0` is the
            // same set. The 528 plan vectors would show a different pick if any reachable gain fell in that band.
            if gain <= TOL {
                continue;
            }
            let ratio = gain / path.len() as f64;
            // mutation: equivalent - the gain and ratio comparisons only break ties between two candidates whose gains
            // are within 1e-9; the reachable gains are multiples of 0.15/75 = 0.002 and their sums, none within 1e-9 of
            // another, so `>`/`>=` and `<=`/`<` select the same path. The plan vectors would expose a changed pick.
            let take = match &best {
                None => true,
                Some(b) => {
                    ratio > b.ratio + TOL || ((ratio - b.ratio).abs() <= TOL && gain > b.gain)
                }
            };
            if take {
                best = Some(Best {
                    path,
                    gain,
                    ratio,
                    score: next_score,
                    gains: next_gains,
                    prices: next_prices,
                });
            }
        }
        let Some(best) = best else { break };
        for k in &best.path {
            chosen.push(k.clone());
            if !taken.contains(k) {
                taken.push(k.clone());
            }
        }
        tree = Tree {
            start: Some(start.to_owned()),
            keys: chosen.clone(),
        };
        sort_tree(&mut tree);
        score = best.score;
        gains = best.gains;
        prices = best.prices;
    }
    let stars = chosen.len() as f64;
    let mut keys = chosen;
    keys.sort();
    Greedy {
        tree: Tree {
            start: Some(start.to_owned()),
            keys,
        },
        totals: stats_from_parts(&gains, &prices),
        score,
        stars,
    }
}

/// A tree as the JS shapes it (`{ start, keys }`), and the law's typed form.
pub use crate::firmament_law::Tree;

/// Most plans the cache holds before a new one pushes another out: far above the eight presets, low enough that a
/// long-lived process walking every purse stays small.
const PLAN_CACHE_MAX: usize = 128;

type PlanCache = Mutex<HashMap<(String, String), Value>>;

/// The plan object a build's purse produces (`planBuild`), memoised for the process.
///
/// The key is the whole of both arguments in their bit-exact encoding, so two builds that share an id, or any option
/// added to `opts` later, never share a plan. A new input that does NOT arrive through the arguments must join the key.
pub fn plan_build(build: &Value, opts: &Value) -> Value {
    static CACHE: OnceLock<PlanCache> = OnceLock::new();
    cached_plan(CACHE.get_or_init(Default::default), build, opts)
}

fn cached_plan(cache: &PlanCache, build: &Value, opts: &Value) -> Value {
    let key = (write(build), write(opts));
    // The lock is never held while planning, and a map is valid after any panic, so poisoning is ignored.
    let lock = || cache.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(hit) = lock().get(&key) {
        return hit.clone();
    }
    let plan = compute_plan(build, opts);
    remember(&mut lock(), key, plan.clone());
    plan
}

/// Store a plan, dropping one other (whichever the map yields first) when a new key finds it full. A key another thread
/// stored meanwhile costs nobody their entry.
fn remember(map: &mut HashMap<(String, String), Value>, key: (String, String), plan: Value) {
    if map.len() >= PLAN_CACHE_MAX && !map.contains_key(&key) {
        if let Some(old) = map.keys().next().cloned() {
            map.remove(&old);
        }
    }
    map.insert(key, plan);
}

fn compute_plan(build: &Value, opts: &Value) -> Value {
    let stars = match opts.get("stars") {
        Undefined => Num(FIRMAMENT_STARS),
        v => v.clone(),
    };
    let n = stars.to_number();
    let or_zero = if n.is_nan() || n == 0.0 { 0.0 } else { n };
    let budget = 0.0f64.max(FIRMAMENT_STARS.min(or_zero.trunc()));
    let start = opts.get("start");
    let starts: Vec<String> = if start.truthy() {
        vec![start.to_js_string()]
    } else {
        law_start_keys()
            .into_iter()
            .filter(|k| sector_allows(k, build))
            .map(str::to_owned)
            .collect()
    };
    struct Best {
        plan: Greedy,
        same_sector: usize,
    }
    let mut best: Option<Best> = None;
    for st in &starts {
        if node(st).is_none() {
            continue;
        }
        let plan = greedy(st, build, budget);
        let sector = st.split('.').next().unwrap_or(st).to_owned();
        let same_sector = plan
            .tree
            .keys
            .iter()
            .filter(|k| node(k).is_some_and(|n| n.sector == sector))
            .count();
        let take = match &best {
            None => true,
            Some(b) => {
                // mutation: equivalent - the three arms compare a plan score (a sum of channel shares, all multiples of
                // 0.15/75 = 0.002) and a star count; no two starts' scores are within 1e-9 without being equal, so the
                // TOL boundary and `>`/`>=` never change the winner. `plan.score` equals `b.plan.score` only when the
                // greedy walk took the same stars; then the star count and the sector count decide, which they do.
                plan.score > b.plan.score + TOL
                    || ((plan.score - b.plan.score).abs() <= TOL && plan.stars < b.plan.stars)
                    || ((plan.score - b.plan.score).abs() <= TOL
                        && plan.stars == b.plan.stars
                        && same_sector > b.same_sector)
            }
        };
        if take {
            best = Some(Best { plan, same_sector });
        }
    }
    let start_key = best.as_ref().map_or_else(
        || law_start_keys()[0].to_owned(),
        |b| b.plan.tree.start.clone().unwrap_or_default(),
    );
    let start_name = sign_name(node(&start_key).map_or("sp", |n| n.sector));
    let mut out = obj([("build", build.clone())]);
    match best {
        Some(b) => {
            out.set("tree", tree_value(&b.plan.tree));
            out.set("totals", totals_value(&b.plan.totals));
            out.set("score", Num(b.plan.score));
            out.set("stars", Num(b.plan.stars));
            out.set("sameSector", Num(b.same_sector as f64));
            out.set("start", s(&start_key));
            out.set("startName", s(&start_name));
            out.set("starBudget", Num(budget));
            out.set("freeStars", Num(0.0f64.max(budget - b.plan.stars)));
        }
        None => {
            out.set(
                "tree",
                obj([("start", s(&start_key)), ("keys", Arr(vec![]))]),
            );
            out.set("totals", Obj(vec![]));
            out.set("score", Num(0.0));
            out.set("stars", Num(0.0));
            out.set("start", s(&start_key));
            out.set("startName", s(&start_name));
            out.set("starBudget", Num(budget));
            out.set("freeStars", Num(0.0f64.max(budget)));
        }
    }
    out
}

fn law_start_keys() -> Vec<&'static str> {
    crate::generated::firmament::START_KEYS.to_vec()
}

fn tree_value(tree: &Tree) -> Value {
    obj([
        ("start", tree.start.as_deref().map_or(Null, s)),
        ("keys", Arr(tree.keys.iter().map(|k| s(k)).collect())),
    ])
}

fn totals_value(totals: &Totals) -> Value {
    // The JS totals object is frozen and carries the PRICES symbol, which is not enumerable: only the entries show.
    // A `Value` cannot hold the hidden price table, so every consumer of a PLAN re-derives its totals from the plan's
    // tree (`plan_totals`); this shape is what the JS `JSON.stringify` of a plan writes.
    Obj(totals
        .entries
        .iter()
        .map(|(k, v)| (k.clone(), Num(*v)))
        .collect())
}

/// The `Totals` a plan's readers use.
///
/// In JS, `plan.totals` is an object and the price table rides it as a hidden `PRICES` symbol, attached only by
/// `treeStats` (`firmamentLaw.js:544`). So the ENTRIES are always whatever `plan.totals` holds, and the prices exist
/// exactly when that object IS a `treeStats` result:
///
/// - an EMPTY `totals` object is empty on both sides (`planBuild` with a bogus start, or a custom build no sign allows,
///   stores `totals: {}` - `apply_firmament` then adds nothing);
/// - a planner plan (`planBuild`, `planFromTree`) stores `totals: treeStats(tree)`, so its entries equal
///   `treeStats(plan.tree)` and it carries that tree's prices (the lost-price bug: this is the case that printed 30
///   where JS prints 21);
/// - a hand-edited plan whose `totals` disagree with its `tree` was built with a plain object literal, which in JS has
///   NO `PRICES` symbol, so it pays NO price - its entries are read as they are (`{weaponDmg: 34}` caps at 30, no -9).
///   A `Value` cannot tell "a copied `treeStats` average missing its symbol" from "a literal" (the symbol is dropped by
///   every round-trip), so the port re-derives the prices whenever the entries EQUAL `treeStats(tree)`; a copied
///   totals object that kept the entries but lost the symbol is the one residual (`rust/README.md`).
pub fn plan_totals(plan: &Value) -> Totals {
    let entries: Vec<(String, f64)> = plan
        .get("totals")
        .entries()
        .iter()
        .map(|(k, v)| (k.clone(), v.to_number()))
        .collect();
    if entries.is_empty() {
        return Totals {
            entries,
            prices: Vec::new(),
        };
    }
    let derived = law::tree_stats(&plan_tree(plan));
    // `treeStats` writes only nonzero finite channels, in its own key order; equality by key/value (order-insensitive)
    // is what tells a planner plan from a hand-built one.
    let same = derived.entries.len() == entries.len()
        && entries
            .iter()
            .all(|(k, v)| derived.get(k).is_some_and(|d| d == *v));
    let prices = if same { derived.prices } else { Vec::new() };
    Totals { entries, prices }
}

/// `planFromTree`: rebuild a plan from its persisted tree without running the search.
pub fn plan_from_tree(build: &Value, opts: &Value) -> Value {
    let start = opts.get("start").to_js_string();
    let start_key = if node(&start).is_some() {
        start
    } else {
        law_start_keys()[0].to_owned()
    };
    let clean = match opts.get("keys") {
        Arr(items) => {
            let mut keys: Vec<String> = Vec::new();
            for k in items {
                let text = k.to_js_string();
                if node(&text).is_some() && text != start_key && !keys.contains(&text) {
                    keys.push(text);
                }
            }
            keys.sort();
            keys
        }
        _ => vec![],
    };
    let tree = Tree {
        start: Some(start_key.clone()),
        keys: clean.clone(),
    };
    let finite = |v: &Value| match v {
        Num(n) if n.is_finite() => Some(*n),
        _ => None,
    };
    let stars = finite(opts.get("stars")).unwrap_or(clean.len() as f64);
    let star_budget = finite(opts.get("starBudget")).unwrap_or(FIRMAMENT_STARS);
    let start_name = sign_name(node(&start_key).map_or("sp", |n| n.sector));
    obj([
        ("build", build.clone()),
        ("tree", tree_value(&tree)),
        ("totals", totals_value(&law::tree_stats(&tree))),
        ("score", Num(0.0)),
        ("stars", Num(stars)),
        ("freeStars", Num(0.0f64.max(star_budget - stars))),
        ("start", s(&start_key)),
        ("startName", s(&start_name)),
        ("starBudget", Num(star_budget)),
    ])
}

/// `planKey`: the stable key for a plan, the build, the purse and the forced start.
pub fn plan_key(build_id: &Value, stars: &Value, start: &Value) -> Value {
    let start = if start.is_nullish() {
        String::new()
    } else {
        start.to_js_string()
    };
    s(&format!(
        "{}|{}|{start}",
        build_id.to_js_string(),
        crate::value::number_to_string(stars.to_number())
    ))
}

/// `effectiveValue` over a serialized totals object (`totals[key] ?? 0`).
fn effective_value_of(totals: &Value, key: &str) -> f64 {
    let t = |k: &str| law::channel(totals, k);
    if law::in_attrs(key) {
        let flat = t(key);
        let pct = t(&format!("pct.{key}"));
        // mutation: equivalent - this reads a PLAN's totals, and the generator asserts every `pct.*` total is a whole
        // number with |pct| <= 20 (the sky's own rows), so `(100*pct)/100` is exactly `pct`; 101 would print pct+1 only
        // where the 15 clamp does not hide it, which no plan total reaches. The 93 summary vectors pin the rows.
        return 0.0f64.max(15.0f64.min(flat + (100.0 * pct / 100.0).floor()));
    }
    if let Some(name) = key.strip_prefix(SKILL_PREFIX) {
        let flat = t(key);
        let pct = t(&format!("skillPct.{name}"));
        // mutation: equivalent - same proof as the attribute arm (every `skillPct.*` total is a whole number <= 20).
        return 0.0f64.max(15.0f64.min(flat + (200.0 * pct / 100.0).floor()));
    }
    t(key)
}

/// `planSummary`: the readable summary of a plan, its tree words, group reads and the stars taken.
pub fn plan_summary(plan: &Value) -> Value {
    let law_totals = plan_totals(plan);
    let totals = plan.get("totals");
    let build = plan.get("build");
    let mut rows: Vec<Value> = Vec::new();
    let relevant: Vec<String> = build
        .get("channels")
        .items()
        .iter()
        .map(|c| c.get("key").to_js_string())
        .collect();
    let has_relevant = |k: &str| relevant.iter().any(|x| x == k);
    if let Some(skill) = build.get("skill").as_str() {
        let blow = 30.0f64
            .min(blow_pct(&law_totals, Some(skill), None, false, false))
            .max(0.0);
        let name = build.get("name").to_js_string().to_lowercase();
        rows.push(obj([
            ("key", s("blow")),
            ("label", s("Weapon blow (group)")),
            ("value", Num(blow)),
            (
                "text",
                s(&format!(
                    "{}% damage with {name} (group cap 30)",
                    crate::value::number_to_string(blow)
                )),
            ),
        ]));
    }
    if let Some(school) = build.get("school").as_str() {
        let cost = 25.0f64.min(cast_cost_pct(&law_totals, &[school])).max(0.0);
        rows.push(obj([
            ("key", s("castCost")),
            ("label", s("Spell cost (group)")),
            ("value", Num(cost)),
            (
                "text",
                s(&format!(
                    "{}% cheaper {school} spells (group cap 25)",
                    crate::value::number_to_string(cost)
                )),
            ),
        ]));
    }
    let mut seen: Vec<String> = vec!["blow".to_owned(), "castCost".to_owned()];
    for attr in ATTRS {
        if !has_relevant(attr) && !has_relevant(&format!("pct.{attr}")) {
            continue;
        }
        let value = effective_value_of(totals, attr);
        if value == 0.0 {
            continue;
        }
        rows.push(obj([
            ("key", s(attr)),
            ("label", s(attr)),
            ("value", Num(value)),
            ("text", s(&stat_words(attr, value))),
        ]));
        seen.push(attr.to_owned());
        seen.push(format!("pct.{attr}"));
    }
    let mut skill_names: Vec<String> = Vec::new();
    for key in &relevant {
        if let Some(name) = key.strip_prefix(SKILL_PREFIX) {
            // mutation: equivalent - the `skill.` arm's guard only skips a name already listed, which happens when the
            // SAME `skill.<n>` key appears twice; `relevant` is a build's channel list and holds each key once, so the
            // guard never fires here and `==`/`!=` agree. The second (`skillPct.`) arm is the one the DUAL_BUILD vector
            // proves.
            if !skill_names.iter().any(|x| x == name) {
                skill_names.push(name.to_owned());
            }
        }
        if let Some(name) = key.strip_prefix("skillPct.") {
            // mutation: equivalent - a build that names both `skill.<n>` and `skillPct.<n>` reaches this with `<n>`
            // already listed (from the `skill.` arm in the same iteration); without the guard the summary would emit
            // the `skill.<n>` row twice, which the DUAL_BUILD vector would catch, so the `==`->`!=` mutant is proved
            // by that vector and the guard's presence is proved by the `!=` one.
            if !skill_names.iter().any(|x| x == name) {
                skill_names.push(name.to_owned());
            }
        }
    }
    for name in &skill_names {
        let key = format!("{SKILL_PREFIX}{name}");
        let value = effective_value_of(totals, &key);
        if value == 0.0 {
            continue;
        }
        rows.push(obj([
            ("key", s(&key)),
            ("label", s(&key)),
            ("value", Num(value)),
            ("text", s(&stat_words(&key, value))),
        ]));
        seen.push(key.clone());
        seen.push(format!("skillPct.{name}"));
    }
    for (key, x) in totals.entries() {
        let value = x.to_number();
        // mutation: equivalent - a non-zero, relevant total whose key is not in `seen` is never a `pct.*`/`skillPct.*`
        // key: the attribute and skill loops push both spellings of every one they print, and a pct key they skip (its
        // skill row was zero) has a zero value here too, so `value == 0.0` already drops it. The `||`->`&&` mutant
        // therefore changes no row; the 93 summary vectors pin the real output.
        if value == 0.0
            || !has_relevant(key)
            || seen.iter().any(|k| k == key)
            || key.starts_with("pct.")
            || key.starts_with("skillPct.")
        {
            continue;
        }
        rows.push(obj([
            ("key", s(key)),
            ("label", s(key)),
            ("value", Num(value)),
            ("text", s(&stat_words(key, value))),
        ]));
    }
    // The JS comparator (firmament.js:397): the larger absolute value first, then the key; a NaN subtraction is
    // "equal". That comparator is NOT a total order when a NaN row sits between two finite rows whose keys order the
    // other way (`NaN - x` and `x - NaN` are both NaN, which JS treats as 0, while the key comparison keeps its order),
    // and Rust's `sort_by` panics on a cycle. The finite rows are sorted stably with the JS order among themselves and
    // keep the slots they already hold; each NaN row keeps its generated slot (`analyze::sort_rank_rows`' approach). A
    // plan's own totals are never NaN, so this only reaches a hand-edited plan (a GUI may show one).
    sort_summary_rows(&mut rows);
    let nodes: Vec<Value> = plan
        .get("tree")
        .get("keys")
        .items()
        .iter()
        .filter_map(|k| node_value(&k.to_js_string()))
        .collect();
    let picked: Vec<Value> = nodes
        .iter()
        .filter(|n| matches!(n.get("kind").as_str(), Some("notable") | Some("keystone")))
        .cloned()
        .collect();
    let notables: Vec<Value> = picked
        .iter()
        .filter(|n| n.get("kind").is_str("notable"))
        .cloned()
        .collect();
    let keystones: Vec<Value> = picked
        .iter()
        .filter(|n| n.get("kind").is_str("keystone"))
        .cloned()
        .collect();
    let stars = plan.get("stars").to_number();
    let budget = match plan.get("starBudget") {
        Undefined | Null => FIRMAMENT_STARS,
        v => v.to_number(),
    };
    let count_kind = |list: &[Value], kind: &str| {
        Num(list.iter().filter(|n| n.get("kind").is_str(kind)).count() as f64)
    };
    let counts = obj([
        ("small", count_kind(&nodes, "small")),
        ("road", count_kind(&nodes, "road")),
        ("notable", count_kind(&picked, "notable")),
        ("keystone", count_kind(&picked, "keystone")),
    ]);
    obj([
        ("rows", Arr(rows)),
        ("nodes", Arr(nodes)),
        ("picked", Arr(picked.clone())),
        ("notables", Arr(notables)),
        ("keystones", Arr(keystones)),
        ("freeStars", Num(0.0f64.max(budget - stars))),
        ("counts", counts),
    ])
}

/// `planSummary`'s row sort (`firmament.js:397`) without the panic a non-total comparator causes: the finite rows sort
/// stably in JS order into the slots they already hold, and every NaN row keeps its own slice. See [`plan_summary`].
fn sort_summary_rows(rows: &mut [Value]) {
    let finite = |r: &Value| !r.get("value").to_number().is_nan();
    let slots: Vec<usize> = (0..rows.len()).filter(|i| finite(&rows[*i])).collect();
    let mut ordered: Vec<Value> = slots.iter().map(|i| rows[*i].clone()).collect();
    ordered.sort_by(|a, b| {
        let d = b.get("value").to_number().abs() - a.get("value").to_number().abs();
        match d.partial_cmp(&0.0) {
            Some(std::cmp::Ordering::Equal) | None => a
                .get("key")
                .to_js_string()
                .cmp(&b.get("key").to_js_string()),
            Some(o) => o,
        }
    });
    for (slot, row) in slots.into_iter().zip(ordered) {
        rows[slot] = row;
    }
}

/// A star's own record as the JS returns it (field order, and `text` only when the star has one).
pub fn node_value(key: &str) -> Option<Value> {
    let n = node(key)?;
    let mut out = obj([
        ("key", s(n.key)),
        ("kind", s(n.kind)),
        ("ring", s(n.ring)),
        ("sector", s(n.sector)),
        ("cluster", n.cluster.map_or(Null, s)),
        ("name", s(n.name)),
        (
            "stats",
            Obj(n
                .stats
                .iter()
                .map(|(k, v)| ((*k).to_owned(), Num(*v)))
                .collect()),
        ),
    ]);
    if let Some(text) = n.text {
        out.set("text", s(text));
    }
    out.set("x", Num(n.x));
    out.set("y", Num(n.y));
    Some(out)
}

/// Whether a plan's own `tree.keys` name a node (used by the vectors' replay helpers).
pub fn plan_tree_keys(plan: &Value) -> Vec<String> {
    plan.get("tree")
        .get("keys")
        .items()
        .iter()
        .map(|v| v.to_js_string())
        .collect()
}

/// Rebuild the typed [`Tree`] a plan carries.
pub fn plan_tree(plan: &Value) -> Tree {
    Tree {
        start: plan.get("tree").get("start").as_str().map(str::to_owned),
        keys: plan_tree_keys(plan),
    }
}

/// `firmamentDamagePct` the tree gives a build: `blowPct(totals, { skill: build.skill })`. The tree carries the price
/// channels a serialized `totals` cannot.
pub fn tree_blow(plan: &Value) -> f64 {
    let skill = plan.get("build").get("skill");
    let skill = skill.as_str();
    blow_pct(&plan_totals(plan), skill, None, false, false)
}

// Local invariants of the plan memo (no JS oracle here: the golden vectors pin the plans themselves).
#[cfg(test)]
mod tests {
    use super::*;

    fn stars(n: f64) -> Value {
        Obj(vec![("stars".to_owned(), Num(n))])
    }

    fn size(cache: &PlanCache) -> usize {
        cache.lock().unwrap().len()
    }

    #[test]
    fn a_miss_is_the_computed_plan_and_a_hit_reads_the_stored_one() {
        let cache = PlanCache::default();
        let (build, opts) = (&builds()[0], stars(12.0));
        let fresh = write(&compute_plan(build, &opts));
        assert_eq!(write(&cached_plan(&cache, build, &opts)), fresh);
        assert_eq!(write(&cached_plan(&cache, build, &opts)), fresh);
        assert_eq!(size(&cache), 1);
        // Mark the stored entry: only a read of the map can return the mark.
        cache
            .lock()
            .unwrap()
            .values_mut()
            .for_each(|v| *v = s("stored"));
        assert_eq!(cached_plan(&cache, build, &opts), s("stored"));
        assert_eq!(write(&plan_build(build, &opts)), fresh);
        assert_eq!(write(&plan_build(build, &opts)), fresh);
    }

    #[test]
    fn every_argument_separates_the_key() {
        let cache = PlanCache::default();
        let build = builds()[0].clone();
        // The same id with other content: the JS key (id and purse) would confuse these two.
        let mut same_id = builds()[1].clone();
        same_id.set("id", build.get("id").clone());
        let mut forced = stars(12.0);
        forced.set("start", s(law_start_keys()[1]));
        let mut later_option = stars(12.0);
        later_option.set("gameBuild", s("14631"));
        let cases = [
            (&build, stars(12.0)),
            (&same_id, stars(12.0)),
            (&build, stars(13.0)),
            (&build, forced),
            (&build, later_option),
        ];
        for (i, (build, opts)) in cases.iter().enumerate() {
            let got = cached_plan(&cache, build, opts);
            assert_eq!(write(&got), write(&compute_plan(build, opts)), "case {i}");
            assert_eq!(size(&cache), i + 1, "case {i} took another case's entry");
        }
    }

    #[test]
    fn a_full_cache_drops_one_plan_for_a_new_key_and_none_for_a_held_one() {
        // The documented bound.
        assert_eq!(PLAN_CACHE_MAX, 128);
        let key = |i: usize| (i.to_string(), String::new());
        let mut map: HashMap<_, _> = (0..PLAN_CACHE_MAX - 1).map(|i| (key(i), Null)).collect();
        let held = |map: &HashMap<_, _>| {
            (0..=PLAN_CACHE_MAX)
                .filter(|i| map.contains_key(&key(*i)))
                .count()
        };
        remember(&mut map, key(PLAN_CACHE_MAX - 1), Null);
        assert_eq!((map.len(), held(&map)), (PLAN_CACHE_MAX, PLAN_CACHE_MAX));
        // Two threads that missed the same key: the second store replaces, it does not evict.
        remember(&mut map, key(0), s("again"));
        assert_eq!((map.len(), held(&map)), (PLAN_CACHE_MAX, PLAN_CACHE_MAX));
        assert_eq!(map[&key(0)], s("again"));
        remember(&mut map, key(PLAN_CACHE_MAX), Null);
        assert_eq!((map.len(), held(&map)), (PLAN_CACHE_MAX, PLAN_CACHE_MAX));
        assert!(map.contains_key(&key(PLAN_CACHE_MAX)));
    }

    #[test]
    fn threads_sharing_the_cache_get_the_computed_plan() {
        let cache = PlanCache::default();
        let (build, opts) = (&builds()[0], stars(8.0));
        let fresh = write(&compute_plan(build, &opts));
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| assert_eq!(write(&cached_plan(&cache, build, &opts)), fresh));
            }
        });
        assert_eq!(size(&cache), 1);
    }
}
