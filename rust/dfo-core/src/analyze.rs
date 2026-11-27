//! Deterministic report cards and what-ifs (`src/model.js:82,1064–1842`).
use crate::allowance::{self, ClaimInput, Kind, Phase, Proc, Report, Spec, Stream};
use crate::blow_outcomes::defence_target;
use crate::dual_wield::{dual_schedule, off_hand_burden, off_hand_damage, OFF_HAND_BLOW_WEIGHT};
use crate::generated::data::{CURB_SHARE, RRI_WEAPON_DAMAGE, SKILLS, WARD_SHARE, WRATH_AFTER_S};
pub use crate::generated::mint_rows::GATE_BODY_LEVEL;
use crate::model_blow::{self as model, BlowOutcome, Carry};
use crate::round::{js_clamp, js_max, js_min, math_round};
use crate::spells::{object as obj, Spellbook};
use crate::target::{self, Core, Target};
use crate::value::obj_table_get;
use crate::value::Value::{self, Arr, Bool, Null, Num, Obj, Undefined};

fn s(text: &str) -> Value {
    Value::Str(text.into())
}

fn default(v: &Value, fallback: Value) -> Value {
    if matches!(v, Undefined) {
        fallback
    } else {
        v.clone()
    }
}

fn nullish(v: &Value, fallback: Value) -> Value {
    if v.is_nullish() {
        fallback
    } else {
        v.clone()
    }
}

fn number(v: &Value, key: &str) -> f64 {
    v.get(key).to_number()
}

fn numbers(values: impl IntoIterator<Item = f64>) -> Value {
    Arr(values.into_iter().map(Num).collect())
}

const STATS: [&str; 8] = [
    "strength",
    "intelligence",
    "willpower",
    "agility",
    "endurance",
    "personality",
    "speed",
    "luck",
];

fn skills(values: impl IntoIterator<Item = (i64, f64)>) -> Value {
    Obj(values
        .into_iter()
        .map(|(k, v)| (k.to_string(), Num(v)))
        .collect())
}

fn target_record(
    level: f64,
    is_class: bool,
    stats: Value,
    skills: Value,
    armor: Vec<Value>,
) -> Value {
    obj([
        ("isPlayer", Bool(false)),
        ("isClass", Bool(is_class)),
        ("level", Num(level)),
        ("combatLevel", Num(level)),
        ("mobileType", Null),
        ("careerIndex", Num(-1.0)),
        ("career", Null),
        ("affinity", Null),
        ("group", Null),
        ("stats", stats),
        ("skills", skills),
        ("armorValues", Arr(armor)),
        ("equip", obj([("slots", Obj(vec![]))])),
        ("minMetalToHit", Num(-1.0)),
        ("spareGear", Bool(false)),
        ("health", Num(100.0)),
        ("maxHealth", Num(100.0)),
        ("activeEffects", Arr(vec![])),
    ])
}

/// JS:1614. An undefined preset takes the tough default.
pub fn reference_foe(level: &Value, preset: &Value) -> Value {
    let level = level.finite_or(1.0);
    let (is_class, armor) = match preset.as_str() {
        Some("soft") => (false, 30.0),
        Some("armoured") => (false, -50.0),
        Some("human") => (true, 60.0),
        _ if preset.get("isClass").truthy() => (true, 60.0),
        _ => (false, preset.get("armorValue").finite_or(0.0) * 5.0),
    };
    let stat = obj(STATS.map(|k| (k, Num(50.0))));
    let skill = js_min(100.0, level * 5.0 + 30.0);
    let mut t = target_record(
        level,
        is_class,
        stat,
        skills((0..35).map(|i| (i, skill))),
        vec![Num(armor); 7],
    );
    t.set("group", nullish(preset.get("group"), Null));
    t.set("affinity", nullish(preset.get("affinity"), Null));
    t.set("healthShare", Num(preset.get("healthShare").finite_or(1.0)));
    t
}

fn boss_fields(mut t: Value, opts: &Value) -> Value {
    let health = default(opts.get("health"), Num(5000.0));
    t.set(
        "level",
        Num(default(opts.get("level"), Num(30.0)).finite_or(1.0)),
    );
    t.set("health", health.clone());
    t.set("maxHealth", health);
    t.set("isBoss", Bool(true));
    t.set("bossTraits", Arr(opts.get("traits").items().to_vec()));
    if !opts.get("group").is_nullish() {
        t.set("group", opts.get("group").clone());
    }
    t.set("healthShare", Num(1.0));
    for k in ["hitCap", "phaseShields", "shieldSeconds"] {
        t.set(k, default(opts.get(k), Num(0.0)));
    }
    t.set("spareGear", default(opts.get("spareGear"), Bool(true)));
    t
}

/// JS:1661. A typed mint supplies the stand-in; `basics` retains the original JS row shape.
pub fn boss_target(opts: &Value) -> Result<Value, String> {
    let mobile = opts.get("mobileType");
    if !mobile.is_nullish() {
        let set: Vec<_> = [
            "armorValue",
            "isClass",
            "careerIndex",
            "career",
            "affinity",
            "minMetalToHit",
        ]
        .into_iter()
        .filter(|k| !opts.get(k).is_nullish())
        .collect();
        if !set.is_empty() {
            return Err(format!("bossTarget: mobile {}'s body is the game's stand-in (standInTarget); {} cannot be set beside it", mobile.to_js_string(), set.join(", ")));
        }
        let id = Num(mobile.to_number());
        let body = crate::mint::stand_in_target(id.to_number(), &crate::boot::Boot::shipped())
            .map_err(|_| format!("bossTarget: no stand-in body for {}", mobile.to_js_string()))?;
        let basics = obj_table_get(crate::generated::mint_rows::STAND_IN_BASICS, &id)
            .expect("minted stand-in has an original row");
        let mut t = target_record(
            body.level.expect("minted level"),
            body.is_class.unwrap_or(false),
            obj(STATS.into_iter().zip(body.live.stats.map(Num))),
            skills(body.skills),
            body.armor_values.into_iter().map(Num).collect(),
        );
        t.set("mobileType", id);
        t.set("careerIndex", body.career_index.canon());
        t.set("affinity", body.affinity.as_deref().map_or(Null, s));
        t.set("group", body.group.as_deref().map_or(Null, s));
        t.set("minMetalToHit", body.min_metal_to_hit.canon());
        t.set(
            "basics",
            crate::value::parse(basics).expect("generated ordered stand-in row"),
        );
        t.set("levelSource", s("mint"));
        t.set("relayBody", Bool(true));
        return Ok(boss_fields(t, opts));
    }
    let is_class = opts.get("isClass").truthy();
    let mut t = reference_foe(
        &default(opts.get("level"), Num(30.0)),
        &obj([
            ("isClass", Bool(is_class)),
            ("armorValue", nullish(opts.get("armorValue"), Num(0.0))),
        ]),
    );
    let ci = nullish(opts.get("careerIndex"), Num(-1.0));
    let affinity = nullish(
        opts.get("affinity"),
        if is_class { s("Human") } else { Null },
    );
    let career = default(opts.get("career"), Null);
    if career.truthy() {
        let mut stats = t.get("stats").clone();
        for k in STATS {
            let n = number(&career, k);
            if n.is_finite() {
                stats.set(k, Num(n));
            }
        }
        t.set("stats", stats);
    }
    t.set("careerIndex", ci.clone());
    t.set("career", career);
    let group = crate::mint::target_group_of(Some(ci.to_number()), affinity.as_str(), is_class);
    t.set("affinity", affinity);
    t.set(
        "minMetalToHit",
        nullish(opts.get("minMetalToHit"), Num(-1.0)),
    );
    t.set("group", group.map_or(Null, s));
    Ok(boss_fields(t, opts))
}

/// JS:1701. This uses the shipped Breach stand-in and selector, not a generic boss.
pub fn gate_target(level: &Value, opts: &Value) -> Value {
    use crate::generated::data::{GATE_HIT_CAP_X, GATE_SHIELDS, GATE_SHIELD_S, GATE_TTK_S};
    let reference = allowance::ref_of(level.to_number());
    let players = default(opts.get("players"), Num(1.0)).to_number();
    let health = default(opts.get("health"), Num(GATE_TTK_S * reference)).to_number()
        * js_max(1.0, players.floor());
    let traits = nullish(
        opts.get("traits"),
        Arr(crate::boss_traits::relay_traits_for(&s("breach"))
            .into_iter()
            .flatten()
            .map(s)
            .collect()),
    );
    let cap = nullish(
        opts.get("hitCap"),
        Num(math_round(
            GATE_HIT_CAP_X * reference * js_max(1.0, opts.get("blowX").finite_or(1.0)),
        )),
    );
    let mut t = boss_target(&obj([
        ("level", level.clone()),
        ("health", Num(health)),
        ("traits", traits),
        ("mobileType", Num(31.0)),
        ("group", s("daedra")),
        ("hitCap", cap),
        ("phaseShields", Num(GATE_SHIELDS)),
        ("shieldSeconds", Num(GATE_SHIELD_S)),
    ]))
    .expect("Breach's stand-in is shipped");
    let spec = allowance::allowance_spec(
        level.to_number(),
        players,
        &allowance::BREACH_PHASES,
        0.0,
        None,
    );
    t.set(
        "allowance",
        obj([
            ("level", level.clone()),
            ("players", Num(spec.players)),
            (
                "phases",
                Arr(spec
                    .phases
                    .iter()
                    .map(|p| obj([("at", Num(p.at)), ("shieldS", Num(p.shield_s))]))
                    .collect()),
            ),
            ("openingS", Num(spec.opening_s)),
            ("immunityShare", spec.immunity_share.canon()),
        ]),
    );
    t
}

