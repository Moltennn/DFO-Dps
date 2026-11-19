mod common;

use common::Case;
use dfo_core::target::*;
use dfo_core::vendored::*;
use std::collections::BTreeMap;

/// `CAREER`: the four flag bytes and `attackModifierFlags`, each an opt.
fn career5(c: &mut Case) -> Career {
    Career {
        resistance_flags: c.opt(),
        immunity_flags: c.opt(),
        low_tolerance_flags: c.opt(),
        critical_weakness_flags: c.opt(),
        attack_modifier_flags: c.opt(),
        ..Default::default()
    }
}

/// `ITEM`: group (is Armor), templateIndex, material, artifact, maxCondition, currentCondition.
fn item6(c: &mut Case) -> Item {
    Item {
        is_armor: c.bool(),
        template_index: c.opt(),
        material: c.opt(),
        artifact: c.bool(),
        max_condition: c.opt(),
        current_condition: c.opt(),
    }
}

/// `ITEMOPT`: `0` for no item, else `1` and an ITEM.
fn item_opt(c: &mut Case) -> Option<Item> {
    match c.word().as_str() {
        "0" => None,
        "1" => Some(item6(c)),
        t => c.fail(&format!("bad item presence token `{t}`")),
    }
}

/// `WOPT`: `0` for no weapon, else `1` and skillId, material, flags, itemFlags.
fn weapon_opt(c: &mut Case) -> Option<Weapon> {
    match c.word().as_str() {
        "0" => None,
        "1" => Some(Weapon {
            skill_id: c.opt(),
            material: c.opt(),
            flags: c.opt(),
            item_flags: c.opt(),
        }),
        t => c.fail(&format!("bad weapon presence token `{t}`")),
    }
}

/// Eight opts, in the order of the stat names (a missing one is 0).
fn opt8(c: &mut Case) -> [f64; 8] {
    let mut out = [0.0; 8];
    for v in out.iter_mut() {
        *v = c.opt().unwrap_or(0.0);
    }
    out
}

/// One effect: kind, ended, then its payload.
fn effect(c: &mut Case) -> Effect {
    let kind = c.word();
    let ended = c.bool();
    match kind.as_str() {
        "disease" | "poison" | "artifact" => Effect::StatMods {
            ended,
            stat_mods: opt8(c),
        },
        "racialOverride" => Effect::RacialOverride {
            ended,
            stat_mods: opt8(c),
        },
        "fortifyAttribute" => {
            let stat = c.opt_name().and_then(|s| Stat::from_name(&s));
            let magnitude = c.opt().unwrap_or(0.0);
            Effect::Fortify {
                ended,
                stat,
                magnitude,
            }
        }
        "drainAttribute" | "transferAttribute" => {
            let stat = c.opt_name().and_then(|s| Stat::from_name(&s));
            let magnitude = c.opt().unwrap_or(0.0);
            Effect::Drain {
                ended,
                stat,
                magnitude,
            }
        }
        _ => Effect::Other { ended },
    }
}

/// `LIVE`: 8 stats (NaN is a missing key), the effects, then 8 mod opts and 8 statMax opts.
fn live(c: &mut Case) -> Live {
    let mut stats = [0.0; 8];
    for s in stats.iter_mut() {
        *s = c.f64();
    }
    let n = c.int();
    let active_effects = (0..n).map(|_| effect(c)).collect();
    let stat_mods = opt8(c);
    let stat_max = opt8(c);
    Live {
        stats,
        active_effects,
        stat_mods,
        stat_max,
    }
}

/// `tgt id isPlayer isClass careerIndex level combatLevel CAREER LIVE armorValues slots`.
fn target_def(c: &mut Case) -> (i64, Target) {
    let id = c.int();
    let is_player = c.bool();
    let is_class = match c.word().as_str() {
        "-" => None,
        "1" => Some(true),
        "0" => Some(false),
        t => c.fail(&format!("bad isClass token `{t}`")),
    };
    let career_index = c.opt();
    let level = c.opt();
    let combat_level = c.opt();
    let career = career5(c);
    let live = live(c);
    let n = c.int();
    let armor_values = (0..n).map(|_| c.f64()).collect();
    let m = c.int();
    let mut equip_slots = Vec::new();
    for _ in 0..m {
        let slot = c.f64();
        equip_slots.push((slot, item6(c)));
    }
    let target = Target {
        is_player,
        is_class,
        career_index,
        career,
        level,
        combat_level,
        live,
        armor_values,
        equip_slots,
        ..Default::default()
    };
    (id, target)
}

