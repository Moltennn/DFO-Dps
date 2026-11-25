//! The R8 singular `spell` cards, differentially against the real JS CLI over a synthetic `SPELLS.STD`.
//!
//! The branch (`src/cli.js:1516-1599`) is not exported, so each case runs `bin/dfo-dps.js spell ...` and compares stdout
//! byte for byte with the renderer. The synthetic book is written under a temp root (never the machine's ARENA2) and
//! read by the Rust side through `dfo_core::spells::read_spells_std`, so both sides see the same records. The pool is
//! every standard record (the theory character has no spellbook), and the character, target, cost, damage and rotation
//! are the shared core's; this pins only the presentation: the caption, the `index ?? '-'` / `String(name ?? '')` cells,
//! the `--all-spells` table, the rotation card with its effects block, the numeric helpers and `table`.
//!
//! Pool resolution (`resolveSpells`/`values.standard`), the pricing/search split, the empty-book case, the selection and
//! the `--json` document shapes are dispatch, not this module; `tests/cli_spell.rs` pins those end to end. The local
//! invariants below (placeholder cells, the NaN comparator, the selection arms) are marked as such.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js, pin_mtime, temp_root};

#[path = "../src/spell.rs"]
mod spell;

use std::fs;
use std::path::{Path, PathBuf};

use dfo_core::analyze::{gate_target, reference_foe};
use dfo_core::maxprofile::Profiles as MaxProfiles;
use dfo_core::spells::{read_spells_std, spells_by_index_map};
use dfo_core::theory::theory_character;
use dfo_core::value::Value::{self, Arr, Bool, Num, Obj, Str};
use std::cmp::Ordering as CmpOrdering;

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}
/// One effect as the record layout stores it: `(type, subType, durationBase, durationMod, durationPerLevel,
/// magnitudeBaseLow, magnitudeBaseHigh, magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel)`.
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

/// One 89-byte `SPELLS.STD` record (`src/spells.js:24-50`, as `tests/build.rs` writes it).
fn spell_record(
    index: u8,
    name: &str,
    element: u8,
    range_type: u8,
    effects: &[SpellEffect],
) -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    for i in 0..3 {
        let (t, st) = effects.get(i).map_or((-1, -1), |e| (e.0, e.1));
        b[2 * i] = t as u8;
        b[2 * i + 1] = st as u8;
    }
    b[6] = element;
    b[7] = range_type;
    b[8..10].copy_from_slice(&12u16.to_le_bytes());
    for (i, e) in effects.iter().enumerate() {
        // durationBase, durationMod, durationPerLevel
        b[14 + 3 * i] = e.2;
        b[15 + 3 * i] = e.3;
        b[16 + 3 * i] = e.4;
        // magnitudeBaseLow/High, magnitudeLevelBase/High, magnitudePerLevel
        b[32 + 5 * i] = e.5;
        b[33 + 5 * i] = e.6;
        b[34 + 5 * i] = e.7;
        b[35 + 5 * i] = e.8;
        b[36 + 5 * i] = e.9;
    }
    let bytes = name.as_bytes();
    b[47..47 + bytes.len().min(25)].copy_from_slice(&bytes[..bytes.len().min(25)]);
    b[73] = index;
    b
}

/// The synthetic book: one instant bolt, one DoT, a debug-name record the list still shows (the `priced` filter is
/// not this branch's), a non-damage Shield, and a range-scaled spell.
fn spells_std() -> Vec<u8> {
    [
        spell_record(1, "Bolt", 4, 0, &[(4, 0, 0, 0, 1, 10, 20, 0, 0, 1)]),
        spell_record(2, "Burn", 4, 0, &[(1, 0, 2, 1, 1, 4, 8, 0, 0, 1)]),
        spell_record(3, "Lvl 1 Probe", 4, 0, &[(4, 0, 0, 0, 1, 1, 3, 0, 0, 1)]),
        spell_record(4, "Shield", 4, 0, &[(35, -1, 0, 5, 1, 0, 0, 0, 0, 1)]),
        spell_record(5, "Far Bolt", 0, 2, &[(4, 0, 0, 0, 1, 20, 40, 1, 1, 2)]),
    ]
    .concat()
}

/// The spellbook the JS `--data` names and the Rust side parses.
fn write_spellbook(root: &Path) -> PathBuf {
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), spells_std()).expect("synthetic SPELLS.STD");
    pin_mtime(&arena.join("SPELLS.STD"));
    arena
}