fn avg(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |sum, v| sum + v) / values.len() as f64
}

fn low(values: &[f64]) -> f64 {
    values.iter().copied().fold(f64::INFINITY, js_min)
}

fn high(values: &[f64]) -> f64 {
    values.iter().copied().fold(f64::NEG_INFINITY, js_max)
}

fn mix_cards(cards: &[Value]) -> Value {
    if let [only] = cards {
        return only.clone();
    }
    const ROLLS: [&str; 5] = [
        "plainRolls",
        "critRolls",
        "preFinishRolls",
        "backstabPlainRolls",
        "backstabCritRolls",
    ];
    let first = cards.first().expect("nonempty swing draw");
    // The roll lists are rebuilt below, so they are not copied first.
    let mut out = Obj(first
        .entries()
        .iter()
        .map(|(k, v)| {
            let rebuilt = ROLLS.contains(&k.as_str());
            (k.clone(), if rebuilt { Undefined } else { v.clone() })
        })
        .collect());
    for (key, reduce) in [
        ("min", low as fn(&[f64]) -> f64),
        ("max", high),
        ("avg", avg),
        ("critMin", low),
        ("critMax", high),
        ("critAvg", avg),
    ] {
        let values: Vec<_> = cards.iter().map(|c| number(c, key)).collect();
        out.set(key, Num(reduce(&values)));
    }
    for key in ROLLS {
        let field = first.get(key);
        let values = if field.truthy() {
            // Card by card across all positions: each position still adds the cards in order.
            let mut sums = vec![0.0; field.items().len()];
            for card in cards {
                let list = card.get(key);
                for (i, sum) in sums.iter_mut().enumerate() {
                    *sum += list.at(i).to_number();
                }
            }
            numbers(sums.into_iter().map(|sum| sum / cards.len() as f64))
        } else {
            Undefined
        };
        out.set(key, values);
    }
    let mut parts = out.get("parts").clone();
    if parts.truthy() {
        for key in ["dmgMods", "swingDamage"] {
            parts.set(
                key,
                Num(cards
                    .iter()
                    .fold(0.0, |sum, c| sum + number(c.get("parts"), key))
                    / cards.len() as f64),
            );
        }
    }
    out.set("parts", parts);
    out
}

fn display_card(card: &Value, off: bool, bow: &Value) -> Value {
    let mut out = card.clone();
    for (off_stage, bow_stage) in [(off, false), (false, bow.truthy())] {
        if !off_stage && !bow_stage {
            continue;
        }
        for (key, min_key, max_key, avg_key) in [
            ("plainRolls", "min", "max", "avg"),
            ("critRolls", "critMin", "critMax", "critAvg"),
        ] {
            let values: Vec<_> = out
                .get(key)
                .items()
                .iter()
                .map(|v| {
                    let d = v.to_number();
                    if off_stage {
                        crate::dual_wield::off_hand_damage(d)
                    } else {
                        crate::model_blow::bow_blow(d, bow)
                    }
                })
                .collect();
            for (k, v) in [
                (min_key, low(&values)),
                (max_key, high(&values)),
                (avg_key, avg(&values)),
            ] {
                out.set(k, Num(v));
            }
            if off_stage {
                out.set(key, numbers(values));
            }
        }
        if bow_stage {
            out.set("bow", bow.clone());
        }
    }
    out
}

fn mix_hits(hits: &[Value], chance: f64) -> Value {
    if let [only] = hits {
        return only.clone();
    }
    let first = hits.first().expect("nonempty swing draw");
    let mut out = first.clone();
    let acc = |get: &dyn Fn(&Value) -> f64| hits.iter().fold(0.0, |sum, h| sum + get(h) * chance);
    for key in ["hit", "hitPlain", "hitCrit"] {
        out.set(key, Num(acc(&|h| number(h, key))));
    }
    out.set(
        "byPart",
        obj(["plain", "crit"].map(|k| {
            (
                k,
                numbers(
                    (0..first.get("byPart").get(k).items().len())
                        .map(|i| acc(&|h| h.get("byPart").get(k).at(i).to_number())),
                ),
            )
        })),
    );
    let mut terms = out.get("terms").clone();
    for key in ["base", "armour", "other", "backstab"] {
        terms.set(key, Num(acc(&|h| h.get("terms").get(key).finite_or(0.0))));
    }
    out.set("terms", terms);
    out
}

fn blend_hits(mut hit: Value, behind: &Value, uptime: f64, skill: f64) -> Value {
    let blend = |a, b| (1.0 - uptime) * a + uptime * b;
    for key in ["hit", "hitPlain", "hitCrit"] {
        hit.set(key, Num(blend(number(&hit, key), number(behind, key))));
    }
    let parts = obj(["plain", "crit"].map(|k| {
        (
            k,
            numbers(
                hit.get("byPart")
                    .get(k)
                    .items()
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        blend(v.to_number(), behind.get("byPart").get(k).at(i).to_number())
                    }),
            ),
        )
    }));
    hit.set("byPart", parts);
    let mut terms = hit.get("terms").clone();
    terms.set("backstab", Num(uptime * skill));
    hit.set("terms", terms);
    hit
}

type Branch = [f64; 6];
const REDUCE: [fn(&[f64]) -> f64; 3] = [avg, low, high];

struct Defence<'a> {
    t: &'a Target,
    weapon: &'a Value,
    projected: Option<target::Weapon>,
    ctx: Value,
    weights: Vec<f64>,
    geared: bool,
    off: bool,
    carried: bool,
    cap: f64,
}

impl Defence<'_> {
    fn defended(&self, d: f64) -> f64 {
        if self.geared {
            target::target_expected_damage(
                Some(self.t),
                d,
                self.projected.as_ref(),
                &self.weights,
                None,
            )
            .expect("overhaul draw has positive body-part weight")
        } else {
            target::intrinsic_damage(Some(self.t), d, self.projected.as_ref(), self.carried)
        }
    }

    fn branch(&self, hit: &Value, plain: &Value, crit: &Value) -> Branch {
        let chance = number(hit.get("crit"), "chance");
        let after = |d| model::after_share(d, 1.0, self.weapon, &self.ctx);
        let miss = self.ctx.get("potentVs").truthy().then(|| after(0.0));
        let value = |o: &BlowOutcome, capped| {
            (if capped && self.cap > 0.0 {
                js_min(o.v, self.cap)
            } else {
                o.v
            }) + o.x
        };
        let reduce_out = |out: &[BlowOutcome], i: usize| {
            let damage = |o: &BlowOutcome| value(o, i >= 3);
            match i % 3 {
                0 => out.iter().fold(0.0, |sum, o| sum + o.p * damage(o)),
                1 => out.iter().map(damage).fold(f64::INFINITY, js_min),
                _ => out.iter().map(damage).fold(f64::NEG_INFINITY, js_max),
            }
        };
        // One outcome list per distinct card roll, and each blow's slot in it.
        let per_roll = |(unique, index): &(Vec<f64>, Vec<u32>), part| {
            let rows: Vec<_> = unique
                .iter()
                .map(|&d| {
                    if self.geared {
                        model::resolve_blow(d, part, Some(self.t), self.weapon, &self.ctx)
                    } else {
                        let d = self.defended(d);
                        after(if self.off { off_hand_damage(d) } else { d })
                    }
                })
                .collect();
            let per: [Vec<f64>; 6] =
                std::array::from_fn(|i| rows.iter().map(|row| reduce_out(row, i)).collect());
            // The means (0 uncapped, 3 capped) are left-to-right float sums: every blow, in the enumerated order,
            // both in one pass.
            let (landed, claimed) = index.iter().fold((0.0, 0.0), |(a, b), &k| {
                (a + per[0][k as usize], b + per[3][k as usize])
            });
            let n = index.len() as f64;
            let reduced: [f64; 6] = std::array::from_fn(|i| match i {
                0 => landed / n,
                3 => claimed / n,
                // Min and max depend only on the set of values.
                _ => REDUCE[i % 3](&per[i]),
            });
            reduced
        };
        let rolls = |v: &Value| model::distinct(v.items().iter().map(Value::to_number));
        let plain = rolls(plain);
        let crit = rolls(crit);
        if self.geared {
            let by = hit.get("byPart");
            let parts: Vec<_> = self
                .weights
                .iter()
                .enumerate()
                // mutation: equivalent - body_part_weights(Overhaul) supplies seven strictly positive fractions less than one.
                .filter(|(_, w)| **w != 0.0)
                .map(|(p, &w)| {
                    (
                        w,
                        (1.0 - chance) * by.get("plain").at(p).to_number(),
                        chance * by.get("crit").at(p).to_number(),
                        per_roll(&plain, p as f64),
                        per_roll(&crit, p as f64),
                    )
                })
                .collect();
            std::array::from_fn(|i| {
                let landed = parts.iter().fold(0.0, |sum, (w, hp, hc, plain, crit)| {
                    sum + w * (hp * plain[i] + hc * crit[i])
                });
                let missed = miss.as_ref().map_or(0.0, |row| {
                    parts.iter().fold(0.0, |sum, (w, hp, hc, _, _)| {
                        sum + w * (1.0 - (hp + hc)) * reduce_out(row, i)
                    })
                });
                landed + missed
            })
        } else {
            // mutation: equivalent - per_roll reads its part only in the geared branch; it is unused for either bare roll list.
            let plain = per_roll(&plain, 0.0);
            // mutation: equivalent - per_roll reads its part only in the geared branch; it is unused for either bare roll list.
            let crit = per_roll(&crit, 0.0);
            let hp = (1.0 - chance) * number(hit, "hitPlain");
            let hc = chance * number(hit, "hitCrit");
            std::array::from_fn(|i| {
                let missed = miss
                    .as_ref()
                    .map_or(0.0, |row| (1.0 - (hp + hc)) * reduce_out(row, i));
                hp * plain[i] + hc * crit[i] + missed
            })
        }
    }
}