/// `atk id LIVE attackModifierFlags CAREER`.
fn attacker_def(c: &mut Case) -> (i64, Attacker) {
    let id = c.int();
    let live = live(c);
    let attack_modifier_flags = c.opt();
    let career = career5(c);
    (
        id,
        Attacker {
            live,
            attack_modifier_flags,
            career,
        },
    )
}

/// A definition that must exist (a reference to a line not yet read is a broken file, not a skip).
fn need<'a, T>(c: &Case, map: &'a BTreeMap<i64, T>, id: i64) -> &'a T {
    map.get(&id)
        .unwrap_or_else(|| c.fail(&format!("definition {id} is not in the file")))
}

/// A target reference: `-` for none, else the id of a `tgt` definition.
fn tref<'a>(c: &mut Case, targets: &'a BTreeMap<i64, Target>) -> Option<&'a Target> {
    let t = c.word();
    if t == "-" {
        return None;
    }
    let id: i64 = t
        .parse()
        .unwrap_or_else(|_| c.fail(&format!("bad target ref `{t}`")));
    Some(need(c, targets, id))
}

/// An attacker reference: `-` for none, else the id of an `atk` definition.
fn aref<'a>(c: &mut Case, attackers: &'a BTreeMap<i64, Attacker>) -> Option<&'a Attacker> {
    let t = c.word();
    if t == "-" {
        return None;
    }
    let id: i64 = t
        .parse()
        .unwrap_or_else(|_| c.fail(&format!("bad attacker ref `{t}`")));
    Some(need(c, attackers, id))
}

/// A target that the kind requires (the generator never writes `-` for it).
fn required<'a>(c: &mut Case, targets: &'a BTreeMap<i64, Target>) -> &'a Target {
    tref(c, targets).unwrap_or_else(|| c.fail("this kind needs a target"))
}

fn tolerance_name(t: Tolerance) -> &'static str {
    match t {
        Tolerance::Normal => "Normal",
        Tolerance::Resistant => "Resistant",
        Tolerance::Immune => "Immune",
        Tolerance::LowTolerance => "LowTolerance",
        Tolerance::CriticalWeakness => "CriticalWeakness",
    }
}

/// Two items equal field by field, NaN equal to NaN (the JS payload is not meaningful).
fn check_item(c: &Case, what: &str, exp: Option<Item>, got: Option<Item>) {
    match (exp, got) {
        (None, None) => {}
        (Some(e), Some(g)) => {
            c.check_eq(&format!("{what}.is_armor"), e.is_armor, g.is_armor);
            c.check_opt(
                &format!("{what}.template"),
                e.template_index,
                g.template_index,
            );
            c.check_opt(&format!("{what}.material"), e.material, g.material);
            c.check_eq(&format!("{what}.artifact"), e.artifact, g.artifact);
            c.check_opt(&format!("{what}.max"), e.max_condition, g.max_condition);
            c.check_opt(
                &format!("{what}.current"),
                e.current_condition,
                g.current_condition,
            );
        }
        (e, g) => c.fail(&format!("{what}: expected {e:?}, got {g:?}")),
    }
}

