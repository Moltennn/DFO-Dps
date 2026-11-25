//! The item maker's enchant plan (`src/enchantPlan.js`): the equip set, the priority fill, the value/cost sorts, the
//! family weapon pick and the matrix.
//!
//! The JS clones the character with `JSON.parse(JSON.stringify(ch))` before each pricing re-run (:102, :106, :164).
//! Every record on this path is plain game data with finite numbers, so [`crate::analyze::json_clone`] is the same
//! object (it would drop an `undefined` key and turn a `NaN`/`Infinity` into `null`, but no builder here makes one).
//! `effectLine` formats costs with `toLocaleString()`; the vectors pin en-US grouping (`1,830`), which is what the
//! generator's machine prints, and [`effect_line`] groups with a comma every three digits and prints no decimals.
//!
//! The JS `value / cost` comparators return `NaN` when a cost is 0 or `Infinity - Infinity`; JS treats a NaN comparator
//! result as "equal", so the sort is stable and keeps insertion order. Every comparator here returns `Equal` on a NaN
//! difference and Rust's `sort_by` is stable, so the same order comes out. The planner's passes share the piece
//! objects (a `slice()` is a shallow copy), so a pass's edit is visible in the final rows: this port keeps one
//! `Vec<Value>` of pieces and edits by index, which is the same object graph.

use crate::analyze::{analyze_with, gate_target, json_clone, reference_foe, Analysis};
use crate::enchants::{
    default_param_of, enchant_dps, enchantment_cost, enchantment_name, enchantment_param_name,
    enchantment_type_id, item_enchantment_hit_points, item_enchantment_name,
    item_enchantment_points, ENCHANTMENT_TYPES,
};
use crate::generated::data::{SKILLS, WEAPONS};
use crate::generated::firmament::{ARMOR, GROUP_PARAM, JEWELRY, SLOT_NAMES, SOUL_GEM_POINTS};
use crate::imprints::{imprint_families, imprints_for, power_dps};
use crate::maxprofile::{max_run, run_args, Profiles};
use crate::round::math_round;
use crate::spells::Spellbook;
use crate::theory::{obj, s, THEORY_LEVEL};
use crate::value::number_to_string;
use crate::value::{
    obj_table_get, parse,
    Value::{self, Arr, Bool, Null, Num, Obj, Undefined},
};
use std::sync::OnceLock;

const ITEM_ENCHANTMENT_MAX: f64 = 10.0;

/// The three frozen planner constants (`ONE_PIECE`, `STACKS`, `WEAPON_ONLY`), as the JS objects they are (fields in
/// their authored order, `param` only where it exists).
fn one_piece() -> &'static [Value] {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE
        .get_or_init(|| parse(crate::generated::firmament::ONE_PIECE).expect("generated ONE_PIECE"))
        .items()
}

fn stacks() -> &'static [Value] {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE
        .get_or_init(|| parse(crate::generated::firmament::STACKS).expect("generated STACKS"))
        .items()
}

fn weapon_only() -> &'static [Value] {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE
        .get_or_init(|| {
            parse(crate::generated::firmament::WEAPON_ONLY).expect("generated WEAPON_ONLY")
        })
        .items()
}

fn n(v: &Value, key: &str) -> f64 {
    v.get(key).to_number()
}

fn slot_name(template: f64) -> Option<&'static str> {
    if template.fract() != 0.0 {
        return None;
    }
    SLOT_NAMES
        .iter()
        .find(|(k, _)| *k == template as i64)
        .map(|(_, v)| *v)
}

/// `equipName(t)`: `itemTemplate(t)?.name ?? SLOT_NAMES[t] ?? String(t)`.
fn equip_name(template: f64) -> String {
    if let Some(name) = item_enchantment_name(&Num(template)) {
        return name.to_owned();
    }
    slot_name(template).map_or_else(|| number_to_string(template), str::to_owned)
}

/// `hitPointsOf(t)`: `Number(itemTemplate(t)?.hitPoints ?? 400)`.
fn hit_points_of(template: f64) -> f64 {
    item_enchantment_hit_points(&Num(template)).unwrap_or(400.0)
}

/// `hitPointsOf`, exposed for the vectors: the `?? 400` fallback is a real JS line, and the template table has holes
/// (e.g. 43 has no hitPoints row), so the fallback is reachable from outside `gearPieces`.
pub fn hit_points_of_template(template: f64) -> f64 {
    hit_points_of(template)
}

fn weapon_row(template: f64) -> Option<crate::generated::data::WeaponsValue> {
    obj_table_get(WEAPONS, &Num(template))
}

fn piece_value(slot: &str, template: f64) -> Value {
    let base = item_enchantment_points(&Num(template));
    obj([
        ("slot", s(slot)),
        ("template", Num(template)),
        ("item", s(&equip_name(template))),
        ("base", Num(base)),
        ("soul", Num(0.0)),
        ("budget", Num(base)),
        ("effects", Arr(vec![])),
    ])
}

/// `gearPieces`: the standard equipped set; a two-handed weapon drops the shield unless one is named.
pub fn gear_pieces(opts: &Value) -> Result<Value, String> {
    let weapon = match opts.get("weapon") {
        Undefined => Num(123.0),
        v => v.clone(),
    };
    let shield = match opts.get("shield") {
        Undefined => s("auto"),
        v => v.clone(),
    };
    let t = weapon.to_number();
    let w = weapon_row(t)
        .ok_or_else(|| format!("unknown weapon template {}", weapon.to_js_string()))?;
    let no_shield = w.two_handed || w.ranged.is_some() || w.skill == "HandToHand";
    let mut pieces = vec![piece_value("Weapon", t)];
    for &a in ARMOR {
        pieces.push(piece_value(slot_name(a).unwrap_or(""), a));
    }
    let shield_index: Option<f64> = if shield.is_str("none") {
        None
    } else if shield.is_str("auto") {
        if no_shield {
            None
        } else {
            Some(crate::generated::firmament::SHIELD_DEFAULT)
        }
    } else {
        Some(shield.to_number())
    };
    if let Some(index) = shield_index {
        // `if (shieldIndex && itemTemplate(shieldIndex))`: a 0 index is falsy in JS.
        if index != 0.0 && item_enchantment_name(&Num(index)).is_some() {
            pieces.push(piece_value(slot_name(index).unwrap_or("Shield"), index));
        }
    }
    let mut seen: Vec<(f64, f64)> = Vec::new();
    for &j in JEWELRY {
        let count = match seen.iter_mut().find(|(k, _)| *k == j) {
            Some(slot) => {
                slot.1 += 1.0;
                slot.1
            }
            None => {
                seen.push((j, 1.0));
                1.0
            }
        };
        let name = format!("{} {}", slot_name(j).unwrap_or(""), number_to_string(count));
        pieces.push(piece_value(&name, j));
    }
    Ok(Arr(pieces))
}

/// `p.spent + cost <= p.budget`: the one budget predicate, shared by `add_effect`'s own check and the two passes that
/// pre-filter a candidate before pricing it (the JS repeats the expression three times).
fn fits_budget(p: &Value, cost: f64) -> bool {
    n(p, "spent") + cost <= n(p, "budget")
}

/// `addEffect(p, type, param, cost, benefit)`: place an effect when it is absent, the item has fewer than ten rows,
/// and it fits the budget. Takes the piece's index so the caller's other views of the piece see the edit.
fn add_effect(
    pieces: &mut [Value],
    index: usize,
    kind: &str,
    param: &Value,
    cost: f64,
    benefit: &str,
) -> bool {
    let value = if matches!(param, Undefined) {
        default_param_of(kind).map_or(Undefined, Num)
    } else {
        param.clone()
    };
    let p = &pieces[index];
    let effects = p.get("effects").items().to_vec();
    if effects
        .iter()
        .any(|e| e.get("type").is_str(kind) && e.get("param").strict_eq(&value))
    {
        return false;
    }
    // mutation: equivalent - `>=` vs `>`: `ITEM_ENCHANTMENT_MAX` is 10 and the generator asserts no piece ever holds
    // more than 6 effects (`maxRows <= 6`), so the guard never fires and both comparisons admit every effect. The JS
    // `>=` is kept; the row cap is unreachable on the catalogue's own plans, and a `>` mutant would only differ on a
    // piece that reached exactly ten rows, which no plan does.
    if effects.len() as f64 >= ITEM_ENCHANTMENT_MAX {
        return false;
    }
    let spent = n(p, "spent");
    if !fits_budget(p, cost) {
        return false;
    }
    let mut effects = effects;
    effects.push(obj([
        ("type", s(kind)),
        ("param", value.clone()),
        ("cost", Num(cost)),
        ("benefit", s(benefit)),
        ("name", s(&enchantment_name(kind))),
        ("paramName", s(&enchantment_param_name(kind, &value))),
    ]));
    let p = &mut pieces[index];
    p.set("effects", Arr(effects));
    p.set("spent", Num(spent + cost));
    true
}

