//! Per-blow model (`src/model.js:106-1051`). Value inputs share the save/item boundary.
use crate::damage::{self, Wear};
use crate::dual_wield::off_hand_to_hit;
use crate::gear_lines::{blade_lines, weapon_damage_pct};
use crate::generated::data::*;
use crate::loot::{power_ids_of, power_of};
pub use crate::round::unity_round;
use crate::round::{js_clamp, js_max, js_min};
use crate::save::{effective_skill, live_stat, master_capped_skill, skill_value, weapon_skill};
use crate::swing::{swing_frame_seconds, swing_handling, swing_heft, SwingWeapon};
use crate::value::{obj_table_get, Value};
use crate::{round, target};

fn obj(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Obj(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

fn n(v: f64) -> Value {
    Value::Num(v)
}
fn b(v: bool) -> Value {
    Value::Bool(v)
}
fn s(v: &str) -> Value {
    Value::Str(v.into())
}
fn on(v: &Value, k: &str) -> bool {
    v.get(k).truthy()
}
fn yes(v: &Value, k: &str) -> bool {
    matches!(v.get(k), Value::Bool(true))
}
fn enabled(v: &Value, k: &str) -> bool {
    !matches!(v.get(k), Value::Bool(false))
}
fn num(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).finite_or(d)
}
fn read(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).num_or(d)
}
fn tag<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).as_str().unwrap_or("")
}
fn ws(w: &Value) -> f64 {
    read(w, "skillId", f64::NAN)
}

pub fn weapon_of(item: &Value, rri: bool) -> Value {
    if !item.truthy() {
        return Value::Null;
    }
    let id = item.get("templateIndex");
    let Some(t) = obj_table_get(WEAPONS, id) else {
        return Value::Null;
    };
    let blade = blade_lines(item);
    let mut ids = Vec::<Value>::new();
    let mut powers = Vec::new();
    for id in power_ids_of(item) {
        // mutation: equivalent - lootRarity.js:1271 emits at most one string (exclusive rarities); another iteration can only pass a non-string to power_of, which returns Null and is filtered out.
        if id.as_str().is_some() && !ids.iter().any(|old| old.same_value_zero(&id)) {
            let p = power_of(&id);
            if p.truthy() {
                powers.push(p);
            }
            ids.push(id);
        }
    }
    let material = num(item, "material", 0.0);
    let damage = obj_table_get(RRI_WEAPON_DAMAGE, id);
    let bound = |k, base, alt: Option<f64>| {
        if rri {
            alt.unwrap_or(base)
        } else {
            let v = num(item, k, 0.0);
            if v > 0.0 {
                v
            } else {
                base
            }
        }
    };
    let condition = crate::durability::condition_percentage(item);
    obj([
        ("item", item.clone()),
        ("powers", Value::Arr(powers)),
        ("templateIndex", id.clone()),
        (
            "name",
            if on(item, "name") {
                item.get("name").clone()
            } else {
                s(t.name)
            },
        ),
        ("baseName", s(t.name)),
        ("min", n(bound("minDamage", t.min, damage.map(|x| x.min)))),
        ("max", n(bound("maxDamage", t.max, damage.map(|x| x.max)))),
        (
            "skillId",
            n(weapon_skill(id).unwrap_or(SKILLS.hand_to_hand)),
        ),
        ("skill", s(t.skill)),
        ("type", n(t.type_)),
        ("weight", n(t.weight)),
        ("shortBlade", b(t.short_blade)),
        ("twoHanded", b(t.two_handed)),
        ("ranged", b(t.ranged.unwrap_or(false) || on(item, "ranged"))),
        ("gun", b(t.gun.unwrap_or(false) || on(item, "gun"))),
        ("ammo", b(t.ammo.unwrap_or(false) || on(item, "ammo"))),
        ("wraps", b(t.wraps.unwrap_or(false) || on(item, "wraps"))),
        ("bowPull", n(t.bow_pull.unwrap_or(1.0))),
        ("bowWithin", n(t.bow_within.unwrap_or(1.0))),
        ("material", n(material)),
        (
            "materialName",
            s(material_name(&n(material)).unwrap_or("Iron")),
        ),
        ("flags", n(num(item, "flags", 0.0))),
        ("damagePct", n(weapon_damage_pct(item))),
        ("slayer", blade.get("slayer").clone()),
        ("slayerByGroup", blade.get("slayerByGroup").clone()),
        ("elemental", blade.get("elemental").clone()),
        ("elementalLines", blade.get("elementalLines").clone()),
        ("conditionPercent", n(condition)),
        ("conditionPct", n(condition / 100.0)),
        ("bonusDamage", n(num(item, "__bonusDamage", 0.0))),
    ])
}

fn material_name(v: &Value) -> Option<&'static str> {
    v.array_index().and_then(|i| MATERIALS.get(i).copied())
}

pub fn synthetic_weapon(template: &Value, material: &Value, rri: bool) -> Value {
    let Some(t) = obj_table_get(WEAPONS, template) else {
        return Value::Null;
    };
    let material = if matches!(material, Value::Undefined) {
        n(9.0)
    } else {
        material.clone()
    };
    let name = format!("{} {}", material_name(&material).unwrap_or(""), t.name);
    weapon_of(
        &obj([
            ("group", s("Weapons")),
            ("templateIndex", template.clone()),
            ("material", material),
            ("name", s(name.trim())),
            ("maxCondition", n(100.0)),
            ("currentCondition", n(100.0)),
        ]),
        rri,
    )
}

pub fn is_blade(w: &Value) -> bool {
    w.truthy() && ws(w) != SKILLS.blunt_weapon
}
pub fn is_blunt(w: &Value) -> bool {
    !w.truthy() || ws(w) == SKILLS.blunt_weapon
}

fn material_mod(w: &Value) -> f64 {
    // The data is indexed by material id, not by a coercive numeric conversion.
    w.get("material")
        .array_index()
        .and_then(|i| WEAPON_MATERIAL_MODIFIER.get(i).copied())
        .unwrap_or(0.0)
}

pub fn weapon_to_hit(w: &Value) -> f64 {
    material_mod(w) * 2.0 + 2.0
}

pub fn combat_stat(ch: &Value, name: &str, opts: &Value) -> f64 {
    let bonus = enabled(opts, "passiveOn")
        && matches!(
            (tag(ch, "martialPath"), name),
            ("shadowdancer", "agility") | ("windrunner", "speed")
        );
    if !bonus {
        return js_max(0.0, live_stat(ch, name));
    }
    let mut ch = ch.clone();
    let mut mods = object_or_empty(ch.get("_mods"));
    let mut stats = object_or_empty(mods.get("stats"));
    stats.set(name, n(read(&stats, name, 0.0) + 10.0));
    mods.set("stats", stats);
    ch.set("_mods", mods);
    js_max(0.0, live_stat(&ch, name))
}

fn object_or_empty(v: &Value) -> Value {
    if matches!(v, Value::Obj(_)) {
        v.clone()
    } else {
        obj([])
    }
}

