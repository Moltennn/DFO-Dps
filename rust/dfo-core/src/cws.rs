//! Cast When Strikes (`src/cws.js`). The target and the hurt sink are fight-local.
#![allow(clippy::neg_cmp_op_on_partial_ord)] // The JS negated guards also reject NaN.
use crate::durability::dice100;
use crate::enchants::{enchantment_rows, payload_rows, ENCHANTMENT_TYPES};
use crate::gear_lines::valid_item_lines;
use crate::generated::{
    data::SKILLS,
    loot_powers::{POTENCY_CAP, SPELL_POWER_MOST},
    paperdoll::EQUIP_SLOTS,
};
use crate::loot::{counted_pieces, power_ids_of, power_of};
use crate::rolls::Rolls;
use crate::round::{js_max, js_min, math_round, to_int32};
use crate::spells::{
    effect_cost, effect_school, fighting_climb, object, saving_chance_outcome, spell_rounds,
    Spellbook, CAST_COST_FLOOR, TARGET_COST_MULT,
};
use crate::target::{ELEMENT_FLAG_BY_INDEX, MAGIC};
use crate::value::{
    obj_table_get, Value,
    Value::{Arr, Bool, Null, Num, Obj, Str},
};

fn number(v: &Value, key: &str, default: f64) -> f64 {
    let v = v.get(key);
    if v.is_nullish() {
        default
    } else {
        v.to_number()
    }
}

fn integer(v: &Value) -> Option<f64> {
    match v {
        Num(n) if n.is_finite() && n.trunc() == *n => Some(*n),
        _ => None,
    }
}

fn effects(target: &Value) -> &[Value] {
    target.get("activeEffects").items()
}

pub fn is_damage_health(e: &Value) -> bool {
    e.get("type").strict_eq(&Num(4.0)) && e.get("subType").strict_eq(&Num(0.0))
}

pub fn is_continuous_damage(e: &Value) -> bool {
    e.get("type").strict_eq(&Num(1.0)) && e.get("subType").strict_eq(&Num(0.0))
}

fn best_live_chance(target: &Value, kind: &str) -> f64 {
    let mut best = 0.0;
    for a in effects(target)
        .iter()
        .filter(|a| a.get("kind").is_str(kind) && !a.get("ended").truthy())
    {
        let chance = number(a, "chance", 0.0);
        // mutation: equivalent - replacing equal finite chances leaves the same number; ±0 both fail the positive-chance guard.
        if chance > best {
            best = chance;
        }
    }
    best
}

/// skills.js:199–225, without applying the report build's implicit player flag.
fn absorption_skill(target: &Value, skill: f64) -> f64 {
    let id = Num(skill);
    let fixed = target.get("skillOverrides").prop(&id);
    if !fixed.is_nullish() {
        return fixed.to_number();
    }
    let mods = |v: &Value| {
        let n = v.prop(&id);
        if n.is_nullish() {
            0.0
        } else {
            n.to_number()
        }
    };
    let mut bonus = mods(target.get("_enchantMods").get("skillMods"));
    for a in effects(target)
        .iter()
        .filter(|a| a.get("kind").is_str("racialOverride") && !a.get("ended").truthy())
    {
        bonus += mods(a.get("skillMods"));
    }
    bonus += mods(target.get("_mods").get("skills"));
    let raw = target.get("skills");
    let mut entity;
    let target = if matches!(raw, Num(_)) {
        entity = target.clone();
        entity.set("skills", Obj(vec![(id.to_js_string(), raw.clone())]));
        &entity
    } else {
        target
    };
    fighting_climb(target, &id).to_number() + bonus
}