fn mix_branch(rows: &[Branch], chance: f64) -> Branch {
    if let [only] = rows {
        *only
    } else {
        std::array::from_fn(|i| rows.iter().fold(0.0, |sum, row| sum + row[i] * chance))
    }
}

fn blend_branch(o: Branch, bo: Branch, bb: Branch, uptime: f64, prob: f64) -> Branch {
    std::array::from_fn(|i| (1.0 - uptime) * o[i] + uptime * ((1.0 - prob) * bo[i] + prob * bb[i]))
}

trait Canon {
    fn canon(&self) -> Value;
}

impl Canon for Value {
    fn canon(&self) -> Value {
        self.clone()
    }
}
impl Canon for f64 {
    fn canon(&self) -> Value {
        Num(*self)
    }
}
impl Canon for bool {
    fn canon(&self) -> Value {
        Bool(*self)
    }
}
impl<T: Canon> Canon for Option<T> {
    fn canon(&self) -> Value {
        self.as_ref().map_or(Null, Canon::canon)
    }
}

// Field declaration order is the JS insertion order, including for nested cards.
macro_rules! record {
    ($name:ident { $($field:ident: $ty:ty => $key:literal),* $(,)? }) => {
        #[derive(Debug, Clone)]
        pub struct $name { $(pub $field: $ty,)* }
        impl Canon for $name {
            fn canon(&self) -> Value { obj([$(($key, self.$field.canon()),)*]) }
        }
    };
}

record!(Backstab {
    skill: f64 => "skill", chance: f64 => "chance", probability: f64 => "probability",
    to_hit: f64 => "toHit", multiplier: f64 => "multiplier", uptime: f64 => "uptime",
    expected_mult: f64 => "expectedMult", watchful: bool => "watchful",
    min: f64 => "min", max: f64 => "max", crit_min: f64 => "critMin", crit_max: f64 => "critMax",
});

record!(TargetDefense {
    career_index: Value => "careerIndex", mobile_type: Value => "mobileType", natural: f64 => "natural",
    material: f64 => "material", hide_at_100: f64 => "hideAt100", worn_armour: bool => "wornArmour",
    shield: Value => "shield", combat_level: Value => "combatLevel",
});

record!(Notes {
    pre_worn_armor: bool => "preWornArmor", target_intrinsic: bool => "targetIntrinsic",
    condition: Value => "condition", soft_material: bool => "softMaterial",
});

record!(CardFields {
    core: Value => "core", weapon: Value => "weapon", target: Value => "target", swing: Value => "swing",
    swing_directions: Value => "swingDirections", swing_mix: Value => "swingMix", hit: Value => "hit",
    damage: Value => "damage", cadence: Value => "cadence",
    per_swing: f64 => "perSwing", per_swing_min: f64 => "perSwingMin", per_swing_max: f64 => "perSwingMax",
    dps: f64 => "dps", dps_min: f64 => "dpsMin", dps_max: f64 => "dpsMax",
    capped_per_swing: f64 => "cappedPerSwing", capped_per_swing_min: f64 => "cappedPerSwingMin", capped_per_swing_max: f64 => "cappedPerSwingMax",
    capped_dps: f64 => "cappedDps", capped_dps_min: f64 => "cappedDpsMin", capped_dps_max: f64 => "cappedDpsMax",
    cap: f64 => "cap", cap_source: Value => "capSource", cap_loss: f64 => "capLoss",
    enchant_per_swing: f64 => "enchantPerSwing", enchant_dps: f64 => "enchantDps", enchant_dps_min: f64 => "enchantDpsMin", enchant_dps_max: f64 => "enchantDpsMax",
    total_dps: Option<f64> => "totalDps", total_dps_min: Option<f64> => "totalDpsMin", total_dps_max: Option<f64> => "totalDpsMax",
    enchant_procs: Value => "enchantProcs", enchant_dot_dps: f64 => "enchantDotDps", enchant_dot_dps_min: f64 => "enchantDotDpsMin", enchant_dot_dps_max: f64 => "enchantDotDpsMax",
    procs_before_break: Option<f64> => "procsBeforeBreak", procs_before_break_basis: Value => "procsBeforeBreakBasis",
    resist: f64 => "resist", health: Option<f64> => "health", ward: f64 => "ward", shields: f64 => "shields",
    ttk: Option<f64> => "ttk", ttk_cap_only: Option<f64> => "ttkCapOnly", total_ttk_cap_only: Option<f64> => "totalTtkCapOnly",
    allowance: Option<Value> => "allowance", wrath: bool => "wrath", wrath_at: f64 => "wrathAt",
    target_defense: TargetDefense => "targetDefense", backstab: Backstab => "backstab", traits: Value => "traits",
    health_share: Value => "healthShare", notes: Notes => "notes",
});

#[derive(Debug, Clone)]
pub struct Card {
    pub fields: CardFields,
    pub hands: Hands,
}

#[derive(Debug, Clone)]
pub enum Hands {
    Single,
    Dual {
        off_hand: Box<Card>,
        schedule: crate::dual_wield::DualSchedule,
    },
    Pair,
}

impl std::ops::Deref for Card {
    type Target = CardFields;
    fn deref(&self) -> &CardFields {
        &self.fields
    }
}

impl Canon for Card {
    fn canon(&self) -> Value {
        let mut out = self.fields.canon();
        match &self.hands {
            Hands::Single => (),
            Hands::Pair => out.set("pair", Bool(true)),
            Hands::Dual { off_hand, schedule } => {
                out.set("dual", Bool(true));
                out.set("offHand", off_hand.canon());
                out.set("schedule", schedule_value(schedule));
            }
        }
        out
    }
}

fn schedule_value(sc: &crate::dual_wield::DualSchedule) -> Value {
    crate::spells::numbers([
        ("mainTicks", sc.main_ticks),
        ("offTicks", sc.off_ticks),
        ("hold", sc.hold),
        ("period", sc.period),
        ("swingsPerSecond", sc.swings_per_second),
        ("blowsPerSecondPerHand", sc.blows_per_second_per_hand),
        ("mainSeconds", sc.main_seconds),
        ("offSeconds", sc.off_seconds),
        ("singlePeriod", sc.single_period),
    ])
}

fn has(traits: &Value, key: &str) -> bool {
    traits.items().iter().any(|v| v.is_str(key))
}

fn ceiling(health: f64, ward: f64, shields: f64, dps: f64) -> Option<f64> {
    (health > 0.0 && dps > 0.0).then(|| (health + ward) / dps + shields)
}

