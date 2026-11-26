//! The planners price the shipped build (`--game-build`), DIFFERENTIALLY against the real JS at `14631` (and `14512` as
//! the cut) - one case per forwarding site `git show 311c991` added.
//!
//! `tests/planner_oracle.mjs` drives the JS and prints one case per line (`<kind> <input> => <expected>`, whole ordered
//! values as codec tokens); every case is replayed here through the port and compared token for token. `planners.rs` next
//! to this file pins the port's own wiring as local invariants; this file is what proves the numbers, so a dropped
//! forwarding site fails here rather than passing an `assert_ne!`.
//!
//! The oracle is a Node script in this repository and a missing `node` fails the test: a skipped differential proves
//! nothing. Its output is cached by the generators' content hash (the same key the golden vectors use), so a mutation
//! sweep re-runs the JS once, not once per mutant. `shortlistLoadouts` samples 1,000 fights per row and lives in
//! `tests/planner_shortlist.rs`.
//!
//! Sites this file is built to kill, one per `git show 311c991` hunk:
//!   maxprofile.rs  `scenario`, `run_args`, `evaluated`'s cache key, `max_character`        (legal, frontier, max, run)
//!   imprints.rs    `gate_opts`, `build_opts`, `raw_args`                                  (rank)
//!   enchant_plan.rs `skill_gain`, `plan_enchants_with`'s three opts, `apply_plan_dps_at`,
//!                   `best_weapon_for_family_with_build`                                  (plan, matrix, best)
//!   real_build.rs  `StageOpts::from_value`, `real_build_stages_with`'s four scenario keys,
//!                   `real_weapon_loadouts_with`'s normalisation                          (template, stage, loadouts)
//!   model_blow.rs  `game_build_name` / `game_build_one` (a bogus build must price as the live build)

mod common;

use dfo_core::enchant_plan::{best_weapon_for_family_at, plan_enchants, plan_matrix};
use dfo_core::imprints::rank_family;
use dfo_core::maxprofile::{max_run, Profiles};
use dfo_core::real_build::{
    real_build_stages_with, real_template_with, real_weapon_loadouts_with, StageOpts,
};
use dfo_core::spells::{spells_by_index_map, Spellbook};
use dfo_core::value::Value::{self, Arr, Num, Str};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// [`repo_root`]/.cache/planner-oracle: `.cache/` is gitignored and shared by a worktree's parallel mutant copies (the
/// same convention the CLI oracle cache uses), so one sweep generates the JS answer once.
fn cache_dir() -> PathBuf {
    let root = repo_root().join(".cache").join("planner-oracle");
    fs::create_dir_all(&root).expect("the oracle cache directory");
    root
}

/// FNV-1a 64 over bytes: no dependency for a cache key, and a collision only costs a stale answer that the `warm` check
/// below would not catch - so every input the oracle reads is folded in, not a sample.
fn fnv1a(bytes: &[u8], mut hash: u64) -> u64 {
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Every input `tests/planner_oracle.mjs` reads, hashed: the JS modules it imports, the tools they import, its own text
/// and the game's SPELLS.STD. A change to any of them is a cache miss, so a stale answer cannot outlive an edit.
fn inputs_key() -> String {
    let root = repo_root();
    let mut hash = 0xcbf29ce484222325u64;
    let mut fold = |path: &std::path::Path| {
        let bytes = fs::read(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        hash = fnv1a(path.to_string_lossy().as_bytes(), hash);
        hash = fnv1a(&(bytes.len() as u64).to_le_bytes(), hash);
        hash = fnv1a(&bytes, hash);
    };
    let mut dirs = vec![root.join("src"), root.join("tools")];
    while let Some(dir) = dirs.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{dir:?}: {e}"))
            .flatten()
            .map(|e| e.path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "js" || e == "mjs") {
                fold(&path);
            }
        }
    }
    fold(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("planner_oracle.mjs"),
    );
    fold(&arena2_dir().join("SPELLS.STD"));
    format!("{hash:016x}")
}