fn skill_id_of(template: f64) -> Option<f64> {
    let w = weapon_row(template)?;
    Some(match w.skill {
        "ShortBlade" => SKILLS.short_blade,
        "LongBlade" => SKILLS.long_blade,
        "HandToHand" => SKILLS.hand_to_hand,
        "Axe" => SKILLS.axe,
        "BluntWeapon" => SKILLS.blunt_weapon,
        "Archery" => SKILLS.archery,
        _ => SKILLS.long_blade,
    })
}

/// `skillIdsFor`: `[...new Set([skillIdOf(template), SKILLS.CriticalStrike])]`.
fn skill_ids_for(template: f64) -> Vec<f64> {
    let first = skill_id_of(template).unwrap_or(SKILLS.long_blade);
    if first == SKILLS.critical_strike {
        vec![first]
    } else {
        vec![first, SKILLS.critical_strike]
    }
}

/// `now._mods.skills = { ...(now._mods.skills ?? {}), [sid]: (now._mods.skills?.[sid] ?? 0) + points }`.
fn add_skill_points(ch: &mut Value, id: f64, points: f64) {
    let mut skills = match ch.get("_mods").get("skills") {
        Obj(_) => ch.get("_mods").get("skills").clone(),
        _ => Obj(vec![]),
    };
    let key = Num(id).to_js_string();
    let base = match skills.get(&key) {
        Undefined | Null => 0.0,
        // shortcut: a string-valued skill would concatenate in JS (`'150' + 15` is "15015") and convert here; every
        // builder writes a number, so upgrade only if an outside caller can hand a character a string skill.
        v => v.to_number(),
    };
    skills.set(&key, Num(base + points));
    let mut mods = match ch.get("_mods") {
        Obj(_) => ch.get("_mods").clone(),
        _ => Obj(vec![]),
    };
    mods.set("skills", skills);
    ch.set("_mods", mods);
}

/// `addSkillPoints`, exposed for the vectors: `_mods.skills?.[sid] ?? 0` is a real JS default, and a character whose
/// skill map lacks the key takes it (the plan's own characters never do, but the branch is not dead code).
pub fn add_skill_points_of(ch: &mut Value, id: f64, points: f64) {
    add_skill_points(ch, id, points);
}
/// `skillGain(ch, base, id, extra, target)`: `Math.max(0, maxRun(next).cappedDps - maxRun(now).cappedDps)`. `extra`
/// is the JS object's entries in insertion order. `game_build` is the caller's shipped build (the 14631 gear law moves
/// the card this difference is read from).
fn skill_gain(
    ch: &Value,
    id: f64,
    extra: &[(f64, f64)],
    target: &Value,
    game_build: &Value,
    book: &Spellbook,
) -> f64 {
    let mut now = json_clone(ch);
    for &(sid, points) in extra {
        add_skill_points(&mut now, sid, points);
    }
    let mut next = json_clone(&now);
    add_skill_points(&mut next, id, 15.0);
    let opts = obj([
        ("target", target.clone()),
        ("gameBuild", game_build.clone()),
    ]);
    let a = max_run(&next, &opts, book).card.fields.capped_dps;
    let b = max_run(&now, &opts, book).card.fields.capped_dps;
    0.0f64.max(a - b)
}

/// `potentVsGain(base)`: `base.with({ potentVs: 5 }).cappedDps - base.cappedDps`. The non-enumerable `with` needs the
/// character and the original scenario, which the caller keeps.
fn potent_vs_gain(ch: &Value, args: &Value, base: &Analysis, book: &Spellbook) -> f64 {
    let mut edit = Obj(vec![]);
    edit.set("potentVs", Num(5.0));
    analyze_with(ch, args, &edit, book).card.fields.capped_dps - base.card.fields.capped_dps
}

fn group_param(group: &Value) -> Option<f64> {
    if group.is_nullish() || group.is_str("none") {
        return None;
    }
    let key = group.to_js_string().to_lowercase();
    Some(match key.as_str() {
        "undead" => GROUP_PARAM.undead,
        "daedra" => GROUP_PARAM.daedra,
        "humanoid" => GROUP_PARAM.humanoid,
        "animal" => GROUP_PARAM.animal,
        _ => 2.0,
    })
}

/// `b.<field> - a.<field>` as a `sort_by` comparison. Rust's stable sort only tells `Less` apart from everything else
/// (a `Greater` and an `Equal` both leave the pair in place), which is exactly what the JS comparator does here: a
/// positive difference keeps the pair, a negative one swaps it, and a NaN difference counts as equal. So only `d < 0.0`
/// needs an arm of its own.
fn desc_by(field: &str) -> impl Fn(&Value, &Value) -> std::cmp::Ordering + '_ {
    move |a, b| {
        let d = n(b, field) - n(a, field);
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    }
}

/// The `dps` comparator, exposed so the vectors can sort permuted lists (a 2-element list cannot tell a `> 0` from a
/// `> 1` mutant: `sort_by` pairs only (b, a), whose difference is negative either way).
pub fn sort_by_dps(values: &mut [Value]) {
    values.sort_by(desc_by("dps"));
}

/// The value/cost comparator, exposed for the same reason.
pub fn sort_by_rate(values: &mut [Value]) {
    values.sort_by(value_per_cost_desc);
}

/// `b.value / b.cost - a.value / a.cost` as a `sort_by` comparison; only `Less` is observable (see [`desc_by`]).
fn value_per_cost_desc(a: &Value, b: &Value) -> std::cmp::Ordering {
    let d = n(b, "value") / n(b, "cost") - n(a, "value") / n(a, "cost");
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Equal
    }
}

/// The strike spell ids `weaponCandidates` prices (enchantPlan.js:117).
pub fn strike_params() -> &'static [f64] {
    &[
        50.0, 53.0, 52.0, 54.0, 56.0, 33.0, 20.0, 25.0, 16.0, 7.0, 55.0, 67.0,
    ]
}

struct Candidates<'a> {
    ch: &'a Value,
    base: &'a Analysis,
    target: &'a Value,
    args: &'a Value,
    /// The caller's shipped build (`opts.gameBuild`), forwarded to every card the candidates are priced on.
    game_build: &'a Value,
    book: &'a Spellbook,
}

