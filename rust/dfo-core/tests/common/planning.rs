use dfo_core::{
    spells::{spells_by_index_map, Spellbook},
    value::{write, Value},
};
use std::collections::BTreeMap;

pub fn spellbook(mut line: super::Case) -> Spellbook {
    assert_eq!(line.kind, "book");
    let records = line.value(&Default::default());
    assert!(!records.items().is_empty());
    line.done();
    spells_by_index_map(records.items().iter().cloned())
}

/// The spellbook in force: the `book` row `tools/rust-vectors.mjs` wrote first into `real_build` (synthetic unless the
/// gate ran with the real tier). Never read from the game's files here.
#[allow(dead_code)]
pub fn fixture_book() -> Spellbook {
    spellbook(
        super::stream("real_build")
            .next()
            .expect("real_build: the spellbook row comes first"),
    )
}

pub fn replay(
    name: &str,
    floors: &[(&str, usize)],
    needs_book: bool,
    mut check: impl FnMut(&str, &mut dyn FnMut() -> Value, Option<&Spellbook>) -> Value,
) {
    let defs = Default::default();
    let mut book = None;
    let mut counts = BTreeMap::new();
    for mut row in super::stream(name) {
        let k = row.kind.clone();
        if k == "book" {
            let v = row.value(&defs);
            assert!(!v.items().is_empty());
            assert!(book
                .replace(spells_by_index_map(v.items().iter().cloned()))
                .is_none());
        } else {
            assert!(!needs_book || book.is_some());
            let got = check(&k, &mut || row.value(&defs), book.as_ref());
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
        }
        row.done();
        *counts.entry(k).or_insert(0) += 1;
    }
    for &(k, floor) in floors {
        assert!(
            counts.get(k).copied().unwrap_or(0) >= floor,
            "missing vectors: {name}/{k}: {counts:?}"
        );
    }
}
