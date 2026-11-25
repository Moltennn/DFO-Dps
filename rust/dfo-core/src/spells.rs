//! SPELLS.STD and the pure spell model (`src/spells.js`).
use crate::boss_traits::element_trait_of;
use crate::generated::{boss_traits::RESIST_SHARE, data::SKILLS, races, spell_tables};
use crate::round::{js_clamp, js_max, js_min, to_int32};
use crate::save::{effective_skill, skill_value};
use crate::target;
use crate::value::{index_key, obj_table_get, Value, Value::Num};

pub use spell_tables::{CAST_COST_FLOOR, EFFECT_COST_TABLE, MAGIC_ROUND_SECONDS, TARGET_COST_MULT};
pub const SPELL_RECORD_SIZE: usize = spell_tables::SPELL_RECORD_SIZE as usize;

pub(crate) fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Obj(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
pub(crate) fn numbers(fields: impl IntoIterator<Item = (&'static str, f64)>) -> Value {
    object(fields.into_iter().map(|(k, v)| (k, Num(v))))
}

const DURATION: [&str; 3] = ["durationBase", "durationMod", "durationPerLevel"];
const CHANCE: [&str; 3] = ["chanceBase", "chanceMod", "chancePerLevel"];
const MAGNITUDE: [&str; 5] = [
    "magnitudeBaseLow",
    "magnitudeBaseHigh",
    "magnitudeLevelBase",
    "magnitudeLevelHigh",
    "magnitudePerLevel",
];

/// Classic 89-byte stride. The cost is LE, and names are byte-valued code units, not UTF-8.
pub fn read_spell_record(bytes: &[u8], offset: usize) -> Option<Value> {
    let bytes = bytes.get(offset..)?.get(..SPELL_RECORD_SIZE)?;
    let effects: Vec<_> = (0..3)
        .map(|i| {
            numbers(
                [
                    ("type", f64::from(bytes[2 * i] as i8)),
                    ("subType", f64::from(bytes[2 * i + 1] as i8)),
                ]
                .into_iter()
                .chain(
                    DURATION
                        .into_iter()
                        .zip(bytes[14 + 3 * i..].iter().copied().map(f64::from)),
                )
                .chain(
                    CHANCE
                        .into_iter()
                        .zip(bytes[23 + 3 * i..].iter().copied().map(f64::from)),
                )
                .chain(
                    MAGNITUDE
                        .into_iter()
                        .zip(bytes[32 + 5 * i..].iter().copied().map(f64::from)),
                ),
            )
        })
        .collect();
    if !effects.iter().any(|e| e.get("type").to_number() > -1.0) {
        return None;
    }
    Some(object([
        ("effects", Value::Arr(effects)),
        ("element", Num(bytes[6].into())),
        ("rangeType", Num(bytes[7].into())),
        ("cost", Num(u16::from_le_bytes([bytes[8], bytes[9]]).into())),
        (
            "name",
            Value::Str(
                bytes[47..72]
                    .split(|&b| b == 0)
                    .next()
                    .unwrap()
                    .iter()
                    .copied()
                    .map(char::from)
                    .collect(),
            ),
        ),
        ("icon", Num(bytes[72].into())),
        ("index", Num(bytes[73].into())),
    ]))
}

pub fn read_spells_std(bytes: &[u8]) -> Vec<Value> {
    bytes
        .as_chunks::<SPELL_RECORD_SIZE>()
        .0
        .iter()
        .filter_map(|chunk| {
            let mut record = read_spell_record(chunk, 0)?;
            let first = &record.get("effects").items()[0];
            if record.get("index").strict_eq(&Num(10.0))
                && first.get("type").strict_eq(&Num(3.0))
                && first.get("subType").strict_eq(&Num(2.0))
            {
                let mut effects = record.get("effects").items().to_vec();
                effects[0].set("type", Num(26.0));
                effects[0].set("subType", Num(-1.0));
                record.set("effects", Value::Arr(effects));
            }
            Some(record)
        })
        .collect()
}

/// The caller owns this snapshot; no config, I/O, or caching in core.
#[derive(Clone, Debug, Default)]
pub struct Spellbook(Vec<(Value, Value)>);

impl Spellbook {
    pub fn get(&self, index: &Value) -> Option<&Value> {
        self.0
            .iter()
            .find(|(id, _)| id.same_value_zero(index))
            .map(|(_, sp)| sp)
    }

    pub fn entries(&self) -> &[(Value, Value)] {
        &self.0
    }
}

pub fn spells_by_index_map(records: impl IntoIterator<Item = Value>) -> Spellbook {
    let mut book = Spellbook::default();
    for sp in records {
        let index = sp.get("index");
        if book.get(index).is_none() {
            book.0.push((index.clone(), sp));
        }
    }
    book
}

pub fn resolve_spells<'a>(spells: &'a Value, standard: &'a Spellbook) -> Vec<&'a Value> {
    spells
        .items()
        .iter()
        .filter_map(|sp| match sp {
            Num(_) => standard.get(sp),
            _ if matches!(sp.get("effects"), Value::Arr(_)) => Some(sp),
            _ => None,
        })
        .collect()
}

fn entry(e: &Value) -> Option<spell_tables::EffectCostTableValue> {
    let key = format!(
        "{},{}",
        e.get("type").to_js_string(),
        to_int32(e.get("subType").to_number()) & 0xff
    );
    EFFECT_COST_TABLE
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, row)| *row)
}