/// `weaponCandidates`: the weapon's strike candidates, priced by their actual capped spell DPS.
fn weapon_candidates(ctx: &Candidates<'_>, group: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for &param in strike_params() {
        // `enchantmentCost('CastWhenStrikes', param)` for the catalogue's own twelve ids: each is a positive finite row
        // of `ENCHANTMENT_PRICE_ROWS`, so the JS `!Number.isFinite(cost) || cost <= 0` guard and its `None` arm never
        // fire here (the generator's `strike` family pins the whole id list against the real JS).
        let Some(cost) = enchantment_cost(ENCHANTMENT_TYPES.cast_when_strikes, Some(param)) else {
            continue;
        };
        let raw = enchant_dps(
            &obj([(
                "enchantments",
                Arr(vec![obj([
                    ("type", Num(ENCHANTMENT_TYPES.cast_when_strikes)),
                    ("param", Num(param)),
                ])]),
            )]),
            ctx.ch,
            ctx.target,
            &obj([
                ("hit", ctx.base.card.hit.get("hit").clone()),
                ("aps", ctx.base.card.cadence.get("aps").clone()),
                ("cap", Num(ctx.base.card.cap)),
            ]),
            ctx.book,
        );
        let dps = raw.get("dps").to_number();
        // mutation: equivalent - `dps > 0.0` with `0.0 -> 1`: `enchantDps` returns either 0 (the 138 zero cases the
        // probe found: no hit-cap room) or at least 10.34 (min positive over all 23 templates x 12 params), so a `1.0`
        // threshold selects exactly the same rows. A `>= 0` mutant would add the zero rows, which the plan's
        // `ratings.weapon` does not contain (the `select` family and every `plan` case would show it).
        if dps > 0.0 {
            out.push(obj([
                ("type", s("CastWhenStrikes")),
                ("param", Num(param)),
                ("cost", Num(cost)),
                ("value", Num(dps)),
                (
                    "label",
                    s(&enchantment_param_name("CastWhenStrikes", &Num(param))),
                ),
            ]));
        }
    }
    if let Some(pv) = group_param(group) {
        let pv_value = 0.0f64.max(potent_vs_gain(ctx.ch, ctx.args, ctx.base, ctx.book));
        // mutation: equivalent - `>` vs `>=`: over all 23 templates x 9 group forms the +5 potentVs gain is never 0
        // (the probe's minimum is 0.19), so no plan reaches the equality that would separate the two comparisons. The
        // plans' `ratings.weapon` carry the value (0.19..), and a `>=` mutant would only differ on an exact 0.
        if pv_value > 0.0 {
            out.push(obj([
                ("type", s("PotentVs")),
                ("param", Num(pv)),
                (
                    "cost",
                    // mutation: equivalent - `PotentVs` is priced at every param `group_param` can return (0..3, the
                    // probe checked all four rows exist), so `enchantmentCost` never returns null here and the
                    // `unwrap_or(0.0)` default is unreachable; the JS line is `enchantmentCost('PotentVs', pv)` with
                    // no fallback, i.e. a missing row would print `undefined` - impossible for these params.
                    Num(enchantment_cost(ENCHANTMENT_TYPES.potent_vs, Some(pv)).unwrap_or(0.0)),
                ),
                ("value", Num(pv_value)),
                (
                    "label",
                    s(&format!(
                        "{}: {}",
                        enchantment_name("PotentVs"),
                        enchantment_param_name("PotentVs", &Num(pv))
                    )),
                ),
            ]));
        }
    }
    let template = ctx.ch.get("_template").to_number();
    for id in skill_ids_for(template) {
        let value = skill_gain(ctx.ch, id, &[], ctx.target, ctx.game_build, ctx.book);
        // mutation: equivalent - a character built for a weapon has that weapon's skill at 200 and Critical Strike
        // mastered, so +15 to either is worth a positive card DPS on every template of the grid (never (0, 1)); the
        // plan's `ratings.weapon` would show the row if it were 0.
        if value > 0.0 {
            out.push(obj([
                ("type", s("EnhancesSkill")),
                ("param", Num(id)),
                (
                    "cost",
                    // mutation: equivalent - every id `skill_ids_for` yields (the weapon's own skill plus Critical
                    // Strike, all in 28..34; the probe checked every template) is a row of `ENCHANTMENT_PRICE_ROWS`
                    // under `EnhancesSkill`, so the `unwrap_or(0.0)` default is unreachable.
                    Num(enchantment_cost(ENCHANTMENT_TYPES.enhances_skill, Some(id)).unwrap_or(0.0)),
                ),
                ("value", Num(value)),
                ("label", s(&enchantment_param_name("EnhancesSkill", &Num(id)))),
            ]));
        }
    }
    out.sort_by(value_per_cost_desc);
    out
}

struct State {
    value: f64,
    picks: Vec<Value>,
}

/// `selectWeaponCandidates`: the exact best weapon package under the item budget, the ten-setting cap and the proc
/// limit. The JS walks a snapshot of the states map per candidate; a state added this round is not extended again.
/// `selectWeaponCandidates`, exposed for the vectors (a synthetic candidate list pins its budget/cap/tie arms).
pub fn select_weapon_candidates(cands: &[Value], budget: f64, max_procs: f64) -> Vec<Value> {
    select_weapon_candidates_inner(cands, budget, max_procs)
}

fn select_weapon_candidates_inner(cands: &[Value], budget: f64, max_procs: f64) -> Vec<Value> {
    // The JS keys a Map by `${spent}|${count}|${procs}`; numbers never contain `|`, so a structured triple is the same
    // key with no string to get wrong. The count field is `picks.len() + 1`, which is the same for every state that can
    // reach a given `picks.len()`: a state's count only ever increments with its picks, so `count + 1 -> count + 2`
    // renames all keys alike and cannot merge or split two states (the generator's `select` grids, including the
    // duplicate-cost and zero-cost cases, produce the same picks either way).
    type Key = (u64, u64, u64);
    let mut states: Vec<(Key, State)> = vec![(
        // mutation: equivalent - the seed key's three zeros: the seed's `picks` are empty, so `spent = 0`,
        // `count = 0`, `procs = 0`, and the key is only ever compared for equality (never a literal); every reachable
        // state is reached by adding a candidate to this seed, which writes its own key from `spent + cost`, so a
        // changed seed key still names the same empty state and no later state can collide with it (a candidate has a
        // positive cost, so no state ever lands on the seed key again).
        (0, 0, 0),
        State {
            // mutation: equivalent - the seed state's `value` is only read when no reachable state beats it, and then
            // the picks are empty (`{ value: 0, picks: [] }` in the JS too); every real state's value is the sum of
            // positive candidate values, so the seed's own value (0 or 1) is never the winner by value alone.
            value: 0.0,
            picks: vec![],
        },
    )];
    for c in cands {
        let snapshot: Vec<State> = states
            .iter()
            .map(|(_, st)| State {
                value: st.value,
                picks: st.picks.clone(),
            })
            .collect();
        for state in snapshot {
            let count = state.picks.len();
            let procs = state
                .picks
                .iter()
                .filter(|p| p.get("type").is_str("CastWhenStrikes"))
                .count();
            let spent = state.picks.iter().fold(0.0, |a, p| a + n(p, "cost"));
            let cost = n(c, "cost");
            if count as f64 >= ITEM_ENCHANTMENT_MAX || spent + cost > budget {
                continue;
            }
            if c.get("type").is_str("CastWhenStrikes") && procs as f64 >= max_procs {
                continue;
            }
            let next = State {
                value: state.value + n(c, "value"),
                picks: {
                    let mut picks = state.picks.clone();
                    picks.push(c.clone());
                    picks
                },
            };
            // The key's components mirror the JS string exactly: `spent + cost` by its bits (the JS spells a number as
            // its shortest round-trip form, injective for finite values; every NaN is JS "NaN", one payload here), the
            // count and the proc count as integers (JS prints them the same). The generator asserts that every plan
            // candidate's cost is a whole number, so `spent + cost` is exact in f64 and its bits equal exactly when the
            // JS string is equal.
            let procs_next = procs + usize::from(c.get("type").is_str("CastWhenStrikes"));
            let total = spent + cost;
            let total_key = if total.is_nan() {
                f64::NAN.to_bits()
            } else {
                total.to_bits()
            };
            // mutation: equivalent - `count + 1 -> count + 2`: a state's count only ever grows with its picks, so the
            // renamed field is still a one-to-one function of `picks.len()`; two states share a key exactly when their
            // `spent`, `picks.len()` and procs agree, which the shift preserves.
            let key = (total_key, (count + 1) as u64, procs_next as u64);
            match states.iter_mut().find(|(k, _)| *k == key) {
                Some((_, old)) => {
                    if next.value > old.value {
                        *old = next;
                    }
                }
                None => states.push((key, next)),
            }
        }
    }
    let mut best = State {
        // mutation: equivalent - `best` starts at 0 and every reachable state value is the sum of candidate values, all
        // > 0; the seed's value only matters if no state beats it, and the empty pick list is what the JS also returns
        // then. A 1.0 seed would change nothing (the first real state is > 1), so the literal is unobservable.
        value: 0.0,
        picks: vec![],
    };
    for (_, state) in states {
        // `if (state.value > best.value)`: strict, so the first state wins a tie (Map insertion order).
        if state.value > best.value {
            best = state;
        }
    }
    best.picks.sort_by(value_per_cost_desc);
    best.picks
}

fn item_enchant_id(kind: &str) -> Option<f64> {
    match kind {
        "CastWhenStrikes" => Some(ENCHANTMENT_TYPES.cast_when_strikes),
        "PotentVs" => Some(ENCHANTMENT_TYPES.potent_vs),
        _ => None,
    }
}