/// The absorption.js call used by CWS: inside, not day, nothing paid; the lab has no registered sigils.
fn try_absorption(effect: &Value, range_type: f64, target: &Value, rolls: &mut impl Rolls) -> f64 {
    if effect_school(effect) != SKILLS.destruction {
        return 0.0;
    }
    let cost = effect_cost(effect, |id| absorption_skill(target, id), false).1;
    let cost = js_max(
        CAST_COST_FLOOR,
        (cost * obj_table_get(TARGET_COST_MULT, &Num(range_type)).unwrap_or(1.0)).trunc(),
    );
    let room = number(target, "maxMagicka", 0.0) - number(target, "magicka", 0.0);
    if cost > room {
        return 0.0;
    }
    let mut best = 0.0;
    for a in effects(target)
        .iter()
        .filter(|a| a.get("kind").is_str("spellAbsorption") && !a.get("ended").truthy())
    {
        let chance = if a.get("chanceBase").is_nullish() {
            number(a, "chance", 0.0)
        } else {
            // mutation: equivalent - this arm requires a non-nullish chanceBase, so its nullish fallback is not read.
            number(a, "chanceBase", 0.0)
                + number(a, "chanceMod", 0.0)
                    * (number(target, "level", 1.0) / js_max(1.0, number(a, "chancePerLevel", 1.0)))
                        .floor()
        };
        // mutation: equivalent - replacing a tied best chance cannot change the percentile decision, including ±0 (no draw).
        if chance > best {
            best = chance;
        }
    }
    let chance = js_min(50.0, best);
    let career = target.get("career").get("spellAbsorptionFlags");
    if (chance > 0.0 && dice100(chance, rolls.roll()))
        || career.strict_eq(&Num(2.0))
        || career.strict_eq(&Num(4.0))
        || (target.get("_enchantMods").get("absorbsSpells").truthy() && dice100(50.0, rolls.roll()))
    {
        cost
    } else {
        0.0
    }
}

pub fn roll_magnitude(effect: &Value, caster_level: f64, rolls: &mut impl Rolls) -> f64 {
    let mut range = |lo, hi| {
        let lo = number(effect, lo, 0.0);
        let hi = number(effect, hi, 0.0);
        lo + (rolls.roll() * (hi + 1.0 - lo)).floor()
    };
    let base = range("magnitudeBaseLow", "magnitudeBaseHigh");
    let plus = range("magnitudeLevelBase", "magnitudeLevelHigh");
    let per = js_max(1.0, number(effect, "magnitudePerLevel", 1.0));
    base + plus * (caster_level / per).floor()
}

pub fn saving_throw(
    element: f64,
    flag: f64,
    target: &Value,
    rolls: &mut impl Rolls,
    pierce: f64,
) -> f64 {
    let resist = effects(target)
        .iter()
        .filter(|a| {
            a.get("kind").is_str("elementalResistance")
                && a.get("element").strict_eq(&Num(element))
                && !a.get("ended").truthy()
        })
        .fold(0.0, |total, a| total + number(a, "chance", 0.0));
    if resist > 0.0 && dice100(resist, rolls.roll()) {
        return 0.0;
    }
    let (saving, immune) = saving_chance_outcome(
        target,
        &object([
            ("element", Num(element)),
            ("effectFlags", Num(flag)),
            ("pierce", Num(pierce)),
        ]),
    );
    if immune {
        return 0.0;
    }
    let roll = 1.0 + (rolls.roll() * 100.0).floor();
    // mutation: equivalent - at roll == saving the scaled arm and the unscaled arm both return exactly 100.
    let percent = if roll <= saving {
        // mutation: equivalent - at distance 20 the scaled arm returns zero; extending to 21 only introduces negative percentages clipped to zero below.
        if saving - 20.0 <= roll {
            100.0 - 5.0 * (saving - roll)
        } else {
            0.0
        }
    } else {
        // mutation: equivalent - returning 101 instead of 100 here is clipped to 100 by the final clamp.
        100.0
    };
    // mutation: equivalent - percent cannot exceed 100: the scaled arm subtracts a nonnegative amount and the other arms return 0 or 100.
    js_max(0.0, js_min(100.0, percent))
}