pub fn effect_school(e: &Value) -> f64 {
    entry(e).map_or(SKILLS.destruction, |r| r.skill)
}

fn component(a: f64, b: f64, offset: f64, [base, increase, per]: [f64; 3]) -> f64 {
    (offset + a * base + b * (increase / js_max(1.0, per)).trunc()).trunc()
}

pub fn effect_cost(e: &Value, skill_of: impl FnOnce(f64) -> f64, online: bool) -> (f64, f64) {
    let Some(row) = entry(e) else {
        return (0.0, 0.0);
    };
    let skill = skill_of(row.skill);
    let get = |k| e.get(k).to_number();
    let mut gold = 0.0;
    if let Some(c) = row.duration {
        gold += component(c.a, c.b, c.offset, DURATION.map(get));
    }
    if let Some(c) = row.chance {
        gold += component(c.a, c.b, c.offset, CHANCE.map(get));
    }
    if let Some(c) = row.magnitude {
        let [lo, hi, ll, lh, per] = MAGNITUDE.map(get);
        gold += component(
            c.a,
            c.b,
            c.offset,
            [((lo + hi) / 2.0).trunc(), ((ll + lh) / 2.0).trunc(), per],
        );
    }
    if row.duration.is_none() && row.chance.is_none() && row.magnitude.is_none() {
        gold += component(60.0, 100.0, 160.0, [1.0; 3]);
    }
    let r = 100.0;
    let sp = if online && skill > r {
        (gold * (110.0 - r) * r) / (skill * 400.0)
    } else {
        (gold * (110.0 - skill)) / 400.0
    };
    (gold, sp.trunc())
}

pub fn spell_cost(spell: &Value, ch: &Value, online: bool) -> f64 {
    let mut sp = 0.0;
    for e in spell.get("effects").items() {
        // No negative effect type has a row; effect_cost returns (+0, +0) for those records.
        sp += effect_cost(e, |id| skill_value(ch, &Num(id)), online).1;
    }
    // `TARGET_COST_MULT[rangeType]` is a property read: the string "2" names the same row as the number.
    let range = index_key(&spell.get("rangeType").to_js_string())
        .and_then(|i| obj_table_get(TARGET_COST_MULT, &Num(i.into())));
    sp = (sp * range.unwrap_or(1.0)).trunc();
    if spell.get("minimumCastingCost").truthy() {
        sp = CAST_COST_FLOOR;
    }
    js_max(CAST_COST_FLOOR, sp)
}

#[derive(Clone, Copy, Debug, Default)]
pub enum Mode {
    #[default]
    Avg,
    Min,
    Max,
}