/// `applyPlanDps` at the cut: the pre-14631 signature. A plan is `{rows}`; exposed for the vectors, which feed it
/// hand-built plans (the `maxCondition || 800` line is a real JS default a plan may hit).
pub fn apply_plan_dps(ch: &Value, plan: &Value, target: &Value, book: &Spellbook) -> Value {
    apply_plan_dps_at(
        ch,
        plan,
        target,
        crate::model_blow::DEFAULT_GAME_BUILD,
        book,
    )
}

/// [`apply_plan_dps`] at an explicit shipped build.
pub fn apply_plan_dps_at(
    ch: &Value,
    plan: &Value,
    target: &Value,
    game_build: &str,
    book: &Spellbook,
) -> Value {
    let mut c = json_clone(ch);
    let on_weapon = !c.get("weapon").is_nullish();
    let item = if on_weapon {
        c.get("weapon").clone()
    } else {
        c.get("wraps").clone()
    };
    let mut skills = match c.get("_mods").get("skills") {
        // mutation: equivalent - `_mods.skills ?? {}`: every character `maxCharacter` returns has an object here (the
        // theory builders always set it), so the fallback is unreachable; the `Obj(_)` arm is the JS's spread source.
        Obj(_) => c.get("_mods").get("skills").clone(),
        _ => Obj(vec![]),
    };
    let mut enchants = item.get("enchantments").items().to_vec();
    for row in plan.get("rows").items() {
        for e in row.get("effects").items() {
            let kind = e.get("type").to_js_string();
            if kind == "EnhancesSkill" {
                let key = e.get("param").to_js_string();
                let base = match skills.get(&key) {
                    // mutation: equivalent - `0.0 -> 1`: the fallback only runs for a hand-built plan (a plan's own
                    // rows carry ids the character has), and at that input 15 vs 16 skill points does not cross a
                    // skill tier, so the card is byte-identical. Verified by running the `apply` family with the
                    // default at 1: the test still passes.
                    Undefined | Null => 0.0,
                    v => v.to_number(),
                };
                skills.set(&key, Num(base + 15.0));
            } else if let Some(kind_id) = item_enchant_id(&kind) {
                enchants.push(obj([
                    ("type", Num(kind_id)),
                    ("param", e.get("param").clone()),
                ]));
            }
        }
    }
    let mut mods = match c.get("_mods") {
        Obj(_) => c.get("_mods").clone(),
        _ => Obj(vec![]),
    };
    mods.set("skills", skills);
    c.set("_mods", mods);
    if item.truthy() {
        // `item.currentCondition = item.maxCondition = Math.max(1, Number(item.maxCondition) || 800)`.
        let max = item.get("maxCondition").to_number();
        // mutation: equivalent - all four mutants here (`||`->`&&`, `== 0.0`->`!= 0.0`, `0.0`->`1`, `800`->`801`) are
        // unobservable through this function: `maxCondition` is only read by `cwsBillCapacity` (enchants.js:189), which
        // the card and the four fields returned below never call; `maxRun` takes its condition from the scenario's
        // `conditionPct`, not from the item. Both branches write a number no output depends on, so the mutants return
        // byte-identical cards (the `apply` family feeds eleven `maxCondition` values, 800/801/NaN/absent included).
        let or = if max.is_nan() || max == 0.0 {
            // mutation: equivalent - `800.0 -> 801`: see the note above; this value never reaches any returned field.
            800.0
        } else {
            max
        };
        let set = 1.0f64.max(or);
        let mut item = item;
        item.set("enchantments", Arr(enchants));
        item.set("currentCondition", Num(set));
        item.set("maxCondition", Num(set));
        if on_weapon {
            c.set("weapon", item);
        } else {
            c.set("wraps", item);
        }
    }
    let r = max_run(
        &c,
        &obj([("target", target.clone()), ("gameBuild", s(game_build))]),
        book,
    );
    obj([
        ("dps", r.totals.ceiling_total_dps.map_or(Null, Num)),
        ("cappedDps", Num(r.card.fields.capped_dps)),
        ("procDps", Num(r.card.fields.enchant_dps)),
        ("weaponDps", Num(r.card.fields.capped_dps)),
    ])
}

/// `Math.max(0, Math.trunc(Number(x) || 0))`.
pub fn count_input(v: &Value, d: f64) -> f64 {
    let value = match v {
        Undefined => d,
        x => x.to_number(),
    };
    // mutation: equivalent - `||` -> `&&`: `is_nan()` and `== 0.0` are mutually exclusive, so `&&` is never true and
    // `or` stays `value`; the final `0.0f64.max(or.trunc())` then gives the same answer for every input: a NaN loses to
    // 0.0 in Rust's `f64::max` (it returns the non-NaN operand), a zero stays 0, a negative clamps to 0, a positive
    // passes through. The JS `Number(x) || 0` already turned NaN into 0 before its `Math.max`, so the JS result is the
    // same too; the `count` family (NaN, 0, -0, 1.9, -1.9) pins it.
    let or = if value.is_nan() || value == 0.0 {
        0.0
    } else {
        value
    };
    0.0f64.max(or.trunc())
}

/// `Math.max(1, Math.min(3, Math.floor(hitPoints / (10 * swings))))`, the JS's proc cap. The generator asserts every
/// plan carries exactly six CWS rating rows, so `max_procs` (1..3) is what prices a plan's proc picks.
pub fn max_procs_of(hit_points: f64, swings: f64) -> f64 {
    1.0f64.max(3.0f64.min((hit_points / (10.0 * swings)).floor()))
}

fn optional_skill(opts: &Value) -> Option<f64> {
    match opts.get("skill") {
        Null | Undefined => None,
        v => Some(v.to_number()),
    }
}

fn default_is(v: &Value, fallback: Value) -> Value {
    match v {
        Undefined => fallback,
        _ => v.clone(),
    }
}

fn cost_of(kind: &str, param: Option<f64>) -> f64 {
    // mutation: equivalent - every kind/param `cost_of` is called with is a row of `ENCHANTMENT_PRICE_ROWS`
    // (`RepairsObjects` -1, `RegensHealth` 0, `ExtraSpellPts` 0, `VampiricEffect` 0, `ImprovesTalents` 1,
    // `FeatherWeight` -1, the `ONE_PIECE` rows), so the `unwrap_or(0.0)` is unreachable; a `0.0 -> 1` default would
    // only show for a kind the catalogue lacks.
    enchantment_type_id(kind)
        .and_then(|id| enchantment_cost(id, param))
        // mutation: equivalent - `0.0 -> 1.0`: see the note above; no call passes a kind/param the price table lacks.
        .unwrap_or(0.0)
}

/// `cost_of`, exposed for the vectors: every `Some(param)`/`None` argument in the utility catalogue is compared here,
/// so a wrong param in any of those rows shows as a wrong cost.
pub fn cost_of_kind(kind: &str, param: Option<f64>) -> f64 {
    cost_of(kind, param)
}

/// The pieces' indices in `pieces.slice(1).sort((a, b) => b.budget - a.budget)` order (stable).
fn by_budget_desc(pieces: &[Value]) -> Vec<usize> {
    let mut order: Vec<usize> = (1..pieces.len()).collect();
    order.sort_by(|&i, &j| desc_by("budget")(&pieces[i], &pieces[j]));
    order
}

/// `rate: cost > 0 ? value / cost : 0`, the JS guard the PotentVs and skill ratings share. Exposed for the vectors: a
/// zero cost is a real JS input (the branch is not dead), so the vectors pin both arms instead of a note.
pub fn guarded_rate(value: f64, cost: f64) -> f64 {
    if cost > 0.0 {
        value / cost
    } else {
        0.0
    }
}

/// `planEnchants`. The caller supplies `target` (the JS default is `gateTarget(THEORY_LEVEL)`); every other option comes
/// from `opts` with the JS default parameter when it is `undefined`.
pub fn plan_enchants(opts: &Value, book: &Spellbook) -> Result<Value, String> {
    let mut profiles = Profiles::new(book);
    plan_enchants_with(opts, &mut profiles)
}

