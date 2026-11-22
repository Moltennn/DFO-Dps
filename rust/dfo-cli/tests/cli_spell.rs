//! The R8 `spell --list` command, end to end against the real JS CLI.
//!
//! Every success case runs `bin/dfo-dps.js spell --list ...` and the Rust binary on the same arguments under one temp
//! `DAGGER_USER_DATA` root, and compares stdout and the exit code byte for byte. The book comes from a synthetic
//! `SPELLS.STD` written by the test (never the machine's ARENA2), either through an explicit `--data <dir>` or through
//! the launcher's `config.json` -> `arena2Path` fallback, and the save pool comes from a synthetic save under
//! `Saves/SAVE1/SaveData.txt` (stock indices plus one custom record), never a real save.
//!
//! `tests/spell.rs` pins the renderer over core rows; this file pins the command around it: the character, the theory
//! caster tweak, the two spellbook sources, `resolveSpells`/`--standard`, the empty-book line, and the refusals
//! (`--json` with `--list`, `--out`, and every unported `spell` mode: those must say they are unported, not imitate the
//! JS card).
//!
//! A missing `node` panics rather than skips, because a skipped differential proves nothing.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn temp_root(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dfo-cli-spell-cli-{label}-{}-{n}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("Saves")).expect("temp fixture root");
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

fn rust(args: &[&str], root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dfo-cli"))
        .args(args)
        .current_dir(repo_root())
        .env("DAGGER_USER_DATA", root)
        .output()
        .expect("the Rust CLI binary runs")
}

/// A success case: both exit 0 and stdout matches byte for byte.
fn same(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        Some(0),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stdout),
        String::from_utf8_lossy(&want.stdout),
        "stdout differs for {args:?}"
    );
}

/// A refusal both CLIs share word for word: exit 2 and the same trimmed stderr, no stdout.
fn same_usage(args: &[&str], root: &Path) {
    let want = js(args, root);
    let got = rust(args, root);
    assert_eq!(
        want.status.code(),
        Some(2),
        "js {args:?}: stdout {:?} stderr {:?}",
        String::from_utf8_lossy(&want.stdout),
        String::from_utf8_lossy(&want.stderr)
    );
    assert_eq!(
        got.status.code(),
        Some(2),
        "rust {args:?}: {}",
        String::from_utf8_lossy(&got.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end(),
        "stderr differs for {args:?}"
    );
    assert!(got.stdout.is_empty(), "no card for a refusal: {args:?}");
}

/// One effect as the record layout stores it: `(type, subType, durationBase, durationMod, durationPerLevel,
/// magnitudeBaseLow, magnitudeBaseHigh, magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel)`.
type SpellEffect = (i8, i8, u8, u8, u8, u8, u8, u8, u8, u8);

/// One 89-byte `SPELLS.STD` record (`src/spells.js:24-50`, field for field as `tests/build.rs` writes it).
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

/// A five-record synthetic book: an instant bolt, a DoT, a debug name the list still shows, a non-damage Shield (its
/// damage is 0, which is what the `priced` gate sees), and a range-scaled shock bolt.
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

/// A second book with the same indices and different names, so a card proves WHICH book resolved the records.
fn other_spells_std() -> Vec<u8> {
    [
        spell_record(1, "Other Bolt", 4, 0, &[(4, 0, 0, 0, 1, 10, 20, 0, 0, 1)]),
        spell_record(2, "Other Burn", 4, 0, &[(1, 0, 2, 1, 1, 4, 8, 0, 0, 1)]),
        spell_record(3, "Lvl 1 Other", 4, 0, &[(4, 0, 0, 0, 1, 1, 3, 0, 0, 1)]),
        spell_record(4, "Other Shield", 4, 0, &[(35, -1, 0, 5, 1, 0, 0, 0, 0, 1)]),
        spell_record(5, "Other Far", 0, 2, &[(4, 0, 0, 0, 1, 20, 40, 1, 1, 2)]),
    ]
    .concat()
}

/// `<root>/ARENA2/SPELLS.STD`, returning the directory for `--data`.
fn write_arena(root: &Path) -> PathBuf {
    let arena = root.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), spells_std()).expect("synthetic SPELLS.STD");
    arena
}