pub fn magnitude_at(e: &Value, level: f64, mode: Mode) -> f64 {
    let [lo, hi, ll, lh, per] = MAGNITUDE.map(|k| e.get(k).to_number());
    let (base, plus) = match mode {
        Mode::Avg => ((lo + hi) / 2.0, (ll + lh) / 2.0),
        Mode::Min => (lo, ll),
        Mode::Max => (hi, lh),
    };
    base + plus * (level / js_max(1.0, per)).floor()
}

pub fn spell_rounds(e: &Value, level: f64) -> f64 {
    let [base, increase, per] = DURATION.map(|k| e.get(k).to_number());
    base + increase * js_max(1.0, (level / js_max(1.0, per)).floor())
}

pub fn spell_has_flags(element: f64, check: i32, flags: i32) -> bool {
    use target::*;
    (element == 0.0 && check & FIRE as i32 != 0)
        || (element == 1.0 && check & FROST as i32 != 0)
        || (element == 2.0 && check & flags & (DISEASE as i32 | POISON as i32) != 0)
        || (element == 3.0 && check & SHOCK as i32 != 0)
        || (element == 4.0 && check & MAGIC as i32 != 0)
        || (flags & PARALYSIS as i32 != 0 && check & PARALYSIS as i32 != 0)
}

pub fn race_by_id(id: &Value) -> Option<&'static races::RaceTemplatesItem> {
    races::RACE_TEMPLATES
        .iter()
        .find(|r| id.strict_eq(&Num(r.id)))
}

pub fn race_by_key(key: &Value) -> Option<&'static races::RaceTemplatesItem> {
    races::RACE_TEMPLATES.iter().find(|r| key.is_str(r.key))
}

/// Client entity climb for CWS (spellPower.js:56–57), distinct from report potency.
pub fn fighting_climb(entity: &Value, id: &Value) -> Value {
    let raw = entity.get("skills").prop(id);
    let mut raw = if raw.is_nullish() { Num(0.0) } else { raw };
    if entity.get("isPlayer").truthy() && raw.to_number() > 100.0 {
        let active = entity.get("_online").strict_eq(&Value::Bool(true))
            || entity.get("masterSkills").strict_eq(&Value::Bool(true));
        let mastered = id.is_nullish()
            || entity
                .get("masteredSkills")
                .items()
                .iter()
                .any(|v| v.same_value_zero(id));
        if !(active && mastered) {
            raw = Num(100.0);
        }
    }
    let mentor = entity.get("_mentor");
    let baseline = spell_tables::MENTOR_SKILL_BASELINE;
    if mentor.truthy() && raw.to_number() > baseline {
        let n = raw.to_number();
        let scaled = baseline + (n - baseline) * mentor.get("skillFactor").to_number();
        raw = Num(js_max(
            js_min(n, baseline),
            js_min(
                js_min(n, mentor.get("skillCeiling").to_number()),
                scaled.floor(),
            ),
        ));
    }
    if raw.to_number() > 100.0 {
        // The client enters the overcap branch before clampSkill maps non-numbers to zero (effective 75).
        Num(if matches!(raw, Num(n) if n.is_finite()) {
            effective_skill(&raw)
        } else {
            75.0
        })
    } else {
        raw
    }
}