/// The launcher's ARENA2 directory, read as `src/save.js:28-40` does. A test may do file I/O (the core may not, AGENTS
/// rule 6), and one field of a small config needs no JSON dependency: the value is a JSON string.
fn arena2_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from(""), PathBuf::from);
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let user_data = std::env::var_os("DAGGER_USER_DATA")
        .map_or_else(|| base.join("Daggerfall JavaScript"), PathBuf::from);
    let path = user_data.join("config.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path:?}: {e}\nSPELLS.STD prices every planner: a differential without it proves nothing"));
    let at = text
        .find("\"arena2Path\"")
        .unwrap_or_else(|| panic!("{path:?} names no arena2Path"))
        + "\"arena2Path\"".len();
    let rest = &text[at..];
    let open = rest.find('"').expect("arena2Path is a JSON string");
    let close = rest[open + 1..]
        .find('"')
        .expect("arena2Path is a JSON string");
    let dir = &rest[open + 1..open + 1 + close];
    assert!(!dir.is_empty(), "{path:?}: an empty arena2Path");
    PathBuf::from(dir)
}

/// The oracle's lines, cached under [`inputs_key`]. A corrupt entry is a miss, never a wrong answer.
fn oracle_lines() -> Vec<String> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("planner_oracle.mjs");
    let entry = cache_dir().join(format!("{}.txt", inputs_key()));
    if let Ok(text) = fs::read_to_string(&entry) {
        if text.starts_with("# planner oracle") && text.lines().count() > 100 {
            return text
                .lines()
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_owned)
                .collect();
        }
    }
    let out = Command::new("node")
        .arg(&script)
        .current_dir(repo_root())
        .output()
        .expect("the planner oracle runs (this repository is a Node project)");
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle {script:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body = String::from_utf8(out.stdout).expect("the oracle's output is UTF-8");
    let text = format!("# planner oracle {}\n{body}", inputs_key());
    fs::write(&entry, &text).expect("the oracle cache is writable");
    body.lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

/// The stock spellbook, read from the launcher's SPELLS.STD as the oracle's `book` row does. Cheap: no Node spawn.
fn stock_book() -> Spellbook {
    let bytes = fs::read(arena2_dir().join("SPELLS.STD")).expect("SPELLS.STD is readable");
    spells_by_index_map(dfo_core::spells::read_spells_std(&bytes))
}

/// `obj({ k: v, ... })` from pairs, in order (the harness helper is crate-private).
fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Value::Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// A readable first difference: comparing the whole token hides which field moved.
fn difference(expected: &Value, got: &Value, path: &str) -> Option<String> {
    match (expected, got) {
        (Value::Obj(e), Value::Obj(g)) => {
            for ((ek, ev), (gk, gv)) in e.iter().zip(g) {
                if ek != gk {
                    return Some(format!("{path}: expected key {ek:?}, got {gk:?}"));
                }
                if let Some(d) = difference(ev, gv, &format!("{path}.{ek}")) {
                    return Some(d);
                }
            }
            (e.len() != g.len()).then(|| {
                format!(
                    "{path}: keys expected {:?}, got {:?}",
                    e.iter().map(|x| &x.0).collect::<Vec<_>>(),
                    g.iter().map(|x| &x.0).collect::<Vec<_>>()
                )
            })
        }
        (Value::Arr(e), Value::Arr(g)) => {
            if e.len() != g.len() {
                return Some(format!(
                    "{path}: expected length {}, got {}",
                    e.len(),
                    g.len()
                ));
            }
            e.iter()
                .zip(g)
                .enumerate()
                .find_map(|(i, (e, g))| difference(e, g, &format!("{path}[{i}]")))
        }
        _ => (dfo_core::value::write(expected) != dfo_core::value::write(got))
            .then(|| format!("{path}: expected {expected:?}, got {got:?}")),
    }
}

/// A character as the stage projection prints it (`stripCharacter` in the planner generator).
fn strip_character(ch: &Value) -> Value {
    let on_weapon = !ch.get("weapon").is_nullish();
    let item = if on_weapon {
        ch.get("weapon").clone()
    } else {
        ch.get("wraps").clone()
    };
    let or_null = |v: &Value| {
        if v.is_nullish() {
            Value::Null
        } else {
            v.clone()
        }
    };
    let num_or_null = |v: &Value| match v {
        Value::Num(n) => Num(*n),
        _ => Value::Null,
    };
    let off = ch.get("offWeapon");
    obj([
        ("mods", ch.get("_mods").clone()),
        (
            "firmamentDamagePct",
            num_or_null(ch.get("firmamentDamagePct")),
        ),
        ("enchantments", or_null(item.get("enchantments"))),
        ("condition", num_or_null(item.get("currentCondition"))),
        ("offEnchantments", or_null(off.get("enchantments"))),
        ("offCondition", num_or_null(off.get("currentCondition"))),
        ("dual", Value::Bool(ch.get("_dual").truthy())),
    ])
}

fn stage_value(st: &dfo_core::real_build::Stages) -> Value {
    obj([
        ("capped", Value::Bool(st.capped)),
        (
            "target",
            obj([
                ("maxHealth", st.target.get("maxHealth").clone()),
                (
                    "allowance",
                    if st.target.get("allowance").truthy() {
                        Value::Bool(true)
                    } else {
                        Value::Null
                    },
                ),
            ]),
        ),
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
        ("gearCh", strip_character(&st.gear_ch)),
        ("treeCh", strip_character(&st.tree_ch)),
        ("enchCh", strip_character(&st.ench_ch)),
        ("imprint", st.imprint.clone()),
    ])
}

/// The frontier projection the oracle writes: `[lb, cs, dmg, dps, cappedDps, allowanceDps]` per legal point.
fn frontier_value(rows: &Value) -> Value {
    Arr(rows
        .items()
        .iter()
        .map(|p| {
            Arr(vec![
                p.get("lb").clone(),
                p.get("cs").clone(),
                p.get("dmg").clone(),
                p.get("dps").clone(),
                p.get("cappedDps").clone(),
                p.get("allowanceDps").clone(),
            ])
        })
        .collect())
}

/// `rankFamily` as the oracle writes it: the host it picked, both prices, and every power's measured gain.
fn rank_value(r: &Value) -> Value {
    let mut out = obj([]);
    for key in ["key", "template"] {
        out.set(key, r.get(key).clone());
    }
    out.set(
        "base",
        Num(r.get("base").get("carriedCappedDps").to_number()),
    );
    out.set(
        "uncapped",
        Num(r.get("uncapped").get("carriedDps").to_number()),
    );
    out.set(
        "rows",
        Arr(r
            .get("rows")
            .items()
            .iter()
            .map(|x| {
                Arr(vec![
                    x.get("id").clone(),
                    x.get("template").clone(),
                    x.get("baseDps").clone(),
                    x.get("conditionalDps").clone(),
                    x.get("uncappedDps").clone(),
                    x.get("delta").clone(),
                    x.get("triggerDelta").clone(),
                    x.get("uncappedDelta").clone(),
                ])
            })
            .collect()),
    );
    out
}

/// One replayed case: the port's answer for a kind.
fn run_kind(kind: &str, input: &Value, book: &Spellbook, profiles: &mut Profiles<'_>) -> Value {
    match kind {
        "legal" => profiles
            .legal_gear(input.get("weapon"), input.get("opts"))
            .expect("legalGear"),
        "frontier" => frontier_value(
            profiles
                .legal_frontier(input.get("weapon"), input.get("opts"))
                .expect("legalFrontier"),
        ),
        "max" => profiles
            .max_character(input.get("weapon"), input.get("opts"))
            .expect("maxCharacter"),
        "run" => max_run(input.get("ch"), input.get("opts"), book).to_value(),
        "rank" => rank_value(
            &rank_family(input.get("family"), input.get("opts"), profiles).expect("rankFamily"),
        ),
        "plan" => plan_enchants(input, book).expect("planEnchants"),
        "matrix" => plan_matrix(input, book).expect("planMatrix"),
        "best" => best_weapon_for_family_at(
            input.get("family"),
            input.get("target"),
            input.get("build").as_str().unwrap_or("14631"),
            book,
        )
        .expect("bestWeaponForFamily"),
        "template" => {
            let opts = StageOpts::from_value(input.get("opts"));
            real_template_with(input.get("template"), input.get("family"), &opts, profiles)
                .expect("realTemplate")
        }
        "stage" => {
            let opts = StageOpts::from_value(input.get("opts"));
            let st =
                real_build_stages_with(input.get("template"), input.get("family"), &opts, profiles)
                    .expect("realBuildStages");
            stage_value(&st)
        }
        "loadouts" => {
            let modes: Vec<String> = input
                .get("modes")
                .items()
                .iter()
                .map(|m| m.to_js_string())
                .collect();
            let rows = real_weapon_loadouts_with(
                &modes,
                input.get("vampire").truthy(),
                &input.get("encounter").to_js_string(),
                input.get("build").as_str().unwrap_or("14631"),
                profiles,
            )
            .expect("realWeaponLoadouts");
            Arr(rows)
        }
        other => panic!("unexpected planner kind {other}"),
    }
}

#[test]
fn maxprofile_and_imprints_price_the_shipped_build_as_the_js_does() {
    replay(&["legal", "frontier", "max", "run", "best"]);
}

#[test]
fn the_imprint_ranking_prices_the_shipped_build_as_the_js_does() {
    replay(&["rank"]);
}

#[test]
fn the_enchant_plan_and_matrix_price_the_shipped_build_as_the_js_does() {
    replay(&["plan", "matrix"]);
}

/// The real-build chain, one template per family. Its own test because every row re-plans an enchant set: the `loadouts`
/// universe below is ~2x this and a mutation sweep should be able to pick the cheap half.
#[test]
fn the_real_build_chain_prices_the_shipped_build_as_the_js_does() {
    replay(&["template", "stage"]);
}

/// The whole universe at each build: 31 templates, the widest read of the build through the chain.
#[test]
fn the_loadout_universe_prices_the_shipped_build_as_the_js_does() {
    replay(&["loadouts"]);
}

fn replay(kinds: &[&str]) {
    let lines = oracle_lines();
    assert!(
        lines.len() > 100,
        "the oracle printed too few cases: {}",
        lines.len()
    );
    let mut book = None;
    let mut profiles: Option<Profiles<'_>> = None;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for line in lines {
        let (head, expected) = line
            .split_once(" => ")
            .unwrap_or_else(|| panic!("no `=>` in {line}"));
        let mut toks = head.split(' ');
        let kind = toks.next().expect("a kind");
        let token = toks.next().expect("an input token");
        assert!(toks.next().is_none(), "{line}: one input token");
        let input = dfo_core::value::parse(token)
            .unwrap_or_else(|e| panic!("{line}: bad input token `{token}`: {e}"));
        if kind == "book" {
            // `book <null> => <records>`: the fixture is the expected side of its own line.
            let records = dfo_core::value::parse(expected)
                .unwrap_or_else(|e| panic!("{line}: bad book token: {e}"));
            assert!(!records.items().is_empty());
            let b = book.replace(spells_by_index_map(records.items().iter().cloned()));
            assert!(b.is_none(), "one `book` row");
            profiles = book.as_ref().map(Profiles::new);
            continue;
        }
        if !kinds.contains(&kind) {
            continue;
        }
        let book = book
            .as_ref()
            .expect("the oracle writes its `book` row first");
        let profiles = profiles.as_mut().expect("the cache follows the book");
        let got = run_kind(kind, &input, book, profiles);
        let want = dfo_core::value::parse(expected)
            .unwrap_or_else(|e| panic!("{line}: bad expected token: {e}"));
        if let Some(diff) = difference(&want, &got, kind) {
            panic!("{kind} {token}\n{diff}");
        }
        *counts.entry(kind.to_owned()).or_insert(0) += 1;
    }
    for (kind, floor) in [
        ("legal", 30),
        ("frontier", 18),
        ("max", 24),
        ("run", 24),
        ("rank", 24),
        ("plan", 12),
        ("matrix", 1),
        ("best", 24),
        ("template", 12),
        ("stage", 12),
        ("loadouts", 2),
    ] {
        if !kinds.contains(&kind) {
            continue;
        }
        let n = counts.get(kind).copied().unwrap_or(0);
        assert!(n >= floor, "planner/{kind}: {n} cases, floor {floor}");
    }
}