fn analyze_card(ch: &Value, args: &Value, book: &Spellbook) -> Card {
    let mut opts = Obj(args.entries().to_vec());
    let rri = opts.get("rri").truthy();
    let mut w = if matches!(args.get("weapon"), Undefined) {
        model::weapon_of(ch.get("weapon"), rri)
    } else {
        args.get("weapon").clone()
    };
    if w.truthy() && rri {
        if let Some(rr) = obj_table_get(RRI_WEAPON_DAMAGE, w.get("templateIndex")) {
            w.set("min", Num(rr.min));
            w.set("max", Num(rr.max));
        }
    }
    let mut t = if args.get("target").is_nullish() {
        reference_foe(ch.get("level"), &Undefined)
    } else {
        args.get("target").clone()
    };
    for k in ["group", "affinity"] {
        t.set(k, nullish(t.get(k), Null));
    }
    let traits = nullish(
        args.get("traits"),
        nullish(t.get("bossTraits"), Arr(vec![])),
    );
    let swing = default(args.get("swing"), s("random"));
    let core = default(args.get("core"), s("overhaul"));
    opts.set("critDamage", default(args.get("critDamage"), Bool(true)));

    let off_item = ch.get("offWeapon");
    let dual = opts.get("dual").truthy()
        && off_item.truthy()
        && !w.get("twoHanded").truthy()
        && !w.get("gun").truthy()
        && !obj_table_get(
            crate::generated::data::WEAPONS,
            off_item.get("templateIndex"),
        )
        .is_some_and(|row| row.two_handed);
    let pair = opts.get("pair").truthy() && w.get("templateIndex").strict_eq(&Num(562.0));
    if dual || pair {
        return paired_card(ch, &opts, &w, &t, &traits, dual, book);
    }

    opts.set("passiveOn", default(args.get("passiveOn"), Bool(true)));
    // mutation: equivalent - a nullish wraps item projects to null, and selected weapons never read the wraps descriptor.
    let wraps = if !w.truthy() && ch.get("wraps").truthy() {
        model::weapon_of(ch.get("wraps"), rri)
    } else {
        Null
    };
    let wp = model::target_weapon(&w);
    let mat = crate::mint::material_requirement_multiplier(
        Some(number(&t, "minMetalToHit")),
        w.truthy().then(|| Some(number(&w, "material"))),
        !matches!(opts.get("softMaterialRequirements"), Bool(false)),
    );
    let held = if w.is_nullish() { &wraps } else { &w };
    let held_powers = held.get("powers").items();
    let additions = model::additions_to(held_powers, opts.get("imprints").items());
    let all_powers: Vec<_> = held_powers.iter().chain(&additions).cloned().collect();
    let projected = defence_target(&t);
    let strikes = opts.get("potentVs").finite_or(0.0)
        + model::strikes_net(held.get("item"), Some(&projected));
    opts.set(
        "healthShare",
        nullish(
            opts.get("healthShare"),
            nullish(t.get("healthShare"), Num(1.0)),
        ),
    );
    opts.set(
        "firmamentDamagePct",
        nullish(
            opts.get("firmamentDamagePct"),
            nullish(ch.get("firmamentDamagePct"), Num(0.0)),
        ),
    );
    opts.set("wraps", wraps);
    opts.set("matReqMulti", Num(mat));
    opts.set("imprintsExtra", Arr(additions));

    let ranged = w.get("ranged").truthy();
    let dirs: Vec<_> = if !swing.is_str("random") {
        vec![swing.clone()]
    } else if ranged {
        vec![s(if w.get("gun").truthy() {
            "StrikeLeft"
        } else {
            "StrikeDown"
        })]
    } else {
        model::swing_directions().map(s).collect()
    };
    let chance = 1.0 / dirs.len() as f64;
    let core_name = core.as_str().unwrap_or("");
    let hits: Vec<_> = dirs
        .iter()
        .map(|key| model::hit_model(ch, &w, &t, &key.to_js_string(), core_name, &opts))
        .collect();
    let dmgs: Vec<_> = dirs
        .iter()
        .map(|key| {
            model::damage_model(
                ch,
                &w,
                Some(&projected),
                &key.to_js_string(),
                core_name,
                &opts,
                &mut Carry::default(),
            )
        })
        .collect();
    let off = opts.get("offHand").truthy();
    let bow = model::bow_of(&w, &opts);
    let damage = if off || bow.truthy() {
        mix_cards(
            &dmgs
                .iter()
                .map(|d| display_card(d, off, &bow))
                .collect::<Vec<_>>(),
        )
    } else {
        mix_cards(&dmgs)
    };

    let watchful = matches!(t.get("watchful"), Bool(true))
        || matches!(t.get("revenant").get("edge").get("watchful"), Bool(true));
    let back = opts.get("backstabChance");
    let back_skill = if watchful {
        0.0
    } else if back.is_nullish() {
        model::skill(ch, &Num(SKILLS.backstabbing), &opts)
    } else {
        back.finite_or(0.0)
    };
    let uptime = js_clamp(opts.get("backstabUptime").finite_or(0.0), 0.0, 1.0);
    let prob = if back_skill > 1.0 {
        // mutation: equivalent - back_skill is already strictly greater than 1.0 in this arm.
        js_clamp(back_skill, 0.0, 100.0) / 100.0
    } else {
        0.0
    };
    // Uptime is clamped to [0, 1] from a finite input.
    let behind = uptime != 0.0 && back_skill != 0.0;
    let facing_hits = behind.then(|| {
        let mut opts = opts.clone();
        opts.set("backstabBonus", Num(back_skill));
        dirs.iter()
            .map(|key| model::hit_model(ch, &w, &t, &key.to_js_string(), core_name, &opts))
            .collect::<Vec<_>>()
    });

    let cadence = if ranged {
        model::ranged_cadence(ch, &w, &opts)
    } else {
        model::cadence(ch, &w, &opts)
    };
    let aps = number(&cadence, "aps");
    let health = args.get("health").finite_or(0.0);
    let curbing = if has(&traits, "curbing") && health > 0.0 {
        js_max(1.0, math_round(health * CURB_SHARE))
    } else {
        0.0
    };
    let hard_cap = t.get("hitCap").finite_or(0.0);
    let cap = [curbing, hard_cap]
        .into_iter()
        .filter(|v| *v > 0.0)
        .reduce(js_min)
        .unwrap_or(0.0);
    let cap_source = if cap == 0.0 {
        Null
    } else if hard_cap > 0.0 && (curbing == 0.0 || hard_cap <= curbing) {
        s("hit cap")
    } else {
        s("curbing")
    };
    let overhaul = core.is_str("overhaul");
    let geared = overhaul && target::has_worn_equipment(Some(&projected));
    let kind = if ranged { "arrow" } else { "melee" };
    let defence = Defence {
        t: &projected,
        weapon: &w,
        projected: wp,
        ctx: obj([
            ("offHand", Bool(off)),
            ("traits", traits.clone()),
            ("strikeKind", s(kind)),
            ("bow", bow.clone()),
            ("potentVs", Num(strikes)),
            ("echoes", numbers(model::echo_chances(&all_powers))),
            ("relay", Bool(t.get("relayBody").truthy())),
            ("warded", Bool(projected.warded)),
        ]),
        weights: target::body_part_weights(if overhaul {
            Core::Overhaul
        } else {
            Core::Other
        }),
        geared,
        off,
        carried: matches!(opts.get("carried"), Bool(true)),
        cap,
    };
    let td = TargetDefense {
        career_index: nullish(t.get("careerIndex"), Num(-1.0)),
        mobile_type: nullish(t.get("mobileType"), Null),
        natural: target::natural_damage_resistance(Some(&projected)),
        material: mat,
        hide_at_100: if t.get("isClass").truthy() {
            100.0
        } else {
            target::intrinsic_damage(Some(&projected), 100.0, defence.projected.as_ref(), false)
        },
        worn_armour: geared,
        shield: target::left_hand_shield(Some(&projected))
            .and_then(|x| x.template_index)
            .canon(),
        combat_level: nullish(t.get("combatLevel"), nullish(t.get("level"), Num(1.0))),
    };
    let mut rows = [vec![], vec![], vec![]];
    for (i, d) in dmgs.iter().enumerate() {
        rows[0].push(defence.branch(&hits[i], d.get("plainRolls"), d.get("critRolls")));
        if let Some(facing) = &facing_hits {
            rows[1].push(defence.branch(&facing[i], d.get("plainRolls"), d.get("critRolls")));
            rows[2].push(defence.branch(
                &facing[i],
                d.get("backstabPlainRolls"),
                d.get("backstabCritRolls"),
            ));
        }
    }
    let blend = |a, b, c| blend_branch(a, b, c, uptime, prob);
    let swing_mix = Arr(dirs
        .iter()
        .enumerate()
        .map(|(i, key)| {
            let o = rows[0][i];
            let branch = blend(
                o,
                *rows[1].get(i).unwrap_or(&o),
                *rows[2].get(i).unwrap_or(&o),
            );
            let (dmg, to_hit) = model::swing_terms(&key.to_js_string());
            obj([
                ("key", key.clone()),
                ("chance", Num(chance)),
                ("damage", Num(dmg)),
                ("toHit", Num(to_hit)),
                ("hit", hits[i].get("hit").clone()),
                ("perSwing", Num(branch[0])),
                ("cappedPerSwing", Num(branch[3])),
            ])
        })
        .collect());
    let ordinary = mix_branch(&rows[0], chance);
    let [per_swing, per_swing_min, per_swing_max, capped_per_swing, capped_per_swing_min, capped_per_swing_max] =
        blend(
            ordinary,
            if behind {
                mix_branch(&rows[1], chance)
            } else {
                ordinary
            },
            if behind {
                mix_branch(&rows[2], chance)
            } else {
                ordinary
            },
        );
    let hit = mix_hits(&hits, chance);
    let bh = facing_hits.map_or_else(|| hit.clone(), |h| mix_hits(&h, chance));
    let hit = blend_hits(hit, &bh, uptime, back_skill);
    let item = [w.get("item"), ch.get("wraps"), ch.get("weapon")]
        .into_iter()
        .find(|v| !v.is_nullish())
        .unwrap_or(ch.get("weapon"));
    let ench = if matches!(opts.get("enchants"), Bool(false)) {
        Null
    } else {
        crate::enchants::enchant_dps(
            item,
            ch,
            &t,
            &obj([
                ("hit", hit.get("hit").clone()),
                ("aps", Num(aps)),
                ("level", ch.get("level").clone()),
                ("potencyPct", opts.get("potencyPct").clone()),
                ("pierce", opts.get("pierce").clone()),
                ("cap", Num(cap)),
            ]),
            book,
        )
    };
    let e = |k| ench.get(k).num_or(0.0);
    let ward = if has(&traits, "warded") && health > 0.0 {
        js_max(1.0, math_round(health * WARD_SHARE))
    } else {
        0.0
    };
    let shields = js_max(0.0, t.get("phaseShields").finite_or(0.0))
        * js_max(0.0, t.get("shieldSeconds").finite_or(0.0));
    let dps = per_swing * aps;
    let capped_dps = capped_per_swing * aps;
    let capped_dps_min = capped_per_swing_min * aps;
    let capped_dps_max = capped_per_swing_max * aps;
    let total = capped_dps + e("dps");
    let ttk = ceiling(health, ward, shields, capped_dps);
    let back_dmg = |k, f: fn(&[f64]) -> f64| {
        // `display_card` leaves the backstab lists alone, so the displayed mix carries the card's own.
        let rolls: Vec<_> = damage.get(k).items().iter().map(Value::to_number).collect();
        let d = model::bow_blow(defence.defended(f(&rolls)), &bow);
        model::resist_blow(traits.items(), d, kind, &w, None)
    };
    let condition = if w.truthy() {
        w.get("conditionPct").clone()
    } else {
        Num(1.0)
    };
    let before_break = crate::enchants::procs_before_break(item);
    let backstab = Backstab {
        skill: back_skill,
        chance: prob,
        probability: prob,
        to_hit: back_skill,
        multiplier: 3.0,
        uptime,
        expected_mult: 1.0 + 2.0 * uptime * prob,
        watchful,
        min: back_dmg("backstabPlainRolls", low),
        max: back_dmg("backstabPlainRolls", high),
        crit_min: back_dmg("backstabCritRolls", low),
        crit_max: back_dmg("backstabCritRolls", high),
    };
    let wrath = has(&traits, "wrathful");
    let resist = model::weapon_resist_factor(&w, traits.items());
    let mut card = Card {
        fields: CardFields {
            core,
            weapon: w,
            target: t,
            swing,
            swing_directions: Arr(dirs),
            swing_mix,
            hit,
            damage,
            cadence,
            per_swing,
            per_swing_min,
            per_swing_max,
            dps,
            dps_min: per_swing_min * aps,
            dps_max: per_swing_max * aps,
            capped_per_swing,
            capped_per_swing_min,
            capped_per_swing_max,
            capped_dps,
            capped_dps_min,
            capped_dps_max,
            cap,
            cap_source,
            cap_loss: if dps > 0.0 {
                1.0 - capped_dps / dps
            } else {
                0.0
            },
            enchant_per_swing: e("perSwing"),
            enchant_dps: e("dps"),
            enchant_dps_min: e("dpsMin"),
            enchant_dps_max: e("dpsMax"),
            total_dps: Some(total),
            total_dps_min: Some(capped_dps_min + e("dpsMin")),
            total_dps_max: Some(capped_dps_max + e("dpsMax")),
            enchant_procs: nullish(ench.get("procs"), Arr(vec![])),
            enchant_dot_dps: e("dotDps"),
            enchant_dot_dps_min: e("dotDpsMin"),
            enchant_dot_dps_max: e("dotDpsMax"),
            procs_before_break: before_break,
            procs_before_break_basis: s(crate::enchants::PROCS_BEFORE_BREAK_BASIS),
            resist,
            health: (health != 0.0).then_some(health),
            ward,
            shields,
            ttk,
            ttk_cap_only: ttk,
            total_ttk_cap_only: ceiling(health, ward, shields, total),
            allowance: None,
            wrath,
            wrath_at: WRATH_AFTER_S,
            target_defense: td,
            backstab,
            traits,
            health_share: opts.get("healthShare").clone(),
            notes: Notes {
                pre_worn_armor: !geared,
                target_intrinsic: true,
                condition,
                soft_material: mat < 1.0,
            },
        },
        hands: Hands::Single,
    };
    patch_allowance(&mut card, false, |c, procs| {
        claim_streams(c, aps, procs, 1.0, true)
    });
    card
}

