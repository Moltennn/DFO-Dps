//! The R8 `spell --list` card, differentially against the real JS CLI over a synthetic `SPELLS.STD`.
//!
//! The branch (`src/cli.js:1550-1554`) is not exported, so each case runs `bin/dfo-dps.js spell --list --theory
//! --data <arena> ...` and compares stdout byte for byte with [`spell::text`]. The synthetic book is written under a
//! temp root (never the machine's ARENA2) and read by the Rust side through `dfo_core::spells::read_spells_std`, so
//! both sides see the same records. The pool is every standard record (the theory character has no spellbook), and the
//! character, target, cost and damage are the shared core's; this pins only the presentation: the caption, the
//! `index ?? '-'` / `String(name ?? '')` cells, the JS `fmt` and `table`.
//!
//! `--data` is unported in the CLI's dispatch, so the test hands the same directory to the JS and parses the bytes
//! itself for the Rust side. Pool resolution (`resolveSpells`/`values.standard`), the `priced` empty case and the
//! `--json` refusal are dispatch, not this module; the test mirrors the branch's inputs only.
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

#[path = "../src/spell.rs"]
mod spell;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use dfo_core::analyze::{gate_target, reference_foe};
use dfo_core::maxprofile::Profiles as MaxProfiles;
use dfo_core::spells::{read_spells_std, spells_by_index_map};
use dfo_core::theory::theory_character;
use dfo_core::value::Value::{self, Arr, Bool, Num, Obj, Str};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("dfo-cli-spell-{label}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp fixture root");
    root
}

fn js(args: &[&str], root: &Path) -> Output {
    Command::new("node")
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANG", "en_US.UTF-8")
        .arg(repo_root().join("bin").join("dfo-dps.js"))
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the JS CLI runs (this repository's Node project)")
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