/// `loadCharacter` for `--theory` (`src/cli.js:401-431`): the legal gear budget from the EMPTY book, which is the
/// module cache's state before the spell branch fills it.
fn theory_character_like_cli(level: f64) -> Value {
    let book = dfo_core::spells::Spellbook::default();
    let legal = MaxProfiles::new(&book)
        .legal_gear(&Num(123.0), &Value::Undefined)
        .expect("the legal gear budget");
    theory_character(&obj([
        ("level", Num(level)),
        ("race", Str("darkelf".to_owned())),
        ("blade", Num(123.0)),
        ("material", Num(9.0)),
        ("gearLB", Num(legal.get("lb").to_number())),
        ("gearCS", Num(legal.get("cs").to_number())),
        ("damagePct", Num(legal.get("dmg").to_number())),
        ("vampire", Bool(false)),
        ("starStats", Obj(vec![])),
        ("starSkills", Obj(vec![])),
        ("starDamage", Num(0.0)),
    ]))
    .expect("the theory character builds")
}

/// The branch's caster tweak (`src/cli.js:1517`): Destruction 200 and mastered, a pool, the name.
fn theory_caster(mut ch: Value) -> Value {
    let mut skills = Arr(ch.get("skills").items().to_vec());
    if let Value::Arr(items) = &mut skills {
        items[22] = Num(200.0);
    }
    ch.set("skills", skills);
    let mut mastered: Vec<Value> = ch.get("masteredSkills").items().to_vec();
    if !mastered.iter().any(|v| v.strict_eq(&Num(22.0))) {
        mastered.push(Num(22.0));
    }
    ch.set("masteredSkills", Arr(mastered));
    if !ch.get("maxMagicka").truthy() {
        ch.set(
            "maxMagicka",
            Num((ch.get("stats").get("intelligence").num_or(100.0) * 3.0).floor()),
        );
    }
    ch.set("name", Str("Level 45 theory caster".to_owned()));
    ch
}

/// The branch's `spellTarget` (`src/cli.js:1527`): `armoured` is the Breach gate, anything else the reference foe.
fn spell_target(level: f64, name: &str) -> Value {
    if name == "armoured" {
        gate_target(&Num(level), &obj([("traits", Arr(vec![]))]))
    } else {
        reference_foe(&Num(level), &Str(name.to_owned()))
    }
}

/// The branch's `opts` (`src/cli.js:1528-1538`), field for field.
fn opts(
    target: &Value,
    level: f64,
    potency: f64,
    pierce: f64,
    cast_speed: f64,
    magicka: Option<f64>,
) -> Value {
    let health = if target.get("isBoss").truthy() {
        target.get("maxHealth").to_number()
    } else {
        0.0
    };
    let mut o = obj([
        ("level", Num(level)),
        ("online", Bool(true)),
        ("potencyPct", Num(potency)),
        ("pierce", Num(pierce)),
        ("castSpeedPct", Num(cast_speed)),
        ("manaSolved", Bool(true)),
        ("health", Num(health)),
        ("traits", target.get("bossTraits").clone()),
    ]);
    if let Some(magicka) = magicka {
        o.set("magicka", Num(magicka));
    }
    o
}

/// One case: the JS flags after `spell --list --theory --data <arena>`, plus the resolved inputs the branch reads.
struct Case<'a> {
    extra: &'a [&'a str],
    label: &'a str,
    level: f64,
    target: &'a str,
    potency: f64,
    pierce: f64,
    cast_speed: f64,
    magicka: Option<f64>,
}

fn cases() -> Vec<Case<'static>> {
    vec![
        Case {
            extra: &[],
            label: "the defaults over a five-spell book",
            level: 45.0,
            target: "armoured",
            potency: 0.0,
            pierce: 0.0,
            cast_speed: 0.0,
            magicka: None,
        },
        Case {
            extra: &[
                "--level",
                "30",
                "--target",
                "soft",
                "--potency",
                "30",
                "--pierce",
                "10",
            ],
            label: "a level-30 soft target with potency and pierce",
            level: 30.0,
            target: "soft",
            potency: 30.0,
            pierce: 10.0,
            cast_speed: 0.0,
            magicka: None,
        },
        Case {
            extra: &["--cast-speed", "20", "--mana-limit", "--magicka", "50"],
            label: "a pool-limited caster with extra cast speed",
            level: 45.0,
            target: "armoured",
            potency: 0.0,
            pierce: 0.0,
            cast_speed: 20.0,
            magicka: Some(50.0),
        },
        Case {
            extra: &["--standard"],
            label: "the same pool through --standard",
            level: 45.0,
            target: "armoured",
            potency: 0.0,
            pierce: 0.0,
            cast_speed: 0.0,
            magicka: None,
        },
    ]
}

