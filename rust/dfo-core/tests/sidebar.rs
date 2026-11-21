//! `dfo_core::sidebar`'s PUBLIC composition, differentially against the VENDORED game code.
//!
//! `tests/sidebar_oracle.mjs` drives what this repository can actually run (see its header) and prints the vendor's own
//! answers; each case is replayed here through `import_save` + `firmament_layer` + `vitals`, so a port that composes a
//! term twice, in the wrong order, with the wrong base, or not at all fails. What the oracle cannot drive (the stubbed
//! `firmamentTree`, the C# paperdoll rating, `renownBonus`) is stated in its header and NOT pretended to be covered.
//!
//! The repo is a Node project and this test spawns `node`; it panics rather than skipping, because a skipped
//! differential proves nothing.

use dfo_core::sidebar::{
    armor_display_mod, armor_fold_parts, armor_values, even_hp_of, firmament_layer, health_layer,
    import_save, spell_point_multiplier, spell_points, vitals, Fact, Layer, Sky,
};
use dfo_core::value::Value::{self, Arr, Num, Obj, Str};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn oracle_lines() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("sidebar_oracle.mjs");
    let out = Command::new("node")
        .arg(&script)
        .current_dir(repo_root())
        .output()
        .expect("the vendored oracle script runs (this repository's Node project)");
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle {script:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("the oracle's output is UTF-8")
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (k, v) in pairs {
        out.set(k, v);
    }
    out
}

/// A save shaped like real upstream: `items[]` carrying `equipSlot`, and NO `worn` (`src/save.js:251-259`).
fn doc(stored: f64, endurance: f64, max_magicka: f64) -> Value {
    obj([
        (
            "career",
            obj([
                ("hitPointsPerLevel", Num(12.0)),
                ("abilityFlagsAndSpellPointsBitfield", Num(0x1000 as f64)),
            ]),
        ),
        ("level", Num(10.0)),
        (
            "stats",
            obj([("intelligence", Num(77.0)), ("endurance", Num(endurance))]),
        ),
        ("activeEffects", Arr(vec![])),
        ("_mods", Obj(vec![])),
        ("health", Num(1.0)),
        ("maxHealth", Num(stored)),
        ("magicka", Num(0.0)),
        ("maxMagicka", Num(max_magicka)),
        ("items", Arr(vec![])),
    ])
}

/// The normalized build for `save`, as `save::character_from_save` makes it (`src/save.js:251-305`).
fn build_of(save: &Value) -> Value {
    dfo_core::save::character_from_save(
        save,
        &obj([
            ("online", dfo_core::value::Value::Bool(true)),
            ("martialPath", dfo_core::value::Value::Undefined),
            ("slot", dfo_core::value::Value::Null),
            ("file", dfo_core::value::Value::Null),
        ]),
    )
}

fn known(f: Fact) -> f64 {
    f.value().expect("the case supplies every fact")
}

