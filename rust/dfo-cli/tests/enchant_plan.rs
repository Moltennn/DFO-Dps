//! The R8 `enchant-plan` / `gear-plan` text card, differentially against the real JS CLI.
//!
//! Every case runs `bin/dfo-dps.js enchant-plan --theory ... --out <temp file>` under a temp `DAGGER_USER_DATA`, and
//! compares its stdout byte for byte with [`enchant_plan::text`] over the same `dfo_core::enchant_plan::plan_enchants`
//! value plus the branch's own `enchant plan written:` line. The JS is the oracle: a port that drifts from
//! `src/cli.js:1161-1191` fails here. The plan numbers are the shared core's (already pinned by
//! `dfo-core/tests/enchant_plan.rs`), so these cases pin the rendering.
//!
//! Nothing reads a real save or a real `SPELLS.STD`: one case writes a two-record synthetic `SPELLS.STD` under the temp
//! root and points the launcher's `config.json` at it, so the strike-proc pricing and the imprint line are exercised
//! with a nonzero book; the others have no launcher config and price the empty book, as the JS `standardSpells()` does.
//! The `--all` matrix page, the `--json` document and the CLI flags are `main.rs`'s, not this port's. A missing `node`
//! panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js_page as js, temp_root};

// The renderer test pins the text card over a real plan; the page/`--all` renderers are pinned end-to-end against
// the JS by `tests/cli_enchant_plan.rs`, so the test crate does not call them.
#[path = "../src/enchant_plan.rs"]
#[allow(dead_code)]
mod enchant_plan;
#[path = "../src/graph.rs"]
#[allow(dead_code)]
mod graph;

use std::fs;
use std::path::Path;

use dfo_core::analyze::{gate_target, reference_foe};
use dfo_core::enchant_plan::plan_enchants;
use dfo_core::spells::{read_spells_std, spells_by_index_map, Spellbook};
use dfo_core::value::Value::{self, Bool, Num, Obj, Str};

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}
/// One 89-byte `SPELLS.STD` record (field for field as `src/spells.js:24-50` reads it).
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

fn spell_record(index: u8, name: &str, element: u8, effects: &[SpellEffect]) -> Vec<u8> {
    let mut b = vec![0u8; 0x59];
    for i in 0..3 {
        let (t, st) = effects.get(i).map_or((-1, -1), |e| (e.0, e.1));
        b[2 * i] = t as u8;
        b[2 * i + 1] = st as u8;
    }
    b[6] = element;
    b[8..10].copy_from_slice(&12u16.to_le_bytes());
    for (i, e) in effects.iter().enumerate() {
        b[14 + 3 * i] = e.2;
        b[15 + 3 * i] = e.3;
        b[16 + 3 * i] = e.4;
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

/// `Wizard's Fire` (7) and `Ice Bolt` (16), two of the twelve Cast When Strikes ids, so the plan's proc row and the
/// weapon rating table price a real spell. A DamageHealth instant and a ContinuousDamageHealth DoT.
fn spells_std() -> Vec<u8> {
    [
        spell_record(7, "Wizard's Fire", 4, &[(4, 0, 0, 0, 1, 30, 45, 0, 0, 1)]),
        spell_record(16, "Ice Bolt", 4, &[(1, 0, 2, 1, 1, 8, 14, 0, 0, 1)]),
    ]
    .concat()
}

/// Write `<root>/ARENA2/SPELLS.STD` and the launcher's `config.json` pointing at it; the book the test passes to the
/// core is the parse of the very same bytes.
fn write_spellbook(root: &Path) -> Vec<u8> {
    let bytes = spells_std();
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), &bytes).expect("synthetic SPELLS.STD");
    fs::write(
        root.join("config.json"),
        format!(
            r#"{{"arena2Path":"{}"}}"#,
            arena.to_string_lossy().replace('\\', "\\\\")
        ),
    )
    .expect("launcher config");
    bytes
}