pub fn skill(ch: &Value, id: &Value, opts: &Value) -> f64 {
    skill_value(ch, id)
        + if enabled(opts, "passiveOn")
            && tag(ch, "martialPath") == "shadowdancer"
            && id.strict_eq(&n(SKILLS.dodging))
        {
            15.0
        } else {
            0.0
        }
}

pub fn martial_pace(ch: &Value, opts: &Value) -> f64 {
    if !enabled(opts, "passiveOn") {
        return 0.0;
    }
    match tag(ch, "martialPath") {
        "warblade" if on(opts, "rhythm") => 15.0,
        "bladedancer" if on(opts, "cyclone") => 20.0,
        // mutation: equivalent - the selfShare default 1 (model.js:595) and 2 both miss the < 0.5 frenzy gate.
        "berserker" if num(opts, "attackerHealthShare", 1.0) < 0.5 => 10.0,
        _ => 0.0,
    }
}

fn mastery_climb(ch: &Value, id: &Value) -> f64 {
    let raw = ch.get("skills").prop(id);
    let raw = if matches!(raw, Value::Null | Value::Undefined) {
        // mutation: equivalent - model.js:414,617 use raw 0 for nullish skill; raw 0 and 1 both stay <= 100 after the effective-skill read, so climb clamps to +0.
        n(0.0)
    } else {
        raw
    };
    js_max(
        0.0,
        effective_skill(&master_capped_skill(ch, id, &raw)) - 100.0,
    )
}

pub fn mastery_pace(ch: &Value, w: &Value) -> f64 {
    if !on(ch, "online") || !w.truthy() || ws(w) != SKILLS.short_blade {
        return 0.0;
    }
    mastery_climb(ch, &n(SKILLS.short_blade))
}

fn handling(w: &Value) -> f64 {
    let desc = SwingWeapon {
        type_: match w.get("type") {
            Value::Num(t) => Some(*t),
            Value::Str(t) => crate::value::index_key(t).map(f64::from),
            _ => None,
        },
        short_blade: on(w, "shortBlade"),
        two_handed: on(w, "twoHanded"),
    };
    swing_handling(w.truthy().then_some(&desc))
}

fn pace(ch: &Value, w: &Value, opts: &Value) -> f64 {
    js_clamp(
        martial_pace(ch, opts) + mastery_pace(ch, w) + num(opts, "attackSpeedPct", 0.0),
        0.0,
        50.0,
    )
}

pub fn cadence(ch: &Value, w: &Value, opts: &Value) -> Value {
    let mut speed = combat_stat(ch, "speed", opts);
    let handling = handling(w);
    let frame = |speed, heft| swing_frame_seconds(Some(speed), Some(heft), Some(handling));
    let (mut tick, mut heft, mut pace_pct) = (frame(speed, 1.0), 1.0, 0.0);
    let rri = on(opts, "rri");
    if w.truthy() {
        let strength = combat_stat(ch, "strength", opts);
        let weight = read(w, "weight", f64::NAN);
        if rri {
            let capped = js_min(speed, 98.0);
            let adjusted = ((150.0 - strength) * weight) / 100.0;
            let reduction = adjusted * RRI_SPEED_REDUCTION_FACTOR;
            speed = (capped - capped * reduction / 90.0).trunc();
        } else {
            heft = swing_heft(Some(weight), Some(strength));
        }
        tick = frame(speed, heft);
        pace_pct = pace(ch, w, opts);
        // mutation: equivalent - at zero pace division is by exactly 1 and frame already enforces SWING_FRAME_MIN.
        if pace_pct > 0.0 {
            tick = js_max(SWING_FRAME_MIN, tick / (1.0 + pace_pct / 100.0));
        }
    }
    let seconds = 5.0 * tick;
    let mut card = obj([
        ("seconds", n(seconds)),
        ("tick", n(tick)),
        ("aps", n(1.0 / seconds)),
        ("speed", n(speed)),
        ("heft", n(heft)),
        ("handling", n(handling)),
        ("pace", n(pace_pct)),
    ]);
    if w.truthy() {
        card.set("rri", b(rri));
    }
    card
}

pub fn ranged_cadence(ch: &Value, w: &Value, opts: &Value) -> Value {
    if !w.truthy() {
        return Value::Null;
    }
    let speed = combat_stat(ch, "speed", opts);
    let handling = handling(w);
    if on(w, "gun") {
        let pistol = w
            .get("templateIndex")
            .strict_eq(&n(crate::generated::item_facts::PISTOLET_TEMPLATE));
        let (fps, frames, reload) = if pistol {
            (PISTOLET_FPS, PISTOLET_FRAMES, PISTOLET_RELOAD_S)
        } else {
            (
                GUN_FPS,
                THUNDERLOCK_FRAMES,
                js_max(
                    GUN_RELOAD_MIN_S,
                    GUN_RELOAD_S
                        * (1.0 - GUN_SPEED_SCALE * (crate::round::finite_or(speed, 50.0) - 50.0)),
                ),
            )
        };
        let pair = on(opts, "pair") && pistol;
        let cycle = frames / fps + reload;
        let seconds = if pair { cycle / 2.0 } else { cycle };
        return obj([
            ("seconds", n(seconds)),
            ("tick", n(1.0 / fps)),
            ("aps", n(1.0 / seconds)),
            ("speed", n(speed)),
            ("heft", n(1.0)),
            ("handling", n(handling)),
            ("pace", n(0.0)),
            ("gun", b(true)),
            ("reload", n(reload)),
            ("pair", b(pair)),
            ("cycle", n(cycle)),
        ]);
    }
    let strength = combat_stat(ch, "strength", opts);
    let heft = swing_heft(Some(read(w, "weight", f64::NAN)), Some(strength));
    let mut frame = swing_frame_seconds(Some(speed), Some(heft), Some(handling));
    let pace_pct = pace(ch, w, opts);
    // mutation: equivalent - at zero pace division is by exactly 1 and frame already enforces the 0.09 minimum.
    if pace_pct > 0.0 {
        frame = js_max(0.09, frame / (1.0 + pace_pct / 100.0));
    }
    let reload = js_max(0.0, 5.0 * frame - BOW_DRAW_LOOSE_S);
    let cycle = (if on(opts, "bowDrawback") { 7.0 } else { 4.0 }) * 0.0625 + reload;
    let within = read(w, "bowWithin", 1.0);
    let spam = on(opts, "bowSpam");
    let seconds = if spam { cycle } else { js_max(cycle, within) };
    let pull = read(w, "bowPull", 1.0) * if spam { 0.2 } else { 1.0 };
    obj([
        ("seconds", n(seconds)),
        ("cycle", n(cycle)),
        ("tick", n(frame)),
        ("aps", n(1.0 / seconds)),
        ("speed", n(speed)),
        ("heft", n(1.0)),
        ("handling", n(handling)),
        ("pace", n(pace_pct)),
        ("bow", b(true)),
        ("reload", n(reload)),
        ("within", n(within)),
        ("pull", n(pull)),
        ("spam", b(spam)),
    ])
}

