//! The real-build chain against the real JS (`tools/rust-planner-vectors.mjs`).

mod common;

use dfo_core::loadout_shortlist::{shortlist_loadouts_with, ShortlistOpts};
use dfo_core::maxprofile::Profiles;
use dfo_core::real_build::{
    apply_tree, is_sampled_loadout, real_build_stages_with, real_weapon_loadouts_with, StageOpts,
};
use dfo_core::spells::spells_by_index_map;
use dfo_core::value::Value::{self, Arr, Bool, Num, Str};
use std::collections::BTreeMap;

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

/// `obj({ k: v, ... })` from pairs, in order (the harness helper is crate-private).
fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Value::Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// The probe tuple the generator writes for a stage: the mods, the blow percent, the item's enchant rows and condition.
fn strip_character(ch: &Value) -> Value {
    let on_weapon = !ch.get("weapon").is_nullish();
    let item = if on_weapon {
        ch.get("weapon").clone()
    } else {
        ch.get("wraps").clone()
    };
    let off = ch.get("offWeapon");
    let condition = match item.get("currentCondition") {
        Value::Num(n) => Num(*n),
        _ => Value::Null,
    };
    let off_condition = match off.get("currentCondition") {
        Value::Num(n) => Num(*n),
        _ => Value::Null,
    };
    // JS `?? null`: an absent key prints as `null`, not `undefined`.
    let or_null = |v: &Value| {
        if v.is_nullish() {
            Value::Null
        } else {
            v.clone()
        }
    };
    let off_slot = match off.get("equipSlot") {
        Value::Num(n) => Num(*n),
        _ => Value::Null,
    };
    obj([
        ("mods", ch.get("_mods").clone()),
        ("firmamentDamagePct", {
            let v = ch.get("firmamentDamagePct");
            if matches!(v, Value::Num(_)) {
                v.clone()
            } else {
                Value::Null
            }
        }),
        ("enchantments", or_null(item.get("enchantments"))),
        ("condition", condition),
        ("offEnchantments", or_null(off.get("enchantments"))),
        ("offCondition", off_condition),
        ("offEquipSlot", off_slot),
        ("dual", Bool(ch.get("_dual").truthy())),
    ])
}

fn stage_value(st: &dfo_core::real_build::Stages) -> Value {
    obj([
        ("capped", Bool(st.capped)),
        ("target", st.target.clone()),
        ("treeStars", st.tree.get("stars").clone()),
        ("treeFreeStars", st.tree.get("freeStars").clone()),
        (
            "treeBlow",
            Num(st.tree_ch.get("firmamentDamagePct").to_number()),
        ),
        (
            "treeDps",
            Num(st.tree_run.totals.carried_capped_dps + st.tree_run.card.fields.enchant_dps),
        ),
        (
            "enchDps",
            Num(st.ench_run.totals.carried_capped_dps + st.ench_run.card.fields.enchant_dps),
        ),
        ("treeCh", strip_character(&st.tree_ch)),
        ("enchCh", strip_character(&st.ench_ch)),
        ("gearCh", strip_character(&st.gear_ch)),
        ("imprint", st.imprint.clone()),
    ])
}

/// Every family the file may carry; a new one must be added here and to a test, so it cannot pass unread.
const KNOWN: &[&str] = &[
    "stage",
    "loadouts",
    "sampled",
    "apply",
    "shortlist",
    "shortlist-err",
];

