//! The R3b golden vectors (`tests/vectors/maketarget.txt`, written by `tools/rust-vectors.mjs`): the target builders
//! (`makeTarget`, `enemyTarget`, `standInTarget`, `mintRow`), `gearEnemy`, the small target helpers, and the enemy
//! equipment arms, each driven through the real JS with a scripted roll sequence. The grammars are in
//! `rust/README.md` (R3b) and mirror `tools/rust-vectors.mjs` token for token.
//!
//! Each case's rolls are replayed here; the case must consume exactly the recorded number of them (a shorter or longer
//! draw is a divergence in the order of the random draws, and fails the case). The expected target is the same
//! canonical token string the JS writes (`canonTarget`), compared as a string.
//!
//! A missing, headerless or short file fails the test (`common::load`), and so does a family below its floor.

mod common;

use common::Case;
use dfo_core::boot::Boot;
use dfo_core::gear::{
    assign_enemy_equipment, assign_rri_enemy_equipment, gear_enemy, Entity, GearOut, Hand, Piece,
    PieceRef,
};
use dfo_core::generated::canon_rows::{canon_enemy_basics_row, canon_mint_row};
use dfo_core::mint::{
    career_index_of, enemy_row_of, enemy_target, is_class_enemy_of, make_target,
    material_requirement_multiplier, mint_row, stand_in_target, target_group_of, EnemyOpts,
    MakeFields,
};
use dfo_core::rolls::Rolls;
use dfo_core::target::{Career, Effect, Item, Stat, Target};
use dfo_core::vectors_canon as vc;
use std::collections::BTreeMap;

/// The roll sequence a case replays: an explicit list of the values the JS consumed (in order), or a constant fill
/// (every roll is `constant`). `expected` is how many the JS drew; the port must draw exactly that many.
struct Scripted {
    vals: Vec<f64>,
    constant: Option<f64>,
    expected: usize,
    pos: usize,
}

impl Rolls for Scripted {
    fn roll(&mut self) -> f64 {
        if let Some(v) = self.constant {
            self.pos += 1;
            return v;
        }
        let Some(v) = self.vals.get(self.pos) else {
            panic!(
                "maketarget: the case drew more rolls than the JS did ({} recorded)",
                self.expected
            );
        };
        self.pos += 1;
        *v
    }
}

impl Scripted {
    fn finished(&self) -> bool {
        self.pos == self.expected
    }
}

/// The ROLLS block: `-` (no roll function), `I n` then n f64 (the consumed values), or `K F I` (every roll is the f64,
/// and I is how many the JS drew).
fn read_rolls_opt(c: &mut Case) -> Option<Scripted> {
    match c.word().as_str() {
        "-" => None,
        "K" => {
            let v = c.f64();
            let n = c.int() as usize;
            Some(Scripted {
                vals: Vec::new(),
                constant: Some(v),
                expected: n,
                pos: 0,
            })
        }
        t => {
            let n: usize = t
                .parse()
                .unwrap_or_else(|_| c.fail(&format!("bad rolls count `{t}`")));
            let vals = (0..n).map(|_| c.f64()).collect();
            Some(Scripted {
                vals,
                constant: None,
                expected: n,
                pos: 0,
            })
        }
    }
}

/// A block that must be present (every family but the enemy target's).
fn read_rolls(c: &mut Case) -> Scripted {
    read_rolls_opt(c).unwrap_or_else(|| c.fail("a rolls block is required here"))
}

/// Ends a case: every recorded roll was drawn, and no more.
fn rolls_done(c: &Case, r: &Scripted) {
    if !r.finished() {
        c.fail(&format!(
            "the JS drew {} rolls, the port drew {}",
            r.expected, r.pos
        ));
    }
}

/// `-` / `1` / `0`.
fn opt_bool(c: &mut Case) -> Option<bool> {
    match c.word().as_str() {
        "-" => None,
        "1" => Some(true),
        "0" => Some(false),
        t => c.fail(&format!("bad optional bool `{t}`")),
    }
}