pub fn weapon_resist_factor(w: &Value, traits: &[Value]) -> f64 {
    if traits.iter().any(|t| t.is_str("bladeturning")) && is_blade(w)
        || traits.iter().any(|t| t.is_str("stoneskin")) && is_blunt(w)
    {
        0.5
    } else {
        1.0
    }
}

pub fn expected_capped(min: f64, max: f64, cap: f64) -> f64 {
    if cap <= 0.0 || cap.is_nan() || max <= cap {
        return (min + max) / 2.0;
    }
    if min >= cap {
        return cap;
    }
    let lo = min.ceil();
    let hi = max.floor();
    if hi < lo {
        return js_min(cap, (min + max) / 2.0);
    }
    let mut d = lo;
    let mut total = 0.0;
    while d <= hi {
        total += js_min(d, cap);
        d += 1.0;
    }
    total / (hi - lo + 1.0)
}

pub fn condition_multiplier(w: &Value, sharp_edge: bool) -> f64 {
    let wear = Wear {
        condition_percent: match w.get("conditionPercent") {
            Value::Null | Value::Undefined => None,
            v => Some(v.to_number()),
        },
        condition_pct: w.get("conditionPct").to_number(),
        blunt: ws(w) == SKILLS.blunt_weapon,
    };
    damage::condition_multiplier(w.truthy().then_some(&wear), sharp_edge)
}

fn swing_terms(key: &str) -> (f64, f64) {
    macro_rules! pair {
        ($k:ident) => {
            (SWING_MODS.$k.damage, SWING_MODS.$k.to_hit)
        };
    }
    match key {
        "StrikeLeft" => pair!(strike_left),
        "StrikeRight" => pair!(strike_right),
        "StrikeUp" => pair!(strike_up),
        "StrikeDownRight" => pair!(strike_down_right),
        "StrikeDownLeft" => pair!(strike_down_left),
        "StrikeDown" => pair!(strike_down),
        _ => (0.0, 0.0),
    }
}

pub fn swing_directions() -> impl Iterator<Item = &'static str> {
    use crate::generated::{
        anims::DIRECTION_TO_STRIKE as M, weapon_states::CLICK_ATTACK_DIRECTIONS,
    };
    CLICK_ATTACK_DIRECTIONS.iter().map(|d| match *d {
        "UpRight" => M.up_right,
        "Up" => M.up,
        "UpLeft" => M.up_left,
        "Left" => M.left,
        "Right" => M.right,
        "DownLeft" => M.down_left,
        "Down" => M.down,
        "DownRight" => M.down_right,
        _ => panic!("unmapped click attack direction {d}"),
    })
}

fn terms(damage: f64, hit: f64) -> Value {
    obj([("damage", n(damage)), ("toHit", n(hit))])
}

fn proficiency(ch: &Value, w: &Value, core: &str, opts: &Value) -> (f64, f64) {
    let expert = (round::to_uint32(
        ch.get("career")
            .get("weaponArmorShieldsBitfield")
            .to_number(),
    ) >> 16)
        & 0x3f;
    let flag = if w.truthy() {
        crate::save::proficiency_flag(w.get("skillId")).unwrap_or(-1.0)
    } else {
        4.0
    };
    if expert & round::to_uint32(flag) == 0 {
        return (0.0, 0.0);
    }
    if core == "classic" {
        let level = ch.get("level");
        return (
            (level.to_number() / 3.0).trunc() + 1.0,
            level.num_or(f64::NAN),
        );
    }
    let t = |k: &str, divisor: f64| (combat_stat(ch, k, opts) / divisor).trunc();
    let a = |d| t("agility", d);
    let st = |d| t("strength", d);
    let e = |d| t("endurance", d);
    let sp = |d| t("speed", d);
    let l = |d| t("luck", d);
    if !w.truthy() {
        return (
            st(50.0) + e(50.0) + a(50.0) + sp(50.0) + 1.0,
            a(22.0) + sp(22.0) + st(22.0) + e(22.0) + l(22.0),
        );
    }
    let id = ws(w);
    if id == SKILLS.archery {
        (st(25.0) + a(25.0) + 1.0, a(8.0) + sp(20.0) + l(20.0))
    } else if id == SKILLS.axe {
        (st(20.0) + a(33.0) + 1.0, st(11.0) + a(11.0) + l(22.0))
    } else if id == SKILLS.blunt_weapon {
        (st(20.0) + e(33.0) + 1.0, st(10.0) + a(16.0) + l(16.0))
    } else if id == SKILLS.long_blade {
        (a(20.0) + st(33.0) + 1.0, a(8.0) + sp(20.0) + l(20.0))
    } else if id == SKILLS.short_blade {
        (a(25.0) + sp(25.0) + 1.0, a(10.0) + sp(14.0) + l(18.0))
    } else {
        (0.0, 0.0)
    }
}

fn racial(ch: &Value, w: &Value, core: &str, opts: &Value) -> (f64, f64) {
    let race = read(ch, "raceId", f64::NAN);
    let id = ws(w);
    if core == "classic" {
        let div = if !w.truthy() {
            return (0.0, 0.0);
        } else if race == RACES.dark_elf {
            4.0
        } else if if id == SKILLS.archery {
            race == RACES.wood_elf
        } else {
            race == RACES.redguard
        } {
            3.0
        } else {
            return (0.0, 0.0);
        };
        let v = (ch.get("level").to_number() / div).trunc();
        return (v, v);
    }
    let t = |k: &str, divisor: f64| (combat_stat(ch, k, opts) / divisor).trunc();
    let a = |d| t("agility", d);
    let st = |d| t("strength", d);
    let e = |d| t("endurance", d);
    let sp = |d| t("speed", d);
    let l = |d| t("luck", d);
    if !w.truthy() {
        return if race == RACES.khajiit {
            (
                st(33.0) + e(33.0) + a(50.0) + sp(50.0),
                a(25.0) + sp(50.0) + st(50.0) + e(50.0) + l(50.0),
            )
        } else if race == RACES.nord {
            (st(33.0) + e(50.0), 0.0)
        } else {
            (0.0, 0.0)
        };
    }
    if id == SKILLS.short_blade {
        if race == RACES.argonian {
            return (a(33.0) + sp(33.0), a(16.0) + sp(33.0) + l(33.0));
        }
        if race == RACES.dark_elf {
            return (a(50.0) + sp(50.0), a(33.0) + sp(33.0) + l(33.0));
        }
        if race == RACES.wood_elf || race == RACES.khajiit {
            return (a(33.0) + sp(50.0), a(20.0) + sp(33.0) + l(50.0));
        }
    }
    if id == SKILLS.long_blade {
        if race == RACES.dark_elf {
            return (a(25.0) + st(25.0), a(25.0) + sp(33.0) + l(33.0));
        }
        if race == RACES.redguard {
            return (a(33.0) + st(50.0), a(10.0) + sp(25.0) + l(25.0));
        }
    }
    if id == SKILLS.archery {
        if race == RACES.wood_elf {
            return (st(25.0) + a(25.0), a(10.0) + sp(25.0) + l(25.0));
        }
        if race == RACES.redguard {
            return (st(50.0) + a(50.0), a(25.0) + sp(33.0) + l(33.0));
        }
    }
    if id == SKILLS.axe && (race == RACES.nord || race == RACES.redguard) {
        return (st(16.0) + a(33.0), st(33.0) + a(33.0) + l(33.0));
    }
    if id == SKILLS.blunt_weapon {
        if race == RACES.nord {
            return (st(25.0) + e(25.0), st(25.0) + a(33.0) + l(33.0));
        }
        if race == RACES.redguard {
            return (st(33.0) + e(33.0), st(20.0) + a(25.0) + l(33.0));
        }
    }
    (0.0, 0.0)
}