pub fn saving_chance_outcome(target: &Value, opts: &Value) -> (f64, bool) {
    use crate::target::*;
    // A string element (a save or custom record) is NaN to the strict compares below, as in the JS, but still names
    // its flag: `ELEMENT_FLAG_BY_INDEX[element]` reads it as a property key.
    let raw = opts.get("element");
    let element = raw.num_or(4.0);
    // A nullish element names no row and lands on Magic, which is the default element's flag too.
    let default = index_key(&raw.to_js_string())
        .and_then(|i| ELEMENT_FLAG_BY_INDEX.get(i as usize))
        .map_or(MAGIC, |f| *f);
    let flags = to_int32(opts.get("effectFlags").finite_or(default));
    let player = target.get("isPlayer").truthy();
    let mut saving = 50.0;
    if player {
        let r = target.get("raceTemplate");
        let names = [
            "resistanceFlags",
            "immunityFlags",
            "lowToleranceFlags",
            "criticalWeaknessFlags",
        ];
        let tolerances = if r.is_nullish() {
            race_by_id(target.get("raceId"))
                .or_else(|| race_by_key(target.get("race")))
                .map_or([0; 4], |r| {
                    [
                        r.resistance_flags,
                        r.immunity_flags,
                        r.low_tolerance_flags,
                        r.critical_weakness_flags,
                    ]
                    .map(to_int32)
                })
        } else {
            names.map(|k| to_int32(r.get(k).to_number()))
        };
        let [resistant, immune, low, critical] =
            tolerances.map(|check| spell_has_flags(element, check, flags));
        if resistant {
            saving += 30.0;
        }
        if immune {
            saving = 100.0;
        }
        if low {
            saving -= 25.0;
        }
        if critical {
            saving -= 50.0;
        }
    }
    let c = target.get("career");
    let career = Career {
        resistance_flags: Some(c.get("resistanceFlags").to_number()),
        immunity_flags: Some(c.get("immunityFlags").to_number()),
        low_tolerance_flags: Some(c.get("lowToleranceFlags").to_number()),
        critical_weakness_flags: Some(c.get("criticalWeaknessFlags").to_number()),
        ..Career::default()
    };
    let mut seen = [false; 4]; // mutation: equivalent - only indices 0..=3 are named, and zip consumes exactly four entries.
    let mut biography = 0.0;
    for (flag, bio) in [
        (PARALYSIS, None),
        (MAGIC, Some("biographyResistMagicMod")),
        (POISON, Some("biographyResistPoisonMod")),
        (FIRE, None),
        (FROST, None),
        (SHOCK, None),
        (DISEASE, Some("biographyResistDiseaseMod")),
    ] {
        if flags & flag as i32 == 0 {
            continue;
        }
        match career_tolerance(&career, flag) {
            Tolerance::Immune => seen[0] = true,
            Tolerance::CriticalWeakness => seen[1] = true,
            Tolerance::LowTolerance => seen[2] = true,
            Tolerance::Resistant => seen[3] = true,
            Tolerance::Normal => (),
        }
        if let Some(k) = bio.filter(|_| player) {
            biography += target.get(k).num_or_default(0.0);
        }
    }
    for (active, amount) in seen.into_iter().zip([50.0, -50.0, -25.0, 25.0]) {
        if active {
            saving += amount;
        }
    }
    saving += biography + opts.get("modifier").num_or_default(0.0);
    let resist = target.get("_mods").get("resist");
    for (flag, k) in [
        (FIRE, "fire"),
        (FROST, "frost"),
        (SHOCK, "shock"),
        (POISON, "poison"),
        (MAGIC, "magic"),
    ] {
        if flags & flag as i32 != 0 {
            saving += resist.get(k).num_or_default(0.0);
        }
    }
    if saving >= 100.0 {
        return (100.0, true);
    }
    let will = if target.is_nullish() {
        50.0 // mutation: equivalent - both 50 and 51 contribute trunc(will / 10) == 5.
    } else {
        crate::save::live_stat(target, "willpower")
    };
    // mutation: equivalent - live_stat clamps willpower to [0, ...] or NaN; replacing the lower guard 0 with 1 still truncates willpower < 1 to zero.
    saving += (js_max(0.0, will) / 10.0).trunc();
    saving -= js_max(0.0, opts.get("pierce").num_or_default(0.0));
    (js_clamp(saving, 5.0, 95.0), false)
}

pub fn saving_chance(target: &Value, opts: &Value) -> f64 {
    saving_chance_outcome(target, opts).0
}