fn claim_streams(c: &Card, aps: f64, with_procs: bool, weight: f64, dot_host: bool) -> Vec<Stream> {
    let procs: Vec<_> = c
        .enchant_procs
        .items()
        .iter()
        .map(|p| Proc {
            name: p.get("name").as_str().map(str::to_owned),
            // mutation: equivalent - enchant_dps emits the `damage` key as a Num on every proc, never nullish.
            damage: p.get("damage").num_or(0.0) * weight,
            dot_tick: if dot_host {
                // mutation: equivalent - enchant_dps emits the `dotTick` key as a Num on every proc, never nullish.
                p.get("dotTick").num_or(0.0)
            } else {
                0.0
            },
        })
        .collect();
    allowance::claim_streams(&ClaimInput {
        capped_per_swing: c.capped_per_swing,
        hit: number(&c.hit, "hit"),
        aps,
        procs: &procs,
        cap: c.cap,
        with_procs,
    })
}

fn stream_value(st: &Stream) -> Value {
    let mut out = obj([(
        "kind",
        s(match st.kind {
            Kind::Blow => "blow",
            Kind::Proc => "proc",
            Kind::Dot => "dot",
        }),
    )]);
    if st.kind == Kind::Proc {
        out.set("name", st.name.as_deref().map_or(Undefined, s));
    }
    out.set("perClaim", Num(st.per_claim));
    out.set("interval", Num(st.interval));
    out.set("start", st.start.map_or(Undefined, Num));
    out
}

fn report_value(report: &Report, streams: &[Stream], weapon: &Report) -> Value {
    let r = &report.run;
    let law = &report.law;
    obj([
        (
            "law",
            obj([
                ("ref", law.reference.canon()),
                ("depth", Num(law.depth)),
                ("rate", Num(law.rate)),
                ("cap", Num(law.cap)),
                ("hitHz", Num(law.hit_hz)),
                ("share", law.share.canon()),
            ]),
        ),
        ("share", Num(report.share)),
        ("killed", Bool(r.killed)),
        ("ttk", r.ttk.canon()),
        ("fightSeconds", Num(r.fight_seconds)),
        ("shieldedSeconds", Num(r.shielded_seconds)),
        ("activeSeconds", Num(r.active_seconds)),
        ("claimsOffered", Num(r.claims_offered as f64)),
        ("claimsAccepted", Num(r.claims_accepted as f64)),
        ("claimsRefused", Num(r.claims_refused as f64)),
        ("offered", Num(r.offered)),
        ("claimed", Num(r.claimed)),
        ("landed", Num(r.landed)),
        ("clipped", Num(r.clipped)),
        ("landedShare", Num(r.landed_share)),
        ("burst5", Num(r.burst5)),
        ("dryAt", r.dry_at.canon()),
        ("immunityShare", Num(r.immunity_share)),
        ("openingS", Num(r.opening_s)),
        ("splitPenaltyS", Num(r.split_penalty_s)),
        ("ceilingDps", Num(report.ceiling_dps)),
        ("sustainedDps", Num(report.sustained_dps)),
        ("saturated", Bool(report.saturated)),
        ("claimsPerSecond", Num(report.claims_per_second)),
        ("burst5Dps", Num(report.burst5_dps)),
        ("averageDps", report.average_dps.canon()),
        ("streams", Arr(streams.iter().map(stream_value).collect())),
        (
            "weaponOnly",
            obj([
                ("ttk", weapon.run.ttk.canon()),
                ("sustainedDps", Num(weapon.sustained_dps)),
                ("ceilingDps", Num(weapon.ceiling_dps)),
                ("burst5Dps", Num(weapon.burst5_dps)),
                ("averageDps", weapon.average_dps.canon()),
            ]),
        ),
    ])
}

