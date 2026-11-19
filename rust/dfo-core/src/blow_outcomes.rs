//! Exact joint blow tiers and explicit-roll sampler (`src/blowOutcomes.js`).
use crate::dual_wield::{off_hand_damage, OFF_HAND_BLOW_WEIGHT};
use crate::generated::data::{CURB_SHARE, RRI_WEAPON_DAMAGE, SKILLS, WEAPONS};
use crate::loot::{power_ids_of, power_of};
use crate::model_blow::{self as model, BlowOutcome, Carry};
use crate::round::{js_clamp, js_max, js_min, math_round};
use crate::target::{self, Core, Item, Live, Target};
use crate::value::{obj_table_get, Value, NAN_BITS};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;
use Value::{Arr, Bool, Null, Num, Undefined};

/// Bound on probability drift, not a threshold for dropping or grouping atoms (JS:60).
pub const TOLERANCE: f64 = 1e-12;

#[derive(Default)]
struct Sum {
    s: f64,
    c: f64,
}

impl Sum {
    fn add(&mut self, x: f64) {
        let t = self.s + x;
        // mutation: equivalent - on an absolute-value tie, equal operands use the identical expression, opposite finite operands have t == +0 and both corrections are +0, and infinite operands make both corrections NaN.
        self.c += if self.s.abs() >= x.abs() {
            (self.s - t) + x
        } else {
            (x - t) + self.s
        };
        self.s = t;
    }

    fn value(&self) -> f64 {
        self.s + self.c
    }
}