/// `<root>/ARENA_OTHER/SPELLS.STD`: the book `--data` names when the launcher's own book must not be the one read.
fn write_other_arena(root: &Path) -> PathBuf {
    let arena = root.join("ARENA_OTHER");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), other_spells_std()).expect("synthetic SPELLS.STD");
    arena
}

/// The launcher's own shape: `config.json` -> `arena2Path`, so `standardSpells()` finds the book with no `--data`.
fn write_config(root: &Path, arena: &Path) {
    let path = arena.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        root.join("config.json"),
        format!(r#"{{"arena2Path":"{path}"}}"#),
    )
    .expect("launcher config");
}

/// A synthetic offline save: stock spell indices 1 and 2 plus one custom record with no index, so the pool is
/// `resolveSpells`' order and the custom record prints the `-` index. The character owns no spells of its own shape
/// beyond that.
fn save_with_spells() -> String {
    save_with_indices(&[1, 2])
}

/// The same save with the stock indices the caller names (to tell two different books apart).
fn save_with_indices(indices: &[u8]) -> String {
    let stats = [
        "strength",
        "intelligence",
        "willpower",
        "agility",
        "endurance",
        "personality",
        "speed",
        "luck",
    ]
    .map(|k| format!("\"{k}\":50"))
    .join(",");
    let skills = (0..35).map(|_| "60").collect::<Vec<_>>().join(",");
    let indices = indices
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"name":"Spell Fixture","level":20,"raceId":1,"race":"Breton","gender":"male",
"health":90,"maxHealth":120,"magicka":30,"maxMagicka":80,
"stats":{{{stats}}},"skills":[{skills}],"masterSkills":true,"masteredSkills":[22],
"martialPath":"blademaster","items":[],
"spells":[{indices},{{"name":"Custom Zap","element":4,"rangeType":0,"effects":[
{{"type":4,"subType":0,"magnitudeBaseLow":6,"magnitudeBaseHigh":12,
"magnitudeLevelBase":0,"magnitudeLevelHigh":0,"magnitudePerLevel":1}}]}}]}}"#
    )
}

fn write_save(root: &Path) {
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), save_with_spells()).expect("fixture save");
}

fn write_save_with(root: &Path, indices: &[u8]) {
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("save folder");
    fs::write(dir.join("SaveData.txt"), save_with_indices(indices)).expect("fixture save");
}

/// The theory character over the explicit `--data` book, every flag the branch reads.
#[test]
fn theory_list_with_explicit_data_matches_the_js() {
    let root = temp_root("theory-data");
    let arena = write_arena(&root);
    let data = arena.to_str().unwrap();
    for args in [
        &["spell", "--list", "--theory", "--data", data][..],
        &["spell", "--list", "--theory", "--data", data, "--standard"][..],
        &[
            "spell", "--list", "--theory", "--data", data, "--level", "30", "--target", "soft",
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--target",
            "gate",
            "--players",
            "2",
            "--blow-x",
            "2",
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--potency",
            "30",
            "--pierce",
            "10",
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--cast-speed",
            "20",
            "--magicka",
            "50",
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--mana-limit",
            "--seconds",
            "10",
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--traits",
            "spellproof",
        ][..],
        // `--list` returns before `--all-spells`/`--spell`, exactly as the JS branch's `if (values.list)` does.
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--all-spells",
        ][..],
        &[
            "spell", "--list", "--theory", "--data", data, "--spell", "Bolt",
        ][..],
        // Other theory blades, races and gear go through `legalGear`, whose analysis could price Cast When Strikes
        // before the branch - the JS `standardSpells` cache would then keep the launcher's book and ignore `--data`.
        // These cases pin the observable result either way.
        &[
            "spell", "--list", "--theory", "--data", data, "--blade", "118",
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            data,
            "--race",
            "redguard",
            "--firmament",
        ][..],
        &[
            "spell", "--list", "--theory", "--data", data, "--weapon", "121:3",
        ][..],
    ] {
        same(args, &root);
    }
    // The differential is not vacuous: the card is the theory caster's table with the synthetic records.
    let card = js(&["spell", "--list", "--theory", "--data", data], &root);
    let text = String::from_utf8_lossy(&card.stdout).into_owned();
    assert!(
        text.starts_with("Level 45 theory caster - Dark Elf Longblade, level 45  |  5 spell(s)\n")
    );
    assert!(text.contains("Bolt") && text.contains("Far Bolt"), "{text}");
    // The `priced` gate fires before the list: a book whose only damaging record is a debug name prints the empty
    // line. `Lvl 1 Probe` is the only `4,0` record there, say, by dropping the others - so this asserts the gate is
    // live by comparing a custom-only list pool.
    let only_debug = temp_root("only-debug");
    let arena = only_debug.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(
        arena.join("SPELLS.STD"),
        spell_record(3, "Lvl 1 Probe", 4, 0, &[(4, 0, 0, 0, 1, 1, 3, 0, 0, 1)]),
    )
    .expect("debug-only book");
    same(
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            arena.to_str().unwrap(),
        ],
        &only_debug,
    );
    // The JS prints the empty-pool line, not the table: the `priced` gate is before `if (values.list)`.
    let text = String::from_utf8_lossy(
        &js(
            &[
                "spell",
                "--list",
                "--theory",
                "--data",
                arena.to_str().unwrap(),
            ],
            &only_debug,
        )
        .stdout,
    )
    .into_owned();
    assert_eq!(
        text,
        "No damaging spells in the spellbook. Pass --spell <index|name> or --standard.\n"
    );
    fs::remove_dir_all(&only_debug).expect("cleanup");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The launcher fallback: no `--data`, the `config.json` -> `arena2Path` book, as `standardSpells()` resolves it.