#[test]
fn target_matches_js_vectors() {
    let mut targets: BTreeMap<i64, Target> = BTreeMap::new();
    let mut attackers: BTreeMap<i64, Attacker> = BTreeMap::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let default_weights = body_part_weights(Core::Overhaul);
    let (f1, f2, f3) = (
        |x: f64| x * 0.75,
        |x: f64| x + 1.0,
        |x: f64| (x / 3.0).floor(),
    );
    for mut c in common::load("target") {
        let kind = c.kind.clone();
        match kind.as_str() {
            "tgt" => {
                let (id, t) = target_def(&mut c);
                targets.insert(id, t);
            }
            "atk" => {
                let (id, a) = attacker_def(&mut c);
                attackers.insert(id, a);
            }
            "career_tolerance" => {
                let flag = c.f64();
                let career = career5(&mut c);
                c.expect("=>");
                let want = c.word();
                let got = tolerance_name(career_tolerance(&career, flag));
                c.check_eq(&format!("career_tolerance({flag:?})"), want.as_str(), got);
            }
            "element_share" => {
                let t = tref(&mut c, &targets);
                let e = c.opt_name();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("element_share({e:?})"),
                    want,
                    element_share(t, e.as_deref()),
                );
            }
            "natural" => {
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    "naturalDamageResistance",
                    want,
                    natural_damage_resistance(t),
                );
            }
            "live_stat" => {
                let which = c.word();
                let id = c.int();
                let name = c.word();
                c.expect("=>");
                let want = c.f64();
                let stat = Stat::from_name(&name)
                    .unwrap_or_else(|| c.fail(&format!("unknown stat `{name}`")));
                let got = match which.as_str() {
                    "t" => live_stat(&need(&c, &targets, id).live, stat),
                    "a" => live_stat(&need(&c, &attackers, id).live, stat),
                    w => c.fail(&format!("bad live owner `{w}`")),
                };
                c.check_f64(&format!("liveStat({which}{id}, {name})"), want, got);
            }
            "enemy_type_group" => {
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let want = c.f64();
                c.check_f64("enemyTypeGroup", want, enemy_type_group(t));
            }
            "bonus_range" => {
                let a = aref(&mut c, &attackers);
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let want = [c.f64(), c.f64(), c.f64(), c.f64(), c.f64(), c.f64()];
                let r = enemy_type_bonus_range(a, t);
                let got = [
                    r.group,
                    r.decoded,
                    r.bonus,
                    r.penalty,
                    r.will,
                    r.target_level,
                ];
                for (i, (w, g)) in want.iter().zip(got.iter()).enumerate() {
                    c.check_f64(&format!("bonus_range field {i}"), *w, *g);
                }
            }
            "bonus_value" => {
                let a = aref(&mut c, &attackers);
                let t = tref(&mut c, &targets);
                let roll = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("enemyTypeBonusValue(roll {roll:?})"),
                    want,
                    enemy_type_bonus_value(a, t, roll),
                );
            }
            "bonus_values" => {
                let a = aref(&mut c, &attackers);
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let n = c.int();
                let want: Vec<f64> = (0..n).map(|_| c.f64()).collect();
                let got = enemy_type_bonus_values(a, t);
                c.check_eq("enemyTypeBonusValues length", want.len(), got.len());
                for (i, (w, g)) in want.iter().zip(got.iter()).enumerate() {
                    c.check_f64(&format!("enemyTypeBonusValues[{i}]"), *w, *g);
                }
            }
            "silver_applies" => {
                let t = tref(&mut c, &targets);
                let w = weapon_opt(&mut c);
                c.expect("=>");
                let want = c.bool();
                c.check_eq("silverApplies", want, silver_applies(t, w.as_ref()));
            }
            "skeletal_damage" => {
                let d = c.f64();
                let t = tref(&mut c, &targets);
                let w = weapon_opt(&mut c);
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("skeletalSilverDamage({d:?})"),
                    want,
                    skeletal_silver_damage(d, t, w.as_ref()),
                );
            }
            "is_skeletal" => {
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let want = c.bool();
                c.check_eq("isSkeletalTarget", want, is_skeletal_target(t));
            }
            "monster_hide" => {
                let t = tref(&mut c, &targets);
                let d = c.f64();
                let blunt = c.bool();
                let nat = c.opt();
                let exact = c.bool();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("monsterHideDamage({d:?}, blunt {blunt}, nat {nat:?}, exact {exact})"),
                    want,
                    monster_hide_damage(t, d, blunt, nat, exact),
                );
            }
            "intrinsic_damage" => {
                let t = tref(&mut c, &targets);
                let d = c.f64();
                let w = weapon_opt(&mut c);
                let exact = c.bool();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("intrinsicDamage({d:?}, exact {exact})"),
                    want,
                    intrinsic_damage(t, d, w.as_ref(), exact),
                );
            }
            "armour_material_id" => {
                let it = item_opt(&mut c);
                c.expect("=>");
                let want = c.f64();
                c.check_f64("armourMaterialId", want, armour_material_id(it.as_ref()));
            }
            "armour_condition" => {
                let it = item_opt(&mut c);
                let sharp = c.bool();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    "armourConditionMultiplier",
                    want,
                    armour_condition_multiplier(it.as_ref(), sharp),
                );
            }
            "armour_reduction" | "shield_reduction" => {
                let it = item_opt(&mut c);
                let d = c.f64();
                let s = Strike {
                    natural: c.f64(),
                    blunt: c.bool(),
                    unarmed: c.bool(),
                    sharp_edge: c.bool(),
                };
                c.expect("=>");
                let want = c.f64();
                let (what, got) = if kind == "armour_reduction" {
                    ("armourReduction", armour_reduction(it.as_ref(), d, s))
                } else {
                    ("shieldReduction", shield_reduction(it.as_ref(), d, s))
                };
                c.check_f64(&format!("{what}({d:?})"), want, got);
            }
            "shield_block" => {
                let t = required(&mut c, &targets);
                let strong = c.bool();
                let it = item_opt(&mut c);
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    "pcaaoShieldBlockChance",
                    want,
                    shield_block_chance(t, strong, it.as_ref()),
                );
            }
            "shield_beats" => {
                let t = tref(&mut c, &targets);
                let part = c.f64();
                let nat = c.opt();
                let sharp = c.bool();
                c.expect("=>");
                let want = c.bool();
                c.check_eq(
                    "shieldBeatsUnderArmour",
                    want,
                    shield_beats_under_armour(t, part, nat, sharp),
                );
            }
            "struck_slot" => {
                let t = tref(&mut c, &targets);
                let part = c.f64();
                c.expect("=>");
                let want = item_opt(&mut c);
                let got = struck_slot_item(t, part).copied();
                check_item(&c, &format!("struckSlotItem({part})"), want, got);
            }
            "left_hand" => {
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let want = item_opt(&mut c);
                let got = left_hand_shield(t).copied();
                check_item(&c, "leftHandShield", want, got);
            }
            "has_worn" => {
                let t = tref(&mut c, &targets);
                c.expect("=>");
                let want = c.bool();
                c.check_eq("hasWornEquipment", want, has_worn_equipment(t));
            }
            "part_outcomes" => {
                let t = tref(&mut c, &targets);
                let d = c.f64();
                let part = c.f64();
                let w = weapon_opt(&mut c);
                let sharp = c.bool();
                c.expect("=>");
                let n = c.int();
                let want: Vec<(f64, f64)> = (0..n).map(|_| (c.f64(), c.f64())).collect();
                let got = target_part_outcomes(t, d, part, w.as_ref(), sharp);
                c.check_eq("targetPartOutcomes length", want.len(), got.len());
                for (i, (wo, go)) in want.iter().zip(got.iter()).enumerate() {
                    c.check_f64(&format!("outcome[{i}].p"), wo.0, go.p);
                    c.check_f64(&format!("outcome[{i}].damage"), wo.1, go.damage);
                }
            }
            "part_damage" => {
                let t = tref(&mut c, &targets);
                let d = c.f64();
                let part = c.f64();
                let w = weapon_opt(&mut c);
                let sharp = c.bool();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("targetPartDamage({d:?}, {part})"),
                    want,
                    target_part_damage(t, d, part, w.as_ref(), sharp),
                );
            }
            "expected_damage" => {
                let t = tref(&mut c, &targets);
                let d = c.f64();
                let w = weapon_opt(&mut c);
                let weights: Vec<f64> = match c.word().as_str() {
                    "-" => default_weights.clone(),
                    n => {
                        let n: usize = n
                            .parse()
                            .unwrap_or_else(|_| c.fail(&format!("bad weight count `{n}`")));
                        (0..n).map(|_| c.f64()).collect()
                    }
                };
                let mi = c.int();
                let map: Option<&dyn Fn(f64) -> f64> = match mi {
                    0 => None,
                    1 => Some(&f1),
                    2 => Some(&f2),
                    3 => Some(&f3),
                    _ => c.fail(&format!("bad map index {mi}")),
                };
                c.expect("=>");
                let want = c.opt();
                let got = target_expected_damage(t, d, w.as_ref(), &weights, map);
                c.check_opt(&format!("targetExpectedDamage({d:?})"), want, got);
            }
            "equip_armour" => {
                let base = required(&mut c, &targets).clone();
                let n = c.int();
                let pieces: Vec<Item> = (0..n).map(|_| item6(&mut c)).collect();
                let av = c.bool();
                c.expect("=>");
                let mut after = base;
                equip_armour(&mut after, &pieces, av);
                let m = c.int();
                let mut want_slots: Vec<(f64, Item)> = Vec::new();
                for _ in 0..m {
                    let slot = c.f64();
                    want_slots.push((slot, item6(&mut c)));
                }
                let k = c.int();
                let want_armor: Vec<f64> = (0..k).map(|_| c.f64()).collect();
                want_slots.sort_by(|a, b| a.0.total_cmp(&b.0));
                let mut got_slots = after.equip_slots.clone();
                got_slots.sort_by(|a, b| a.0.total_cmp(&b.0));
                c.check_eq("equip slot count", want_slots.len(), got_slots.len());
                for (i, ((ws, wi), (gs, gi))) in want_slots.iter().zip(got_slots.iter()).enumerate()
                {
                    c.check_f64(&format!("equip slot[{i}]"), *ws, *gs);
                    check_item(&c, &format!("equip item[{i}]"), Some(*wi), Some(*gi));
                }
                c.check_eq(
                    "armorValues length",
                    want_armor.len(),
                    after.armor_values.len(),
                );
                for (i, (w, g)) in want_armor.iter().zip(after.armor_values.iter()).enumerate() {
                    c.check_f64(&format!("armorValues[{i}]"), *w, *g);
                }
            }
            "material_armor_value" => {
                let m = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64("materialArmorValue", want, material_armor_value(m));
            }
            "item_armor_value" => {
                let it = item_opt(&mut c);
                c.expect("=>");
                let want = c.f64();
                c.check_f64("itemArmorValue", want, item_armor_value(it.as_ref()));
            }
            "enemy_group" => {
                let career = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64("enemyEntityGroup", want, enemy_entity_group(career));
            }
            "career_attack_modifier" => {
                let flags = c.f64();
                let group = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    "careerAttackModifier",
                    want,
                    career_attack_modifier(flags, group),
                );
            }
            "enemy_entity_type" => {
                let id = c.f64();
                c.expect("=>");
                let want = c.word();
                let got = match enemy_entity_type(id) {
                    Some(EntityType::Monster) => "monster",
                    Some(EntityType::Class) => "class",
                    None => "null",
                };
                c.check_eq(&format!("enemyEntityType({id:?})"), want.as_str(), got);
            }
            "enemy_career_index" => {
                let id = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64("enemyCareerIndex", want, enemy_career_index(id));
            }
            "slot_for_body_part" => {
                let part = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64("slotForBodyPart", want, slot_for_body_part(part));
            }
            "armor_body_parts" => {
                let it = item_opt(&mut c);
                c.expect("=>");
                let n = c.int();
                let want: Vec<f64> = (0..n).map(|_| c.f64()).collect();
                let got = armor_body_parts(it.as_ref());
                c.check_eq("armorBodyParts length", want.len(), got.len());
                for (i, (w, g)) in want.iter().zip(got.iter()).enumerate() {
                    c.check_f64(&format!("armorBodyParts[{i}]"), *w, *g);
                }
            }
            "condition_percentage" => {
                let it = item_opt(&mut c);
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    "conditionPercentage",
                    want,
                    condition_percentage(it.as_ref()),
                );
            }
            "armour_piece" => {
                let max = c.opt();
                let cond = c.f64();
                c.expect("=>");
                let want = c.f64();
                c.check_f64(
                    &format!("armourPiece current (max {max:?}, condition {cond:?})"),
                    want,
                    armour_piece_current(max, cond),
                );
            }
            "body_part_weights" => {
                let core = match c.word().as_str() {
                    "undef" | "overhaul" => Core::Overhaul,
                    "struck" => Core::Other,
                    t => c.fail(&format!("bad core `{t}`")),
                };
                c.expect("=>");
                let n = c.int();
                let want: Vec<f64> = (0..n).map(|_| c.f64()).collect();
                let got = body_part_weights(core);
                c.check_eq("bodyPartWeights length", want.len(), got.len());
                for (i, (w, g)) in want.iter().zip(got.iter()).enumerate() {
                    c.check_f64(&format!("bodyPartWeights[{i}]"), *w, *g);
                }
            }
            "silver_doubles" => {
                let _ = tref(&mut c, &targets);
                c.expect("=>");
                let want = c.bool();
                c.check_eq("silverDoubles", want, silver_doubles());
            }
            "is_shield_template" => {
                let t = c.opt();
                c.expect("=>");
                let want = c.bool();
                c.check_eq("isShieldTemplate", want, is_shield_template(t));
            }
            "enemy_armor_values" => {
                let is_class = c.bool();
                let armor = c.f64();
                let n = c.int();
                let pieces: Vec<ArmourPieceRef> = (0..n)
                    .map(|_| ArmourPieceRef {
                        piece: c.opt(),
                        material: c.opt(),
                        shield: c.bool(),
                    })
                    .collect();
                c.expect("=>");
                let want: Vec<f64> = (0..7).map(|_| c.f64()).collect();
                let got = enemy_armor_values(is_class, armor, &pieces);
                for (i, (w, g)) in want.iter().zip(got.iter()).enumerate() {
                    c.check_f64(&format!("enemyArmorValues[{i}]"), *w, *g);
                }
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    // Floors: each family has at least 2000 cases in total (the generator writes 2000 or more per family).
    let families: [(&str, &[&str]); 10] = [
        ("career", &["career_tolerance", "element_share"]),
        ("natural", &["natural", "live_stat"]),
        (
            "enemy_type",
            &[
                "enemy_type_group",
                "bonus_range",
                "bonus_value",
                "bonus_values",
            ],
        ),
        (
            "silver",
            &["silver_applies", "skeletal_damage", "is_skeletal"],
        ),
        ("hide", &["monster_hide", "intrinsic_damage"]),
        (
            "armour",
            &[
                "armour_material_id",
                "armour_condition",
                "armour_reduction",
                "shield_reduction",
            ],
        ),
        (
            "shield",
            &[
                "shield_block",
                "shield_beats",
                "struck_slot",
                "left_hand",
                "has_worn",
            ],
        ),
        (
            "outcome",
            &["part_outcomes", "part_damage", "expected_damage"],
        ),
        ("equip", &["equip_armour"]),
        (
            "scalar",
            &[
                "material_armor_value",
                "item_armor_value",
                "enemy_group",
                "career_attack_modifier",
                "enemy_entity_type",
                "enemy_career_index",
                "slot_for_body_part",
                "armor_body_parts",
                "condition_percentage",
                "armour_piece",
                "body_part_weights",
                "silver_doubles",
                "is_shield_template",
                "enemy_armor_values",
            ],
        ),
    ];
    for (family, kinds) in families {
        let n: usize = kinds
            .iter()
            .map(|k| seen.get(*k).copied().unwrap_or(0))
            .sum();
        assert!(
            n >= 2000,
            "target.txt: only {n} cases in the `{family}` family (expected >= 2000)"
        );
    }
}