fn obj(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Obj(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

fn s(v: &str) -> Value {
    Value::Str(v.into())
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

// Only referenceFoe's tough preset is called (model.js:1614-1634).
fn reference_foe(level: &Value) -> Value {
    let level = level.finite_or(1.0);
    // mutation: equivalent - the reference has no mastery, so save.js masterCappedSkill caps both 100 and 101 at 100 before the hit card reads the skill.
    let skill = js_min(100.0, level * 5.0 + 30.0);
    obj([
        ("level", Num(level)),
        ("isClass", Bool(false)),
        ("careerIndex", Num(-1.0)),
        ("stats", obj(STATS.into_iter().map(|k| (k, Num(50.0))))),
        ("skills", Arr((0..35).map(|_| Num(skill)).collect())),
        // mutation: equivalent - both health fields are read only by inRush, which short-circuits because the reference has no adrenaline career bit.
        ("health", Num(100.0)),
        ("maxHealth", Num(100.0)),
        // mutation: equivalent - hitModel reads only parts 0..6; nothing reads armorValues[7] or the array length.
        ("armorValues", Arr(vec![Num(0.0); 7])),
    ])
}

// Hit reads the original Value; the defence arm needs the R3 projection. Its stat reads are
// already clamped by save::live_stat, so keep them as modifiers with no second upper ceiling.
fn defence_target(v: &Value) -> Target {
    let opt = |v: &Value| (!v.is_nullish()).then(|| v.num_or(f64::NAN));
    let career = |k| opt(v.get("career").get(k));
    let slots = v.get("equip").get("slots");
    let item = |v: &Value| Item {
        is_armor: v.get("group").is_str("Armor"),
        template_index: opt(v.get("templateIndex")),
        material: opt(v.get("material")),
        artifact: v.get("artifact").truthy(),
        max_condition: opt(v.get("maxCondition")),
        current_condition: opt(v.get("currentCondition")),
    };
    Target {
        is_class: match v.get("isClass") {
            Bool(x) => Some(*x),
            _ => None,
        },
        is_player: v.get("isPlayer").truthy(),
        career_index: opt(v.get("careerIndex")),
        level: opt(v.get("level")),
        combat_level: opt(v.get("combatLevel")),
        mobile_type: opt(v.get("mobileType")),
        group: v.get("group").as_str().map(str::to_owned),
        affinity: v.get("affinity").as_str().map(str::to_owned),
        warded: matches!(v.get("warded"), Bool(true)),
        career: target::Career {
            resistance_flags: career("resistanceFlags"),
            immunity_flags: career("immunityFlags"),
            low_tolerance_flags: career("lowToleranceFlags"),
            critical_weakness_flags: career("criticalWeaknessFlags"),
            ..Default::default()
        },
        live: Live {
            stat_mods: STATS.map(|k| crate::save::live_stat(v, k)),
            stat_max: [f64::INFINITY; STATS.len()],
            ..Default::default()
        },
        equip_slots: slots
            .entries()
            .iter()
            .map(|(k, v)| (crate::value::index_key(k).map_or(f64::NAN, f64::from), v))
            .chain(slots.items().iter().enumerate().map(|(i, v)| (i as f64, v)))
            .filter(|(_, v)| v.truthy())
            .map(|(i, v)| (i, item(v)))
            .collect(),
        ..Default::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hand {
    Main,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierKind {
    Full,
    Fight,
    Carry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlowError {
    InvalidHand,
    CarryRequired,
    FightRequired,
    EmptyDistribution,
    InvalidRoll,
}

#[derive(Debug, Clone, Default)]
pub struct Atom {
    pub p: f64,
    /// Index into the owning tier's directions (which also preserves the original swing value).
    pub direction_index: usize,
    pub facing: bool,
    pub backstab: bool,
    pub crit: bool,
    pub hit: bool,
    pub whole: bool,
    pub part: Option<usize>,
    pub detail: Option<FullDetail>,
    pub blow_base: Option<f64>,
    pub branch: Option<usize>,
    pub blow: f64,
    pub echo_damage: f64,
    pub damage: f64,
    pub claim: f64,
    pub capped_damage: f64,
    pub echo_mask: i32,
    pub echo_hits: i32,
    pub echo_eligible: bool,
    pub formula_positive: bool,
    pub strikes_damage: f64,
    pub strikes_positive: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct FullDetail {
    pub roll: isize,
    pub pre_finish: f64,
    pub card: f64,
}

#[derive(Debug, Clone)]
pub struct Tier {
    pub kind: TierKind,
    pub hand: Hand,
    pub cap: f64,
    pub directions: Vec<Value>,
    pub outcomes: Vec<Atom>,
    pub total: f64,
    pub meta: Value,
    pub merged_from: Option<usize>,
    pub carry_resolve: Option<Arc<CarryResolve>>,
}

#[derive(Debug)]
struct Defence {
    target: Target,
    weapon: Value,
    projected_weapon: Option<target::Weapon>,
    geared: bool,
    off_hand: bool,
    contexts: [Value; 2],
}

impl Defence {
    fn resolve(&self, card: f64, part: usize, whole: bool) -> Vec<BlowOutcome> {
        let t = Some(&self.target);
        let w = self.projected_weapon.as_ref();
        let after = |d, p| {
            model::after_share(
                if self.off_hand { off_hand_damage(d) } else { d },
                p,
                &self.weapon,
                &self.contexts[usize::from(whole)],
            )
        };
        if self.geared {
            target::target_part_outcomes(t, card, part as f64, w, false)
                .into_iter()
                .flat_map(|o| after(o.damage, o.p))
                .collect()
        } else {
            after(target::intrinsic_damage(t, card, w, false), 1.0)
        }
    }
}

#[derive(Debug)]
pub struct CarryResolve {
    ch: Value,
    defence: Defence,
    opts: Value,
    finish_opts: Value,
    cap: f64,
}

impl CarryResolve {
    /// Retain the sampled branch; recompute only damage with the fight's live per-item keys.
    /// Misses and nonpositive bases don't consume a remainder (JS:209-224).
    pub fn resolve(&self, draw: &Atom, carry: &mut Carry<'_>) -> Atom {
        let Some(base) = draw.blow_base.filter(|v| *v > 0.0 && draw.hit) else {
            return draw.clone();
        };
        let mut card = model::weapon_blow(
            &self.ch,
            &self.defence.weapon,
            base,
            Some(&self.defence.target),
            &self.opts,
            carry,
        );
        if draw.backstab {
            card *= 3.0;
        }
        card = model::finish_blow(card, &self.finish_opts, draw.crit);
        if let (Some(part), Some(branch)) = (draw.part, draw.branch) {
            if let Some(o) = self.defence.resolve(card, part, draw.whole).get(branch) {
                return finish(draw.clone(), o, self.cap);
            }
        }
        draw.clone()
    }
}

fn finish(mut atom: Atom, o: &BlowOutcome, cap: f64) -> Atom {
    atom.blow = o.v;
    atom.echo_damage = o.x;
    atom.damage = o.v + o.x;
    atom.claim = if cap > 0.0 { js_min(o.v, cap) } else { o.v };
    atom.capped_damage = atom.claim + o.x;
    atom.echo_mask = o.echo_mask;
    atom.echo_hits = o.echo_hits;
    atom.echo_eligible = o.echo_eligible;
    atom.formula_positive = o.formula_positive;
    atom.strikes_damage = o.strikes_damage;
    atom.strikes_positive = o.strikes_positive;
    atom
}

// The JS keys stringify numbers: both signed zeros coincide and all NaNs coincide. The bits
// identify the same finite values without depending on either language's decimal printer.
fn key_number(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        NAN_BITS
    } else {
        x.to_bits()
    }
}

fn echo_powers(item: &Value, additions: &[Value]) -> Value {
    let mut seen = std::collections::HashSet::new();
    let get = |p: &Value, id, source| {
        (p.get("chance").to_number() > 0.0 && p.get("kind").is_str("echo")).then(|| {
            obj([
                ("id", id),
                ("chance", p.get("chance").clone()),
                ("source", s(source)),
            ])
        })
    };
    let mut powers = Vec::new();
    if item.truthy() {
        for id in power_ids_of(item) {
            if id.as_str().is_some_and(|id| seen.insert(id.to_owned())) {
                if let Some(p) = get(&power_of(&id), id, "item") {
                    powers.push(p);
                }
            }
        }
    }
    powers.extend(additions.iter().filter_map(|p| get(p, Null, "what-if")));
    Arr(powers)
}

/// Enumerate in JS order, including misses after every whole/part roll sequence (JS:88-297).
#[allow(clippy::neg_cmp_op_on_partial_ord)] // `!(p > 0)` also rejects NaN, as in JS.
pub fn blow_outcomes(ch: &Value, args: &Value) -> Result<Tier, BlowError> {
    let hand = match args.get("hand") {
        Undefined => Hand::Main,
        v if v.is_str("main") => Hand::Main,
        v if v.is_str("off") => Hand::Off,
        _ => return Err(BlowError::InvalidHand),
    };
    let hand_text = if hand == Hand::Main { "main" } else { "off" };
    let mut ch = ch.clone();
    let mut opts = Value::Obj(args.entries().to_vec());
    let rri = opts.get("rri").truthy();
    let mut w = args.get("weapon").clone();
    let off = ch.get("offWeapon");
    let template = |it: &Value| obj_table_get(WEAPONS, it.get("templateIndex"));
    if hand == Hand::Off
        && opts.get("dual").truthy()
        && off.truthy()
        && !template(ch.get("weapon")).is_some_and(|w| w.two_handed)
        && !template(off).is_some_and(|w| w.two_handed || w.gun == Some(true))
    {
        w = model::weapon_of(off, rri);
        ch.set("weapon", off.clone());
        opts.set("loot", Null);
        opts.set("imprints", Null);
        opts.set("potentVs", Num(0.0));
    }
    let off_hand = hand == Hand::Off || matches!(opts.get("offHand"), Bool(true));
    opts.set("offHand", Bool(off_hand));
    opts.set("dual", Bool(false));
    opts.set("pair", Bool(false));
    if matches!(w, Undefined) {
        w = model::weapon_of(ch.get("weapon"), rri);
    }
    if w.truthy() && rri {
        if let Some(rr) = obj_table_get(RRI_WEAPON_DAMAGE, w.get("templateIndex")) {
            w.set("min", Num(rr.min));
            w.set("max", Num(rr.max));
        }
    }
    let mut raw_t = args.get("target").clone();
    if raw_t.is_nullish() {
        raw_t = reference_foe(ch.get("level"));
    }
    let t = defence_target(&raw_t);
    let traits = nullish(
        args.get("traits"),
        nullish(raw_t.get("bossTraits"), Arr(vec![])),
    );
    // mutation: equivalent - with no wraps weaponOf returns null; with a truthy w neither the card, weaponBlow, nor w ?? wraps can read wraps.
    let wraps = if !w.truthy() && ch.get("wraps").truthy() {
        model::weapon_of(ch.get("wraps"), rri)
    } else {
        Null
    };
    let swing = default(args.get("swing"), s("random"));
    let ranged = w.get("ranged").truthy();
    let directions = if !swing.is_str("random") {
        vec![swing]
    } else if ranged {
        vec![s(if w.get("gun").truthy() {
            "StrikeLeft"
        } else {
            "StrikeDown"
        })]
    } else {
        model::swing_directions().map(s).collect()
    };
    let direction_p = 1.0 / directions.len() as f64;
    let weapon = model::target_weapon(&w);
    let mat_req = crate::mint::material_requirement_multiplier(
        Some(raw_t.get("minMetalToHit").to_number()),
        weapon.as_ref().map(|_| Some(w.get("material").to_number())),
        !matches!(opts.get("softMaterialRequirements"), Bool(false)),
    );
    let held = if w.is_nullish() { &wraps } else { &w };
    let item = held.get("item");
    let held_powers = held.get("powers").items();
    let additions = model::additions_to(held_powers, opts.get("imprints").items());
    let all_powers: Vec<_> = held_powers.iter().chain(&additions).cloned().collect();
    let echoes = Arr(model::echo_chances(&all_powers)
        .into_iter()
        .map(Num)
        .collect());
    let echo_powers = echo_powers(item, &additions);
    let strikes = opts.get("potentVs").finite_or(0.0) + model::strikes_net(item, Some(&t));
    let bow = model::bow_of(&w, &opts);
    let carry = matches!(opts.get("carry"), Bool(true));
    opts.set("passiveOn", default(args.get("passiveOn"), Bool(true)));
    opts.set("critDamage", default(args.get("critDamage"), Bool(true)));
    opts.set(
        "healthShare",
        nullish(
            opts.get("healthShare"),
            nullish(raw_t.get("healthShare"), Num(1.0)),
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
    opts.set("matReqMulti", Num(mat_req));
    opts.set("imprintsExtra", Arr(additions));
    if carry {
        opts.set("carryBases", Bool(true));
    }

    let watch = matches!(raw_t.get("watchful"), Bool(true))
        || matches!(
            raw_t.get("revenant").get("edge").get("watchful"),
            Bool(true)
        );
    let back = opts.get("backstabChance");
    let back_skill = if watch {
        0.0
    } else if back.is_nullish() {
        model::skill(&ch, &Num(SKILLS.backstabbing), &opts)
    } else {
        back.finite_or(0.0)
    };
    let uptime = js_clamp(opts.get("backstabUptime").finite_or(0.0), 0.0, 1.0);
    let back_p = if back_skill > 1.0 {
        // mutation: equivalent - changing the clamp minimum from 0 to 1 does not affect an input strictly greater than 1.
        js_clamp(back_skill, 0.0, 100.0) / 100.0
    } else {
        0.0
    };
    let behind = uptime > 0.0 && back_skill != 0.0;
    let health = args.get("health").finite_or(0.0);
    let curb = if traits.items().iter().any(|v| v.is_str("curbing")) && health > 0.0 {
        js_max(1.0, math_round(health * CURB_SHARE))
    } else {
        0.0
    };
    let cap = [curb, raw_t.get("hitCap").finite_or(0.0)]
        .into_iter()
        .filter(|n| *n > 0.0)
        .reduce(js_min)
        .unwrap_or(0.0);

    let core = default(args.get("core"), s("overhaul"));
    let overhaul = core.is_str("overhaul");
    let geared = overhaul && target::has_worn_equipment(Some(&t));
    let weights = target::body_part_weights(if overhaul {
        Core::Overhaul
    } else {
        Core::Other
    });
    let relay = raw_t.get("relayBody").truthy();
    let contexts = [false, true].map(|whole| {
        obj([
            ("offHand", Bool(false)),
            ("traits", traits.clone()),
            ("strikeKind", s(if ranged { "arrow" } else { "melee" })),
            ("bow", bow.clone()),
            ("potentVs", Num(if whole { strikes } else { 0.0 })),
            ("echoes", echoes.clone()),
            ("relay", Bool(relay)),
            ("warded", Bool(t.warded)),
        ])
    });
    let defence = Defence {
        target: t,
        weapon: w,
        projected_weapon: weapon,
        geared,
        off_hand,
        contexts,
    };
    let w = &defence.weapon;
    let condition = if w.truthy() {
        model::condition_multiplier(w, matches!(opts.get("equipmentDamageEnhanced"), Bool(true)))
    } else {
        // mutation: equivalent - finishBlow skips condition multiplication when hasWeapon is false, regardless of the supplied multiplier.
        1.0
    };
    let mut finish_opts = obj([
        ("core", core.clone()),
        ("matReq", Num(mat_req)),
        ("conditionMult", Num(condition)),
        ("hasWeapon", Bool(w.truthy())),
    ]);
    let core_name = core.as_str().unwrap_or("");
    let wholes: &[(bool, f64)] = if off_hand {
        &[
            (true, OFF_HAND_BLOW_WEIGHT),
            (false, 1.0 - OFF_HAND_BLOW_WEIGHT),
        ]
    } else {
        &[(true, 1.0)]
    };
    let mut behind_opts = opts.clone();
    behind_opts.set("backstabBonus", Num(back_skill));
    let mut cache = HashMap::new();
    let misses = defence
        .contexts
        .each_ref()
        .map(|ctx| model::after_share(0.0, 1.0, w, ctx));
    let mut outcomes = Vec::new();
    for (direction_index, direction) in directions.iter().enumerate() {
        let swing = direction.to_js_string();
        let h = model::hit_model(&ch, w, &raw_t, &swing, core_name, &opts);
        let d = model::damage_model(
            &ch,
            w,
            Some(&defence.target),
            &swing,
            core_name,
            &opts,
            &mut Carry::default(),
        );
        finish_opts.set("critMult", d.get("crit").get("damageMult").clone());
        let hb = behind.then(|| model::hit_model(&ch, w, &raw_t, &swing, core_name, &behind_opts));
        let mut facings = vec![(
            false,
            false,
            if behind { 1.0 - uptime } else { 1.0 },
            &h,
            ["plainRolls", "critRolls"],
            1.0,
        )];
        if let Some(hb) = &hb {
            // mutation: equivalent - back_p is in [0,1]; either relaxation adds only back_p == 1, whose uptime * (1 - back_p) is zero and is skipped.
            if back_p < 1.0 {
                facings.push((
                    true,
                    false,
                    uptime * (1.0 - back_p),
                    hb,
                    ["plainRolls", "critRolls"],
                    1.0,
                ));
            }
            // mutation: equivalent - including back_p == 0 gives weight uptime * 0, which the facing loop skips.
            if back_p > 0.0 {
                facings.push((
                    true,
                    true,
                    uptime * back_p,
                    hb,
                    ["backstabPlainRolls", "backstabCritRolls"],
                    3.0,
                ));
            }
        }
        for (facing, backstab, weight, hit, cards, scale) in facings {
            // mutation: equivalent - a zero-weight facing cannot emit an atom; resolve depends only on card, part and whole, not the facing, and the x3 preserves zero's sign.
            if !(weight > 0.0) {
                continue;
            }
            let chance = hit.get("crit").get("chance").to_number();
            for crit in [false, true] {
                let pc = if crit { chance } else { 1.0 - chance };
                // mutation: equivalent - zero crit mass cannot pass the final p > 0 guard; a negative crit multiplier can produce -0 only from a zero base whose plain +0 resolve was already visited.
                if !(pc > 0.0) {
                    continue;
                }
                let cards = d.get(cards[usize::from(crit)]).items();
                let roll_p = 1.0 / cards.len() as f64;
                let parts = hit.get("byPart").get(if crit { "crit" } else { "plain" });
                for (part, &wt) in weights.iter().enumerate() {
                    // mutation: equivalent - both generated body-part tables contain every part 0..6, so all their weights are positive.
                    if !(wt > 0.0) {
                        continue;
                    }
                    let ph = parts.at(part).to_number();
                    let base = direction_p * weight * pc * wt;
                    for &(whole, pw) in wholes {
                        // mutation: equivalent - the whole branches have weights 1, OFF_HAND_BLOW_WEIGHT, or its complement, all strictly positive.
                        if !(pw > 0.0) {
                            continue;
                        }
                        let common = Atom {
                            direction_index,
                            facing,
                            backstab,
                            crit,
                            part: Some(part),
                            whole,
                            ..Default::default()
                        };
                        // mutation: equivalent - hitModel clamps to [3,97] then divides by 100, or preserves NaN; a part hit probability cannot be zero.
                        if ph > 0.0 {
                            for (r, card) in cards.iter().map(Value::to_number).enumerate() {
                                let resolved = cache
                                    .entry((key_number(card), part, whole))
                                    .or_insert_with(|| defence.resolve(card, part, whole));
                                for (branch, o) in resolved.iter().enumerate() {
                                    let p = base * pw * ph * roll_p * o.p;
                                    if !(p > 0.0) {
                                        continue;
                                    }
                                    outcomes.push(finish(
                                        Atom {
                                            p,
                                            hit: true,
                                            detail: Some(FullDetail {
                                                roll: r as isize,
                                                pre_finish: d
                                                    .get("preFinishRolls")
                                                    .at(r)
                                                    .to_number()
                                                    * scale,
                                                card,
                                            }),
                                            blow_base: carry
                                                .then(|| d.get("blowBaseRolls").at(r).to_number()),
                                            branch: carry.then_some(branch),
                                            ..common
                                        },
                                        o,
                                        cap,
                                    ));
                                }
                            }
                        }
                        // mutation: equivalent - hitModel supplies p <= 0.97 or NaN, so `< 1`, `<= 1`, and `< 2` agree.
                        if ph < 1.0 {
                            for o in &misses[usize::from(whole)] {
                                let p = base * pw * (1.0 - ph) * o.p;
                                if !(p > 0.0) {
                                    continue;
                                }
                                outcomes.push(finish(
                                    Atom {
                                        p,
                                        backstab: false,
                                        detail: Some(FullDetail {
                                            roll: -1,
                                            pre_finish: 0.0,
                                            card: 0.0,
                                        }),
                                        ..common
                                    },
                                    o,
                                    cap,
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    let total = outcomes.iter().fold(0.0, |a, o| a + o.p);
    let flow = all_powers.iter().find(|p| p.get("kind").is_str("flow"));
    let flow = flow.map_or(Null, |p| {
        Num(opts
            .get("flowStacks")
            .finite_or(p.get("max").finite_or(1.0)))
    });
    Ok(Tier {
        kind: TierKind::Full,
        hand,
        cap,
        directions,
        outcomes,
        total,
        merged_from: None,
        meta: obj([
            ("geared", Bool(geared)),
            ("relay", Bool(relay)),
            ("offHand", Bool(off_hand)),
            ("echoes", echoes),
            ("echoPowers", echo_powers),
            ("potentVs", Num(strikes)),
            ("bow", Bool(bow.truthy())),
            ("hand", s(hand_text)),
            ("flowStacks", flow),
            (
                "backstab",
                obj([
                    ("behind", Bool(behind)),
                    ("uptime", Num(uptime)),
                    ("chance", Num(back_p)),
                    ("skill", Num(back_skill)),
                ]),
            ),
        ]),
        carry_resolve: carry.then(|| {
            Arc::new(CarryResolve {
                ch,
                defence,
                opts,
                finish_opts,
                cap,
            })
        }),
    })
}

// Comparisons in `a - b || c - d` advance on either zero or NaN, in that order.
fn number_cmp(a: f64, b: f64) -> Ordering {
    (a - b).partial_cmp(&0.0).unwrap_or(Ordering::Equal)
}

fn prefix(o: &Atom) -> (usize, bool, bool, bool, bool, bool, i32) {
    (
        o.direction_index,
        o.facing,
        o.backstab,
        o.crit,
        o.hit,
        o.whole,
        o.echo_mask,
    )
}

fn compare(a: &Atom, b: &Atom, carry: bool) -> Ordering {
    prefix(a)
        .cmp(&prefix(b))
        .then_with(|| {
            if carry {
                a.part
                    .cmp(&b.part)
                    .then_with(|| {
                        number_cmp(a.blow_base.unwrap_or(-1.0), b.blow_base.unwrap_or(-1.0))
                    })
                    .then_with(|| a.branch.cmp(&b.branch))
            } else {
                Ordering::Equal
            }
        })
        .then_with(|| number_cmp(a.blow, b.blow))
        .then_with(|| number_cmp(a.echo_damage, b.echo_damage))
}

fn merge(full: &Tier, carry: bool) -> Tier {
    let mut groups = HashMap::new();
    let mut rows = Vec::<(Atom, Sum)>::new();
    for o in &full.outcomes {
        let key = (
            prefix(o),
            key_number(o.blow),
            key_number(o.echo_damage),
            o.formula_positive,
            o.strikes_positive,
            carry.then(|| (o.part, o.blow_base.map(key_number), o.branch)),
        );
        let i = *groups.entry(key).or_insert_with(|| {
            let mut first = o.clone();
            first.detail = None;
            if !carry {
                first.part = None;
                first.blow_base = None;
                first.branch = None;
            }
            let i = rows.len();
            rows.push((first, Sum::default()));
            i
        });
        rows[i].1.add(o.p);
    }
    let mut outcomes: Vec<_> = rows
        .into_iter()
        .map(|(mut o, sum)| {
            o.p = sum.value();
            o
        })
        .collect();
    // Hash order is never observed: ties preserve the first appearance of each key.
    outcomes.sort_by(|a, b| compare(a, b, carry));
    let mut t = Sum::default();
    for o in &outcomes {
        t.add(o.p);
    }
    Tier {
        kind: if carry {
            TierKind::Carry
        } else {
            TierKind::Fight
        },
        hand: full.hand,
        cap: full.cap,
        directions: full.directions.clone(),
        outcomes,
        total: t.value(),
        meta: full.meta.clone(),
        merged_from: Some(full.outcomes.len()),
        carry_resolve: full.carry_resolve.clone(),
    }
}

/// JS:347-371. Group on exact equality, retaining the first row's non-key fields.
pub fn merge_to_fight_tier(full: &Tier) -> Tier {
    merge(full, false)
}

/// JS:380-410. Keep the body part, pre-percentage base, and defence branch in the key.
pub fn merge_to_carry_tier(full: &Tier) -> Result<Tier, BlowError> {
    if full.carry_resolve.is_none() {
        return Err(BlowError::CarryRequired);
    }
    Ok(merge(full, true))
}

pub fn blow_fight_tier(ch: &Value, args: &Value) -> Result<Tier, BlowError> {
    let full = blow_outcomes(ch, args)?;
    if matches!(args.get("carry"), Bool(true)) {
        merge_to_carry_tier(&full)
    } else {
        Ok(merge_to_fight_tier(&full))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct TierMeans {
    pub per_swing: f64,
    pub capped_per_swing: f64,
    pub claim: f64,
    pub hit: f64,
    pub crit: f64,
    pub whole: f64,
}

/// JS:418-429. Traverse this tier in its own order (especially after a merge).
pub fn tier_means(tier: &Tier) -> TierMeans {
    let [mut per_swing, mut capped, mut claim, mut hit, mut crit, mut whole] =
        <[Sum; 6]>::default();
    for o in &tier.outcomes {
        per_swing.add(o.p * o.damage);
        capped.add(o.p * o.capped_damage);
        claim.add(o.p * o.claim);
        if o.hit {
            hit.add(o.p);
        }
        if o.crit {
            crit.add(o.p);
        }
        if o.whole {
            whole.add(o.p);
        }
    }
    TierMeans {
        per_swing: per_swing.value(),
        capped_per_swing: capped.value(),
        claim: claim.value(),
        hit: hit.value(),
        crit: crit.value(),
        whole: whole.value(),
    }
}

#[derive(Debug)]
pub struct BlowSampler<'a> {
    live: Vec<(usize, &'a Atom)>,
    cdf: Vec<f64>,
    pub total: f64,
}

/// JS:440-469. The CDF uses compensated prefixes of the positive-probability atoms only,
/// not `fight.total`. Neither construction nor selection draws any randomness.
pub fn create_blow_sampler(fight: &Tier) -> Result<BlowSampler<'_>, BlowError> {
    if fight.kind == TierKind::Full {
        return Err(BlowError::FightRequired);
    }
    let mut sum = Sum::default();
    let mut cdf = Vec::new();
    let mut live = Vec::new();
    for (i, row) in fight.outcomes.iter().enumerate() {
        if row.p > 0.0 {
            sum.add(row.p);
            cdf.push(sum.value());
            live.push((i, row));
        }
    }
    let total = *cdf.last().ok_or(BlowError::EmptyDistribution)?;
    Ok(BlowSampler { live, cdf, total })
}

impl<'a> BlowSampler<'a> {
    pub fn cumulative(&self) -> &[f64] {
        &self.cdf
    }

    /// Like JS `outcomeAt`, validate a caller-supplied roll, then select the first prefix
    /// strictly greater than `roll * total`, or the last live entry if there is none.
    pub fn outcome_at(&self, roll: f64) -> Result<(usize, &'a Atom), BlowError> {
        if !(0.0..1.0).contains(&roll) {
            return Err(BlowError::InvalidRoll);
        }
        Ok(self.sample(roll))
    }

    /// Like JS `sample`, trust the stream contract; callers supply its already drawn roll.
    pub fn sample(&self, roll: f64) -> (usize, &'a Atom) {
        let x = roll * self.total;
        let mut lo = 0;
        let mut hi = self.cdf.len() - 1;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            debug_assert!((lo..hi).contains(&mid));
            if self.cdf[mid] > x {
                hi = mid;
            } else {
                lo = mid + 1;
                // mutation: equivalent - the assignment makes lo exactly mid + 1, with mid < hi, so both the strict and relaxed assertions pass.
                debug_assert!(lo > mid);
            }
        }
        self.live[lo]
    }
}