pub fn saving_lands(saving: f64) -> f64 {
    let mut sum = 0.0;
    for roll in 1..=100 {
        let roll = f64::from(roll);
        // mutation: equivalent - at roll == saving, the following branch subtracts zero and also contributes 100.
        sum += if roll > saving {
            100.0
        // mutation: equivalent - equality is saving == roll + 20 (subtraction is exact near the equality for integer roll 1..100); that contribution is exactly zero.
        } else if saving - 20.0 <= roll {
            100.0 - 5.0 * (saving - roll)
        } else {
            0.0
        };
    }
    sum / 100.0
}

fn level(ch: &Value, opts: &Value) -> f64 {
    if matches!(opts.get("level"), Value::Undefined) {
        ch.get("level").num_or(1.0)
    } else {
        opts.get("level").to_number()
    }
}

fn online(ch: &Value, opts: &Value) -> bool {
    if matches!(opts.get("online"), Value::Undefined) {
        !ch.get("online").strict_eq(&Value::Bool(false))
    } else {
        opts.get("online").truthy()
    }
}

pub fn spell_damage(spell: &Value, ch: &Value, target: &Value, opts: &Value, mode: Mode) -> Value {
    if !spell.truthy() {
        return object([
            ("damage", Num(0.0)),
            ("effects", Value::Arr(vec![])),
            ("school", Num(SKILLS.destruction)),
            ("saving", Num(0.0)),
        ]);
    }
    let level = level(ch, opts);
    let element = spell.get("element").num_or(4.0);
    let resist_mult = if element_trait_of(element)
        .is_some_and(|k| target.get("bossTraits").items().iter().any(|v| v.is_str(k)))
    {
        RESIST_SHARE
    } else {
        1.0
    };
    let rows = spell.get("effects").items();
    let school = rows.first().map_or(SKILLS.destruction, effect_school);
    let climb = effective_skill(&ch.get("skills").prop(&Num(school)));
    // mutation: equivalent - `>` -> `>=` differs only at climb == 100.0, where `1.0 + (100.0 - 100.0) * 0.01` is
    // `1.0 + 0.0`, bit-identical to the else branch's 1.0.
    let school_mult = if online(ch, opts) && climb > 100.0 {
        1.0 + (climb - 100.0) * 0.01
    } else {
        1.0
    };
    let potency = opts.get("potencyPct").num_or(0.0);
    let power_mult = school_mult * js_max(0.5, 1.0 + js_min(50.0, potency) / 100.0) * resist_mult;
    let (chance, immune) = saving_chance_outcome(
        target,
        &object([
            (
                "element",
                crate::theory::nullish(spell.get("element"), Num(4.0)),
            ),
            ("pierce", opts.get("pierce").clone()),
            ("effectFlags", spell.get("effectFlags").clone()),
        ]),
    );
    let saving = if immune {
        0.0
    } else {
        saving_lands(chance) / 100.0
    };
    let (mut instant, mut dot_per_tick, mut dot_rounds) = (0.0, 0.0, 0.0);
    let mut effects = Vec::new();
    for e in rows {
        let ty = e.get("type");
        if ty.to_number() <= -1.0 {
            continue;
        }
        let key = format!("{},{}", ty.to_js_string(), e.get("subType").to_js_string());
        if !matches!(key.as_str(), "4,0" | "1,0" | "11,8") {
            effects.push(object([
                ("key", Value::Str(key)),
                ("damage", Num(0.0)),
                ("note", Value::Str("not health damage".into())),
            ]));
            continue;
        }
        let mag = magnitude_at(e, level, mode);
        let dot = ty.strict_eq(&Num(1.0));
        let rounds = if dot { spell_rounds(e, level) } else { 1.0 };
        let tick = mag * saving * power_mult;
        if dot {
            dot_per_tick += tick;
            dot_rounds = js_max(dot_rounds, rounds);
        } else {
            instant += tick;
        }
        effects.push(object([
            ("key", Value::Str(key)),
            ("magnitude", Num(mag)),
            ("rounds", Num(rounds)),
            (
                "seconds",
                Num(if dot {
                    rounds * MAGIC_ROUND_SECONDS
                } else {
                    0.0
                }),
            ),
            ("perTick", Num(tick)),
            ("damage", Num(if dot { tick * rounds } else { tick })),
            ("dot", Value::Bool(dot)),
        ]));
    }
    let dot_total = dot_per_tick * dot_rounds;
    object([
        ("damage", Num(instant + dot_total)),
        ("instant", Num(instant)),
        ("dotPerTick", Num(dot_per_tick)),
        ("dotRounds", Num(dot_rounds)),
        ("dotSeconds", Num(dot_rounds * MAGIC_ROUND_SECONDS)),
        ("dotTotal", Num(dot_total)),
        ("effects", Value::Arr(effects)),
        ("school", Num(school)),
        ("saving", Num(saving)),
        ("powerMult", Num(power_mult)),
        ("resistMult", Num(resist_mult)),
    ])
}