pub fn racial_modifiers(ch: &Value, w: &Value, core: &str, opts: &Value) -> Value {
    let (d, h) = racial(ch, w, core, opts);
    terms(d, h)
}

fn crit_model(ch: &Value, core: &str, opts: &Value) -> Value {
    let crit = skill(ch, &n(SKILLS.critical_strike), opts);
    let luck = combat_stat(ch, "luck", opts);
    let (chance, hit, mult, kind) = if core != "overhaul" {
        (crit, (crit / 10.0).trunc(), 1.0, "hit")
    } else if !enabled(opts, "critDamage") {
        let third = (crit / 3.0).trunc();
        (third, third, 1.0, "hit")
    } else {
        let f = round::fround;
        let luck_term = f((luck - 50.0) / 25.0).floor();
        (
            (crit / (4.0 - luck_term)).trunc(),
            (crit / 4.0).trunc(),
            f(f((crit / 5.0).trunc() * f(0.05)) + 1.0),
            "damage",
        )
    };
    obj([
        ("chance", n(js_clamp(chance, 0.0, 100.0) / 100.0)),
        ("hitBonus", n(hit)),
        ("damageMult", n(mult)),
        ("kind", s(kind)),
        ("skill", n(crit)),
    ])
}

fn adrenaline(attacker: &Value, target: &Value, overhaul: bool) -> f64 {
    let (div, value) = if overhaul { (6.0, 8.0) } else { (8.0, 5.0) };
    let rush = |e: &Value| {
        round::to_uint32(
            e.get("career")
                .get("abilityFlagsAndSpellPointsBitfield")
                .to_number(),
        ) & 4
            == 4
            // mutation: equivalent - inRush (model.js:187) defaults nonfinite maxHealth to 0; 1 also truncates to +0 after division by 6 or 8, leaving the health comparison unchanged.
            && num(e, "health", 0.0) < (num(e, "maxHealth", 0.0) / div).trunc()
    };
    (if rush(attacker) { value } else { 0.0 }) - if rush(target) { value } else { 0.0 }
}

fn nums(values: impl IntoIterator<Item = f64>) -> Value {
    Value::Arr(values.into_iter().map(n).collect())
}

pub fn hit_model(
    ch: &Value,
    w: &Value,
    target: &Value,
    swing: &str,
    core: &str,
    opts: &Value,
) -> Value {
    let overhaul = core == "overhaul";
    let (_, swing_hit) = swing_terms(swing);
    let (pd, ph) = proficiency(ch, w, core, opts);
    let (rd, rh) = racial(ch, w, core, opts);
    let crit = crit_model(ch, core, opts);
    let dodge = skill(target, &n(SKILLS.dodging), opts);
    let mut other =
        adrenaline(ch, target, overhaul) + read(ch.get("_enchantMods"), "chanceToHitMod", 0.0);
    let id = w.get("skillId");
    let fist = n(SKILLS.hand_to_hand);
    let weapon_skill = skill(ch, if id.is_nullish() { &fist } else { id }, opts);
    let diff = |k: &str, div: f64| {
        ((combat_stat(ch, k, opts) - combat_stat(target, k, &Value::Undefined)) / div).trunc()
    };
    let class = on(target, "isClass");
    let mut base;
    let dodge_term;
    other += diff("luck", 10.0);
    if overhaul {
        base = round::fround(weapon_skill * 1.5).ceil()
            + swing_hit
            + ph
            + rh
            + if w.truthy() { weapon_to_hit(w) } else { 0.0 };
        dodge_term = (dodge / 2.0).trunc();
        other = other + diff("agility", 4.0) + diff("speed", 8.0)
            - unity_round(round::fround(
                (combat_stat(target, "luck", &Value::Undefined) - 50.0) / 10.0,
            ))
            - dodge_term
            + if class { -50.0 } else { 0.0 }
            + if on(opts, "offHand") {
                off_hand_to_hit(combat_stat(ch, "agility", opts))
            } else {
                0.0
            };
    } else {
        base = weapon_skill + swing_hit + ph + rh;
        if w.truthy() {
            base += material_mod(w) * 10.0;
        }
        dodge_term = (dodge / 4.0).floor();
        other = other + diff("agility", 10.0) - dodge_term
            + if on(target, "isPlayer") {
                0.0
            } else if class {
                -50.0
            } else {
                -10.0
            };
    }
    let (mut plain, mut crit_hit, mut armour_avg) = (0.0, 0.0, 0.0);
    let backstab = num(opts, "backstabBonus", 0.0);
    // mutation: equivalent - body_part_weights always returns seven entries and both arrays are overwritten at every index.
    let (mut pplain, mut pcrit) = ([0.0; 7], [0.0; 7]);
    for (part, weight) in target::body_part_weights(if overhaul {
        target::Core::Overhaul
    } else {
        target::Core::Other
    })
    .into_iter()
    .enumerate()
    {
        let armour = if overhaul && class {
            60.0
        } else {
            target.get("armorValues").prop(&n(part as f64)).num_or(0.0)
        };
        let p = js_clamp(base + armour + other + backstab, 3.0, 97.0);
        // mutation: equivalent - crit_model always sets hitBonus to a Num, even when it is NaN.
        let c = js_clamp(
            base + armour + other + read(&crit, "hitBonus", 0.0) + backstab,
            3.0,
            97.0,
        );
        pplain[part] = p / 100.0;
        pcrit[part] = c / 100.0;
        armour_avg += weight * armour;
        plain += (weight * p) / 100.0;
        crit_hit += (weight * c) / 100.0;
    }
    // mutation: equivalent - crit_model always sets chance to a Num, even when it is NaN.
    let chance = read(&crit, "chance", 0.0);
    obj([
        ("hit", n((1.0 - chance) * plain + chance * crit_hit)),
        ("hitPlain", n(plain)),
        ("hitCrit", n(crit_hit)),
        (
            "byPart",
            obj([("plain", nums(pplain)), ("crit", nums(pcrit))]),
        ),
        ("crit", crit),
        (
            "terms",
            obj([
                ("base", n(base)),
                ("armour", n(armour_avg)),
                ("other", n(other)),
                ("backstab", n(backstab)),
                ("dodge", n(dodge_term)),
            ]),
        ),
        ("prof", terms(pd, ph)),
        ("racial", terms(rd, rh)),
    ])
}

fn optional_num(v: &Value, key: &str) -> Option<f64> {
    let v = v.get(key);
    (!v.is_nullish()).then(|| v.num_or(f64::NAN))
}