/// The branch's `planEnchants` options for one case; `group` defaults to its own `daedra`, not the core's `humanoid`.
#[allow(clippy::too_many_arguments)]
fn options(
    weapon: f64,
    shield: &str,
    group: &str,
    repairs: f64,
    regen: f64,
    soul_gem: bool,
    force_skills: bool,
    uncapped: bool,
) -> Value {
    let target = if uncapped {
        reference_foe(&Num(45.0), &Str("tough".to_owned()))
    } else {
        gate_target(&Num(45.0), &Obj(vec![]))
    };
    obj([
        ("weapon", Num(weapon)),
        ("shield", Str(shield.to_owned())),
        ("soulGem", Bool(soul_gem)),
        ("group", Str(group.to_owned())),
        ("repairs", Num(repairs)),
        ("regen", Num(regen)),
        ("forceSkills", Bool(force_skills)),
        ("target", target),
    ])
}

/// Run one case and compare the JS stdout with the Rust card plus the branch's own page-write line. `root` is the
/// fixture root whose launcher config (and book) the JS process reads.
fn same(args: &[&str], opts: &Value, book: &Spellbook, root: &Path) {
    let out = root.join("enchant-plan.html");
    let want = js(args, &out, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let plan = plan_enchants(opts, book).expect("planEnchants");
    let got = format!(
        "{}enchant plan written: {}\n",
        enchant_plan::text(&plan),
        out.to_string_lossy()
    );
    assert_eq!(
        got,
        String::from_utf8_lossy(&want.stdout),
        "the enchant plan card differs for {args:?}"
    );
}

#[test]
fn the_empty_book_card_matches_the_js() {
    let book = Spellbook::default();
    let roots = [
        temp_root("default"),
        temp_root("options"),
        temp_root("uncapped"),
    ];
    // `--theory` alone: the cap-aware default mode against the level-45 Breach, template weapons only.
    same(
        &["enchant-plan", "--theory"],
        &options(123.0, "auto", "daedra", 1.0, 0.0, false, false, false),
        &book,
        &roots[0],
    );
    // Every branch option at once: the soul gem, three repairs and two regens, another Potent Vs group, a flat budget.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--shield",
            "none",
            "--soul-gem",
            "--repairs",
            "3",
            "--regen",
            "2",
            "--group",
            "undead",
        ],
        &options(123.0, "none", "undead", 3.0, 2.0, true, false, false),
        &book,
        &roots[1],
    );
    // The uncapped theory mode: the tough reference foe and weapon skill / Critical Strike forced on every piece.
    same(
        &["enchant-plan", "--theory", "--uncapped", "--weapon", "121"],
        &options(121.0, "auto", "daedra", 1.0, 0.0, false, true, true),
        &book,
        &roots[2],
    );
    for root in roots {
        fs::remove_dir_all(&root).expect("cleanup");
    }
}

#[test]
fn the_synthetic_book_card_matches_the_js() {
    let root = temp_root("book");
    let bytes = write_spellbook(&root);
    let book = spells_by_index_map(read_spells_std(&bytes));
    // A one-handed blade with the launcher's default Kite Shield: the header prints the shield's template index.
    same(
        &["enchant-plan", "--theory", "--weapon", "121"],
        &options(121.0, "auto", "daedra", 1.0, 0.0, false, false, false),
        &book,
        &root,
    );
    // Named shield, soul gem and the uncapped mode: the imprint line's uncapped half and the forced skill rows.
    same(
        &[
            "enchant-plan",
            "--theory",
            "--weapon",
            "118",
            "--shield",
            "109",
            "--soul-gem",
            "--uncapped",
            "--group",
            "animal",
        ],
        &options(118.0, "109", "animal", 1.0, 0.0, true, true, true),
        &book,
        &root,
    );
    fs::remove_dir_all(&root).expect("cleanup");
}