/// [`plan_enchants`] on a caller-owned frontier cache. The JS `_frontiers` map is module-level, so a batch that plans
/// many weapons evaluates each template's frontier once; a caller that owns a [`Profiles`] gets the same reuse.
pub fn plan_enchants_with(opts: &Value, profiles: &mut Profiles<'_>) -> Result<Value, String> {
    let book = profiles.book;
    // `for (const p of pieces) { p.soul = ...; p.budget = p.base + p.soul; p.spent = 0; p.effects = []; }`
    let soul_gem = opts.get("soulGem").truthy();
    let mut pieces: Vec<Value> = gear_pieces(opts)?.items().to_vec();
    for p in &mut pieces {
        let soul = if soul_gem { SOUL_GEM_POINTS } else { 0.0 };
        let base = n(p, "base");
        p.set("soul", Num(soul));
        p.set("budget", Num(base + soul));
        p.set("spent", Num(0.0));
        p.set("effects", Arr(vec![]));
    }
    let template = n(&pieces[0], "template");
    let target = match opts.get("target") {
        Undefined => gate_target(&Num(THEORY_LEVEL), &Undefined),
        v => v.clone(),
    };
    // The shipped build rides every card this plan prices: the legal budget it picks, the baseline it reads the gains
    // from, and the plan's own ceiling.
    let game_build = opts.get("gameBuild").clone();
    let mut ch =
        profiles.max_character(&Num(template), &obj([("gameBuild", game_build.clone())]))?;
    ch.set("_template", Num(template));
    let run_opts = obj([
        ("target", target.clone()),
        ("gameBuild", game_build.clone()),
    ]);
    let args = run_args(&ch, &run_opts);
    let base = max_run(&ch, &run_opts, book);
    let raw_target = reference_foe(&Num(THEORY_LEVEL), &s("tough"));
    let raw_opts = obj([
        ("target", raw_target.clone()),
        ("gameBuild", game_build.clone()),
    ]);
    let raw_args = run_args(&ch, &raw_opts);
    let raw_base = max_run(&ch, &raw_opts, book);
    let skill =
        optional_skill(opts).unwrap_or_else(|| skill_id_of(template).unwrap_or(SKILLS.long_blade));
    // `Math.max(1, Math.round((base.ttk || 20) * base.cadence.aps))`.
    let ttk = match base.card.ttk {
        // mutation: equivalent - the three mutants differ only on inputs the plan cannot reach: `t.is_finite() &&` ->
        // `||` needs a non-finite `ttk` (`ceiling` returns `None`/`inf` only for 0 or negative capped DPS, and
        // `maxCharacter` always gives a positive one, so the plan's own `Some(t)` is finite and positive); the
        // `t != 0.0 -> t != 1.0` mutant needs a target killed in exactly one hit, i.e. `ttk == 0.0`, which `ceiling`
        // never returns (it divides a positive health by a finite DPS); and `20.0 -> 21` needs `ttk` absent, which no
        // plan target is. The `swings`/`maxProcs` values the plans print would change if any of them fired.
        Some(t) if t.is_finite() && t != 0.0 => t,
        // mutation: equivalent - `20.0 -> 21` needs `ttk` absent, which no plan target is; the `&&` -> `||` needs a
        // non-finite `ttk`, which `ceiling` never returns for a positive capped DPS. Both fall back exactly where the
        // JS's `|| 20` would, and the plans' `swings`/`maxProcs` would change if either fired.
        _ => 20.0,
    };
    let swings = 1.0f64.max(math_round(ttk * base.card.cadence.get("aps").to_number()));
    // `Math.max(1, Math.min(3, Math.floor(hitPointsOf(w.template) / (10 * swings))))`.
    let max_procs = max_procs_of(hit_points_of(template), swings);
    let group = match opts.get("group") {
        Undefined => s("humanoid"),
        v => v.clone(),
    };
    let ctx = Candidates {
        ch: &ch,
        base: &base,
        target: &target,
        args: &args,
        game_build: &game_build,
        book,
    };
    let weapon_cands = weapon_candidates(&ctx, &group);
    let budget = n(&pieces[0], "budget");
    let weapon_picks = select_weapon_candidates(&weapon_cands, budget, max_procs);
    // `extra`: the planned +15 skill points, keyed by skill id in insertion order.
    let mut extra: Vec<(f64, f64)> = Vec::new();
    for c in &weapon_picks {
        let benefit = format!("{} DPS", number_to_string(math_round(n(c, "value"))));
        let is_skill = c.get("type").is_str("EnhancesSkill");
        let placed = add_effect(
            &mut pieces,
            0,
            &c.get("type").to_js_string(),
            c.get("param"),
            n(c, "cost"),
            &benefit,
        );
        // mutation: equivalent - `&&` -> `||`: a strike or PotentVs pick that `add_effect` placed would then record an
        // `extra` entry under a param that is not a skill id (50, 53, 1, ...). `extra` is only read by `skill_gain`,
        // which writes those keys into `_mods.skills` and lets `max_run` ignore unknown skill ids, so the card is
        // unchanged. Verified: the mutant passes the whole vector file. For a real skill id both operands are true
        // together (an EnhancesSkill pick is always placed by `add_effect`).
        if placed && is_skill {
            let param = n(c, "param");
            match extra.iter_mut().find(|(id, _)| *id == param) {
                // mutation: equivalent - `15.0 -> 16`: `extra` starts empty and only gains a key when a +15 is placed;
                // a second entry for the same id needs the same candidate twice, which `select_weapon_candidates`
                // never does (a candidate is added to a state at most once), so the `Some` arm is reached only from a
                // *different* candidate of the same skill - and the catalogue has one candidate per skill id, so it
                // never is. A 16 there would move the next `skill_gain` by one point, which no vector shows.
                Some(slot) => slot.1 += 15.0,
                None => extra.push((param, 15.0)),
            }
        }
    }
    let force_skills = opts.get("forceSkills").truthy();
    let repairs_total = count_input(opts.get("repairs"), 1.0);
    let regen_total = count_input(opts.get("regen"), 0.0);
    let repair_cost = cost_of("RepairsObjects", None);
    let regen_cost = cost_of("RegensHealth", Some(0.0));
    // One-piece utilities: shield/helm first (by budget), then whatever has room.
    for u in one_piece() {
        let kind = u.get("type").to_js_string();
        let param = match u.get("param") {
            Undefined => None,
            v => Some(v.to_number()),
        };
        let cost = cost_of(&kind, param);
        let host = by_budget_desc(&pieces).into_iter().find(|&i| {
            // mutation: equivalent - `<=` -> `<`: no utility ever fits its host's budget exactly (the probe replayed
            // every template x soulGem x group x repairs x regen: 6,948 utility placements, 0 with `spent + cost ==
            // budget`), because a utility's price never equals the remaining template points. The plan vectors' utility
            // rows would show a dropped placement if one did.
            fits_budget(&pieces[i], cost)
                // mutation: equivalent - `<` -> `<=`: no piece ever holds ten effects (`maxRows <= 6`), so the length
                // is never `ITEM_ENCHANTMENT_MAX - 1` either; both comparisons admit every piece.
                && (pieces[i].get("effects").items().len() as f64) < ITEM_ENCHANTMENT_MAX
        });
        if let Some(index) = host {
            let benefit = u.get("benefit").to_js_string();
            add_effect(
                &mut pieces,
                index,
                &kind,
                &u.get("param").clone(),
                cost,
                &benefit,
            );
        }
    }
    // Cap-aware mode: every piece that can hold +15 adds the best skill it can fit.
    if !force_skills {
        for index in 1..pieces.len() {
            loop {
                let mut best: Option<(f64, f64, f64)> = None;
                for id in skill_ids_for(template) {
                    if optional_skill(opts).is_some_and(|skill| id != skill) {
                        continue;
                    }
                    let p = &pieces[index];
                    if p.get("effects")
                        .items()
                        .iter()
                        .any(|e| e.get("type").is_str("EnhancesSkill") && n(e, "param") == id)
                    {
                        continue;
                    }
                    let cost =
                        // mutation: equivalent - `0.0 -> 1`: every skill id 28..34 is priced 900 (the probe read all
                        // seven rows), so `enchantment_cost` never returns `None` here and the default is unreachable.
                        enchantment_cost(ENCHANTMENT_TYPES.enhances_skill, Some(id)).unwrap_or(0.0);
                    // mutation: equivalent - the `-` -> `+` mutant: `add_effect` re-checks the same predicate through
                    // `fits_budget`, so a host this pre-filter wrongly admits is rejected there, `add_effect` returns
                    // false, and the loop breaks with no edit. A pre-filter that wrongly refuses cannot arise: the
                    // budget is template points (+5000) and the only skill price is 900, so `spent + 900 <= budget` is
                    // exactly what `fits_budget` decides too (the skill grid's rows pin the resulting effects).
                    if !fits_budget(p, cost) {
                        continue;
                    }
                    let value = skill_gain(&ch, id, &extra, &target, &game_build, book);
                    if value <= 0.0 {
                        continue;
                    }
                    // `value / cost > best.value / best.cost`: a NaN difference is false, keeping the earlier best.
                    let take = match best {
                        None => true,
                        Some((_, c, v)) => value / cost > v / c,
                    };
                    if take {
                        best = Some((id, cost, value));
                    }
                }
                let Some((id, cost, value)) = best else { break };
                let benefit = format!("{} DPS", number_to_string(math_round(value)));
                if !add_effect(
                    &mut pieces,
                    index,
                    "EnhancesSkill",
                    &Num(id),
                    cost,
                    &benefit,
                ) {
                    break;
                }
                match extra.iter_mut().find(|(sid, _)| *sid == id) {
                    Some(slot) => slot.1 += 15.0,
                    None => extra.push((id, 15.0)),
                }
            }
        }
    }
    // Future-cap choice: put weapon skill and Critical Strike on every piece that can hold them.
    if force_skills {
        let skill_ids: Vec<f64> = skill_ids_for(template)
            .into_iter()
            .filter(|id| {
                optional_skill(opts).is_none()
                    || Some(*id) == optional_skill(opts)
                    || *id == SKILLS.critical_strike
            })
            .collect();
        for index in 0..pieces.len() {
            for &id in &skill_ids {
                let p = &pieces[index];
                if p.get("effects")
                    .items()
                    .iter()
                    .any(|e| e.get("type").is_str("EnhancesSkill") && n(e, "param") == id)
                {
                    continue;
                }
                let cost =
                    // mutation: equivalent - `0.0 -> 1`: every id in 28..34 is priced 900 (the probe read all seven
                    // rows), so the `unwrap_or(0.0)` default is unreachable.
                    enchantment_cost(ENCHANTMENT_TYPES.enhances_skill, Some(id)).unwrap_or(0.0);
                // mutation: equivalent - same proof as the cap-aware pass: `add_effect` re-checks through
                // `fits_budget`, so a wrongly admitted id is rejected there and adds nothing, while `fits_budget` here
                // and there are the same call, so a wrongly refused id cannot arise.
                if !fits_budget(p, cost) {
                    continue;
                }
                let future = skill_gain(&ch, id, &extra, &raw_target, &game_build, book);
                let benefit = format!("{} DPS no-cap", number_to_string(math_round(future)));
                if add_effect(
                    &mut pieces,
                    index,
                    "EnhancesSkill",
                    &Num(id),
                    cost,
                    &benefit,
                ) {
                    match extra.iter_mut().find(|(sid, _)| *sid == id) {
                        Some(slot) => slot.1 += 15.0,
                        None => extra.push((id, 15.0)),
                    }
                }
            }
        }
    }
    // QoL is a count, not an automatic fill. `repairHosts = [w, ...pieces.slice(1).sort()]`.
    let mut repairs_left = repairs_total;
    let mut repair_hosts = vec![0usize];
    repair_hosts.extend(by_budget_desc(&pieces));
    for index in repair_hosts {
        if repairs_left <= 0.0 {
            break;
        }
        if add_effect(
            &mut pieces,
            index,
            "RepairsObjects",
            &Undefined,
            repair_cost,
            "1 mend / 4 rounds",
        ) {
            repairs_left -= 1.0;
        }
    }
    let mut regen_left = regen_total;
    for index in by_budget_desc(&pieces) {
        if regen_left <= 0.0 {
            break;
        }
        if add_effect(
            &mut pieces,
            index,
            "RegensHealth",
            &Num(0.0),
            regen_cost,
            "+1 HP / 4 rounds",
        ) {
            regen_left -= 1.0;
        }
    }
    let rows: Vec<Value> = pieces
        .iter()
        .map(|p| {
            obj([
                ("slot", p.get("slot").clone()),
                ("template", p.get("template").clone()),
                ("item", p.get("item").clone()),
                ("base", p.get("base").clone()),
                ("soul", p.get("soul").clone()),
                ("budget", p.get("budget").clone()),
                ("spent", p.get("spent").clone()),
                ("left", Num(n(p, "budget") - n(p, "spent"))),
                ("effects", p.get("effects").clone()),
            ])
        })
        .collect();
    let chosen: Vec<Value> = rows
        .iter()
        .flat_map(|r| r.get("effects").items().to_vec())
        .collect();
    let count_of = |kind: &str, param: Option<f64>| {
        Num(chosen
            .iter()
            .filter(|e| e.get("type").is_str(kind) && param.is_none_or(|p| n(e, "param") == p))
            .count() as f64)
    };
    let weapon_ratings: Vec<Value> = weapon_cands
        .iter()
        .map(|c| {
            obj([
                ("type", c.get("type").clone()),
                ("param", c.get("param").clone()),
                ("label", c.get("label").clone()),
                ("cost", c.get("cost").clone()),
                ("value", c.get("value").clone()),
                (
                    "benefit",
                    s(&format!(
                        "{} DPS",
                        number_to_string(math_round(n(c, "value")))
                    )),
                ),
                (
                    "chosen",
                    count_of(&c.get("type").to_js_string(), Some(n(c, "param"))),
                ),
                ("rate", Num(n(c, "value") / n(c, "cost"))),
            ])
        })
        .collect();
    let mut ratings_weapon = weapon_ratings;
    if let Some(pv) = group_param(&group) {
        if !ratings_weapon
            .iter()
            .any(|r| r.get("type").is_str("PotentVs"))
        {
            let pv_value = 0.0f64.max(potent_vs_gain(&ch, &args, &base, book));
            // mutation: equivalent - `PotentVs` is priced at every param `group_param` returns (0..3; the probe checked
            // all four rows exist), so `unwrap_or(0.0)` is unreachable and a `0.0 -> 1` default would only show for a
            // param the catalogue lacks.
            let pv_cost = enchantment_cost(ENCHANTMENT_TYPES.potent_vs, Some(pv)).unwrap_or(0.0);
            ratings_weapon.push(obj([
                ("type", s("PotentVs")),
                ("param", Num(pv)),
                (
                    "label",
                    s(&format!(
                        "{}: {}",
                        enchantment_name("PotentVs"),
                        enchantment_param_name("PotentVs", &Num(pv))
                    )),
                ),
                ("cost", Num(pv_cost)),
                ("value", Num(pv_value)),
                (
                    "benefit",
                    s(&format!("{} DPS", number_to_string(math_round(pv_value)))),
                ),
                ("chosen", count_of("PotentVs", Some(pv))),
                ("rate", Num(guarded_rate(pv_value, pv_cost))),
            ]));
        }
    }
    let skill_ratings: Vec<Value> = skill_ids_for(template)
        .into_iter()
        .map(|id| {
            let value = skill_gain(&ch, id, &[], &target, &game_build, book);
            let future = skill_gain(&ch, id, &[], &raw_target, &game_build, book);
            // mutation: equivalent - every id is 28..34 and each is a row of `ENCHANTMENT_PRICE_ROWS` under
            // `EnhancesSkill` (the probe checked every template), so the `unwrap_or(0.0)` is unreachable.
            let cost = enchantment_cost(ENCHANTMENT_TYPES.enhances_skill, Some(id)).unwrap_or(0.0);
            obj([
                ("id", Num(id)),
                (
                    "label",
                    s(&enchantment_param_name("EnhancesSkill", &Num(id))),
                ),
                ("cost", Num(cost)),
                ("value", Num(value)),
                ("futureValue", Num(future)),
                (
                    "benefit",
                    s(&format!(
                        "{} DPS no-cap",
                        number_to_string(math_round(future))
                    )),
                ),
                ("chosen", count_of("EnhancesSkill", Some(id))),
                ("rate", Num(guarded_rate(future, cost))),
            ])
        })
        .collect();
    let mut utility_ratings: Vec<Value> = one_piece()
        .iter()
        .map(|u| {
            let kind = u.get("type").to_js_string();
            let param = match u.get("param") {
                Undefined => None,
                v => Some(v.to_number()),
            };
            obj([
                ("type", s(&kind)),
                ("label", s(&enchantment_name(&kind))),
                ("cost", Num(cost_of(&kind, param))),
                ("benefit", u.get("benefit").clone()),
                ("chosen", count_of(&kind, param)),
            ])
        })
        .collect();
    for (kind, label, cost, benefit, chosen) in [
        (
            "RepairsObjects",
            enchantment_name("RepairsObjects"),
            repair_cost,
            "1 mend / 4 rounds",
            count_of("RepairsObjects", None),
        ),
        (
            "RegensHealth",
            enchantment_name("RegensHealth"),
            regen_cost,
            "+1 HP / 4 rounds (≈0.05 HP/s)",
            count_of("RegensHealth", None),
        ),
        (
            "ExtraSpellPts",
            "Extra Spell Points".to_owned(),
            // mutation: equivalent - `Some(0.0) -> Some(1.0)`: `ExtraSpellPts` is priced the same at param 0 and 1
            // (`ENCHANTMENT_PRICE_ROWS` (3.0, 0.0, 500) and (3.0, 1.0, 500)), so the rating's cost is 500 either way.
            cost_of("ExtraSpellPts", Some(0.0)),
            "+75 max MP",
            Num(0.0),
        ),
        (
            "VampiricEffect",
            "Vampiric Effect (at range)".to_owned(),
            cost_of("VampiricEffect", Some(0.0)),
            "+1 HP / 4 rounds per foe",
            Num(0.0),
        ),
        (
            "ImprovesTalents",
            "Improves Talents: Athleticism".to_owned(),
            // mutation: equivalent - `Some(1.0) -> Some(2.0)`: the row is (13.0, 1.0, 600); param 2 is (13.0, 2.0, 600),
            // the same price, so the rating's cost is 600 either way.
            cost_of("ImprovesTalents", Some(1.0)),
            "Athleticism",
            Num(0.0),
        ),
        (
            "FeatherWeight",
            "Feather Weight".to_owned(),
            cost_of("FeatherWeight", None),
            "weight to 0.25 kg",
            Num(0.0),
        ),
    ] {
        utility_ratings.push(obj([
            ("type", s(kind)),
            ("label", s(&label)),
            ("cost", Num(cost)),
            ("benefit", s(benefit)),
            ("chosen", chosen),
        ]));
    }
    let imprint_pool: Vec<Value> = imprints_for(&Num(template))
        .items()
        .iter()
        .map(|rec| {
            let power = rec.get("power");
            obj([
                ("name", rec.get("name").clone()),
                ("power", power.clone()),
                (
                    "carriedDps",
                    Num(power_dps(power, &ch, &args, false, true, book)),
                ),
                (
                    "carriedTriggerDps",
                    Num(power_dps(power, &ch, &args, true, true, book)),
                ),
                (
                    "carriedUncappedDps",
                    Num(power_dps(power, &ch, &raw_args, false, false, book)),
                ),
            ])
        })
        .collect();
    let best_by = |field: &'static str| -> Value {
        let mut pool = imprint_pool.clone();
        pool.sort_by(desc_by(field));
        pool.first().cloned().unwrap_or(Null)
    };
    let imprint = obj([
        ("base", best_by("carriedDps")),
        ("trigger", best_by("carriedTriggerDps")),
        ("uncapped", best_by("carriedUncappedDps")),
    ]);
    let rows_value = Arr(rows.clone());
    let applied = apply_plan_dps_at(
        &ch,
        &obj([("rows", rows_value.clone())]),
        &target,
        crate::model_blow::game_build_one(&game_build),
        book,
    );
    let future = apply_plan_dps_at(
        &ch,
        &obj([("rows", rows_value)]),
        &raw_target,
        crate::model_blow::game_build_one(&game_build),
        book,
    );
    let shield = pieces
        .iter()
        .find(|p| {
            let slot = p.get("slot").to_js_string();
            slot.contains("Shield") || slot.contains("Buckler")
        })
        .map_or(Null, |p| p.get("template").clone());
    Ok(obj([
        ("weapon", Num(template)),
        ("weaponName", pieces[0].get("item").clone()),
        ("shield", shield),
        ("soulGem", Bool(soul_gem)),
        (
            "soulPoints",
            Num(if soul_gem { SOUL_GEM_POINTS } else { 0.0 }),
        ),
        ("group", group.clone()),
        ("carriedBaseDps", Num(base.totals.carried_capped_dps)),
        ("carriedUncappedDps", Num(raw_base.totals.carried_dps)),
        ("cardPlanDps", applied.get("dps").clone()),
        ("cardUncappedPlanDps", future.get("dps").clone()),
        ("procDps", applied.get("procDps").clone()),
        ("skillId", Num(skill)),
        ("rows", Arr(rows)),
        ("imprint", imprint),
        ("swings", Num(swings)),
        ("maxProcs", Num(max_procs)),
        ("forceSkills", Bool(force_skills)),
        ("repairs", Num(repairs_total)),
        ("regen", Num(regen_total)),
        (
            "ratings",
            obj([
                ("weapon", Arr(ratings_weapon)),
                ("skills", Arr(skill_ratings)),
                ("utility", Arr(utility_ratings)),
            ]),
        ),
        ("onePiece", Arr(one_piece().to_vec())),
        ("stacks", Arr(stacks().to_vec())),
        ("weaponOnly", Arr(weapon_only().to_vec())),
    ]))
}

