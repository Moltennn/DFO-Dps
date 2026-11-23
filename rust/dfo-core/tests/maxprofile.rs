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