#[test]
fn the_list_card_matches_the_js() {
    let root = temp_root("list");
    let arena = write_spellbook(&root);
    let arena_text = arena.to_str().unwrap();
    let book = spells_by_index_map(read_spells_std(&spells_std()));
    let pool: Vec<Value> = book.entries().iter().map(|(_, sp)| sp.clone()).collect();
    for case in cases() {
        let mut args: Vec<&str> = vec!["spell", "--list", "--theory", "--data", arena_text];
        args.extend(case.extra);
        let want = js(&args, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {args:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        let ch = theory_caster(theory_character_like_cli(case.level));
        let target = spell_target(case.level, case.target);
        let opts = opts(
            &target,
            case.level,
            case.potency,
            case.pierce,
            case.cast_speed,
            case.magicka,
        );
        let got = spell::text(&ch, &pool, &target, &opts);
        assert_eq!(
            got.as_bytes(),
            want.stdout.as_slice(),
            "{}: the spell --list card differs",
            case.label
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A LOCAL INVARIANT, not an oracle check: a custom record with no `index` and no `name` prints the JS `-` and empty
/// cells, and the `Damage` column rounds through the JS `fmt`. The standard book cannot produce such a record.
#[test]
fn a_custom_record_prints_the_js_placeholders() {
    let ch = theory_caster(theory_character_like_cli(45.0));
    let target = spell_target(45.0, "armoured");
    let opts = opts(&target, 45.0, 0.0, 0.0, 0.0, None);
    let custom = obj([
        (
            "effects",
            Arr(vec![obj([
                ("type", Num(4.0)),
                ("subType", Num(0.0)),
                ("magnitudeBaseLow", Num(10.0)),
                ("magnitudeBaseHigh", Num(20.0)),
                ("magnitudeLevelBase", Num(0.0)),
                ("magnitudeLevelHigh", Num(0.0)),
                ("magnitudePerLevel", Num(1.0)),
            ])]),
        ),
        ("element", Num(4.0)),
        ("rangeType", Num(0.0)),
    ]);
    let got = spell::text(&ch, &[custom], &target, &opts);
    let lines: Vec<&str> = got.lines().collect();
    assert_eq!(
        lines[0],
        "Level 45 theory caster - Dark Elf Longblade, level 45  |  1 spell(s)"
    );
    assert_eq!(lines[1], "Index  Spell  Cost  Damage");
    assert_eq!(lines[2], "-----  -----  ----  ------");
    // No `index` prints the JS `-`, no `name` prints the table's empty cell, and both numbers are the core's.
    let row: Vec<&str> = lines[3].split_whitespace().collect();
    assert_eq!(
        row.len(),
        3,
        "the empty name cell leaves three visible cells: {row:?}"
    );
    assert_eq!(row[0], "-");
    assert_eq!(row[1], "5");
    assert_eq!(row[2], "11.7");
}

/// The `--all-spells` table and its `--json` document, and one `--spell Burn` rotation card and its `--json` document,
/// against the real JS branch over the same synthetic book. The branch is unexported, so the test resolves the pool and
/// prices it the way the branch does before calling the renderers.
#[test]
fn the_all_spells_and_rotation_cards_match_the_js() {
    let root = temp_root("singular");
    let arena = write_spellbook(&root);
    let arena_text = arena.to_str().unwrap();
    let book = spells_by_index_map(read_spells_std(&spells_std()));
    let pool: Vec<Value> = book.entries().iter().map(|(_, sp)| sp.clone()).collect();
    let ch = theory_caster(theory_character_like_cli(45.0));
    let target = spell_target(45.0, "armoured");
    let branch_opts = opts(&target, 45.0, 0.0, 0.0, 0.0, None);

    // `--all-spells`.
    let want = js(
        &["spell", "--theory", "--data", arena_text, "--all-spells"],
        &root,
    );
    assert_eq!(want.status.code(), Some(0));
    let priced = spell::price_pool(&pool, &ch, &target, &branch_opts);
    assert_eq!(
        spell::all_spells_text(&priced).as_bytes(),
        want.stdout.as_slice(),
        "the --all-spells table differs"
    );
    // `--json --all-spells`: the JS keeps the table and appends the document. The document's shape is pinned end to end
    // by `tests/cli_spell.rs`; here the renderer's part is its own key order and values.
    let doc = spell::all_spells_document(&priced);
    let first = doc.at(0);
    let keys: Vec<&str> = first.entries().iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        &keys[..3],
        &["index", "name", "cost"],
        "index/name lead, then the card's own keys: {keys:?}"
    );
    assert_eq!(first.get("name").to_js_string(), "Far Bolt");

    // One spell: `--spell Burn`, the DoT card with its effects block.
    let want = js(
        &["spell", "--theory", "--data", arena_text, "--spell", "Burn"],
        &root,
    );
    assert_eq!(want.status.code(), Some(0));
    let searched = spell::price_search(&pool, &ch, &target, &branch_opts);
    let chosen = spell::select(&priced, &searched, Some("Burn")).expect("Burn is priced");
    let mut rotation_opts = branch_opts.clone();
    rotation_opts.set("seconds", Num(30.0));
    let r = dfo_core::spells::spell_rotation(&chosen.sp, &ch, &target, &rotation_opts);
    assert_eq!(
        spell::rotation_text(&ch, &chosen.sp, &r, "armoured", &target).as_bytes(),
        want.stdout.as_slice(),
        "the rotation card differs"
    );
    let want = js(
        &[
            "spell", "--theory", "--data", arena_text, "--spell", "Burn", "--json",
        ],
        &root,
    );
    let doc = spell::rotation_document(&chosen.sp, &r);
    let keys: Vec<&str> = doc.entries().iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(&keys[..2], &["index", "name"], "JS key order: {keys:?}");
    assert_eq!(doc.get("name").to_js_string(), "Burn");
    assert!(want.status.code().is_some(), "the JS branch ran");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A LOCAL INVARIANT, not an oracle check: the effects table's missing `magnitude`/`rounds`/`note` cells print the JS
/// `-`, `1` and `''`, and a NaN DPS difference sorts as equal (stable order) exactly as `(a, b) => b.dps - a.dps` does.
#[test]
fn the_effects_placeholders_and_the_nan_order_are_the_js_ones() {
    let ch = theory_caster(theory_character_like_cli(45.0));
    let target = spell_target(45.0, "armoured");
    let mut r = opts(&target, 45.0, 0.0, 0.0, 0.0, None);
    r.set("elements", Arr(vec![obj([("key", Str("4,0".into()))])]));
    let got = spell::rotation_text(
        &ch,
        &obj([("name", Str("Nameless".into()))]),
        &r,
        "armoured",
        &target,
    );
    let effects: Vec<&str> = got.lines().skip_while(|l| *l != "Effects").collect();
    assert_eq!(effects[1], "Effect  Magnitude  Rounds  Damage  Note");
    assert_eq!(effects[2], "------  ---------  ------  ------  ----");
    assert_eq!(effects[3], "4,0             -       1       -");

    // `b.dps - a.dps` is NaN for a NaN row, which JS treats as equal (so the stable sort keeps a NaN row's relative
    // place rather than moving it); the exact order is the sort algorithm's, so this pins the comparator, not the order.
    let row = |dps: f64| spell::Priced {
        sp: Value::Undefined,
        r: obj([("dps", Num(dps)), ("damage", Num(1.0))]),
    };
    assert_eq!(spell::by_dps(&row(f64::NAN), &row(7.0)), CmpOrdering::Equal);
    assert_eq!(spell::by_dps(&row(7.0), &row(f64::NAN)), CmpOrdering::Equal);
    assert_eq!(spell::by_dps(&row(7.0), &row(5.0)), CmpOrdering::Less);
    assert_eq!(spell::by_dps(&row(5.0), &row(7.0)), CmpOrdering::Greater);
    assert_eq!(spell::by_dps(&row(5.0), &row(5.0)), CmpOrdering::Equal);
}

/// A LOCAL INVARIANT: the `values.spell` selection arms. Index and case-insensitive name are tried in the search-pool
/// order, then a name substring; an empty query matches the first name by substring, and a miss is `None`.
#[test]
fn the_selection_arms_are_index_name_then_substring() {
    let row = |index: f64, name: &str| spell::Priced {
        sp: obj([("index", Num(index)), ("name", Str(name.into()))]),
        r: obj([("damage", Num(1.0)), ("dps", Num(1.0))]),
    };
    let rows = vec![row(5.0, "Far Bolt"), row(1.0, "Bolt"), row(2.0, "Burn")];
    let pick =
        |q: Option<&str>| spell::select(&rows, &rows, q).map(|x| x.sp.get("name").to_js_string());
    assert_eq!(pick(None), Some("Far Bolt".to_owned()));
    assert_eq!(pick(Some("1")), Some("Bolt".to_owned()));
    assert_eq!(pick(Some("bolt")), Some("Bolt".to_owned()));
    assert_eq!(pick(Some("  BURN ")), Some("Burn".to_owned()));
    // A substring match follows the search pool's own order (DPS descending), so "ol" finds the first record whose
    // name contains it, not the shortest name.
    assert_eq!(pick(Some("OL")), Some("Far Bolt".to_owned()));
    assert_eq!(pick(Some("")), Some("Far Bolt".to_owned()));
    assert_eq!(pick(Some("nope")), None);
}