pub fn school_potency_for(caster: &Value, school: f64) -> f64 {
    if !caster.get("online").strict_eq(&Bool(true)) {
        return 1.0;
    }
    let mut player = caster.clone();
    player.set("isPlayer", Bool(true));
    player.set("_online", Bool(true));
    let climb = fighting_climb(&player, &Num(school)).to_number();
    // mutation: equivalent - at climb == 100 the scaled result is 1 + 0 * 0.01, the same as the fallback.
    if climb > 100.0 {
        1.0 + (climb - 100.0) * 0.01
    } else {
        1.0
    }
}

/// `live_accessor` supplies an already evaluated JS getter, if the record was built with one.
pub fn live_max_magicka(ch: &Value, live_accessor: Option<f64>) -> f64 {
    if let Some(live) = live_accessor {
        return live;
    }
    let base = ch.get("maxMagickaBase").finite_or(f64::NAN);
    if base.is_finite() {
        base + number(ch.get("_enchantMods"), "maxMagicka", 0.0)
    } else {
        number(ch, "maxMagicka", 0.0)
    }
}

fn slot(item: &Value) -> Option<f64> {
    integer(item.get("equipSlot"))
}

fn content(item: &Value) -> Value {
    let read = |item: &Value, k, fallback| {
        let v = item.get(k);
        match v {
            Num(n) if !n.is_finite() => Null,
            v if v.is_nullish() => fallback,
            v => v.clone(),
        }
    };
    let empty = || Str(String::new());
    let mut out: Vec<_> = [
        "group",
        "templateIndex",
        "name",
        "rarity",
        "legendary",
        "imprint",
    ]
    .into_iter()
    .map(|k| read(item, k, empty()))
    .collect();
    out.extend(
        ["material", "flags", "maxCondition", "currentCondition"]
            .into_iter()
            .map(|k| read(item, k, Num(0.0))),
    );
    for (key, fields) in [
        ("affixes", &["id", "param", "value", "gem"][..]),
        ("enchantments", &["type", "param"][..]),
    ] {
        out.push(Arr(item
            .get(key)
            .items()
            .iter()
            .map(|r| Arr(fields.iter().map(|k| read(r, k, empty())).collect()))
            .collect()));
    }
    Arr(out)
}

fn slot_sort(a: Option<f64>, b: Option<f64>) -> std::cmp::Ordering {
    a.unwrap_or(9_007_199_254_740_991.0)
        .partial_cmp(&b.unwrap_or(9_007_199_254_740_991.0))
        .expect("integer slots are finite")
}

/// `occupants` are the build's own main/off objects. Borrow entries from `ch.worn` when they share JS identity.
pub fn equip_table_for_fight(
    ch: &Value,
    weapons: [&Value; 2],
    occupants: [&Value; 2],
) -> Result<Vec<Value>, &'static str> {
    let worn = ch.get("worn");
    if !matches!(worn, Arr(_)) {
        if !ch.get("items").is_nullish() {
            return Err("simulateFight: the build has no equipped (`worn`) list; inventory items are not equipped gear");
        }
        return Ok(weapons
            .into_iter()
            .filter(|it| it.truthy())
            .cloned()
            .collect());
    }
    use std::borrow::Cow;
    let mut table: Vec<_> = worn
        .items()
        .iter()
        .filter(|it| it.truthy())
        .map(Cow::Borrowed)
        .collect();
    for ((item, occupant), hand) in weapons
        .into_iter()
        .zip(occupants)
        .zip([EQUIP_SLOTS.right_hand, EQUIP_SLOTS.left_hand])
    {
        if !item.truthy() {
            continue;
        }
        let at = table
            .iter()
            .position(|e| std::ptr::eq(e.as_ref(), occupant))
            .or_else(|| {
                slot(occupant).and_then(|wanted| table.iter().position(|e| slot(e) == Some(wanted)))
            })
            .or_else(|| table.iter().position(|e| slot(e) == Some(hand)))
            .or_else(|| {
                let mut hits = table
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| slot(e).is_none() && content(e) == content(item));
                let first = hits.next();
                if hits.next().is_none() {
                    first.map(|(i, _)| i)
                } else {
                    None
                }
            });
        let hand = at.and_then(|i| slot(&table[i])).unwrap_or(hand);
        let item = if slot(item) == Some(hand) {
            Cow::Borrowed(item)
        } else {
            let mut item = item.clone();
            item.set("equipSlot", Num(hand));
            Cow::Owned(item)
        };
        if let Some(i) = at {
            table[i] = item;
        } else {
            table.push(item);
        }
    }
    table.sort_by(|a, b| slot_sort(slot(a), slot(b)));
    Ok(table.into_iter().map(Cow::into_owned).collect())
}

