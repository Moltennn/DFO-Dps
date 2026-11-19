mod common;

use dfo_core::blow_outcomes::*;
use dfo_core::model_blow::{create_carry_state, Carry};
use dfo_core::value::{write, Value};
use std::collections::BTreeMap;
use Value::{Arr, Bool, Null, Num, Str, Undefined};

fn idx(n: usize) -> Value {
    Num(n as f64)
}

fn atom(t: &Tier, o: &Atom) -> Value {
    Arr(vec![
        Num(o.p),
        t.directions[o.direction_index].clone(),
        idx(o.direction_index),
        Bool(o.facing),
        Bool(o.backstab),
        Bool(o.crit),
        Bool(o.hit),
        Bool(o.whole),
        o.part.map_or(Undefined, idx),
        o.detail.map_or(Undefined, |d| Num(d.roll as f64)),
        o.detail.map_or(Undefined, |d| Num(d.pre_finish)),
        o.detail.map_or(Undefined, |d| Num(d.card)),
        o.blow_base.map_or(Undefined, Num),
        o.branch.map_or(Undefined, idx),
        Num(o.blow),
        Num(o.echo_damage),
        Num(o.damage),
        Num(o.claim),
        Num(o.capped_damage),
        Num(o.echo_mask.into()),
        Num(o.echo_hits.into()),
        Bool(o.echo_eligible),
        Bool(o.formula_positive),
        Num(o.strikes_damage),
        Bool(o.strikes_positive),
    ])
}

fn atoms(t: &Tier) -> Value {
    Arr(t.outcomes.iter().map(|o| atom(t, o)).collect())
}

fn head(t: &Tier) -> Value {
    let m = tier_means(t);
    let mut meta = t.meta.clone();
    if t.carry_resolve.is_none() {
        meta.set("carryResolve", Null);
    }
    Arr(vec![
        Str(if t.kind == TierKind::Full {
            "full"
        } else {
            "fight"
        }
        .into()),
        Bool(true),
        if t.kind == TierKind::Carry {
            Bool(true)
        } else {
            Undefined
        },
        Str(if t.hand == Hand::Main { "main" } else { "off" }.into()),
        Num(t.cap),
        Arr(t.directions.clone()),
        Num(t.total),
        meta,
        t.merged_from.map_or(Undefined, idx),
        Bool(t.kind == TierKind::Carry && t.carry_resolve.is_some()),
        Arr([
            m.per_swing,
            m.capped_per_swing,
            m.claim,
            m.hit,
            m.crit,
            m.whole,
        ]
        .into_iter()
        .map(Num)
        .collect()),
    ])
}

fn error(e: BlowError) -> Value {
    Str(match e {
        BlowError::CarryRequired | BlowError::FightRequired => "TypeError",
        BlowError::InvalidRoll | BlowError::EmptyDistribution | BlowError::InvalidHand => {
            "RangeError"
        }
    }
    .into())
}