fn target_weapon(w: &Value) -> Option<target::Weapon> {
    w.truthy().then(|| target::Weapon {
        skill_id: optional_num(w, "skillId"),
        material: optional_num(w, "material"),
        flags: optional_num(w, "flags"),
        item_flags: optional_num(w.get("item"), "flags"),
    })
}

fn group_of(t: Option<&target::Target>) -> Option<&'static str> {
    let t = t?;
    crate::loot::foe_group(&obj([
        ("isPlayer", b(t.is_player)),
        ("careerIndex", t.career_index.map_or(Value::Null, n)),
        ("affinity", t.affinity.as_deref().map_or(Value::Null, s)),
    ]))
}

pub fn martial_blow_pct(ch: &Value, t: Option<&target::Target>, opts: &Value) -> f64 {
    if !enabled(opts, "passiveOn") {
        return 0.0;
    }
    match tag(ch, "martialPath") {
        // mutation: equivalent - model.js:602 also defaults to 5 stacks; replacing only the default with 6 still clamps to 5.
        "blademaster" => 3.0 * js_clamp(num(opts, "stacks", 5.0), 0.0, 5.0),
        "warblade" if on(opts, "rally") => 15.0,
        "ranger" if group_of(t) == Some("animal") => 20.0,
        "cutthroat" if on(opts, "unaware") => 25.0,
        "assassin" if on(opts, "firstBlow") => 30.0,
        // mutation: equivalent - the selfShare default 1 (model.js:595) and 2 both miss the < 0.5 frenzy gate.
        "berserker" if num(opts, "attackerHealthShare", 1.0) < 0.5 => 20.0,
        "crusader" if matches!(group_of(t), Some("undead" | "daedra")) => 20.0,
        _ => 0.0,
    }
}

pub fn mastery_pct(ch: &Value, w: &Value, opts: &Value) -> f64 {
    if !on(ch, "online") || !w.truthy() {
        return 0.0;
    }
    let id = w.get("skillId");
    let ws = ws(w);
    let climb = mastery_climb(ch, id);
    let mut pct = 0.0;
    // mutation: equivalent - the >= mutant includes only zero climb, so each selected addend is +0.
    if climb > 0.0 {
        // mutation: equivalent - the model.js:622-623 default 1 and 2 both select the >= 0.5 branch and reject the < 0.5 branch.
        let share = num(opts, "healthShare", 1.0);
        if ws == SKILLS.long_blade || ws == SKILLS.archery {
            pct += climb;
        } else if (ws == SKILLS.axe && share < 0.5) || (ws == SKILLS.blunt_weapon && share >= 0.5) {
            pct += climb * 2.0;
        }
    }
    if ws != SKILLS.hand_to_hand && !on(ch, "_mentor") {
        let gear = crate::save::skill_mod_of(ch, id);
        // mutation: equivalent - the >= mutant includes only signed zero; adding either sign to a nonnegative +0-or-larger pct retains its bits.
        if gear > 0.0 {
            pct += js_min(320.0, gear * 0.44);
        }
    }
    pct
}

pub fn loot_power_terms(powers: &[Value], t: Option<&target::Target>, opts: &Value) -> (f64, f64) {
    let (mut pct, mut flat) = (0.0, 0.0);
    let all = yes(opts, "assumeTriggers");
    let foe = num(opts, "healthShare", 1.0);
    let own = num(opts, "attackerHealthShare", 1.0);
    for p in powers {
        let q = num(p, "pct", 0.0);
        match tag(p, "kind") {
            "bane"
                if all
                    || (t.and_then(|t| t.affinity.as_deref()) != Some("Human")
                        && p.get("foes").items().iter().any(|v| {
                            v.same_value_zero(
                                &t.and_then(|t| t.career_index).map_or(Value::Undefined, n),
                            )
                        })) =>
            {
                pct += q
            }
            "unaware" if all || on(opts, "unaware") => pct += q,
            "sanctified"
                if all
                    || p.get("group")
                        .as_str()
                        .is_some_and(|g| group_of(t) == Some(g)) =>
            {
                pct += q
            }
            "flow" => pct += q * num(opts, "flowStacks", num(p, "max", 1.0)),
            "venom" => {
                flat += (num(p, "flat", 0.0)
                    * if all || foe < 0.5 { 2.0 } else { 1.0 }
                    * target::element_share(t, Some("poison")))
                .floor()
            }
            "moon" if all || on(opts, "night") => {
                pct += q + if all || group_of(t) == Some("animal") {
                    num(p, "beast", 0.0)
                } else {
                    0.0
                }
            }
            "rage" if all || own < num(p, "below", 0.0) / 100.0 => pct += q,
            "execute" if all || foe < num(p, "below", 0.0) / 100.0 => pct += q,
            "firstblood" if all || on(opts, "firstBlow") => pct += q,
            _ => (),
        }
    }
    (pct, flat)
}

/// Stable fight-local identities: the caller reuses a key for the same item (or bare attacker),
/// and assigns distinct keys to distinct objects even when the records are equal.
pub type CarryState = std::collections::HashMap<(&'static str, u64), f64>;

#[derive(Default)]
pub struct Carry<'a> {
    pub state: Option<&'a mut CarryState>,
    pub weapon_key: u64,
    pub loot_key: u64,
}

pub fn create_carry_state() -> CarryState {
    CarryState::new()
}

fn carried_amount(
    state: &mut CarryState,
    channel: &'static str,
    key: u64,
    d: f64,
    pct: f64,
    firm: bool,
) -> f64 {
    let rem = state.entry((channel, key)).or_default();
    let exact = (d * pct) / 100.0 + *rem;
    // mutation: equivalent - <= adds only zero, but the Firmament channel never calls with zero pct.
    let whole = if firm && pct < 0.0 {
        (exact - 1e-9).ceil()
    } else {
        (exact + 1e-9).floor()
    };
    *rem = if firm {
        exact - whole
    } else {
        js_max(0.0, exact - whole)
    };
    whole
}