fn patch_allowance(c: &mut Card, dual: bool, streams: impl Fn(&Card, bool) -> Vec<Stream>) {
    let v = c.target.get("allowance");
    if !v.truthy() {
        return;
    }
    // mutation: equivalent - CardFields.health stores either None or a finite nonzero health, so >= 0 admits no extra value.
    let Some(health) = c.health.filter(|&h| h > 0.0) else {
        return;
    };
    let spec = Spec {
        level: number(v, "level"),
        players: number(v, "players"),
        phases: v
            .get("phases")
            .items()
            .iter()
            .map(|p| Phase {
                at: number(p, "at"),
                shield_s: number(p, "shieldS"),
            })
            .collect(),
        opening_s: number(v, "openingS"),
        immunity_share: match v.get("immunityShare") {
            Num(x) => Some(*x),
            _ => None,
        },
    };
    let run = |streams: &[Stream]| {
        allowance::run_allowance(
            spec.level,
            health / spec.players,
            Some(&spec),
            streams,
            true,
            0.0,
        )
    };
    let weapon_streams = streams(c, false);
    let Some(weapon) = run(&weapon_streams) else {
        return;
    };
    // mutation: equivalent - relaxing either positivity comparison runs one extra lane only when every proc's damage and dotTick are nonpositive; claim_streams then emits the identical weapon stream.
    let has_procs = dual
        || c.enchant_procs
            .items()
            .iter()
            .any(|p| number(p, "damage") > 0.0 || number(p, "dotTick") > 0.0);
    let value = if has_procs {
        let streams = streams(c, true);
        report_value(
            &run(&streams).expect("proc lane retains the weapon stream"),
            &streams,
            &weapon,
        )
    } else {
        report_value(&weapon, &weapon_streams, &weapon)
    };
    c.fields.ttk = weapon.run.ttk.or(c.ttk_cap_only);
    c.fields.allowance = Some(value);
}

fn paired_card(
    ch: &Value,
    opts: &Value,
    w: &Value,
    t: &Value,
    traits: &Value,
    dual: bool,
    book: &Spellbook,
) -> Card {
    let mut base = opts.clone();
    base.set("weapon", w.clone());
    base.set("target", t.clone());
    base.set("traits", traits.clone());
    // The recursive base spreads `opts`, not the destructured passiveOn parameter.
    base.set("passiveOn", Undefined);
    base.set(if dual { "dual" } else { "pair" }, Bool(false));
    base.set("offHand", Bool(false));
    let mut main = analyze_card(ch, &base, book);
    base.set("offHand", Bool(true));
    let mut off_ch = ch.clone();
    let schedule = if dual {
        let off_weapon = model::weapon_of(ch.get("offWeapon"), opts.get("rri").truthy());
        let burden = off_hand_burden(
            number(&off_weapon, "weight"),
            model::combat_stat(ch, "strength", opts),
        );
        base.set("weapon", off_weapon);
        base.set("loot", Null);
        base.set("imprints", Null);
        base.set("potentVs", Num(0.0));
        off_ch.set("weapon", ch.get("offWeapon").clone());
        Some(burden)
    } else {
        None
    };
    let off = analyze_card(&off_ch, &base, book);
    let schedule = schedule.map(|b| {
        dual_schedule(
            number(&main.cadence, "tick"),
            number(&off.cadence, "tick"),
            b,
        )
    });
    let main_aps = number(&main.cadence, "aps");
    let off_aps = number(&off.cadence, "aps");
    let aps = schedule.map_or(main_aps * 2.0, |sc| sc.swings_per_second);
    let [main_dot, off_dot] = if dual {
        [
            main.enchant_dps - main.enchant_per_swing * main_aps,
            off.enchant_dps - off.enchant_per_swing * off_aps,
        ]
    } else {
        [main.enchant_dot_dps, off.enchant_dot_dps]
    };
    let main_hosts = main_dot > 0.0;
    let off_hosts = !main_hosts && off_dot > 0.0;
    let host = if main_hosts {
        Some((&main, main_dot))
    } else if off_hosts {
        Some((&off, off_dot))
    } else {
        None
    };
    let dot = host.map_or(0.0, |(_, d)| d);
    let dot_min = host.map_or(0.0, |(c, _)| c.enchant_dot_dps_min);
    let dot_max = host.map_or(0.0, |(c, _)| c.enchant_dot_dps_max);
    let off_weight = if dual { OFF_HAND_BLOW_WEIGHT } else { 1.0 };
    let ench_sum = main.enchant_per_swing + off.enchant_per_swing * off_weight;
    let enchant_per_swing = ench_sum / 2.0;
    let enchant_dps = if dual {
        ench_sum * (aps / 2.0) + dot
    } else {
        enchant_per_swing * aps + dot
    };
    let band = |m, md, o, od, dot| {
        if dual {
            ((m - md) / main_aps + ((o - od) / off_aps) * off_weight) * (aps / 2.0) + dot
        } else {
            ((m - md + o - od) / 2.0) * 2.0 + dot
        }
    };
    let enchant_dps_min = band(
        main.enchant_dps_min,
        main.enchant_dot_dps_min,
        off.enchant_dps_min,
        off.enchant_dot_dps_min,
        dot_min,
    );
    let enchant_dps_max = band(
        main.enchant_dps_max,
        main.enchant_dot_dps_max,
        off.enchant_dps_max,
        off.enchant_dot_dps_max,
        dot_max,
    );

    let lead = main.clone();
    let m = &mut main.fields;
    m.per_swing = (m.per_swing + off.per_swing) / 2.0;
    m.per_swing_min = (m.per_swing_min + off.per_swing_min) / 2.0;
    m.per_swing_max = (m.per_swing_max + off.per_swing_max) / 2.0;
    m.capped_per_swing = (m.capped_per_swing + off.capped_per_swing) / 2.0;
    m.capped_per_swing_min = (m.capped_per_swing_min + off.capped_per_swing_min) / 2.0;
    m.capped_per_swing_max = (m.capped_per_swing_max + off.capped_per_swing_max) / 2.0;
    m.dps = m.per_swing * aps;
    m.dps_min = m.per_swing_min * aps;
    m.dps_max = m.per_swing_max * aps;
    m.capped_dps = m.capped_per_swing * aps;
    m.capped_dps_min = m.capped_per_swing_min * aps;
    m.capped_dps_max = m.capped_per_swing_max * aps;
    m.enchant_per_swing = enchant_per_swing;
    m.enchant_dps = enchant_dps;
    m.enchant_dps_min = enchant_dps_min;
    m.enchant_dps_max = enchant_dps_max;
    m.total_dps = Some(m.capped_dps + enchant_dps);
    m.total_dps_min = Some(m.capped_dps_min + enchant_dps_min);
    m.total_dps_max = Some(m.capped_dps_max + enchant_dps_max);
    let health = m.health.unwrap_or(0.0);
    m.ttk = ceiling(health, m.ward, m.shields, m.capped_dps);
    m.ttk_cap_only = m.ttk;
    m.total_ttk_cap_only = ceiling(health, m.ward, m.shields, m.capped_dps + enchant_dps);
    m.allowance = None;
    m.cap_loss = if m.dps > 0.0 {
        1.0 - m.capped_dps / m.dps
    } else {
        0.0
    };
    let seconds = schedule.map_or(number(&m.cadence, "seconds") / 2.0, |sc| sc.period / 2.0);
    m.cadence.set("seconds", Num(seconds));
    m.cadence.set("aps", Num(aps));
    if let Some(sc) = schedule {
        m.cadence.set("dual", Bool(true));
        for (k, v) in [
            ("period", sc.period),
            ("mainSeconds", sc.main_seconds),
            ("offSeconds", sc.off_seconds),
        ] {
            m.cadence.set(k, Num(v));
        }
        patch_allowance(&mut main, true, |_, procs| {
            let mut streams = Vec::new();
            for (hand, start, weight, dot) in [
                (&lead, 0.0, 1.0, main_hosts),
                (&off, sc.main_seconds, off_weight, off_hosts),
            ] {
                streams.extend(
                    claim_streams(hand, aps / 2.0, procs, weight, dot)
                        .into_iter()
                        .map(|mut st| {
                            // mutation: equivalent - claim_streams constructs every emitted stream with Some(start).
                            st.start = Some(st.start.unwrap_or(0.0) + start);
                            st
                        }),
                );
            }
            streams
        });
        main.hands = Hands::Dual {
            off_hand: Box::new(off),
            schedule: sc,
        };
    } else {
        m.cadence.set("pair", Bool(true));
        patch_allowance(&mut main, false, |c, procs| {
            claim_streams(c, aps, procs, 1.0, true)
        });
        main.hands = Hands::Pair;
    }
    main
}