/// `-` for none, else `c` and the career's fourteen opts (six flag bytes, eight stats).
fn career_opt(c: &mut Case) -> Option<Career> {
    match c.word().as_str() {
        "-" => None,
        "c" => {
            let mut career = Career {
                resistance_flags: c.opt(),
                immunity_flags: c.opt(),
                low_tolerance_flags: c.opt(),
                critical_weakness_flags: c.opt(),
                attack_modifier_flags: c.opt(),
                weapon_armor_shields_bitfield: c.opt(),
                ..Default::default()
            };
            for s in career.stats.iter_mut() {
                *s = c.opt();
            }
            Some(career)
        }
        t => c.fail(&format!("bad career token `{t}`")),
    }
}

/// `-` or `s` and eight opts (a missing key is NaN in the JS, and `targetStats` reads it as the default there).
fn stats_opt(c: &mut Case) -> Option<[f64; 8]> {
    match c.word().as_str() {
        "-" => None,
        "s" => {
            let mut out = [f64::NAN; 8];
            for v in out.iter_mut() {
                if let Some(x) = c.opt() {
                    *v = x;
                }
            }
            Some(out)
        }
        t => c.fail(&format!("bad stats token `{t}`")),
    }
}

/// `-` or `k`, a count, and (id, value) pairs.
fn skills_opt(c: &mut Case) -> Option<Vec<(i64, f64)>> {
    match c.word().as_str() {
        "-" => None,
        "k" => {
            let n = c.int();
            Some((0..n).map(|_| (c.int(), c.f64())).collect())
        }
        t => c.fail(&format!("bad skills token `{t}`")),
    }
}

/// `-` or `a`, a count, and the values.
fn armor_values_opt(c: &mut Case) -> Option<Vec<f64>> {
    match c.word().as_str() {
        "-" => None,
        "a" => {
            let n = c.int();
            Some((0..n).map(|_| c.f64()).collect())
        }
        t => c.fail(&format!("bad armorValues token `{t}`")),
    }
}

/// `-` or `e`, a count, and (slot, isArmor, template, material, artifact, max, current) per worn piece.
fn equip_opt(c: &mut Case) -> Option<Vec<(f64, Item)>> {
    match c.word().as_str() {
        "-" => None,
        "e" => {
            let n = c.int();
            Some(
                (0..n)
                    .map(|_| {
                        let slot = c.f64();
                        let item = Item {
                            is_armor: c.bool(),
                            template_index: c.opt(),
                            material: c.opt(),
                            artifact: c.bool(),
                            max_condition: c.opt(),
                            current_condition: c.opt(),
                        };
                        (slot, item)
                    })
                    .collect(),
            )
        }
        t => c.fail(&format!("bad equip token `{t}`")),
    }
}

/// One effect of the make input: its kind word, `ended`, and the kind's payload.
fn make_effect(c: &mut Case) -> Effect {
    let kind = c.word();
    let ended = c.bool();
    let stat_mods = |c: &mut Case| {
        let mut out = [0.0; 8];
        for v in out.iter_mut() {
            *v = c.f64();
        }
        out
    };
    match kind.as_str() {
        "disease" | "poison" | "artifact" => Effect::StatMods {
            ended,
            stat_mods: stat_mods(c),
        },
        "racialOverride" => Effect::RacialOverride {
            ended,
            stat_mods: stat_mods(c),
        },
        "fortifyAttribute" => {
            let stat = c.opt_name().and_then(|s| Stat::from_name(&s));
            let magnitude = c.f64();
            Effect::Fortify {
                ended,
                stat,
                magnitude,
            }
        }
        "drainAttribute" | "transferAttribute" => {
            let stat = c.opt_name().and_then(|s| Stat::from_name(&s));
            let magnitude = c.f64();
            Effect::Drain {
                ended,
                stat,
                magnitude,
            }
        }
        _ => Effect::Other { ended },
    }
}