pub fn weapon_blow(
    ch: &Value,
    w: &Value,
    damage: f64,
    t: Option<&target::Target>,
    opts: &Value,
    carry: &mut Carry<'_>,
) -> f64 {
    let theory = num(opts, "damagePct", 0.0);
    if t.is_some_and(|t| t.warded) {
        return damage::apply_pct(damage, theory);
    }
    let carried = yes(opts, "carried");
    let mut channel = |d, pct, name, key, firm| {
        if !carried && d > 0.0 {
            if let Some(state) = carry.state.as_deref_mut() {
                let out = d + carried_amount(state, name, key, d, pct, firm);
                return if firm { js_max(1.0, out) } else { out };
            }
        }
        if carried {
            if firm {
                damage::carried_firmament(d, pct)
            } else {
                damage::carried_pct(d, pct)
            }
        } else {
            damage::apply_pct(d, pct)
        }
    };
    let mut d = damage;
    let mastery = mastery_pct(ch, w, opts);
    if mastery > 0.0 {
        d = channel(d, mastery, "mastery", carry.weapon_key, false);
    }
    let lines = if w.is_nullish() { opts.get("wraps") } else { w };
    let what = opts.get("loot");
    let powers: Vec<_> = lines
        .get("powers")
        .items()
        .iter()
        .chain(opts.get("imprintsExtra").items())
        .cloned()
        .collect();
    let (pct, flat) = loot_power_terms(&powers, t, opts);
    let group = t.and_then(|t| t.group.as_deref()).unwrap_or("");
    let slayer = read(lines.get("slayerByGroup"), group, 0.0) + num(what, "pct", 0.0) + pct;
    if slayer > 0.0 {
        d = channel(d, slayer, "loot", carry.loot_key, false);
    }
    let elems = lines.get("elementalLines").items();
    let mut elem = if elems.is_empty() {
        num(lines, "elemental", 0.0).floor()
    } else {
        elems.iter().fold(0.0, |a, l| {
            a + (num(l, "value", 0.0) * target::element_share(t, l.get("param").as_str())).floor()
        })
    };
    elem += num(what, "flat", 0.0) + flat;
    if elem > 0.0 {
        d += elem;
    }
    let martial = martial_blow_pct(ch, t, opts);
    if martial > 0.0 {
        d = channel(d, martial, "martial", carry.weapon_key, false);
    }
    d = damage::apply_pct(d, theory);
    let firm = num(opts, "firmamentDamagePct", 0.0);
    if firm != 0.0 {
        d = channel(d, firm, "firmament", carry.weapon_key, true);
    }
    d
}

pub fn finish_blow(damage: f64, opts: &Value, critical: bool) -> f64 {
    let core = opts.get("core");
    if !matches!(core, Value::Undefined) && !core.is_str("overhaul") {
        return damage;
    }
    let mut d = js_max(0.0, damage);
    let round = |v| {
        if on(opts, "carried") {
            v
        } else {
            unity_round(v)
        }
    };
    // mutation: equivalent - model.js:665 defaults each multiplier to 1; differs rejects both undefined and numeric 1, so the Rust fallback is never multiplied into d.
    let field = |k| match opts.get(k) {
        Value::Undefined => 1.0,
        v => v.to_number(),
    };
    let crit = field("critMult");
    let mat = field("matReq");
    let cond = field("conditionMult");
    let differs = |k| !matches!(opts.get(k), Value::Undefined | Value::Num(1.0));
    let f = round::fround;
    if critical && differs("critMult") {
        d = round(f(d * crit));
    }
    if differs("matReq") {
        d = round(f(d * f(mat)));
    }
    if d >= 1.0 && on(opts, "hasWeapon") && differs("conditionMult") {
        d = round(f(d * cond));
    }
    d
}

fn extrema(rolls: &[f64]) -> (f64, f64, f64) {
    let (mut lo, mut hi, mut total) = (f64::INFINITY, f64::NEG_INFINITY, 0.0);
    for &d in rolls {
        lo = js_min(lo, d);
        hi = js_max(hi, d);
        total += d;
    }
    (lo, hi, total / rolls.len() as f64)
}

pub fn damage_model(
    ch: &Value,
    w: &Value,
    t: Option<&target::Target>,
    swing: &str,
    core: &str,
    opts: &Value,
    carry: &mut Carry<'_>,
) -> Value {
    let overhaul = core == "overhaul";
    let swing_damage = swing_terms(swing).0;
    let prof = proficiency(ch, w, core, opts).0;
    let race = racial(ch, w, core, opts).0;
    let crit = crit_model(ch, core, opts);
    let str_ = combat_stat(ch, "strength", opts);
    let mat_req = num(opts, "matReqMulti", 1.0);
    let dmg_mods = swing_damage + prof + race;
    let has_weapon = w.truthy();
    let two = on(w, "twoHanded");
    let (mut r, hi, pct, bonus, mat_mod) = if has_weapon {
        (
            read(w, "min", f64::NAN),
            read(w, "max", f64::NAN),
            w.get("damagePct"),
            read(w, "bonusDamage", f64::NAN),
            material_mod(w),
        )
    } else {
        let h2h = skill(ch, &n(SKILLS.hand_to_hand), opts);
        (
            (h2h / 10.0).floor() + 1.0,
            (h2h / 5.0).floor() + 1.0,
            opts.get("wraps").get("damagePct"),
            0.0, // mutation: equivalent - fist rolls never add the weapon-only bonus field.
            0.0,
        )
    };
    let mut rolls = Vec::new();
    while r <= hi {
        let rolled = if pct.truthy() {
            (r * (1.0 + pct.to_number() / 100.0)).trunc()
        } else {
            r
        };
        rolls.push(if has_weapon { rolled + bonus } else { rolled });
        r += 1.0;
    }
    let str_mod = if overhaul {
        damage::pcaao_damage_modifier(str_) * if has_weapon && two { 2.0 } else { 1.0 }
    } else {
        crate::swing::classic_strength(str_, Some(enabled(opts, "fixedStrengthDamageModifier")))
    };
    let weapon = target_weapon(w);
    // The R3 bonus only reads live Willpower; fold it once at the Value boundary.
    let mut a = target::Attacker {
        live: target::Live::default(),
        attack_modifier_flags: optional_num(ch, "attackModifierFlags"),
        career: target::Career {
            attack_modifier_flags: optional_num(ch.get("career"), "attackModifierFlags"),
            ..Default::default()
        },
    };
    let will = target::Stat::Willpower as usize;
    let raw_will = live_stat(ch, "willpower");
    a.live.stat_mods[will] = raw_will;
    a.live.stat_max[will] = f64::INFINITY;
    let bonuses = if overhaul {
        target::enemy_type_bonus_values(Some(&a), t)
    } else {
        vec![0.0]
    };
    let mut bases = Vec::new();
    let mut values = Vec::new();
    let carry_bases = yes(opts, "carryBases");
    for &r in &rolls {
        let mut base = r + dmg_mods;
        if overhaul {
            base = target::skeletal_silver_damage(base, t, weapon.as_ref());
        }
        base += str_mod + mat_mod;
        if base < 1.0 && (overhaul || has_weapon) {
            base = 0.0;
        }
        for &bonus in &bonuses {
            let d = if base >= 1.0 { base + bonus } else { base };
            if carry_bases {
                bases.push(d);
            }
            values.push(if d > 0.0 {
                weapon_blow(ch, w, d, t, opts, carry)
            } else {
                d
            });
        }
    }
    let params = obj([
        ("core", s(core)),
        ("critMult", crit.get("damageMult").clone()),
        ("matReq", n(mat_req)),
        (
            "conditionMult",
            n(condition_multiplier(
                w,
                yes(opts, "equipmentDamageEnhanced"),
            )),
        ),
        ("hasWeapon", b(has_weapon)),
        ("carried", b(yes(opts, "carried"))),
    ]);
    let finish = |critical, mult| {
        values
            .iter()
            .map(|d| finish_blow(d * mult, &params, critical))
            .collect::<Vec<_>>()
    };
    let plain = finish(false, 1.0);
    let crits = finish(true, 1.0);
    let (min, max, avg) = extrema(&plain);
    let (cmin, cmax, cavg) = extrema(&crits);
    let (rmin, rmax, _) = extrema(&rolls);
    let (group, decoded, bonus, penalty, will, level) = if overhaul {
        let r = target::enemy_type_bonus_range(Some(&a), t);
        (
            n(r.group),
            r.decoded,
            r.bonus,
            r.penalty,
            r.will,
            r.target_level,
        )
    } else {
        (
            Value::Null,
            0.0,
            0.0,
            0.0,
            0.0,
            t.and_then(|t| t.combat_level.or(t.level)).unwrap_or(1.0),
        )
    };
    let mut out = obj([
        ("min", n(min)),
        ("max", n(max)),
        ("avg", n(avg)),
        ("critMin", n(cmin)),
        ("critMax", n(cmax)),
        ("critAvg", n(cavg)),
        ("plainRolls", nums(plain)),
        ("critRolls", nums(crits)),
        ("preFinishRolls", Value::Undefined),
    ]);
    let backstab_plain = nums(finish(false, 3.0));
    let backstab_crit = nums(finish(true, 3.0));
    out.set("preFinishRolls", nums(values));
    if carry_bases {
        out.set("blowBaseRolls", nums(bases));
    }
    out.set("backstabPlainRolls", backstab_plain);
    out.set("backstabCritRolls", backstab_crit);
    out.set(
        "parts",
        obj([
            ("roll", nums([rmin, rmax])),
            ("matMod", n(mat_mod)),
            ("strMod", n(str_mod)),
            ("prof", n(prof)),
            ("racial", n(race)),
            ("twoHanded", b(two)),
            ("dmgMods", n(dmg_mods)),
            ("swingDamage", n(swing_damage)),
            (
                "enemyType",
                obj([
                    ("group", group),
                    ("decoded", n(decoded)),
                    ("bonus", n(bonus)),
                    ("penalty", n(penalty)),
                    ("will", n(will)),
                    ("targetLevel", n(level)),
                ]),
            ),
            (
                "silver",
                obj([
                    (
                        "material",
                        weapon.and_then(|w| w.material).map_or(Value::Null, n),
                    ),
                    (
                        "careerIndex",
                        t.and_then(|t| t.career_index).map_or(Value::Null, n),
                    ),
                    ("skeletal", b(target::is_skeletal_target(t))),
                    (
                        "doubled",
                        b(overhaul && target::silver_applies(t, weapon.as_ref())),
                    ),
                ]),
            ),
            ("matReq", n(mat_req)),
            ("mastery", n(mastery_pct(ch, w, opts))),
            ("martial", n(martial_blow_pct(ch, t, opts))),
            ("slayer", n(read(w, "slayer", 0.0))),
        ]),
    );
    out.set("crit", crit);
    out
}