record!(Totals {
    carried_per_swing: f64 => "carriedPerSwing", carried_capped_per_swing: f64 => "carriedCappedPerSwing",
    carried_dps: f64 => "carriedDps", carried_capped_dps: f64 => "carriedCappedDps",
    ceiling_total_dps: Option<f64> => "ceilingTotalDps", ceiling_total_dps_min: Option<f64> => "ceilingTotalDpsMin",
    ceiling_total_dps_max: Option<f64> => "ceilingTotalDpsMax", ceiling_total_ttk: Option<f64> => "ceilingTotalTtk",
    claim_total_ttk: Option<f64> => "claimTotalTtk", claim_sustained_dps: Option<f64> => "claimSustainedDps",
    total_ttk: Option<f64> => "totalTtk",
});

/// The enumerable result of JS `analyze` (1118–1145). Use `analyze_with` for the non-enumerable method.
#[derive(Debug, Clone)]
pub struct Analysis {
    pub card: Card,
    pub totals: Totals,
}

impl std::ops::Deref for Analysis {
    type Target = Card;
    fn deref(&self) -> &Card {
        &self.card
    }
}

impl Analysis {
    pub fn to_value(&self) -> Value {
        let mut out = self.card.canon();
        for (k, v) in self.totals.canon().entries() {
            out.set(k, v.clone());
        }
        out
    }
}

pub fn analyze(ch: &Value, args: &Value, book: &Spellbook) -> Analysis {
    let mut card = analyze_card(ch, args, book);
    let mut carried_opts = Obj(args.entries().to_vec());
    carried_opts.set("carried", Bool(true));
    let carried = analyze_card(ch, &carried_opts, book);
    let metric = |k| match card.allowance.as_ref().map(|a| a.get(k)) {
        Some(Num(n)) => Some(*n),
        _ => None,
    };
    let claim_total_ttk = metric("ttk");
    let claim_sustained_dps = metric("sustainedDps");
    let totals = Totals {
        carried_per_swing: carried.per_swing,
        carried_capped_per_swing: carried.capped_per_swing,
        carried_dps: carried.dps,
        carried_capped_dps: carried.capped_dps,
        ceiling_total_dps: card.total_dps,
        ceiling_total_dps_min: card.total_dps_min,
        ceiling_total_dps_max: card.total_dps_max,
        ceiling_total_ttk: card.total_ttk_cap_only,
        claim_total_ttk,
        claim_sustained_dps,
        total_ttk: if card.target.get("allowance").truthy() {
            claim_total_ttk
        } else {
            card.total_ttk_cap_only
        },
    };
    if card.allowance.is_some() {
        card.fields.total_dps = claim_sustained_dps;
        card.fields.total_dps_min = None;
        card.fields.total_dps_max = None;
    }
    Analysis { card, totals }
}

pub fn analyze_with(ch: &Value, args: &Value, edit: &Value, book: &Spellbook) -> Analysis {
    let mut out = Obj(args.entries().to_vec());
    for (k, v) in edit.entries().iter().filter(|(k, _)| k != "imprint") {
        out.set(k, v.clone());
    }
    if edit.get("imprint").truthy() {
        let mut imprints = args.get("imprints").items().to_vec();
        imprints.push(edit.get("imprint").clone());
        out.set("imprints", Arr(imprints));
    }
    analyze(ch, &out, book)
}

// JSON.parse(JSON.stringify(ch)) for plain Value records (no JS toJSON hooks).
pub fn json_clone(v: &Value) -> Value {
    match v {
        Obj(xs) => Obj(xs
            .iter()
            .filter(|(_, v)| !matches!(v, Undefined))
            .map(|(k, v)| (k.clone(), json_clone(v)))
            .collect()),
        Arr(xs) => Arr(xs.iter().map(json_clone).collect()),
        Num(x) if !x.is_finite() => Null,
        Num(x) if *x == 0.0 => Num(0.0),
        Undefined => Null,
        _ => v.clone(),
    }
}

fn edit_field(v: &mut Value, path: &[&str], edit: impl FnOnce(&Value) -> Value) {
    let Some((&key, rest)) = path.split_first() else {
        *v = edit(v);
        return;
    };
    if let Arr(items) = v {
        let i = crate::value::index_key(key).expect("array field uses an index") as usize;
        if i >= items.len() {
            items.resize(i + 1, Undefined);
        }
        edit_field(&mut items[i], rest, edit);
    } else {
        if v.is_nullish() {
            *v = Obj(vec![]);
        }
        let mut child = v.get(key).clone();
        edit_field(&mut child, rest, edit);
        v.set(key, child);
    }
}

fn add(v: &Value, n: f64) -> Value {
    if let Some(text) = v.as_str() {
        s(&format!("{text}{}", crate::value::number_to_string(n)))
    } else {
        Num(v.to_number() + n)
    }
}

fn add_affix(ch: &mut Value, affix: Value) {
    edit_field(ch, &["weapon", "affixes"], |v| {
        let mut affixes = v.items().to_vec();
        affixes.push(affix);
        Arr(affixes)
    });
}

fn affix(id: &str, param: Option<Value>, value: f64) -> Value {
    let mut line = obj([("id", s(id))]);
    if let Some(p) = param {
        line.set("param", p);
    }
    line.set("value", Num(value));
    line
}

struct WhatIf<'a> {
    ch: &'a Value,
    scenario: &'a Value,
    base: f64,
    book: &'a Spellbook,
    equipped: bool,
    rows: Vec<Value>,
}

impl WhatIf<'_> {
    fn run(&mut self, label: &str, edit: impl FnOnce(&mut Value, &mut Value)) {
        let mut ch = json_clone(self.ch);
        let mut args = Obj(self.scenario.entries().to_vec());
        edit(&mut ch, &mut args);
        if self.equipped {
            args.set("weapon", Undefined);
        }
        let dps = analyze(&ch, &args, self.book).capped_dps;
        self.rows.push(obj([
            ("label", s(label)),
            ("dps", Num(dps)),
            ("delta", Num(dps - self.base)),
            (
                "pct",
                Num(if self.base > 0.0 {
                    (dps / self.base - 1.0) * 100.0
                } else {
                    0.0
                }),
            ),
        ]));
    }
}

/// JS:1719. The baseline's weapon skill controls the weapon-skill what-if.
pub fn marginals(ch: &Value, baseline: &Analysis, scenario: &Value, book: &Spellbook) -> Value {
    let mut each = WhatIf {
        ch,
        scenario,
        base: baseline.capped_dps,
        book,
        equipped: false,
        rows: vec![],
    };
    let skill = nullish(baseline.weapon.get("skillId"), Num(SKILLS.hand_to_hand)).to_js_string();
    let crit = Num(SKILLS.critical_strike).to_js_string();
    for (key, label) in [
        ("strength", "Strength"),
        ("agility", "Agility"),
        ("speed", "Speed"),
        ("luck", "Luck"),
    ] {
        each.run(&format!("+10 {label}"), |c, _| {
            edit_field(c, &["stats", key], |v| add(v, 10.0))
        });
    }
    for (key, n, label) in [
        (&skill, 10.0, "+10 weapon skill"),
        (&crit, 5.0, "+5 Critical Strike"),
    ] {
        each.run(label, |c, _| {
            edit_field(c, &["skills", key], |v| add(&nullish(v, Num(0.0)), n))
        });
    }
    each.run("+1 weapon damage", |c, s| {
        let mut item = Obj(c.get("weapon").entries().to_vec());
        item.set("__bonusDamage", Num(1.0));
        c.set("weapon", item);
        s.set("weapon", Undefined);
    });
    each.run("+5% attack speed", |_, s| s.set("attackSpeedPct", Num(5.0)));
    each.run("+10% damage affix", |c, _| {
        if c.get("weapon").truthy() {
            add_affix(c, affix("damage", None, 10.0));
        }
    });
    Arr(each.rows)
}