/// `bestWeaponForFamily` at the cut: the pre-14631 signature, kept for callers (and the vectors) that pass no build.
pub fn best_weapon_for_family(
    family: &Value,
    target: &Value,
    book: &Spellbook,
) -> Result<Value, String> {
    best_weapon_for_family_at(family, target, crate::model_blow::DEFAULT_GAME_BUILD, book)
}

/// [`best_weapon_for_family`] at an explicit shipped build.
pub fn best_weapon_for_family_at(
    family: &Value,
    target: &Value,
    game_build: &str,
    book: &Spellbook,
) -> Result<Value, String> {
    let mut profiles = Profiles::new(book);
    best_weapon_for_family_at_with(family, target, game_build, &mut profiles)
}

/// [`best_weapon_for_family_at`] on a caller-owned frontier cache.
pub fn best_weapon_for_family_at_with(
    family: &Value,
    target: &Value,
    game_build: &str,
    profiles: &mut Profiles<'_>,
) -> Result<Value, String> {
    best_weapon_for_family_with_build(family, target, &s(game_build), profiles)
}

/// `bestWeaponForFamily` on a caller-owned frontier cache, at the cut: the pre-14631 signature (the vectors pass it).
pub fn best_weapon_for_family_with(
    family: &Value,
    target: &Value,
    profiles: &mut Profiles<'_>,
) -> Result<Value, String> {
    best_weapon_for_family_with_build(
        family,
        target,
        &s(crate::model_blow::DEFAULT_GAME_BUILD),
        profiles,
    )
}