/// Stream `real_build` for `kinds` only, checking the cases whose index among those kinds falls in `only`. The fixture
/// `book` row must still come first, and every caller asserts the floors of its own families: one file, several
/// `#[test]`s, which libtest runs in parallel. A `shortlist` case costs ~17 s, so one `#[test]` per case is what keeps
/// the suite's wall time near one case rather than seven.
fn replay(
    kinds: &[&str],
    only: std::ops::Range<usize>,
    floors: &[&str],
    check: impl Fn(&str, &mut dyn FnMut() -> Value, &mut Profiles<'_>) -> Value,
) {
    let defs = Default::default();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut book = None;
    let mut profiles: Option<Profiles<'_>> = None;
    let mut seen = 0usize;
    for mut row in common::stream("real_build") {
        let kind = row.kind.clone();
        if kind == "book" {
            let v = row.value(&defs);
            assert!(!v.items().is_empty());
            let b = book.replace(spells_by_index_map(v.items().iter().cloned()));
            assert!(b.is_none());
            profiles = book.as_ref().map(Profiles::new);
            row.done();
            continue;
        }
        assert!(
            KNOWN.contains(&kind.as_str()),
            "unexpected real_build kind {kind}"
        );
        if !kinds.contains(&kind.as_str()) {
            continue;
        }
        let index = seen;
        seen += 1;
        if !only.contains(&index) {
            continue;
        }
        let profiles = profiles
            .as_mut()
            .expect("real_build: the fixture spellbook row must come first");
        let got = check(&kind, &mut || row.value(&defs), profiles);
        row.expect("=>");
        let want = row.word();
        let text = dfo_core::value::write(&got);
        if want != text {
            let i = want
                .bytes()
                .zip(text.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let excerpt = |x: &str| x[i.saturating_sub(160)..x.len().min(i + 200)].to_owned();
            row.fail(&format!(
                "{kind} byte {i}: expected {}; got {}",
                excerpt(&want),
                excerpt(&text)
            ));
        }
        row.done();
        *counts.entry(kind).or_insert(0) += 1;
    }
    assert!(book.is_some(), "real_build: the spellbook row is missing");
    for &kind in floors {
        // A ranged replay checks one case per `#[test]` (a `shortlist` case costs ~17 s), so its floor is the MANIFEST
        // count capped by what the range can select.
        let floor = common::floor("real_build", kind).min(only.len());
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "real_build/{kind}: {n} cases, floor {floor}");
    }
}

#[test]
fn stages_loadouts_sampled_apply() {
    replay(
        &["stage", "loadouts", "sampled", "apply"],
        0..usize::MAX,
        &["stage", "loadouts", "sampled", "apply"],
        |kind, v, profiles| match kind {
            "stage" => {
                let o = v();
                let opts = StageOpts::from_value(&o);
                let st = real_build_stages_with(
                    o.get("template"),
                    &obj([("key", o.get("family").clone())]),
                    &opts,
                    profiles,
                )
                .expect("realBuildStages");
                stage_value(&st)
            }
            "loadouts" => {
                let o = v();
                let opt = StageOpts::from_value(&o);
                let rows = real_weapon_loadouts_with(
                    std::slice::from_ref(&opt.mode),
                    opt.vampire,
                    &opt.encounter,
                    &opt.game_build,
                    profiles,
                )
                .expect("realWeaponLoadouts");
                Arr(rows)
            }
            "sampled" => Bool(is_sampled_loadout(&v())),
            "apply" => {
                let o = v();
                let template = o.get("template").to_number();
                let family = o.get("family").to_js_string();
                let ch = profiles
                    .max_character(&Num(template), &obj([]))
                    .expect("maxCharacter");
                let applied = apply_tree(&ch, &family);
                strip_character(&applied)
            }
            other => panic!("unexpected real_build kind {other}"),
        },
    );
}

// One `#[test]` per `shortlist` case: each samples 1,000 fights per row (~17 s), so the suite costs one case's wall
// time under libtest's threads instead of their sum. The family floor is asserted per case, below.
macro_rules! shortlist_case {
    ($name:ident, $index:expr) => {
        #[test]
        fn $name() {
            replay(
                &["shortlist"],
                $index..$index + 1,
                &["shortlist"],
                |kind, v, profiles| {
                    assert_eq!(kind, "shortlist");
                    let opts = ShortlistOpts::from_value(&v());
                    shortlist_loadouts_with(&opts, profiles).expect("shortlistLoadouts")
                },
            );
        }
    };
}
shortlist_case!(shortlist_0, 0);
shortlist_case!(shortlist_1, 1);
shortlist_case!(shortlist_2, 2);
shortlist_case!(shortlist_3, 3);
shortlist_case!(shortlist_4, 4);
shortlist_case!(shortlist_5, 5);
shortlist_case!(shortlist_6, 6);

#[test]
fn shortlist_err() {
    replay(
        &["shortlist-err"],
        0..usize::MAX,
        &["shortlist-err"],
        |kind, v, profiles| match kind {
            "shortlist-err" => {
                let opts = ShortlistOpts::from_value(&v());
                match shortlist_loadouts_with(&opts, profiles) {
                    Ok(_) => Value::Null,
                    Err(message) => s(&message),
                }
            }
            other => panic!("unexpected real_build kind {other}"),
        },
    );
}