pub fn equipped_for_fight(
    ch: &Value,
    weapons: [&Value; 2],
    occupants: [&Value; 2],
) -> Result<Vec<Value>, &'static str> {
    Ok(counted_pieces(&equip_table_for_fight(
        ch, weapons, occupants,
    )?))
}

pub fn spell_power_inputs(
    ch: &Value,
    opts: &Value,
    live_accessor: Option<f64>,
) -> Result<Value, &'static str> {
    let mut worn = opts.get("worn");
    if worn.is_nullish() {
        worn = ch.get("worn");
    }
    if worn.is_nullish() && !ch.get("items").is_nullish() {
        return Err("spellPowerInputs: the build has no equipped (`worn`) list; inventory items are not equipped gear");
    }
    if !worn.is_nullish() && !matches!(worn, Arr(_)) {
        return Err("spellPowerInputs: the equipped list must be an array");
    }
    let mut slotted = Vec::<(f64, Value)>::new();
    let mut loose = Vec::new();
    for it in worn.items().iter().filter(|it| it.truthy()) {
        if let Some(n) = slot(it) {
            if let Some((_, v)) = slotted.iter_mut().find(|(s, _)| n == *s) {
                *v = it.clone();
            } else {
                slotted.push((n, it.clone()));
            }
        } else {
            loose.push(it.clone());
        }
    }
    slotted.sort_by(|(a, _), (b, _)| slot_sort(Some(*a), Some(*b)));
    let list: Vec<_> = slotted.into_iter().map(|(_, v)| v).chain(loose).collect();
    let mut potency = 0.0;
    let (mut surge, mut pierce) = (Null, Null);
    let mut extra = false;
    let mut seen: Vec<Value> = Vec::new();
    for it in counted_pieces(&list) {
        for line in valid_item_lines(&it)
            .iter()
            .filter(|a| a.get("id").is_str("potency"))
        {
            potency += f64::from(to_int32(line.get("value").to_number()));
        }
        extra |= enchantment_rows(&it).any(|e| {
            e.get("type")
                .strict_eq(&Num(ENCHANTMENT_TYPES.extra_spell_pts))
        });
        for id in power_ids_of(&it) {
            if seen.iter().any(|p| p.same_value_zero(&id)) {
                continue;
            }
            let power = power_of(&id);
            seen.push(id);
            if surge.is_nullish() && power.get("kind").is_str("surge") {
                surge = power;
            // mutation: equivalent - vendored power_of has only one pierce id, eye-of-magnus; every non-pierce power lacks points, so temporarily assigning one under || neither contributes points nor prevents assigning the real one.
            } else if pierce.is_nullish() && power.get("kind").is_str("pierce") {
                pierce = power;
            }
        }
    }
    if !surge.is_nullish()
        && extra
        && live_accessor.is_none()
        && ch.get("maxMagickaBase").finite_or(f64::NAN).is_finite()
        && ch.get("_enchantMods").get("maxMagicka").is_nullish()
    {
        return Err("spellPowerInputs: a base `maxMagickaBase` with ExtraSpellPts requires ch._enchantMods.maxMagicka (the fold)");
    }
    potency = js_min(POTENCY_CAP, potency);
    let max = live_max_magicka(ch, live_accessor);
    let mana = ch.get("magicka").finite_or(f64::NAN);
    // mutation: equivalent - a non-null surge comes only from shalidors-brand; its above is always 75, not nullish.
    if !surge.is_nullish() && max > 0.0 && mana > max * number(&surge, "above", 0.0) / 100.0 {
        // mutation: equivalent - shalidors-brand is the sole surge and its pct is always 25; the fallback is never read.
        potency += number(&surge, "pct", 0.0);
    }
    Ok(object([
        (
            "potencyPct",
            Num(js_min(
                SPELL_POWER_MOST,
                potency + js_max(0.0, opts.get("potencyPct").num_or_default(0.0)),
            )),
        ),
        (
            "pierce",
            Num(js_max(0.0, opts.get("pierce").num_or_default(0.0))
                + number(&pierce, "points", 0.0)),
        ),
    ]))
}

