mod common;
use dfo_core::{
    encounters::{encounter_target, purse_of},
    flow_state::FlowState,
    objectives::{evaluate_objective, paired_difference, rank_builds},
    purse::simulate_purse,
    relay_fight::*,
    spells::spells_by_index_map,
    value::{
        self,
        Value::{self, Arr, Bool, Num, Obj, Str},
    },
};

fn check(case: &common::Case, path: &str, want: &Value, got: &Value) {
    match (want, got) {
        (Obj(a), Obj(b)) if a.len() == b.len() => {
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
fn relay_vectors() {
    let mut cases = common::stream("relay_fight");
    let mut first = cases.next().expect("spellbook");
    assert_eq!(first.kind, "book");
    let defs = common::Defs::new();
    let records = first.value(&defs);
    first.done();
    let book = spells_by_index_map(records.items().iter().cloned());
    let (mut configs, mut trials, mut reused, mut scripts) = (0, 0, 0, 0);
    for mut c in cases {
        let a = c.value(&defs);
        let got = match c.kind.as_str() {
            "batch" | "reuse" | "extraBatch" => {
                let args = c.value(&defs);
                let batch = simulate_relay_fights(&a, &args, &book).unwrap_or_else(Str);
                if c.kind == "batch" {
                    configs += 1;
                    trials += batch.get("rows").items().len();
                }
                if c.kind == "reuse" {
                    for row in batch.get("rows").items() {
                        let mut args = args.clone();
                        args.set("seed", row.get("seed").clone());
                        check(
                            &c,
                            "standalone",
                            row,
                            &simulate_relay_fight(&a, &args, &book).unwrap_or_else(Str),
                        );
                        reused += 1;
                    }
                }
                batch
            }
            "single" => simulate_relay_fight(&a, &c.value(&defs), &book).unwrap_or_else(Str),
            "script" => {
                scripts += 1;
                let args = c.value(&defs);
                let log = c.value(&defs);
                let mut iter = log.items().iter();
                let got = simulate_relay_fight_with_rolls(
                    &a,
                    &args,
                    &book,
                    Some(&mut || iter.next().expect("unexpected CWS draw").to_number()),
                )
                .unwrap_or_else(Str);
                assert_eq!(iter.len(), 0, "unconsumed JS rolls");
                got
            }
            "target" => encounter_target(&a, &c.value(&defs), &c.value(&defs)),
            "purse" => simulate_purse(&a, &c.value(&defs), &c.value(&defs)).unwrap_or_else(Str),
            "law" => purse_of(&a),
            "objective" => evaluate_objective(&a, &c.value(&defs), &book).unwrap_or_else(Str),
            "rank" => rank_builds(a.items(), &c.value(&defs), &book).unwrap_or_else(Str),
            "paired" => paired_difference(&a, &c.value(&defs), &c.value(&defs)).unwrap_or_else(Str),
            "flow" => {
                let mut flow = FlowState::new(&a);
                Arr(c
                    .value(&defs)
                    .items()
                    .iter()
                    .map(|e| {
                        let t = e.at(0).to_number();
                        let r = flow.hit(t, e.at(1).truthy(), e.at(2).truthy());
                        Arr(vec![
                            Obj([
                                ("before", Num(r.before)),
                                ("after", Num(r.after)),
                                ("until", Num(r.until)),
                                ("built", Bool(r.built)),
                            ]
                            .map(|(k, v)| (k.into(), v))
                            .to_vec()),
                            flow.state(t),
                        ])
                    })
                    .collect())
            }
            _ => c.fail("unknown case"),
        };
        c.expect("=>");
        let want = c.value(&defs);
        check(&c, "result", &want, &got);
        c.done();
    }
    assert!(configs >= 200 && trials >= 2000 && reused >= 100 && scripts >= 100);
}
