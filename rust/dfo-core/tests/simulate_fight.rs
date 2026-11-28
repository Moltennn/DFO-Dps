mod common;
use dfo_core::{
    simulate_fight::*,
    spells::spells_by_index_map,
    value::{self, Value},
};
use Value::{Arr, Bool, Null, Num, Obj, Str};

fn check(case: &common::Case, path: &str, want: &Value, got: &Value) {
    match (want, got) {
        (Obj(a), Obj(b)) => {
            if a.len() != b.len() {
                case.fail(&format!(
                    "{path}: keys {:?} != {:?}",
                    a.iter().map(|(k, _)| k).collect::<Vec<_>>(),
                    b.iter().map(|(k, _)| k).collect::<Vec<_>>()
                ));
            }
            for ((key, a), (other, b)) in a.iter().zip(b) {
                if key != other {
                    case.fail(&format!("{path}: expected key {key}, got {other}"));
                }
                check(case, &format!("{path}.{key}"), a, b);
            }
        }
        (Arr(a), Arr(b)) if a.len() == b.len() => {
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                check(case, &format!("{path}[{i}]"), a, b);
            }
        }
        _ if value::write(want) == value::write(got) => (),
        _ => case.fail(&format!("{path}: expected {want:?}, got {got:?}")),
    }
}

#[test]
fn seeded_fights() {
    let mut cases = common::stream("simulate_fight");
    let mut book = cases.next().expect("spellbook");
    assert_eq!(book.kind, "book");
    let defs = common::Defs::new();
    let records = book.value(&defs);
    book.done();
    assert!(records.items().len() > 5);
    let book = spells_by_index_map(records.items().iter().cloned());
    let (mut configs, mut trials, mut reused, mut schedules, mut seeds) = (0, 0, 0, 0, 0);
    for mut c in cases {
        let a = c.value(&defs);
        let got = match c.kind.as_str() {
            "batch" | "reuse" | "extraBatch" => {
                let args = c.value(&defs);
                let batch = simulate_fights(&a, &args, &book).unwrap_or_else(Str);
                if c.kind == "reuse" {
                    for row in batch.get("rows").items() {
                        let mut args = args.clone();
                        args.set("seed", row.get("seed").clone());
                        check(
                            &c,
                            "standalone",
                            row,
                            &simulate_fight(&a, &args, &book).unwrap_or_else(Str),
                        );
                        reused += 1;
                    }
                } else if c.kind == "batch" {
                    configs += 1;
                    trials += batch.get("rows").items().len();
                }
                batch
            }
            "with" => {
                simulate_fight_with(&a, &c.value(&defs), &c.value(&defs), &book).unwrap_or_else(Str)
            }
            "batchWith" => simulate_fights_with(&a, &c.value(&defs), &c.value(&defs), &book)
                .unwrap_or_else(Str),
            "single" => simulate_fight(&a, &c.value(&defs), &book).unwrap_or_else(Str),
            "script" => {
                let args = c.value(&defs);
                let log = c.value(&defs);
                let mut cws = log.at(0).items().iter();
                let mut condition = log.at(1).items().iter();
                let row = simulate_fight_cached(
                    &a,
                    &args,
                    &book,
                    &mut create_tier_cache(),
                    FightRolls {
                        cws: Some(&mut || cws.next().expect("unexpected CWS draw").to_number()),
                        condition: Some(&mut || {
                            condition
                                .next()
                                .expect("unexpected condition draw")
                                .to_number()
                        }),
                    },
                )
                .unwrap_or_else(Str);
                assert_eq!(cws.len() + condition.len(), 0, "unconsumed JS rolls");
                row
            }
            "paired" => {
                simulate_paired_fights(a.items(), &c.value(&defs), &book).unwrap_or_else(Str)
            }
            "seeds" => {
                seeds += 1;
                Arr(paired_fight_seeds(&a, &c.value(&defs)))
            }
            "segment" => Num(health_segment(
                &a.items().iter().map(Value::to_number).collect::<Vec<_>>(),
                c.value(&defs).to_number(),
            ) as f64),
            "summary" => summarize(a.items(), &c.value(&defs)),
            "wilson" => wilson_interval(
                a.to_number(),
                c.value(&defs).to_number(),
                c.value(&defs).to_number(),
            ),
            "durability" => durability_stats(a.items()),
            "schedule" => {
                schedules += 1;
                match create_attack_schedule(&a, &c.value(&defs), &book) {
                    Err(e) => Str(e),
                    Ok(None) => Null,
                    Ok(Some(sc)) => Arr(vec![
                        Num(sc.health),
                        sc.assumptions.clone(),
                        sc.probe.health_share.clone(),
                        Arr(sc
                            .take(18)
                            .map(|ev| {
                                Obj(vec![
                                    ("t".into(), Num(ev.t)),
                                    ("hand".into(), Str(format!("{:?}", ev.hand).to_lowercase())),
                                    ("start".into(), Num(ev.start)),
                                    ("fresh".into(), Bool(ev.fresh)),
                                    ("tail".into(), ev.tail.map_or(Null, Num)),
                                    ("holdTicks".into(), Num(ev.hold_ticks)),
                                ])
                            })
                            .collect()),
                    ]),
                }
            }
            _ => c.fail("unknown case"),
        };
        c.expect("=>");
        let want = c.value(&defs);
        check(&c, "result", &want, &got);
        c.done();
    }
    // Each family floor is the sample's own count in MANIFEST: the batch kind selects the configs, every batch runs its
    // 10 trials, every reuse case replays its 3 seeds, and the rest are case counts. No number is copied by hand.
    let batch = common::floor("simulate_fight", "batch");
    let reuse = common::floor("simulate_fight", "reuse");
    const TRIALS_PER_BATCH: usize = 10;
    const SEEDS_PER_REUSE: usize = 3;
    assert!(
        configs >= batch,
        "only {configs} batch configs (expected >= {batch})"
    );
    assert!(
        trials >= TRIALS_PER_BATCH * configs,
        "only {trials} trials for {configs} batches"
    );
    assert!(
        reused >= SEEDS_PER_REUSE * reuse,
        "only {reused} reused rows (expected >= {})",
        SEEDS_PER_REUSE * reuse
    );
    let schedules_min = common::floor("simulate_fight", "schedule");
    assert!(
        schedules >= schedules_min,
        "only {schedules} schedules (expected >= {schedules_min})"
    );
    let seeds_min = common::floor("simulate_fight", "seeds");
    assert!(
        seeds >= seeds_min,
        "only {seeds} seed cases (expected >= {seeds_min})"
    );
}