/// JS:1775. This is the original what-if order, not a sort by damage.
pub fn rank_affixes(ch: &Value, baseline: &Analysis, scenario: &Value, book: &Spellbook) -> Value {
    let w = model::weapon_of(ch.get("weapon"), false);
    if !w.truthy() {
        return Arr(vec![]);
    }
    let mut each = WhatIf {
        ch,
        scenario,
        base: baseline.capped_dps,
        book,
        equipped: true,
        rows: vec![],
    };
    let skill = w.get("skillId").to_js_string();
    let crit = Num(SKILLS.critical_strike).to_js_string();
    for n in [5.0, 10.0, 15.0] {
        each.run(&format!("+{n}% damage affix"), |c, _| {
            add_affix(c, affix("damage", None, n))
        });
    }
    for (key, label, band) in [
        (&skill, "weapon skill", &[5.0, 10.0, 20.0][..]),
        (&crit, "Critical Strike", &[5.0, 10.0]),
    ] {
        for &n in band {
            each.run(&format!("+{n} {label} affix"), |c, _| {
                edit_field(c, &["_mods", "skills", key], |v| {
                    add(&nullish(v, Num(0.0)), n)
                })
            });
        }
    }
    for n in [5.0, 10.0] {
        each.run(&format!("+{n} Strength affix"), |c, _| {
            edit_field(c, &["_mods", "stats", "strength"], |v| {
                add(&nullish(v, Num(0.0)), n)
            })
        });
    }
    for n in [3.0, 6.0, 10.0] {
        each.run(&format!("+{n} elemental damage"), |c, _| {
            add_affix(c, affix("elemental", Some(s("fire")), n))
        });
    }
    for n in [10.0, 20.0, 30.0] {
        each.run(&format!("+{n}% slayer"), |c, args| {
            add_affix(
                c,
                affix(
                    "slayer",
                    Some(nullish(args.get("target").get("group"), s("undead"))),
                    n,
                ),
            )
        });
    }
    for n in [5.0, 10.0, 15.0] {
        each.run(&format!("+{n}% spell potency"), |_, args| {
            args.set(
                "potencyPct",
                // mutation: equivalent - potencyPct affects only enchant output, and rank_affixes projects only capped weapon DPS.
                add(&nullish(args.get("potencyPct"), Num(0.0)), n),
            )
        });
    }
    Arr(each.rows)
}

fn row_suffix(r: &Analysis) -> [(&'static str, f64); 5] {
    [
        ("aps", number(&r.cadence, "aps")),
        ("hit", number(&r.hit, "hit")),
        ("crit", number(r.hit.get("crit"), "chance")),
        ("damage", number(&r.damage, "avg")),
        ("capLoss", r.cap_loss),
    ]
}

/// The JS `rows.sort((a, b) => b.cappedDps - a.cappedDps || b.dps - a.dps)` without the panic a non-total order causes.
/// A row with a NaN `cappedDps` or `dps` cannot be ordered against anything (`a - b` is NaN in JS, which its sort takes
/// as "equal", and the comparator then violates transitivity). The finite rows are sorted stably, in that exact order,
/// into the positions they already hold; a NaN row keeps its generated position. No `sort_by` sees two rows it cannot
/// order, so no panic is possible.
fn sort_rank_rows(rows: &mut [Value]) {
    let finite = |r: &Value| {
        let (a, b) = (number(r, "cappedDps"), number(r, "dps"));
        !(a.is_nan() || b.is_nan())
    };
    let mut slots: Vec<usize> = (0..rows.len()).filter(|i| finite(&rows[*i])).collect();
    let mut ordered: Vec<Value> = slots.iter().map(|i| rows[*i].clone()).collect();
    ordered.sort_by(|a, b| {
        let (ca, cb) = (number(a, "cappedDps"), number(b, "cappedDps"));
        let (da, db) = (number(a, "dps"), number(b, "dps"));
        // Both rows are finite, so `partial_cmp` is `Some` and the order is total.
        cb.partial_cmp(&ca)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal))
    });
    for (slot, row) in slots.drain(..).zip(ordered) {
        rows[slot] = row;
    }
}

/// JS:1752. Options use the JS defaults when fields are absent.
pub fn rank_weapons(ch: &Value, scenario: &Value, opts: &Value, book: &Spellbook) -> Value {
    let mut rows = vec![];
    let mut args = Obj(scenario.entries().to_vec());
    let mats = default(opts.get("materials"), Num(10.0)).to_number();
    for &(id, template) in crate::generated::data::WEAPONS {
        if template.ammo == Some(true) || template.ranged == Some(true) {
            continue;
        }
        for m in 0..(mats.ceil() as usize) {
            let w = model::synthetic_weapon(
                &Num(id as f64),
                &Num(m as f64),
                scenario.get("rri").truthy(),
            );
            if !w.truthy() {
                continue;
            }
            let mut row = obj([
                ("templateIndex", Num(id as f64)),
                ("name", s(template.name)),
                ("material", Num(m as f64)),
                (
                    "materialName",
                    crate::generated::data::MATERIALS
                        .get(m)
                        .map_or(Undefined, |s0| s(s0)),
                ),
                ("skill", s(template.skill)),
                ("twoHanded", Bool(template.two_handed)),
            ]);
            args.set("weapon", w);
            let r = analyze(ch, &args, book);
            for (k, v) in [
                ("dps", r.dps),
                ("dpsMin", r.dps_min),
                ("dpsMax", r.dps_max),
                ("cappedDps", r.capped_dps),
                ("cappedDpsMin", r.capped_dps_min),
                ("cappedDpsMax", r.capped_dps_max),
                ("perSwing", r.per_swing),
                // mutation: equivalent - hit is a convex mixture of probabilities clamped to [0.03, 0.97], or NaN; both epsilon floors have the same result.
                ("perHit", r.per_swing / js_max(1e-9, number(&r.hit, "hit"))),
            ] {
                row.set(k, Num(v));
            }
            for (k, v) in row_suffix(&r) {
                row.set(k, Num(v));
            }
            rows.push(row);
        }
    }
    // JS `rows.sort((a, b) => b.cappedDps - a.cappedDps || b.dps - a.dps)`. `a - b` with a NaN is NaN, which the JS
    // takes as "equal", so that comparator is NOT a total order and V8's own permutation of NaN rows is
    // implementation-defined. Rust's `sort_by` would panic ("user-provided comparison function does not correctly
    // implement a total order"), so the finite rows (the only ones with an order) are sorted stably into the slots they
    // already occupy and every NaN row keeps its generated position. The finite rows are exactly JS's order; the NaN
    // rows' positions are the documented residual (rust/README.md, "a NaN rank").
    sort_rank_rows(&mut rows);
    let top = default(opts.get("top"), Num(20.0)).to_number() as isize;
    rows.truncate(if top < 0 {
        rows.len().saturating_sub(top.unsigned_abs())
    } else {
        top as usize
    });
    Arr(rows)
}

/// JS:1832. The current comparison row displays the unmodified item's affixes.
pub fn current_weapon_row(ch: &Value, scenario: &Value, book: &Spellbook) -> Value {
    let w = model::weapon_of(ch.get("weapon"), false);
    if !w.truthy() {
        return Null;
    }
    let mut out =
        obj(["name", "materialName", "skill", "twoHanded"].map(|k| (k, w.get(k).clone())));
    let mut args = Obj(scenario.entries().to_vec());
    args.set("weapon", w);
    let r = analyze(ch, &args, book);
    for (k, v) in [
        ("dps", r.dps),
        ("cappedDps", r.capped_dps),
        ("perSwing", r.per_swing),
    ]
    .into_iter()
    .chain(row_suffix(&r))
    {
        out.set(k, Num(v));
    }
    out.set(
        "affixes",
        nullish(ch.get("weapon").get("affixes"), Arr(vec![])),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_rank_clone_matches_number_and_undefined_rules() {
        let original = obj([
            ("omitted", Undefined),
            (
                "numbers",
                Arr(vec![
                    Undefined,
                    Num(-0.0),
                    Num(0.0),
                    Num(f64::NAN),
                    Num(f64::INFINITY),
                    Num(f64::NEG_INFINITY),
                    Num(0.125),
                ]),
            ),
            ("nested", obj([("keep", Null), ("omit", Undefined)])),
        ]);
        let expected = obj([
            (
                "numbers",
                Arr(vec![Null, Num(0.0), Num(0.0), Null, Null, Null, Num(0.125)]),
            ),
            ("nested", obj([("keep", Null)])),
        ]);
        assert_eq!(
            crate::value::write(&json_clone(&original)),
            crate::value::write(&expected)
        );
        assert!(original.has("omitted"));
    }

    #[test]
    fn rank_edit_extends_an_array_only_to_the_written_index() {
        let mut value = Arr(vec![Num(7.0)]);
        edit_field(&mut value, &["3"], |_| Num(5.0));
        assert_eq!(value, Arr(vec![Num(7.0), Undefined, Undefined, Num(5.0)]));
    }
}