/// `-` or `v`, a count, and the effects.
fn effects_opt(c: &mut Case) -> Option<Vec<Effect>> {
    match c.word().as_str() {
        "-" => None,
        "v" => {
            let n = c.int();
            Some((0..n).map(|_| make_effect(c)).collect())
        }
        t => c.fail(&format!("bad activeEffects token `{t}`")),
    }
}

/// The fields of one make input (the `makeTokens` order in tools/rust-vectors.mjs).
fn read_make_fields(c: &mut Case) -> MakeFields {
    let is_player = opt_bool(c);
    let is_class = opt_bool(c);
    let level = c.opt();
    let combat_level = c.opt();
    let mobile_type = c.opt();
    let career_index = c.opt();
    let career = career_opt(c);
    let affinity = c.opt_name();
    let group = c.opt_name();
    let stats = stats_opt(c);
    let skills = skills_opt(c);
    let armor_values = armor_values_opt(c);
    let equip_slots = equip_opt(c);
    // `-` absent; `u` present with undefined; else a number.
    let next = c.peek().map(str::to_owned);
    let min_metal_to_hit = match next.as_deref() {
        Some("-") => {
            c.word();
            None
        }
        Some("u") => {
            c.word();
            Some(None)
        }
        _ => Some(Some(c.f64())),
    };
    let spare_gear = opt_bool(c);
    let health = c.opt();
    let max_health = c.opt();
    let active_effects = effects_opt(c);
    let mods = match c.word().as_str() {
        "-" => None,
        "m" => {
            let mut stats = [0.0; 8];
            let mut max = [0.0; 8];
            for v in stats.iter_mut() {
                *v = c.f64();
            }
            for v in max.iter_mut() {
                *v = c.f64();
            }
            Some((stats, max))
        }
        t => c.fail(&format!("bad _mods token `{t}`")),
    };
    let basics = match c.word().as_str() {
        "-" => None,
        "b" => {
            let id = c.int() as f64;
            let code = c.int() as usize;
            let row = mint_row(id, &Boot::from_code(code))
                .unwrap_or_else(|| c.fail(&format!("mint row {id} under boot {code} is missing")));
            Some(row)
        }
        t => c.fail(&format!("bad basics token `{t}`")),
    };
    let relay_body = opt_bool(c);
    let level_source = c.opt_name();
    MakeFields {
        is_player,
        is_class,
        level,
        combat_level,
        mobile_type,
        career_index,
        career,
        affinity,
        group,
        stats,
        skills,
        armor_values,
        equip_slots,
        min_metal_to_hit,
        spare_gear,
        health,
        max_health,
        active_effects,
        mods,
        basics,
        relay_body,
        level_source,
    }
}

/// `-` or `c` and fourteen opts, for the enemy and gear inputs (the same grammar as [`career_opt`]).
fn enemy_career(c: &mut Case) -> Option<Career> {
    career_opt(c)
}

/// The expected form of an arm's answer (`GEAR_OUT`).
struct GearExpect {
    right: Option<(f64, f64)>,
    left: LeftExpect,
    pieces: Vec<(f64, f64, bool)>,
    armor: [f64; 7],
    poison: Option<f64>,
}

enum LeftExpect {
    None,
    Shield(f64),
    Item(f64, f64),
}

fn read_gear_out(c: &mut Case) -> GearExpect {
    let right = match c.word().as_str() {
        "-" => None,
        "W" => Some((c.f64(), c.f64())),
        t => c.fail(&format!("bad right-hand token `{t}`")),
    };
    let left = match c.word().as_str() {
        "-" => LeftExpect::None,
        "S" => LeftExpect::Shield(c.f64()),
        "W" => LeftExpect::Item(c.f64(), c.f64()),
        t => c.fail(&format!("bad left-hand token `{t}`")),
    };
    let n = c.int();
    let pieces = (0..n).map(|_| (c.f64(), c.f64(), c.bool())).collect();
    let mut armor = [0.0; 7];
    for v in armor.iter_mut() {
        *v = c.f64();
    }
    let poison = c.opt();
    GearExpect {
        right,
        left,
        pieces,
        armor,
        poison,
    }
}