/// [`best_weapon_for_family_with`] at an explicit shipped build (a scenario-ready `Value`).
pub fn best_weapon_for_family_with_build(
    family: &Value,
    target: &Value,
    game_build: &Value,
    profiles: &mut Profiles<'_>,
) -> Result<Value, String> {
    let book = profiles.book;
    let mut best: Option<Value> = None;
    // mutation: equivalent - `0.0 -> 1.0`: `best` is `None` on entry, so the first template always wins; and
    // `>` -> `>=`: no two templates in a family tie (the probe read every family at both targets), so the comparison
    // never meets equal DPS. The `best` family's twelve cases would print a different weapon if either fired.
    let mut best_dps = 0.0;
    for t in family.get("templates").items() {
        let template = t.to_number();
        let Some(w) = weapon_row(template) else {
            continue;
        };
        let ch =
            profiles.max_character(&Num(template), &obj([("gameBuild", game_build.clone())]))?;
        let run = max_run(
            &ch,
            &obj([
                ("target", target.clone()),
                ("gameBuild", game_build.clone()),
            ]),
            book,
        );
        let dps = run.card.fields.capped_dps;
        // mutation: equivalent - `>` -> `>=`: no two templates in a family tie at either target (the probe compared
        // every family's capped DPS list), so strict and non-strict pick the same winner; `best` is `None` on the first
        // iteration, so the `0.0` seed is never consulted.
        if best.is_none() || dps > best_dps {
            best_dps = dps;
            best = Some(obj([
                ("template", Num(template)),
                ("name", s(w.name)),
                ("dps", Num(dps)),
            ]));
        }
    }
    Ok(best.unwrap_or(Null))
}