pub fn cast_rate(ch: &Value, cast_speed_pct: f64) -> f64 {
    let speed = js_clamp(ch.get("stats").get("speed").num_or(50.0), 0.0, 100.0);
    js_clamp(
        1.0 + (speed - 50.0) / 200.0 + cast_speed_pct / 100.0,
        0.5,
        2.0,
    )
}

pub fn analyze_spell(spell: &Value, ch: &Value, target: &Value, opts: &Value) -> Value {
    let [avg, min, max] =
        [Mode::Avg, Mode::Min, Mode::Max].map(|m| spell_damage(spell, ch, target, opts, m));
    let cost = spell_cost(spell, ch, online(ch, opts));
    let cast_seconds = 0.7 / cast_rate(ch, opts.get("castSpeedPct").num_or(0.0));
    let magicka = opts.get("magicka").num_or(
        ch.get("maxMagicka")
            .num_or((ch.get("stats").get("intelligence").num_or(50.0) * 3.0).floor()),
    );
    let casts = if cost.is_nan() {
        0.0
    } else {
        (magicka / cost).floor()
    };
    let read = |d: &Value, k| d.get(k).to_number();
    let [burst, burst_min, burst_max] =
        [&avg, &min, &max].map(|d| read(d, "instant") / cast_seconds);
    let [dot, dot_min, dot_max] =
        [&avg, &min, &max].map(|d| read(d, "dotPerTick") / MAGIC_ROUND_SECONDS);
    let dps = burst + dot;
    let health = opts.get("health").num_or(0.0);
    let default = |k, d| {
        let v = spell.get(k);
        if v.is_nullish() {
            d
        } else {
            v.clone()
        }
    };
    object([
        ("name", default("name", Value::Str("spell".into()))),
        ("index", default("index", Value::Null)),
        ("cost", Num(cost)),
        ("damage", avg.get("damage").clone()),
        ("damageMin", min.get("damage").clone()),
        ("damageMax", max.get("damage").clone()),
        ("instant", avg.get("instant").clone()),
        ("instantMin", min.get("instant").clone()),
        ("instantMax", max.get("instant").clone()),
        ("dotPerTick", avg.get("dotPerTick").clone()),
        ("dotPerTickMin", min.get("dotPerTick").clone()),
        ("dotPerTickMax", max.get("dotPerTick").clone()),
        ("dotRounds", avg.get("dotRounds").clone()),
        ("dotSeconds", avg.get("dotSeconds").clone()),
        ("dotTotal", avg.get("dotTotal").clone()),
        ("burstDps", Num(burst)),
        ("dotDps", Num(dot)),
        ("dps", Num(dps)),
        ("burstDpsMin", Num(burst_min)),
        ("burstDpsMax", Num(burst_max)),
        ("dotDpsMin", Num(dot_min)),
        ("dotDpsMax", Num(dot_max)),
        ("dpsMin", Num(burst_min + dot_min)),
        ("dpsMax", Num(burst_max + dot_max)),
        ("castSeconds", Num(cast_seconds)),
        ("castsPerPool", Num(casts)),
        ("poolDamage", Num(read(&avg, "damage") * casts)),
        ("poolSeconds", Num(casts * cast_seconds)),
        ("magicka", Num(magicka)),
        ("saving", avg.get("saving").clone()),
        ("school", avg.get("school").clone()),
        ("powerMult", avg.get("powerMult").clone()),
        ("elements", avg.get("effects").clone()),
        ("rangeType", default("rangeType", Num(0.0))),
        ("element", default("element", Num(4.0))),
        (
            "ttk",
            if health > 0.0 && dps > 0.0 {
                Num(health / dps)
            } else {
                Value::Null
            },
        ),
    ])
}