/// The twin cases are what prove the differential above is not passing on identical answers, so this check is separate
/// from both replays.
#[test]
fn the_build_moves_the_legal_budget_and_the_default_is_the_live_build() {
    let book = stock_book();
    let mut p = Profiles::new(&book);
    let point = |profiles: &mut Profiles<'_>, build: &str| {
        let g = profiles
            .legal_gear(&Num(118.0), &obj([("gameBuild", s(build))]))
            .expect("the frontier");
        (
            g.get("lb").to_number(),
            g.get("cs").to_number(),
            g.get("dmg").to_number(),
        )
    };
    assert_ne!(
        point(&mut p, "14512"),
        point(&mut p, "14631"),
        "14631 re-picks the legal budget"
    );
    // An unknown build name normalises to the live build (`game_build_name`/`game_build_one`), not a third law.
    let live = point(&mut p, "14631");
    assert_eq!(point(&mut p, "1463"), live);
    assert_ne!(
        live,
        point(&mut p, "14512"),
        "and the cut is not the live build"
    );
    // The default is the live build.
    let plain = p
        .legal_gear(&Num(118.0), &obj([]))
        .expect("the default frontier");
    assert_eq!(
        (
            plain.get("lb").to_number(),
            plain.get("cs").to_number(),
            plain.get("dmg").to_number()
        ),
        live
    );
    let _ = p
        .max_character(&Num(118.0), &obj([]))
        .expect("the default is the live build");
}