pub fn mobile_affinity_matches(mobile_type: &Value, param: &Value) -> bool {
    use crate::generated::enchantments::AFFINITY_PARAM as A;
    let affinity = if round::to_uint32(mobile_type.to_number()) & 128 != 0 {
        "Human"
    } else {
        obj_table_get(crate::generated::enemy_basics::ENEMY_BASICS, mobile_type)
            .map_or("None", |r| r.affinity)
    };
    match affinity {
        "Undead" => param.strict_eq(&n(A.undead)),
        "Daedra" => param.strict_eq(&n(A.daedra)),
        "Human" => param.strict_eq(&n(A.humanoid)),
        "Animal" => param.strict_eq(&n(A.animals)),
        _ => false,
    }
}

pub fn payload_rows(item: &Value) -> impl Iterator<Item = &Value> {
    use crate::generated::enchantments::REGISTERED_ENCHANTMENT_TYPES;
    item.get("enchantments")
        .items()
        .iter()
        .filter(|e| e.truthy() && e.get("type").to_number() >= 0.0)
        .take_while(
            |e| matches!(e.get("type"), Value::Num(t) if REGISTERED_ENCHANTMENT_TYPES.contains(t)),
        )
}

pub fn strikes_net(item: &Value, t: Option<&target::Target>) -> f64 {
    use crate::generated::enchantments::{ENCHANTMENT_TYPES as E, LOW_DAMAGE_VS, POTENT_VS_DAMAGE};
    let Some(mobile) = t.and_then(|t| t.mobile_type) else {
        return 0.0;
    };
    payload_rows(item).fold(0.0, |a, e| {
        let t = read(e, "type", f64::NAN);
        if t == E.potent_vs && mobile_affinity_matches(&n(mobile), e.get("param")) {
            a + POTENT_VS_DAMAGE
        } else if t == E.low_damage_vs && mobile_affinity_matches(&n(mobile), e.get("param")) {
            a + LOW_DAMAGE_VS
        } else {
            a
        }
    })
}

pub fn bow_of(w: &Value, opts: &Value) -> Value {
    if !on(w, "ranged") || on(w, "gun") {
        return Value::Null;
    }
    obj([
        (
            "pull",
            if w.get("bowPull").is_nullish() {
                n(1.0)
            } else {
                w.get("bowPull").clone()
            },
        ),
        (
            "fast",
            n(if on(opts, "bowSpam") {
                crate::generated::bow_bloom::BOW_FAST.most
            } else {
                0.0
            }),
        ),
    ])
}

pub fn bow_fast_damage(bow: &Value, d: f64) -> f64 {
    use crate::generated::bow_bloom::BOW_FAST;
    let k = js_clamp(
        bow.get("fast").num_or_default(0.0).trunc(),
        0.0,
        BOW_FAST.most,
    );
    let pull = bow.get("pull").to_number();
    let pull = if pull > 0.0 { pull } else { 1.0 };
    if (k > 0.0 || pull != 1.0) && d > 0.0 {
        js_max(
            1.0,
            round::math_round((d * pull * (100.0 - BOW_FAST.cut * k)) / 100.0),
        )
    } else {
        d
    }
}

pub fn bow_blow(d: f64, bow: &Value) -> f64 {
    if bow.truthy() {
        bow_fast_damage(bow, d)
    } else {
        d
    }
}

pub fn backstab_damage(damage: f64, chance: f64, roll01: f64) -> f64 {
    if chance > 1.0 && crate::durability::dice100(chance, roll01) {
        damage * 3.0
    } else {
        damage
    }
}

fn has(traits: &[Value], key: &str) -> bool {
    traits.iter().any(|v| v.is_str(key))
}