pub fn spell_rotation(spell: &Value, ch: &Value, target: &Value, opts: &Value) -> Value {
    let mut card = analyze_spell(spell, ch, target, opts);
    let get = |k| card.get(k).to_number();
    let (cost, magicka, cast_seconds, dot_seconds) = (
        get("cost"),
        get("magicka"),
        get("castSeconds"),
        get("dotSeconds"),
    );
    let seconds = opts.get("seconds").num_or(30.0);
    let mana_solved =
        opts.get("manaSolved").truthy() || matches!(opts.get("manaSolved"), Value::Undefined);
    let max_casts = if !mana_solved && !cost.is_nan() {
        (magicka / cost).floor()
    } else {
        f64::INFINITY
    };
    let dot_only = get("instant") == 0.0 && get("dotRounds") > 0.0;
    let wanted = if dot_only {
        js_max(1.0, (seconds / js_max(1.0, dot_seconds)).ceil())
    } else if !cast_seconds.is_nan() {
        (seconds / cast_seconds).ceil()
    } else {
        0.0
    };
    let casts = js_max(0.0, js_min(max_casts, wanted));
    let time = casts * cast_seconds;
    let fight = if mana_solved {
        seconds
    } else {
        js_min(seconds, time)
    };
    let active = js_min(fight, dot_seconds);
    let instant = ["instant", "instantMin", "instantMax"].map(|k| get(k) * casts);
    let dot = ["dotPerTick", "dotPerTickMin", "dotPerTickMax"]
        .map(|k| get(k) * (active / MAGIC_ROUND_SECONDS));
    let total = std::array::from_fn::<_, 3, _>(|i| instant[i] + dot[i]);
    let dot_dps = dot.map(|d| d / js_max(1e-9, active));
    let mana = if dot_only {
        dot_dps
    } else {
        total.map(|d| if time > 0.0 { d / time } else { 0.0 })
    };
    let window = total.map(|d| if seconds > 0.0 { d / seconds } else { 0.0 });
    for (k, v) in [
        ("seconds", seconds),
        ("casts", casts),
        ("fightSeconds", fight),
        ("timeToEmpty", time),
        ("instantDamage", instant[0]),
        ("dotDamage", dot[0]),
        ("totalDamage", total[0]),
        ("totalDamageMin", total[1]),
        ("totalDamageMax", total[2]),
        ("manaDps", mana[0]),
        ("manaDpsMin", mana[1]),
        ("manaDpsMax", mana[2]),
        ("windowDps", window[0]),
        ("windowDpsMin", window[1]),
        ("windowDpsMax", window[2]),
        ("dotDps", dot_dps[0]),
        ("dotDpsMin", dot_dps[1]),
        ("dotDpsMax", dot_dps[2]),
    ] {
        card.set(k, Num(v));
    }
    card.set("manaSolved", Value::Bool(mana_solved));
    for (k, v) in [
        ("sustainedDps", window[0]),
        ("sustainedDpsMin", window[1]),
        ("sustainedDpsMax", window[2]),
    ] {
        card.set(k, Num(v));
    }
    card.set(
        "manaLeft",
        if mana_solved {
            Value::Null
        } else {
            Num(magicka - casts * cost)
        },
    );
    let health = opts.get("health").num_or(0.0);
    card.set(
        "poolKill",
        if health > 0.0 {
            Value::Bool(total[0] >= health)
        } else {
            Value::Null
        },
    );
    card.set(
        "ttk",
        if health > 0.0 && mana[0] > 0.0 && (mana_solved || total[0] >= health) {
            Num(health / mana[0])
        } else {
            Value::Null
        },
    );
    card
}
