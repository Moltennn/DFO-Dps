mod common;
use dfo_core::{
    maxprofile as m,
    spells::Spellbook,
    value::{write, Value},
};
use std::collections::BTreeMap;

/// Every family the file carries; a new one must be added here and to a test below, so it cannot pass unread.
const KINDS: &[&str] = &[
    "build", "run", "frontier", "legal", "max", "plan", "refusal",
];

/// Stream `maxprofile` for `kinds` only, with the fixture spellbook row first and a private profile cache per test.
fn replay(
    kinds: &[&str],
    floors: &[(&str, usize)],
    mut check: impl FnMut(&str, &mut dyn FnMut() -> Value, &Spellbook, &mut m::Profiles<'_>) -> Value,
) {
    // Keep the replay's caller-owned cache tied to one copy of the explicit stock book.
    let stock = common::stream("maxprofile")
        .next()
        .expect("fixture spellbook");
    let book: Spellbook = common::planning::spellbook(stock);
    let mut profiles = m::Profiles::new(&book);
    let defs = Default::default();
    let mut counts = BTreeMap::new();
    for mut row in common::stream("maxprofile") {
        let k = row.kind.clone();
        if k == "book" {
            // Each test must still see the fixture spellbook row first (parsed once more: one cheap line).
            assert!(!row.value(&defs).items().is_empty());
            row.done();
            continue;
        }
        assert!(KINDS.contains(&k.as_str()), "unexpected vector kind {k}");
        if !kinds.contains(&k.as_str()) {
            continue;
        }
        let got = check(&k, &mut || row.value(&defs), &book, &mut profiles);
        row.expect("=>");
        let want = row.word();
        let got = write(&got);
        if want != got {
            let i = want
                .bytes()
                .zip(got.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let excerpt = |s: &str| s[i.saturating_sub(100)..s.len().min(i + 150)].to_owned();
            row.fail(&format!(
                "{k} byte {i}: expected {}; got {}",
                excerpt(&want),
                excerpt(&got)
            ));
        }
        row.done();
        *counts.entry(k).or_insert(0) += 1;
    }
    for &(k, floor) in floors {
        assert!(
            counts.get(k).copied().unwrap_or(0) >= floor,
            "missing vectors: maxprofile/{k}: {counts:?}"
        );
    }
}

#[test]
fn build() {
    replay(&["build"], &[("build", 3129)], |k, v, _, _| match k {
        "build" => m::build_max(&v(), &v()).unwrap(),
        other => panic!("unexpected vector kind {other}"),
    });
}

#[test]
fn run() {
    replay(&["run"], &[("run", 3129)], |k, v, book, _| match k {
        "run" => {
            let mut ch = m::build_max(&v(), &v()).unwrap();
            for (k, x) in v().entries() {
                ch.set(k, x.clone());
            }
            m::max_run(&ch, &v(), book).to_value()
        }
        other => panic!("unexpected vector kind {other}"),
    });
}

// Local invariant: `loadout` hands one cache to every encounter and the imprint ranking, so a warm cache must answer
// as a fresh one does, and a template or a shield must not read another's entry.
#[test]
fn a_warm_frontier_cache_answers_as_a_fresh_one() {
    let stock = common::stream("maxprofile")
        .next()
        .expect("fixture spellbook");
    let book: Spellbook = common::planning::spellbook(stock);
    let shield = |t: f64| Value::Obj(vec![("shield".to_owned(), Value::Num(t))]);
    let capped = Value::Obj(vec![("metric".to_owned(), Value::Str("capped".into()))]);
    let requests = [
        (123.0, Value::Undefined),
        (123.0, shield(112.0)),
        (118.0, Value::Undefined),
        (123.0, capped),
        (123.0, Value::Undefined),
    ];
    let mut warm = m::Profiles::new(&book);
    for (template, opts) in &requests {
        let t = Value::Num(*template);
        let mut fresh = m::Profiles::new(&book);
        assert_eq!(
            write(warm.legal_frontier(&t, opts).unwrap()),
            write(fresh.legal_frontier(&t, opts).unwrap()),
            "{template}"
        );
        assert_eq!(
            write(&warm.legal_gear(&t, opts).unwrap()),
            write(&fresh.legal_gear(&t, opts).unwrap()),
            "{template}"
        );
        assert_eq!(
            write(&warm.max_character(&t, opts).unwrap()),
            write(&fresh.max_character(&t, opts).unwrap()),
            "{template}"
        );
    }
}

#[test]
fn legal() {
    replay(
        &["frontier", "legal", "max", "plan", "refusal"],
        &[
            ("frontier", 115),
            ("legal", 346),
            ("max", 92),
            ("plan", 1),
            ("refusal", 2),
        ],
        |k, v, _, profiles| match k {
            "frontier" => profiles.legal_frontier(&v(), &v()).unwrap().clone(),
            "legal" => profiles.legal_gear(&v(), &v()).unwrap(),
            "max" => profiles.max_character(&v(), &v()).unwrap(),
            "plan" => profiles.legal_gear_plan(&v(), &v()).unwrap(),
            "refusal" => Value::Str(profiles.legal_gear(&v(), &v()).unwrap_err()),
            other => panic!("unexpected vector kind {other}"),
        },
    );
}