/// Compares an arm's answer with the JS's (the piece's group is not on the vector: a weapon's or an armour's
/// template and material are, and the armour pieces are the whole of the armour answer).
fn check_gear_out(c: &Case, exp: &GearExpect, got: &GearOut, poison_got: Option<f64>) {
    match (exp.right, got.right) {
        (None, None) => {}
        (Some((t, m)), Some(p)) => {
            c.check_f64("right template", t, p.template);
            c.check_f64("right material", m, p.material);
        }
        _ => c.fail(&format!(
            "right hand: expected {:?}, got {:?}",
            exp.right, got.right
        )),
    }
    match (&exp.left, got.left) {
        (LeftExpect::None, None) => {}
        (LeftExpect::Shield(t), Some(Hand::Shield(g))) => c.check_f64("left shield", *t, g),
        (
            LeftExpect::Item(t, m),
            Some(Hand::Item(Piece {
                template, material, ..
            })),
        ) => {
            c.check_f64("left template", *t, template);
            c.check_f64("left material", *m, material);
        }
        _ => c.fail(&format!(
            "left hand: expected a different answer, got {:?}",
            got.left
        )),
    }
    if exp.pieces.len() != got.armor_pieces.len() {
        c.fail(&format!(
            "armour pieces: expected {}, got {}",
            exp.pieces.len(),
            got.armor_pieces.len()
        ));
    }
    for (
        i,
        (
            (p, m, s),
            PieceRef {
                piece,
                material,
                shield,
            },
        ),
    ) in exp.pieces.iter().zip(got.armor_pieces.iter()).enumerate()
    {
        c.check_f64(&format!("piece {i} template"), *p, *piece);
        c.check_f64(&format!("piece {i} material"), *m, *material);
        c.check_eq(&format!("piece {i} shield"), *s, *shield);
    }
    for (i, v) in exp.armor.iter().enumerate() {
        c.check_f64(&format!("armour value {i}"), *v, got.armor_values[i]);
    }
    c.check_opt("poison", exp.poison, poison_got);
}

// ---- canonical forms (the JS `canonTarget`, `canonOf`) -------------------------------------------------------

fn effect_tokens(e: &Effect, o: &mut Vec<String>) {
    match e {
        Effect::StatMods { ended, stat_mods } => {
            o.push("M".to_owned());
            o.push(vc::b(*ended));
            for v in stat_mods {
                o.push(vc::f(*v));
            }
        }
        Effect::RacialOverride { ended, stat_mods } => {
            o.push("R".to_owned());
            o.push(vc::b(*ended));
            for v in stat_mods {
                o.push(vc::f(*v));
            }
        }
        Effect::Fortify {
            ended,
            stat,
            magnitude,
        } => {
            o.push("F".to_owned());
            o.push(vc::b(*ended));
            o.push(stat.map_or_else(|| "-".to_owned(), |s| (s as usize).to_string()));
            o.push(vc::f(*magnitude));
        }
        Effect::Drain {
            ended,
            stat,
            magnitude,
        } => {
            o.push("D".to_owned());
            o.push(vc::b(*ended));
            o.push(stat.map_or_else(|| "-".to_owned(), |s| (s as usize).to_string()));
            o.push(vc::f(*magnitude));
        }
        Effect::Other { ended } => {
            o.push("X".to_owned());
            o.push(vc::b(*ended));
        }
    }
}