#[test]
fn theory_list_with_the_launcher_fallback_matches_the_js() {
    let root = temp_root("theory-launcher");
    let arena = write_arena(&root);
    write_config(&root, &arena);
    for args in [
        &["spell", "--list", "--theory"][..],
        &["spell", "--list", "--theory", "--standard"][..],
        &[
            "spell", "--list", "--theory", "--target", "boss", "--health", "8000",
        ][..],
        &["spell", "--list", "--theory", "--vampire", "--firmament"][..],
        // The same directory through `--data` (the launcher's cache still supplies the records).
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            arena.to_str().unwrap(),
            "--target",
            "soft",
        ][..],
    ] {
        same(args, &root);
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The JS `standardSpells()` module cache is seeded before the branch (`loadCharacter`'s `legalGear` and the pre-branch
/// `analyze`), so a resolvable launcher config wins over `--data`; only when `arena2Dir()` is falsy does `--data` (or
/// an empty book) decide. This pins both arms with two books that have the same indices and different names.
#[test]
fn the_launcher_wins_over_data_because_of_the_js_module_cache() {
    // Launcher resolvable + a different `--data`: the JS prints the LAUNCHER's names.
    let root = temp_root("cache-launcher-wins");
    let arena = write_arena(&root);
    let other = write_other_arena(&root);
    write_config(&root, &arena);
    for args in [
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            other.to_str().unwrap(),
        ][..],
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            other.to_str().unwrap(),
            "--standard",
        ][..],
    ] {
        same(args, &root);
    }
    let text = String::from_utf8_lossy(
        &js(
            &[
                "spell",
                "--list",
                "--theory",
                "--data",
                other.to_str().unwrap(),
            ],
            &root,
        )
        .stdout,
    )
    .into_owned();
    assert!(
        text.contains("Bolt") && !text.contains("Other Bolt"),
        "the launcher book is the one the JS resolved: {text}"
    );
    fs::remove_dir_all(&root).expect("cleanup");

    // No launcher config at all: `--data` is the book the JS reads.
    let root = temp_root("cache-data-wins");
    let other = write_other_arena(&root);
    same(
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            other.to_str().unwrap(),
        ],
        &root,
    );
    let text = String::from_utf8_lossy(
        &js(
            &[
                "spell",
                "--list",
                "--theory",
                "--data",
                other.to_str().unwrap(),
            ],
            &root,
        )
        .stdout,
    )
    .into_owned();
    assert!(
        text.contains("Other Bolt")
            && text.contains("Lvl 1 Other")
            && !text.contains("Lvl 1 Probe"),
        "{text}"
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// A synthetic save's own `spells` array: stock indices resolve from the book and a custom record is kept whole.
#[test]
fn a_save_spellbook_frontend_matches_the_js() {
    let root = temp_root("save");
    let arena = write_arena(&root);
    write_config(&root, &arena);
    write_save(&root);
    let data = arena.to_str().unwrap();
    for args in [
        &["spell", "--list", "--save", "SAVE1"][..],
        &["spell", "--list", "--save", "SAVE1", "--standard"][..],
        &["spell", "--list", "--save", "SAVE1", "--target", "soft"][..],
        // `--data` names the same book the launcher already supplies, so the module cache precedence changes nothing.
        &["spell", "--list", "--save", "SAVE1", "--data", data][..],
        &[
            "spell",
            "--list",
            "--save",
            "SAVE1",
            "--level",
            "30",
            "--potency",
            "20",
        ][..],
        // `--theory` replaces the save entirely (`loadCharacter`), even with `--save` present.
        &["spell", "--list", "--save", "SAVE1", "--theory"][..],
    ] {
        same(args, &root);
    }
    // The save pool really is the save's own: the custom record and the stock names are in the card.
    let card = js(&["spell", "--list", "--save", "SAVE1"], &root);
    let text = String::from_utf8_lossy(&card.stdout).into_owned();
    assert!(
        text.starts_with("Spell Fixture - Breton, level 20  |  3 spell(s)\n"),
        "{text}"
    );
    assert!(
        text.contains("Custom Zap") && text.contains("Bolt") && text.contains("Burn"),
        "{text}"
    );
    // A save naming only index 4 must print Shield and the custom record, not Bolt/Burn: the indices resolve from the
    // same book the list shows, so the two sources cannot silently disagree. (Here `--data` points at the launcher's own
    // book, so this is the book-cache path of `the_launcher_wins_over_data_because_of_the_js_module_cache`.)
    write_save_with(&root, &[4]);
    for args in [
        &["spell", "--list", "--save", "SAVE1"][..],
        &["spell", "--list", "--save", "SAVE1", "--standard"][..],
        &["spell", "--list", "--save", "SAVE1", "--data", data][..],
    ] {
        same(args, &root);
    }
    let text = String::from_utf8_lossy(&js(&["spell", "--list", "--save", "SAVE1"], &root).stdout)
        .into_owned();
    assert!(text.contains("Shield") && !text.contains("Bolt"), "{text}");
    fs::remove_dir_all(&root).expect("cleanup");
}

/// An empty book is the JS `No damaging spells in the spellbook. Pass --spell <index|name> or --standard.` line, exit
/// 0: no launcher config, a missing `--data` directory, and a `SPELLS.STD` that is not a whole record.
#[test]
fn the_empty_book_line_matches_the_js() {
    let no_config = temp_root("empty-no-config");
    same(&["spell", "--list", "--theory"], &no_config);
    let missing = no_config.join("nowhere");
    same(
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            missing.to_str().unwrap(),
        ],
        &no_config,
    );
    let short = temp_root("empty-short");
    let arena = short.join("ARENA2");
    fs::create_dir_all(&arena).expect("arena dir");
    fs::write(arena.join("SPELLS.STD"), vec![0u8; 0x58]).expect("short book");
    same(
        &[
            "spell",
            "--list",
            "--theory",
            "--data",
            arena.to_str().unwrap(),
        ],
        &short,
    );
    // `--standard` with no records is still empty, so the line fires there too.
    same(&["spell", "--list", "--theory", "--standard"], &no_config);
    // `--data ''` is the JS `dir ?? undefined` falsy arm (`standardSpells` returns a fresh empty map), not the cwd.
    same(&["spell", "--list", "--theory", "--data", ""], &no_config);
    fs::remove_dir_all(&no_config).expect("cleanup");
    fs::remove_dir_all(&short).expect("cleanup");

    // A launcher config that is unusable (`null`/number `arena2Path`, malformed JSON, an array) leaves the JS module
    // cache cold, so `--data` decides, and the card is the data book rather than the empty line. The exception is a
    // truthy non-string `arena2Path`: the JS cache still fills (with an empty book, because `path.join` throws), so
    // `--data` is ignored there.
    for (label, config) in [
        ("null-path", r#"{"arena2Path":null}"#),
        ("malformed", "{oops"),
        ("array", "[1,2]"),
        ("number-path", r#"{"arena2Path":7}"#),
    ] {
        let root = temp_root(&format!("config-{label}"));
        let arena = write_other_arena(&root);
        fs::write(root.join("config.json"), config).expect("launcher config");
        same(
            &[
                "spell",
                "--list",
                "--theory",
                "--data",
                arena.to_str().unwrap(),
            ],
            &root,
        );
        // With no `--data` either, the launcher is unusable, so the JS has no book at all.
        same(&["spell", "--list", "--theory"], &root);
        let text = String::from_utf8_lossy(
            &js(
                &[
                    "spell",
                    "--list",
                    "--theory",
                    "--data",
                    arena.to_str().unwrap(),
                ],
                &root,
            )
            .stdout,
        )
        .into_owned();
        if label == "number-path" {
            assert_eq!(
                text,
                "No damaging spells in the spellbook. Pass --spell <index|name> or --standard.\n",
                "a truthy non-string arena2Path fills the cache with an empty book: {text}"
            );
        } else {
            assert!(text.contains("Other Bolt"), "{label}: {text}");
        }
        fs::remove_dir_all(&root).expect("cleanup");
    }
}

/// Every refusal the JS would accept differently is a deliberate port refusal, so only its exit code and message are
/// pinned; `--json` with `--list` and `--out` are the JS's own refusals, compared word for word.
#[test]
fn the_refusals_are_explicit() {
    let root = temp_root("refusals");
    let arena = write_arena(&root);
    let data = arena.to_str().unwrap();
    // The JS refuses both of these itself (`checkOutputFlags`), with the `spell --list` name.
    same_usage(&["spell", "--list", "--theory", "--json"], &root);
    same_usage(&["spell", "--list", "--theory", "--out", "x.html"], &root);
    // Every other `spell` mode is unported here: it must say so, never imitate the JS card.
    for args in [
        &["spell", "--theory", "--data", data][..],
        &["spell", "--theory", "--data", data, "--all-spells"][..],
        &["spell", "--theory", "--data", data, "--spell", "Bolt"][..],
        &["spell", "--theory", "--data", data, "--json"][..],
    ] {
        let got = rust(args, &root);
        assert_eq!(
            got.status.code(),
            Some(2),
            "rust refuses {args:?}: {}",
            String::from_utf8_lossy(&got.stderr)
        );
        let message = String::from_utf8_lossy(&got.stderr);
        assert!(
            message.contains("not ported yet") && message.contains("spell --list"),
            "the refusal names the unported mode and the ported one: {message}"
        );
        assert!(got.stdout.is_empty(), "no card for {args:?}");
        // The JS runs the mode; this is the documented divergence, not parity.
        assert_eq!(
            js(args, &root).status.code(),
            Some(0),
            "the JS accepts {args:?}"
        );
    }
    // `--list --json` names `spell --list` even though `spell` is a JSON command.
    let got = rust(&["spell", "--list", "--theory", "--json"], &root);
    assert!(String::from_utf8_lossy(&got.stderr).contains("\"spell --list\""));
    // A flag outside the spell command stays refused by name.
    let got = rust(&["build", "--theory", "--list"], &root);
    assert_eq!(got.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&got.stderr).contains("is not supported by this CLI slice"));
    fs::remove_dir_all(&root).expect("cleanup");
}

/// `--help` names the ported mode and says the others are unported.
#[test]
fn help_lists_the_spell_list_mode() {
    let root = temp_root("help");
    let got = rust(&["--help"], &root);
    assert_eq!(got.status.code(), Some(0));
    let text = String::from_utf8_lossy(&got.stdout);
    for line in [
        "dfo-cli spell --list",
        "--list",
        "--standard",
        "--data <dir>",
        "spell --all-spells",
    ] {
        assert!(text.contains(line), "help names {line}");
    }
    fs::remove_dir_all(&root).expect("cleanup");
}