pub fn resist_blow(traits: &[Value], d: f64, kind: &str, w: &Value, element: Option<usize>) -> f64 {
    use crate::generated::boss_traits::{ELEMENT_TRAITS, RESIST_SHARE, WEAPON_RESIST_SHARE};
    // mutation: equivalent - bossTraits.js:89-91 short-circuits empty traits or nonpositive/NaN d. Bypassing that guard leaves landed == d for empty traits, landed >= d for nonpositive d (all shares in (0, 1]), and landed < d false for NaN.
    if traits.is_empty() || d <= 0.0 || d.is_nan() {
        return d;
    }
    // bossStrike reads the RAW item template, not a weapon descriptor's skillId.
    let template = w.get("templateIndex");
    let wraps = template.strict_eq(&n(crate::generated::item_facts::HAND_WRAPS_TEMPLATE));
    let blunt = !w.truthy()
        || wraps
        || crate::value::map_table_get(crate::generated::item_facts::WEAPON_SKILL_USED, template)
            == Some(SKILLS.blunt_weapon);
    let mut landed = d;
    if kind == "spell"
        && element
            .and_then(|i| ELEMENT_TRAITS.get(i))
            .is_some_and(|e| has(traits, e))
    {
        landed *= RESIST_SHARE;
    }
    if has(traits, "bladeturning") && (kind == "arrow" || (kind == "melee" && !blunt)) {
        landed *= WEAPON_RESIST_SHARE;
    }
    if has(traits, "stoneskin") && kind == "melee" && blunt {
        landed *= WEAPON_RESIST_SHARE;
    }
    if landed < d {
        js_max(1.0, round::math_round(landed))
    } else {
        d
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BlowOutcome {
    pub p: f64,
    pub v: f64,
    pub x: f64,
    pub echo_mask: i32,
    pub echo_hits: i32,
    pub echo_eligible: bool,
    pub formula_positive: bool,
    pub strikes_damage: f64,
    pub strikes_positive: bool,
}

pub fn after_share(shared: f64, p: f64, weapon: &Value, opts: &Value) -> Vec<BlowOutcome> {
    let off_hand = on(opts, "offHand");
    let potent = opts.get("potentVs");
    let heard = if !potent.truthy() {
        0.0
    } else if off_hand {
        crate::dual_wield::OFF_HAND_BLOW_WEIGHT
    } else {
        1.0 // mutation: equivalent - 2 also skips the weighted split and takes the full payload (heard >= 1).
    };
    let payload = || js_max(0.0, shared + potent.to_number());
    let branches = if heard > 0.0 && heard < 1.0 {
        vec![(p * heard, payload()), (p * (1.0 - heard), shared)]
    } else {
        vec![(p, if heard >= 1.0 { payload() } else { shared })]
    };
    let traits = opts.get("traits").items();
    let kind = match opts.get("strikeKind") {
        Value::Undefined => "melee",
        v => v.as_str().unwrap_or(""),
    };
    let echoes = opts.get("echoes").items();
    let mut out = Vec::new();
    for (q, damage) in branches {
        let v = resist_blow(
            traits,
            bow_blow(damage, opts.get("bow")),
            kind,
            weapon,
            None,
        );
        let mut base = BlowOutcome {
            p: q,
            v,
            x: 0.0,
            echo_mask: 0,
            echo_hits: 0,
            echo_eligible: false,
            formula_positive: damage > 0.0,
            strikes_damage: shared,
            strikes_positive: shared > 0.0,
        };
        if !base.formula_positive || echoes.is_empty() || on(opts, "warded") {
            out.push(base);
            continue;
        }
        let repeated = js_max(1.0, round::math_round(damage));
        base.echo_eligible = true;
        for mask in 0..1_i32.wrapping_shl(echoes.len() as u32) {
            let mut pr = q;
            let mut k = 0;
            for (i, c) in echoes.iter().enumerate() {
                let hit = mask.wrapping_shr(i as u32) & 1;
                let chance = c.to_number() / 100.0;
                pr *= if hit != 0 { chance } else { 1.0 - chance };
                k += hit;
            }
            if pr <= 0.0 || pr.is_nan() {
                continue;
            }
            let mut row = BlowOutcome {
                p: pr,
                echo_mask: mask,
                echo_hits: k,
                ..base
            };
            if k != 0 {
                let owed = f64::from(k) * repeated;
                if on(opts, "relay") {
                    row.v += resist_blow(traits, owed, "melee", weapon, None);
                } else {
                    row.x = owed;
                }
            }
            out.push(row);
        }
    }
    out
}

pub fn resolve_blow(
    d: f64,
    part: f64,
    t: Option<&target::Target>,
    w: &Value,
    opts: &Value,
) -> Vec<BlowOutcome> {
    let weapon = target_weapon(w);
    target::target_part_outcomes(t, d, part, weapon.as_ref(), false)
        .into_iter()
        .flat_map(|row| {
            let shared = if on(opts, "offHand") {
                crate::dual_wield::off_hand_damage(row.damage)
            } else {
                row.damage
            };
            after_share(shared, row.p, w, opts)
        })
        .collect()
}

fn json_shape(v: &Value) -> Value {
    match v {
        Value::Obj(xs) => Value::Obj(
            xs.iter()
                .filter(|(_, v)| !matches!(v, Value::Undefined))
                .map(|(k, v)| (k.clone(), json_shape(v)))
                .collect(),
        ),
        Value::Arr(xs) => Value::Arr(xs.iter().map(json_shape).collect()),
        Value::Num(x) if !x.is_finite() => Value::Null,
        Value::Undefined => Value::Null,
        _ => v.clone(),
    }
}

pub fn additions_to(held: &[Value], imprints: &[Value]) -> Vec<Value> {
    imprints
        .iter()
        .filter(|p| {
            !held.iter().any(|q| {
                matches!(q, Value::Undefined) == matches!(p, Value::Undefined)
                    && json_shape(q) == json_shape(p)
            })
        })
        .cloned()
        .collect()
}

pub fn weapon_powers(w: &Value, opts: &Value) -> Vec<Value> {
    let held = w.get("powers").items();
    let mut out = held.to_vec();
    out.extend(additions_to(held, opts.get("imprints").items()));
    out
}

pub fn echo_chances(powers: &[Value]) -> Vec<f64> {
    powers
        .iter()
        .filter(|p| tag(p, "kind") == "echo")
        .map(|p| num(p, "chance", 0.0))
        .filter(|&c| c > 0.0)
        .collect()
}

pub fn blow_distribution(
    rolls: &[f64],
    part: f64,
    t: Option<&target::Target>,
    w: &Value,
    opts: &Value,
) -> Vec<(f64, f64)> {
    let mut ctx = object_or_empty(opts);
    ctx.set(
        "strikeKind",
        s(if on(w, "ranged") { "arrow" } else { "melee" }),
    );
    ctx.set("bow", bow_of(w, opts));
    ctx.set("relay", b(t.is_some_and(|t| t.relay_body == Some(true))));
    ctx.set("warded", b(t.is_some_and(|t| t.warded)));
    let cap = opts.get("cap").to_number();
    let mut out: Vec<(f64, f64)> = Vec::new();
    for &d in rolls {
        for row in resolve_blow(d, part, t, w, &ctx) {
            let value = (if cap > 0.0 { js_min(row.v, cap) } else { row.v }) + row.x;
            let p = row.p / rolls.len() as f64;
            if let Some((_, old)) = out
                .iter_mut()
                .find(|(v, _)| n(*v).same_value_zero(&n(value)))
            {
                *old += p;
            } else {
                out.push((if value == 0.0 { 0.0 } else { value }, 0.0 + p));
            }
        }
    }
    out
}