/// A LOCAL INVARIANT: `real_weapon_loadouts` normalises its build argument the one way (`game_build_name`), so a caller
/// holding the CLI's raw flag value cannot invent a third law. The JS `realWeaponLoadouts({ gameBuild })` compares the
/// string in `gameBuildOf`, which this pins without needing a whole universe per spelling.
#[test]
fn a_bogus_build_argument_prices_the_universe_as_the_live_build() {
    let book = stock_book();
    let mut profiles = Profiles::new(&book);
    let row = |build: &str, profiles: &mut Profiles<'_>| {
        let rows =
            real_weapon_loadouts_with(&["uncapped".to_owned()], false, "breach", build, profiles)
                .expect("realWeaponLoadouts");
        rows.iter()
            .find(|r| r.get("template").strict_eq(&Num(118.0)) && !r.get("dual").truthy())
            .map(|r| r.get("totalDps").to_number())
            .expect("the Broadsword row")
    };
    let live = row("14631", &mut profiles);
    // One bogus spelling is enough: `game_build_name` has two arms (`14512`, everything else), and the arm this pins is
    // the `else`. A third universe would only re-read it.
    assert_eq!(
        row("1463", &mut profiles),
        live,
        "a bogus build is the live build"
    );
    assert_ne!(
        row("14512", &mut profiles),
        live,
        "and 14512 is not the live build"
    );
}