/// The target's canonical form: its fields in the JS order, one token each (see `canonTarget`).
fn canon_target(t: &Target) -> String {
    let mut o: Vec<String> = Vec::new();
    o.push(vc::b(t.is_player));
    o.push(vc::opt(t.is_class, vc::b));
    o.push(vc::opt(t.career_index, vc::f));
    if t.has_career {
        for v in [
            t.career.resistance_flags,
            t.career.immunity_flags,
            t.career.low_tolerance_flags,
            t.career.critical_weakness_flags,
            t.career.attack_modifier_flags,
            t.career.weapon_armor_shields_bitfield,
        ] {
            o.push(vc::opt(v, vc::f));
        }
        for v in t.career.stats {
            o.push(vc::opt(v, vc::f));
        }
    } else {
        o.push("-".to_owned());
    }
    o.push(vc::opt(t.level, vc::f));
    o.push(vc::opt(t.combat_level, vc::f));
    o.push(vc::opt(t.mobile_type, vc::f));
    o.push(vc::opt(t.affinity.as_deref(), vc::s));
    o.push(vc::opt(t.group.as_deref(), vc::s));
    for v in t.live.stats {
        o.push(vc::f(v));
    }
    let mut skills = t.skills.clone();
    skills.sort_by_key(|(id, _)| *id);
    o.push(skills.len().to_string());
    for (id, v) in skills {
        o.push(id.to_string());
        o.push(vc::f(v));
    }
    o.push(t.armor_values.len().to_string());
    for v in &t.armor_values {
        o.push(vc::f(*v));
    }
    let mut slots = t.equip_slots.clone();
    slots.sort_by(|a, b| a.0.total_cmp(&b.0));
    o.push(slots.len().to_string());
    for (slot, it) in slots {
        o.push(vc::f(slot));
        o.push(vc::b(it.is_armor));
        o.push(vc::opt(it.template_index, vc::f));
        o.push(vc::opt(it.material, vc::f));
        o.push(vc::b(it.artifact));
        o.push(vc::opt(it.max_condition, vc::f));
        o.push(vc::opt(it.current_condition, vc::f));
    }
    o.push(vc::opt(t.min_metal_to_hit, vc::f));
    o.push(vc::b(t.spare_gear));
    o.push(vc::f(t.health));
    o.push(vc::f(t.max_health));
    o.push(vc::opt(t.relay_body, vc::b));
    o.push(vc::opt(t.level_source.as_deref(), vc::s));
    o.push(t.live.active_effects.len().to_string());
    for e in &t.live.active_effects {
        effect_tokens(e, &mut o);
    }
    for v in t.live.stat_mods {
        o.push(vc::f(v));
    }
    for v in t.live.stat_max {
        o.push(vc::f(v));
    }
    match t.basics {
        None => o.push("-".to_owned()),
        Some(row) => o.extend(canon_mint_row(row).split(';').map(str::to_owned)),
    }
    vc::join(&o, ',')
}

/// One enemy target, or its refusal (`!`), compared with the expected token.
fn check_target(c: &Case, exp: &str, got: Result<Target, dfo_core::mint::Refused>) {
    match got {
        Err(_) => {
            if exp != "!" {
                c.fail(&format!(
                    "the port refuses, the JS builds: {}",
                    &exp[..exp.len().min(80)]
                ));
            }
        }
        Ok(t) => {
            let canon = canon_target(&t);
            if canon != exp {
                c.fail(&format!(
                    "target differs\n  expected {}\n  got      {}",
                    exp.replace(',', " "),
                    canon.replace(',', " ")
                ));
            }
        }
    }
}

/// The per-family floor (the case count a family must reach; a truncated file fails).
const FLOORS: &[(&str, &[&str], usize)] = &[
    ("mint", &["mint"], 2000),
    ("make", &["make"], 2000),
    ("enemy", &["enemy", "stand"], 2000),
    ("gear", &["gear"], 2000),
    ("scalar", &["mrm", "tgo", "erow", "cidx", "iscl"], 2000),
    ("classic", &["classic"], 2000),
    ("rri", &["rri"], 2000),
    // The boundary families (tools/rust-vectors.mjs, boundary probes): each is a floor against truncation only.
    ("bclassic", &["bclassic"], 1000),
    ("brri", &["brri"], 1000),
    ("bgear", &["bgear"], 1000),
    ("benemy", &["benemy"], 1000),
    ("bpoison", &["bpoison"], 1000),
];