pub fn cws_rows<'a>(item: &Value, book: &'a Spellbook) -> Vec<(f64, Option<&'a Value>)> {
    payload_rows(item)
        .filter(|e| {
            e.get("type")
                .strict_eq(&Num(ENCHANTMENT_TYPES.cast_when_strikes))
        })
        .map(|e| {
            let param = e.get("param").to_number();
            (param, book.get(&Num(param)))
        })
        .collect()
}

pub fn cws_eligible(
    target: &Value,
    strikes_positive: bool,
    whole: bool,
    item: &Value,
    book: &Spellbook,
) -> bool {
    target.truthy()
        && strikes_positive
        && !target.get("warded").truthy()
        && whole
        && !cws_rows(item, book).is_empty()
}

pub type Hurt<'a> = Option<&'a mut dyn FnMut(f64, Option<&Value>) -> bool>;

#[derive(Default)]
pub enum Caster<'a> {
    #[default]
    Absent,
    Entity(&'a Value),
    Target,
}

pub struct Cast<'a> {
    pub caster: Caster<'a>,
    pub level: f64,
    pub pierce: f64,
    pub potency_pct: f64,
}

impl Default for Cast<'_> {
    fn default() -> Self {
        Self {
            caster: Caster::Absent,
            level: 1.0,
            pierce: 0.0,
            potency_pct: 0.0,
        }
    }
}

#[derive(Clone, Copy)]
struct Magnitude {
    level: f64,
    element: f64,
    flag: f64,
    save_scaled: bool,
    pierce: f64,
}

impl Magnitude {
    fn roll(self, e: &Value, target: &Value, rolls: &mut impl Rolls) -> (f64, f64, f64) {
        let mag = roll_magnitude(e, self.level, rolls);
        if self.save_scaled {
            let percent = saving_throw(self.element, self.flag, target, rolls, self.pierce);
            (mag, percent, (mag * percent / 100.0).trunc())
        } else {
            (mag, 100.0, mag)
        }
    }
}

fn spell_power(caster: &Value, e: &Value, pct: f64) -> f64 {
    // The cast clamps pct to [0, SPELL_POWER_MOST], so the JS power floor (0.5) never binds.
    school_potency_for(caster, effect_school(e)) * (1.0 + pct / 100.0)
}

fn powered(n: f64, power: f64) -> f64 {
    if n > 0.0 && power != 1.0 {
        js_max(1.0, math_round(n * power))
    } else {
        n
    }
}