fn check(c: &mut common::Case, value: &Value) {
    // Full tier tokens are long: report the first differing atom/field rather than both tiers.
    let exp = c.word();
    let got = write(value);
    if exp != got {
        let i = exp
            .bytes()
            .zip(got.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(exp.len().min(got.len()));
        let view = |s: &str| s[i.saturating_sub(45)..(i + 150).min(s.len())].to_owned();
        c.fail(&format!(
            "byte {i}: JS `{}`, Rust `{}`",
            view(&exp),
            view(&got)
        ));
    }
}

fn sampler(t: &Tier, exp: &Value) -> Value {
    match create_blow_sampler(t) {
        Err(e) => error(e),
        Ok(s) => Arr(vec![
            Num(s.total),
            Arr(s.cumulative().iter().copied().map(Num).collect()),
            Arr(exp
                .at(2)
                .items()
                .iter()
                .map(|r| {
                    let roll = r.at(0).to_number();
                    let checked = s.outcome_at(roll).map_or_else(error, |(i, o)| {
                        assert!(std::ptr::eq(o, &t.outcomes[i]));
                        idx(i)
                    });
                    let (i, o) = s.sample(roll);
                    assert!(std::ptr::eq(o, &t.outcomes[i]));
                    Arr(vec![Num(roll), checked, idx(i)])
                })
                .collect()),
        ]),
    }
}

fn row(v: &Value) -> Atom {
    let f = |i| v.at(i).to_number();
    let b = |i| v.at(i).truthy();
    Atom {
        p: f(0),
        direction_index: f(2) as usize,
        facing: b(3),
        backstab: b(4),
        crit: b(5),
        hit: b(6),
        whole: b(7),
        part: opt(v, 8).map(|n| n as usize),
        detail: Some(FullDetail {
            roll: f(9) as isize,
            pre_finish: f(10),
            card: f(11),
        }),
        blow_base: opt(v, 12),
        branch: opt(v, 13).map(|n| n as usize),
        blow: f(14),
        echo_damage: f(15),
        damage: f(16),
        claim: f(17),
        capped_damage: f(18),
        echo_mask: f(19) as i32,
        echo_hits: f(20) as i32,
        echo_eligible: b(21),
        formula_positive: b(22),
        strikes_damage: f(23),
        strikes_positive: b(24),
    }
}

fn opt(v: &Value, i: usize) -> Option<f64> {
    (!v.at(i).is_nullish()).then(|| v.at(i).to_number())
}

#[test]
fn blow_outcomes_match_js() {
    let defs = common::Defs::new();
    let cases = common::stream("blow_outcomes");
    let mut seen = BTreeMap::new();
    let mut ch = Undefined;
    let mut args = Undefined;
    let mut full = None;
    let mut fight = None;
    let mut carry = None;
    for mut c in cases {
        let kind = c.kind.clone();
        match kind.as_str() {
            "build" => {
                ch = c.value(&defs);
                args = c.value(&defs);
                full = Some(blow_outcomes(&ch, &args).unwrap());
                fight = None;
                carry = None;
            }
            "full" | "fight" | "carry" => {
                let t = match kind.as_str() {
                    "full" => full.as_ref().unwrap(),
                    "fight" => fight.insert(if args.get("carry").truthy() {
                        merge_to_fight_tier(full.as_ref().unwrap())
                    } else {
                        blow_fight_tier(&ch, &args).unwrap()
                    }),
                    _ => carry.insert(blow_fight_tier(&ch, &args).unwrap()),
                };
                check(&mut c, &head(t));
                check(&mut c, &atoms(t));
            }
            "sample_fight" | "sample_carry" | "sample_raw" => {
                let raw;
                let t = match kind.as_str() {
                    "sample_fight" => fight.as_ref().unwrap(),
                    "sample_carry" => carry.as_ref().unwrap(),
                    _ => {
                        raw = Tier {
                            kind: TierKind::Fight,
                            hand: Hand::Main,
                            cap: 0.0,
                            directions: vec![],
                            total: 6.0,
                            meta: Null,
                            merged_from: None,
                            carry_resolve: None,
                            outcomes: c
                                .value(&defs)
                                .items()
                                .iter()
                                .map(|p| Atom {
                                    p: p.to_number(),
                                    ..Default::default()
                                })
                                .collect(),
                        };
                        &raw
                    }
                };
                let exp = c.value(&defs);
                assert_eq!(
                    write(&exp),
                    write(&sampler(t, &exp)),
                    "{}:{} {kind}",
                    c.file,
                    c.line
                );
            }
            "trace" => {
                let t = carry.as_ref().unwrap();
                let resolve = t.carry_resolve.as_ref().unwrap();
                let mut state = create_carry_state();
                let mut carry = Carry {
                    state: Some(&mut state),
                    weapon_key: 1,
                    loot_key: 2,
                };
                for step in c.value(&defs).items() {
                    let i = step.at(0).to_number() as usize;
                    let draw = resolve.resolve(&t.outcomes[i], &mut carry);
                    assert_eq!(
                        write(step.at(1)),
                        write(&atom(t, &draw)),
                        "{}:{} trace at atom {i}",
                        c.file,
                        c.line
                    );
                }
            }
            "merge_raw" => {
                let raw = c.value(&defs);
                let mut t = full.as_ref().unwrap().clone();
                t.kind = TierKind::Full;
                t.outcomes = raw.items().iter().map(row).collect();
                t.directions = vec![Str("StrikeLeft".into())];
                check(&mut c, &atoms(&merge_to_fight_tier(&t)));
                check(&mut c, &atoms(&merge_to_carry_tier(&t).unwrap()));
            }
            "tolerance" => check(&mut c, &Num(TOLERANCE)),
            "bad_hand" => {
                let hand = c.value(&defs);
                let mut args = Value::Obj(vec![]);
                args.set("hand", hand);
                check(
                    &mut c,
                    &error(blow_outcomes(&Undefined, &args).unwrap_err()),
                );
            }
            "bad_kind" => {
                let t = blow_outcomes(&Undefined, &Undefined).unwrap();
                check(&mut c, &error(create_blow_sampler(&t).unwrap_err()));
                check(&mut c, &error(merge_to_carry_tier(&t).unwrap_err()));
            }
            _ => c.fail("unknown family"),
        }
        c.done();
        *seen.entry(kind).or_insert(0) += 1;
    }
    for k in [
        "full",
        "fight",
        "carry",
        "sample_fight",
        "sample_carry",
        "trace",
        "merge_raw",
        "sample_raw",
    ] {
        assert!(
            seen.get(k).copied().unwrap_or(0) >= 2000,
            "short {k} family"
        );
    }
    for k in ["bad_hand", "bad_kind", "tolerance"] {
        assert!(seen.contains_key(k), "missing {k}");
    }
}