#[test]
fn maketarget_matches_js_vectors() {
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in common::load("maketarget") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "mint" => {
                let id = c.f64();
                let code = c.int() as usize;
                c.expect("=>");
                let exp = c.word();
                let got = match mint_row(id, &Boot::from_code(code)) {
                    None => "-".to_owned(),
                    Some(r) => canon_mint_row(r),
                };
                if got != exp {
                    c.fail(&format!(
                        "mint row {id} under {code}: expected {exp}, got {got}"
                    ));
                }
            }
            "make" => {
                let fields = read_make_fields(&mut c);
                c.expect("=>");
                let exp = c.word();
                let got = make_target(fields);
                let canon = canon_target(&got);
                if canon != exp {
                    c.fail(&format!(
                        "makeTarget differs\n  expected {exp}\n  got      {canon}"
                    ));
                }
            }
            "enemy" | "benemy" => {
                let id = c.f64();
                let code = c.int() as usize;
                let player_level = c.opt();
                let level = c.opt();
                let career = enemy_career(&mut c);
                let armor_values = armor_values_opt(&mut c);
                let health = c.opt();
                let max_health = c.opt();
                let exact_level = c.bool();
                let mut rolls = read_rolls_opt(&mut c);
                c.expect("=>");
                let exp = c.word();
                let opts = EnemyOpts {
                    level,
                    player_level,
                    career,
                    armor_values,
                    health,
                    max_health,
                    exact_level,
                };
                let boot = Boot::from_code(code);
                let got = enemy_target(
                    id,
                    &opts,
                    &boot,
                    rolls.as_mut().map(|r| r as &mut dyn Rolls),
                );
                check_target(&c, &exp, got);
                if let Some(r) = &rolls {
                    rolls_done(&c, r);
                }
            }
            "stand" => {
                let id = c.f64();
                let code = c.int() as usize;
                c.expect("=>");
                let exp = c.word();
                check_target(&c, &exp, stand_in_target(id, &Boot::from_code(code)));
            }
            "gear" | "bgear" => {
                let id = c.f64();
                let code = c.int() as usize;
                let player_level_for_class = c.opt();
                let gear_level = c.opt();
                let career = enemy_career(&mut c);
                let mut rolls = read_rolls(&mut c);
                c.expect("=>");
                let exp = c.word();
                let boot = Boot::from_code(code);
                let opts = EnemyOpts {
                    player_level: player_level_for_class,
                    career,
                    exact_level: true,
                    ..Default::default()
                };
                match enemy_target(id, &opts, &boot, None) {
                    Err(_) => {
                        if exp != "!" {
                            c.fail("the port refuses the mint, the JS builds the foe");
                        }
                        // The gear draws nothing when the foe is not built.
                        rolls_done(&c, &rolls);
                    }
                    Ok(mut target) => {
                        gear_enemy(&mut target, &boot, gear_level, &mut rolls);
                        rolls_done(&c, &rolls);
                        let canon = canon_target(&target);
                        if canon != exp {
                            c.fail(&format!(
                                "gearEnemy differs\n  expected {exp}\n  got      {canon}"
                            ));
                        }
                    }
                }
            }
            "mrm" => {
                let min = c.opt();
                let weapon = match c.word().as_str() {
                    "-" => None,
                    "w" => Some(c.opt()),
                    t => c.fail(&format!("bad weapon token `{t}`")),
                };
                let soft = c.bool();
                c.expect("=>");
                let exp = c.f64();
                let got = material_requirement_multiplier(min, weapon, soft);
                c.check_f64("materialRequirementMultiplier", exp, got);
            }
            "tgo" => {
                let career_index = c.opt();
                let affinity = c.opt_name();
                let is_class = c.bool();
                c.expect("=>");
                let exp = c.opt_name();
                let got =
                    target_group_of(career_index, affinity.as_deref(), is_class).map(str::to_owned);
                c.check_eq("targetGroupOf", exp, got);
            }
            "erow" => {
                let id = c.f64();
                c.expect("=>");
                let exp = c.word();
                let got = match enemy_row_of(id) {
                    None => "-".to_owned(),
                    Some(r) => canon_enemy_basics_row(r),
                };
                if got != exp {
                    c.fail(&format!("enemyRowOf {id}: expected {exp}, got {got}"));
                }
            }
            "cidx" => {
                let id = c.f64();
                c.expect("=>");
                let exp = c.f64();
                c.check_f64("careerIndexOf", exp, career_index_of(id));
            }
            "iscl" => {
                let id = c.f64();
                c.expect("=>");
                let exp = c.bool();
                c.check_eq("isClassEnemyOf", exp, is_class_enemy_of(id));
            }
            "classic" | "bclassic" => {
                let id = c.f64();
                let is_class = c.bool();
                let variant = c.opt();
                let armor = c.f64();
                let player_level = c.f64();
                let mut rolls = read_rolls(&mut c);
                c.expect("=>");
                let exp = read_gear_out(&mut c);
                let entity = Entity {
                    mobile_type: Some(id),
                    is_class,
                    level: None,
                    armor,
                    career: None,
                    team: None,
                };
                let got = assign_enemy_equipment(&entity, variant, player_level, &mut rolls);
                rolls_done(&c, &rolls);
                check_gear_out(&c, &exp, &got, None);
            }
            "rri" | "brri" => {
                let id = c.f64();
                let is_class = c.bool();
                let variant = c.opt();
                let player_level = c.f64();
                let level = c.opt();
                let armor = c.f64();
                let mudex = c.bool();
                let team = c.opt_name();
                let bitfield = c.opt();
                let mut rolls = read_rolls(&mut c);
                c.expect("=>");
                let exp = read_gear_out(&mut c);
                let entity = Entity {
                    mobile_type: Some(id),
                    is_class,
                    level,
                    armor,
                    career: bitfield.map(|b| Career {
                        weapon_armor_shields_bitfield: Some(b),
                        ..Default::default()
                    }),
                    team: team.as_deref().map(static_team),
                };
                let boot = Boot::shipped();
                let got = assign_rri_enemy_equipment(
                    &entity,
                    variant,
                    player_level,
                    mudex,
                    &boot,
                    &mut rolls,
                )
                .unwrap_or_else(|| {
                    c.fail("the Enemy Expansion arm answered null with the switches on")
                });
                rolls_done(&c, &rolls);
                check_gear_out(&c, &exp, &got, got.poison);
            }
            "bpoison" => {
                let mob = c.f64();
                let pl = c.f64();
                let mut rolls = read_rolls(&mut c);
                c.expect("=>");
                let exp = c.opt();
                let got = dfo_core::gear::roll_enemy_weapon_poison(Some(mob), pl, &mut rolls);
                rolls_done(&c, &rolls);
                c.check_opt("roll_enemy_weapon_poison", exp, got);
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }

    // A truncated file must not pass: each family has a floor on its case count.
    for (family, kinds, min) in FLOORS {
        let n: usize = kinds
            .iter()
            .map(|k| seen.get(*k).copied().unwrap_or(0))
            .sum();
        assert!(
            n >= *min,
            "maketarget.txt: only {n} `{family}` cases (kinds {kinds:?}, expected >= {min})"
        );
    }
}

/// The team names the vectors write (`Entity.team` is a static name).
fn static_team(s: &str) -> &'static str {
    match s {
        "Orcs" => "Orcs",
        "Centaurs" => "Centaurs",
        "KnightsAndMages" => "KnightsAndMages",
        "Criminals" => "Criminals",
        "PlayerEnemy" => "PlayerEnemy",
        other => panic!("maketarget: no static name for team `{other}`"),
    }
}