fn dot_round(
    entry: &Value,
    target: &Value,
    rolls: &mut impl Rolls,
    hurt: &mut Hurt<'_>,
    dead: bool,
) -> (f64, bool) {
    let settings = Magnitude {
        level: entry.get("casterLevel").to_number(),
        element: entry.get("element").to_number(),
        flag: entry.get("flag").to_number(),
        save_scaled: entry.get("saveScaled").truthy(),
        pierce: number(entry, "pierce", 0.0),
    };
    let (_, _, n) = settings.roll(entry.get("effect"), target, rolls);
    if dead {
        return (0.0, false);
    }
    let amount = powered(n, number(entry, "spellPower", 1.0));
    if !(amount > 0.0) {
        return (0.0, false);
    }
    let killed = hurt.as_mut().is_some_and(|hurt| {
        let caster = entry.get("caster");
        !hurt(
            amount,
            Some(&object([
                (
                    "fromPlayer",
                    Bool(!caster.truthy() || caster.get("isPlayer").truthy()),
                ),
                ("bundleDuel", Bool(entry.get("bundleDuel").truthy())),
                ("round", Bool(true)),
                ("element", present(entry.get("element"))),
                ("spell", present(entry.get("spell"))),
                ("index", present(entry.get("index"))),
            ])),
        )
    });
    (amount, killed)
}

fn present(v: &Value) -> Value {
    if v.is_nullish() {
        Null
    } else {
        v.clone()
    }
}

fn dot(a: &Value) -> bool {
    a.get("kind").is_str("continuousDamage")
}

fn active_mut(target: &mut Value) -> &mut Vec<Value> {
    if target.get("activeEffects").is_nullish() {
        target.set("activeEffects", Arr(Vec::new()));
    }
    if let Obj(fields) = target {
        if let Some((_, Arr(list))) = fields.iter_mut().find(|(k, _)| k == "activeEffects") {
            return list;
        }
    }
    panic!("CWS target activeEffects must be an array");
}

#[derive(Default)]
struct Landing {
    damage: f64,
    absorbed: f64,
    reflected: f64,
    resisted: f64,
    deferred: f64,
    continuous: f64,
    dot_damage: f64,
    dot_kill: bool,
    effects: Vec<Value>,
}

impl Landing {
    fn value(self) -> Value {
        object([
            ("damage", Num(self.damage)),
            ("absorbed", Num(self.absorbed)),
            ("reflected", Num(self.reflected)),
            ("resisted", Num(self.resisted)),
            ("deferred", Num(self.deferred)),
            ("continuous", Num(self.continuous)),
            ("dotDamage", Num(self.dot_damage)),
            ("dotKill", Bool(self.dot_kill)),
            ("effects", Arr(self.effects)),
        ])
    }
}