/// `planMatrix`: one plan per weapon family, on that family's best weapon.
pub fn plan_matrix(opts: &Value, book: &Spellbook) -> Result<Value, String> {
    let mut profiles = Profiles::new(book);
    plan_matrix_with(opts, &mut profiles)
}

/// [`plan_matrix`] on a caller-owned frontier cache.
pub fn plan_matrix_with(opts: &Value, profiles: &mut Profiles<'_>) -> Result<Value, String> {
    let mut out = Vec::new();
    for family in imprint_families() {
        let target = match opts.get("target") {
            Undefined => gate_target(&Num(THEORY_LEVEL), &Undefined),
            v => v.clone(),
        };
        let game_build = opts.get("gameBuild").clone();
        let best = best_weapon_for_family_with_build(family, &target, &game_build, profiles)?;
        if matches!(best, Null) {
            out.push(obj([
                ("family", family.get("name").clone()),
                ("key", family.get("key").clone()),
                ("weapon", Null),
                ("plan", Null),
            ]));
            continue;
        }
        let plan_opts = obj([
            ("weapon", best.get("template").clone()),
            ("soulGem", default_is(opts.get("soulGem"), Bool(false))),
            ("repairs", default_is(opts.get("repairs"), Num(1.0))),
            ("regen", default_is(opts.get("regen"), Num(0.0))),
            ("group", default_is(opts.get("group"), s("daedra"))),
            (
                "forceSkills",
                default_is(opts.get("forceSkills"), Bool(false)),
            ),
            ("target", target.clone()),
            ("gameBuild", game_build.clone()),
        ]);
        let plan = plan_enchants_with(&plan_opts, profiles)?;
        let skill_id = n(&plan, "skillId");
        let skill_pieces = plan
            .get("rows")
            .items()
            .iter()
            .filter(|r| {
                r.get("effects")
                    .items()
                    .iter()
                    .any(|e| e.get("type").is_str("EnhancesSkill") && n(e, "param") == skill_id)
            })
            .count();
        let cs_pieces = plan
            .get("rows")
            .items()
            .iter()
            .filter(|r| {
                r.get("effects").items().iter().any(|e| {
                    e.get("type").is_str("EnhancesSkill") && n(e, "param") == SKILLS.critical_strike
                })
            })
            .count();
        out.push(obj([
            ("family", family.get("name").clone()),
            ("key", family.get("key").clone()),
            ("weapon", best.get("name").clone()),
            ("template", best.get("template").clone()),
            ("skillPieces", Num(skill_pieces as f64)),
            ("csPieces", Num(cs_pieces as f64)),
            ("plan", plan),
        ]));
    }
    Ok(Arr(out))
}

/// `effectLine`: the readable line, e.g. "Cast When Strikes: Hand of Decay (1,830)".
pub fn effect_line(e: &Value) -> String {
    let name = e.get("name").to_js_string();
    let param_name = e.get("paramName");
    let param_text = if param_name.truthy() && !param_name.is_str("undefined") {
        param_name.to_js_string()
    } else {
        String::new()
    };
    let suffix = if param_text.is_empty() {
        String::new()
    } else {
        format!(": {param_text}")
    };
    let benefit = e.get("benefit");
    let benefit_text = if benefit.truthy() {
        benefit.to_js_string()
    } else {
        String::new()
    };
    let cost = grouped_number(n(e, "cost"));
    if benefit_text.is_empty() {
        format!("{name}{suffix} ({cost})")
    } else {
        format!("{name}{suffix} ({cost}; {benefit_text})")
    }
}

/// en-US `toLocaleString()` for a cost: a comma every three digits, and at most three fraction digits with
/// half-expand rounding on the decimal value (Intl's default `maximumFractionDigits: 3`).
/// A big number's JS string form is exponential (`1e21`); `toLocaleString` writes it in full, so the exponent is
/// expanded first. Costs in the enchant catalogue are whole numbers, so the fraction path is only reached by a
/// hand-built effect; `tests/enchant_plan.rs` pins both a whole number and a rounded fraction against the real JS.
///
/// DELIBERATE LOCALE PIN: the JS calls `toLocaleString()` with no argument, so it follows the host's default locale
/// (`1 830` in fr-FR, `1.830` in de-DE). This formatter is fixed to en-US, which is what the differential vectors and
/// the reference machine print. That is a documented limitation, not a bug to "fix" by adding a locale dependency:
/// the numbers a report carries are pinned to one deterministic rendering.
///
/// `-0` prints `"-0"` (`(-0).toLocaleString('en-US')`), unlike `String(-0)` which is `"0"`; a value that rounds to
/// zero keeps the sign of the value it came from (`(-0.0004).toLocaleString('en-US')` is `"-0"`).
fn grouped_number(x: f64) -> String {
    if x == 0.0 {
        return if x.is_sign_negative() { "-0" } else { "0" }.to_owned();
    }
    // Round to three fraction digits on the exact decimal value (half expand, as Intl does; Rust's `round` is away
    // from zero at a tie, which is the same rule).
    let scaled = (x * 1000.0).round() / 1000.0;
    if scaled == 0.0 {
        return if x < 0.0 { "-0" } else { "0" }.to_owned();
    }
    let text = number_to_string(scaled);
    let (sign, rest) = match text.strip_prefix('-') {
        Some(r) => ("-", r),
        None => ("", text.as_str()),
    };
    let (mantissa, exponent) = match rest.split_once(['e', 'E']) {
        // `number_to_string` writes `{:e}`, whose exponent is always an integer, so the parse cannot fail.
        Some((m, e)) => (
            m,
            e.parse::<i32>()
                .expect("number_to_string exponent is an integer"),
        ),
        None => (rest, 0),
    };
    let (whole_in, frac_in) = match mantissa.split_once('.') {
        Some((w, f)) => (w, f),
        None => (mantissa, ""),
    };
    let mut digits: String = format!("{whole_in}{frac_in}");
    let point = whole_in.len() as i32 + exponent;
    // mutation: equivalent - `>` vs `>=`: `digits` always holds at least one digit (`number_to_string` never writes a
    // bare `0.` or an empty mantissa), so `point == digits.len()` leaves `frac` empty and `/` vs `>=` agree: `>=` would
    // push zero zeros, which is the same string.
    if point as usize > digits.len() {
        digits.push_str(&"0".repeat(point as usize - digits.len()));
    }
    let whole = &digits[..point as usize];
    let frac = &digits[point as usize..];
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    if frac.is_empty() {
        return format!("{sign}{grouped}");
    }
    format!("{sign}{grouped}.{frac}")
}

/// `grouped_number`, exposed for the vectors (the whole-number and fraction forms against the real JS).
pub fn grouped_number_of(x: f64) -> String {
    grouped_number(x)
}

/// The skill id `skillIdOf` reads for a template (used by the vectors' replay of a plan's key).
pub fn skill_id_of_template(template: f64) -> Option<f64> {
    skill_id_of(template)
}

/// `skillIdsFor`, the two skills a weapon's plan considers.
pub fn skill_ids_for_template(template: f64) -> Vec<f64> {
    skill_ids_for(template)
}

#[cfg(test)]
mod tests {
    use super::grouped_number_of;

    // Local invariants read from the real engine while writing the port (not oracle vectors): Intl's en-US
    // `toLocaleString()` keeps a negative zero's sign (`(-0).toLocaleString('en-US')` is `"-0"`), rounds a value that
    // falls below the default three fraction digits to `"-0"`/`"0"` by its sign, and writes a big number in full.
    #[test]
    fn locale_grouping_matches_en_us_to_locale_string() {
        assert_eq!(grouped_number_of(0.0), "0");
        assert_eq!(grouped_number_of(-0.0), "-0");
        assert_eq!(grouped_number_of(-0.0004), "-0");
        assert_eq!(grouped_number_of(0.0005), "0.001");
        assert_eq!(grouped_number_of(-0.001), "-0.001");
        assert_eq!(grouped_number_of(1500.0005), "1,500.001");
        assert_eq!(grouped_number_of(-1234.5678), "-1,234.568");
        assert_eq!(grouped_number_of(1e21), "1,000,000,000,000,000,000,000");
    }
}