#[test]
fn the_public_composition_matches_the_vendored_numbers() {
    let lines = oracle_lines();
    assert!(
        lines.len() >= 50,
        "the oracle printed too few cases: {}",
        lines.len()
    );
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for line in lines {
        let toks: Vec<&str> = line.split_whitespace().collect();
        let kind = toks[0];
        *seen.entry(kind.to_owned()).or_insert(0) += 1;
        match kind {
            // `setRenownLayer`: stored (limiter applied by the ACCESSOR) + extras {hp 44, end 15}, floor composed.
            "horse" => {
                let stored: f64 = toks[1].parse().unwrap();
                let limiter = toks[2].parse::<f64>().unwrap();
                let want: f64 = toks[5].parse().unwrap();
                let save = doc(stored, 60.0, 0.0);
                let facts = import_save(&save, &build_of(&save));
                // A save writes the UNLIMITED value; the limiter is a live-entity fact, so it is not imported. The
                // vendor's own number here caps the stored value, so this case is replayed through the documented
                // accessor form instead of `vitals` (which must NOT apply a limiter to a save).
                let capped = if limiter >= 1.0 && limiter < stored {
                    limiter
                } else {
                    stored
                };
                // `setRenownLayer` computes the floor off the UNLIMITED stored value (`systems/levelEven.js:39-45`
                // reads `rawMaxHealth`), not off the limiter's answer.
                let even = even_hp_of(stored, 12.0, 10.0, 60.0 + 15.0);
                let sky = Sky {
                    hp: Fact::Known(44.0),
                    mp: Fact::Known(8.0),
                    even: Fact::Known(even),
                };
                let layer = Layer::default();
                let got = capped + known(health_layer(&layer, &sky));
                assert_eq!(got, want, "{line}");
                let _ = facts;
            }
            // `evenHpOf`: the LEVEL-EVEN order over the stored maximum.
            "even" => {
                let stored: f64 = toks[1].parse().unwrap();
                let h: f64 = toks[2].parse().unwrap();
                let level: f64 = toks[3].parse().unwrap();
                let endurance: f64 = toks[4].parse().unwrap();
                let want: f64 = toks[5].parse().unwrap();
                assert_eq!(even_hp_of(stored, h, level, endurance), want, "{line}");
            }
            // `firmamentPowers.js:253-273` over the law's totals: the PUBLIC `firmament_layer` + `vitals` against the
            // vendor's own accessor after its real setters (`want_total`, `want_magicka`, `want_even`).
            "sky" => {
                let stored: f64 = toks[1].parse().unwrap();
                let endurance: f64 = toks[4].parse().unwrap();
                let (hp, hp_pct, mp, mp_pct): (f64, f64, f64, f64) = (
                    toks[5].parse().unwrap(),
                    toks[6].parse().unwrap(),
                    toks[7].parse().unwrap(),
                    toks[8].parse().unwrap(),
                );
                let (want_total, want_magicka, want_even, want_renown): (f64, f64, f64, f64) = (
                    toks[9].parse().unwrap(),
                    toks[10].parse().unwrap(),
                    toks[11].parse().unwrap(),
                    toks[12].parse().unwrap(),
                );
                let save = doc(stored, endurance, 77.0);
                let facts = import_save(&save, &build_of(&save));
                let totals = obj([
                    ("hp", Num(hp)),
                    ("hpPct", Num(hp_pct)),
                    ("mp", Num(mp)),
                    ("mpPct", Num(mp_pct)),
                    ("endurance", Num(13.0)),
                    ("pct.endurance", Num(9.0)),
                ]);
                let sky = firmament_layer(&facts, &totals);
                assert_eq!(sky.even, Fact::Known(want_even), "{line}");
                // The composed layer the vendor reports is `renownHp` = hp-share + even.
                assert_eq!(
                    known(health_layer(&Layer::default(), &sky)),
                    want_renown,
                    "{line}"
                );
                let v = vitals(&facts, &Layer::default(), &sky);
                assert_eq!(v.health, Fact::Known(want_total), "{line}");
                assert_eq!(v.magicka, Fact::Known(want_magicka), "{line}");
                // The temporary-Endurance case: the same document with a fortify effect must read the SAME sky, because
                // the vendor reads the permanent `entity.stats` (`firmamentPowers.js:128`, `renownLayer.js:84`).
                let mut fortified = doc(stored, endurance, 77.0);
                fortified.set(
                    "activeEffects",
                    Arr(vec![obj([
                        ("kind", s("fortifyAttribute")),
                        ("stat", s("endurance")),
                        ("magnitude", Num(20.0)),
                    ])]),
                );
                let again =
                    firmament_layer(&import_save(&fortified, &build_of(&fortified)), &totals);
                assert_eq!(
                    again, sky,
                    "{line} (a temporary Endurance must not move the sky)"
                );
            }
            // The career base the accessor computes, from the multiplier table.
            "acc" => {
                let intelligence: f64 = toks[1].parse().unwrap();
                let bitfield: f64 = toks[2].parse().unwrap();
                let want: f64 = toks[3].parse().unwrap();
                let live = intelligence.min(100.0);
                assert_eq!(
                    spell_points(live, spell_point_multiplier(bitfield)),
                    want,
                    "{line}"
                );
            }
            // The armour table, the affix fold and the sky fold, through the PUBLIC display term.
            "armor" => {
                let inc: f64 = toks[1].parse().unwrap();
                let sky_armor: f64 = toks[2].parse().unwrap();
                let count: usize = toks[3].parse().unwrap();
                let worn: Vec<Value> = toks[4..4 + count]
                    .iter()
                    .map(|p| {
                        let f: Vec<&str> = p.split(':').collect();
                        let group = match f[0] {
                            "A" => "Armor",
                            "M" => "MensClothing",
                            "W" => "WomensClothing",
                            _ => "Weapons",
                        };
                        let affix: f64 = f[4].parse().unwrap();
                        let mut it = obj([
                            ("group", s(group)),
                            ("templateIndex", Num(f[1].parse().unwrap())),
                            ("material", Num(f[2].parse().unwrap())),
                            ("equipSlot", Num(f[3].parse().unwrap())),
                            ("affixes", Arr(vec![])),
                        ]);
                        if affix > 0.0 {
                            it.set(
                                "affixes",
                                Arr(vec![obj([("id", s("armor")), ("value", Num(affix))])]),
                            );
                        }
                        it
                    })
                    .collect();
                let want: Vec<f64> = toks[4 + count..]
                    .iter()
                    .map(|v| v.parse().unwrap())
                    .collect();
                // The path from a RAW save through the PUBLIC import: a save has `items[]`+`equipSlot`, never `worn`, so
                // this also proves `import_save` reads the normalized build's list (an empty `worn` would yield zeros).
                let save = obj([
                    ("items", Arr(worn.clone())),
                    ("career", obj([("hitPointsPerLevel", Num(12.0))])),
                    ("level", Num(10.0)),
                    ("maxHealth", Num(240.0)),
                    ("maxMagicka", Num(77.0)),
                    ("stats", Obj(vec![])),
                ]);
                let facts = import_save(&save, &build_of(&save));
                assert_eq!(
                    facts.worn.len(),
                    count,
                    "{line} (the armour list is the build's)"
                );
                // The table itself must agree: 100 minus 5 x the vendored value per covered part.
                assert_eq!(armor_values(&facts.worn).len(), 7);
                let fold = armor_fold_parts(&facts.worn, &[sky_armor; 7]);
                let enchant = obj([
                    ("increasedArmorMod", Num(inc)),
                    ("decreasedArmorMod", Num(0.0)),
                ]);
                assert_eq!(armor_display_mod(&enchant, &fold).to_vec(), want, "{line}");
            }
            other => panic!("unknown oracle kind `{other}`"),
        }
    }
    for kind in ["horse", "even", "sky", "acc", "armor"] {
        assert!(
            seen.get(kind).copied().unwrap_or(0) > 0,
            "the oracle covered no `{kind}` case"
        );
    }
}

#[test]
fn an_imported_save_keeps_unknown_terms_unknown() {
    // LOCAL INVARIANT (the reviewer's point): a document with no maxima or permanent facts must not become 0.
    let bare = obj([("health", Num(40.0))]);
    let facts = import_save(&bare, &build_of(&bare));
    assert_eq!(facts.max_health, Fact::Unknown);
    assert_eq!(facts.max_magicka, Fact::Unknown);
    assert_eq!(facts.endurance, Fact::Unknown);
    assert_eq!(facts.health, Fact::Known(40.0));
    let totals = obj([("hp", Num(28.0)), ("hpPct", Num(7.0)), ("mp", Num(8.0))]);
    let sky = firmament_layer(&facts, &totals);
    assert_eq!(sky.hp, Fact::Unknown);
    assert_eq!(sky.even, Fact::Unknown);
    let v = vitals(&facts, &Layer::default(), &sky);
    assert_eq!(v.health, Fact::Unknown);
    assert_eq!(v.magicka, Fact::Unknown);
    let v = vitals(&facts, &Layer::default(), &Sky::asleep());
    assert_eq!(v.health, Fact::Unknown);
    let _ = Arr(vec![]);
}