pub fn resolve_cws_cast(
    spell: &Value,
    target: &mut Value,
    cast: &Cast<'_>,
    rolls: &mut impl Rolls,
    mut hurt: Hurt<'_>,
) -> Value {
    let mut out = Landing::default();
    if !spell.truthy() || !target.truthy() {
        return out.value();
    }
    let range_type = integer(spell.get("rangeType")).unwrap_or(0.0);
    let element = integer(spell.get("element")).unwrap_or(4.0);
    let flag = Num(element)
        .array_index()
        .and_then(|i| ELEMENT_FLAG_BY_INDEX.get(i).copied())
        .unwrap_or(MAGIC);
    let m = Magnitude {
        level: cast.level,
        element,
        flag,
        save_scaled: range_type != 0.0,
        pierce: cast.pierce,
    };
    let pct = js_min(
        SPELL_POWER_MOST,
        js_max(0.0, Num(cast.potency_pct).num_or_default(0.0)),
    );
    let reflectable = matches!(cast.caster, Caster::Entity(v) if v.truthy());
    let mut dead = false;
    for e in spell.get("effects").items() {
        if !e.truthy() || e.get("type").to_number() <= -1.0 {
            continue;
        }
        let mut trace = object([
            ("type", e.get("type").clone()),
            ("subType", e.get("subType").clone()),
        ]);
        let mut mark = |tag| {
            trace.set(tag, Bool(true));
            trace.set("applied", Bool(false));
        };
        // mutation: equivalent - try_absorption can return zero, NaN, or at least CAST_COST_FLOOR (5); > 1 selects the same results as > 0.
        if try_absorption(e, range_type, target, rolls) > 0.0 {
            out.absorbed += 1.0;
            mark("absorbed");
        } else if reflectable
            && out.reflected == 0.0
            && check_live(target, "spellReflection", rolls)
        {
            out.reflected += 1.0;
            mark("reflected");
        } else if m.save_scaled && check_live(target, "spellResistance", rolls) {
            out.resisted += 1.0;
            mark("resisted");
        } else if is_continuous_damage(e) {
            let rounds = spell_rounds(e, cast.level);
            if rounds > 0.0 {
                let index = active_mut(target).iter().position(dot);
                if let Some(i) = index {
                    let incumbent = &effects(target)[i];
                    let left = incumbent.get("roundsRemaining").to_number();
                    if !(left > 0.0) {
                        let (n, killed) = dot_round(incumbent, target, rolls, &mut hurt, dead);
                        out.dot_damage += n;
                        out.dot_kill |= killed;
                        dead |= killed;
                    }
                    if rounds - 1.0 > left {
                        active_mut(target)[i].set("roundsRemaining", Num(rounds - 1.0));
                    }
                } else {
                    let caster = entity(&cast.caster, target);
                    let entry = object([
                        ("kind", Str("continuousDamage".into())),
                        ("effect", e.clone()),
                        ("casterLevel", Num(m.level)),
                        ("caster", present(caster)),
                        ("element", Num(m.element)),
                        ("flag", Num(m.flag)),
                        ("saveScaled", Bool(m.save_scaled)),
                        ("pierce", Num(m.pierce)),
                        ("spellPower", Num(spell_power(caster, e, pct))),
                        ("roundsRemaining", Num(rounds)),
                        ("spell", present(spell.get("name"))),
                        ("index", present(spell.get("index"))),
                    ]);
                    let list = active_mut(target);
                    let i = list.len();
                    list.push(entry);
                    let (n, killed) =
                        dot_round(&effects(target)[i], target, rolls, &mut hurt, dead);
                    out.dot_damage += n;
                    out.dot_kill |= killed;
                    dead |= killed;
                    active_mut(target)[i].set("roundsRemaining", Num(rounds - 1.0));
                }
                out.continuous += 1.0;
            }
            trace.set("rounds", Num(rounds));
            trace.set("continuous", Bool(true));
        } else if !is_damage_health(e) {
            out.deferred += 1.0;
            mark("deferred");
        } else {
            let (magnitude, percent, n) = m.roll(e, target, rolls);
            let power = spell_power(entity(&cast.caster, target), e, pct);
            let n = powered(n, power);
            let applied = !dead && n > 0.0;
            if applied {
                out.damage += n;
                dead = hurt.as_mut().is_some_and(|hurt| !hurt(n, None));
            }
            trace.set("magnitude", Num(magnitude));
            trace.set("savePercent", Num(percent));
            trace.set("school", Num(effect_school(e)));
            trace.set("spellPower", Num(power));
            trace.set("damage", Num(n));
            trace.set("applied", Bool(applied));
        }
        out.effects.push(trace);
    }
    out.value()
}

fn entity<'a>(caster: &'a Caster<'_>, target: &'a Value) -> &'a Value {
    match caster {
        Caster::Absent => &Null,
        Caster::Entity(caster) => caster,
        Caster::Target => target,
    }
}

fn check_live(target: &Value, kind: &str, rolls: &mut impl Rolls) -> bool {
    let chance = best_live_chance(target, kind);
    chance > 0.0 && dice100(chance, rolls.roll())
}

pub fn tick_active_effects(target: &mut Value, mut hurt: Hurt<'_>, rolls: &mut impl Rolls) {
    if effects(target).is_empty() {
        return;
    }
    let mut kept = Vec::new();
    for a in effects(target) {
        let mut a = a.clone();
        if dot(&a) {
            let left = a.get("roundsRemaining").to_number();
            if !(left > 0.0) {
                continue;
            }
            dot_round(&a, target, rolls, &mut hurt, false);
            a.set("roundsRemaining", Num(left - 1.0));
        }
        kept.push(a);
    }
    target.set("activeEffects", Arr(kept));
}
