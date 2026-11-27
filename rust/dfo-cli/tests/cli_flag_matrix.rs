//! Flag coverage the earlier differential files left out: one table per command group, each row a flag the audit listed
//! as untested. Every row runs `bin/dfo-dps.js <command> <base> --flag` and the Rust binary with the same arguments and
//! compares stdout (and the written page where the command writes one) byte for byte.
//!
//! A row whose flag leaves the JS output byte-identical to its own base proves nothing, so the helper asserts that too
//! where the command prices the flag at all: the `changed` field says whether this row must move the JS output, and a
//! `false` there is a deliberate pin for a flag the JS accepts, reads and that happens to leave this base's card alone.
//!
//! Theory cases read no save; save-backed rows write their own tiny fixture under a temp `DAGGER_USER_DATA` root. A
//! missing `node` panics rather than skips, because a skipped differential proves nothing.

mod common;

use common::{js, rust, take_page, temp_root};

use std::fs;
use std::path::{Path, PathBuf};

/// `bin/dfo-dps.js <args...> --out <page>` (the JS page goes through `writeFileSync`).
fn js_out(args: &[&str], page: &Path, root: &Path) -> std::process::Output {
    let mut argv = args.to_vec();
    argv.push("--out");
    argv.push(page.to_str().expect("utf-8 page path"));
    js(&argv, root)
}

/// The Rust CLI with the same arguments and `--out <page>`.
fn rust_out(args: &[&str], page: &Path, root: &Path) -> std::process::Output {
    let mut argv = args.to_vec();
    argv.push("--out");
    argv.push(page.to_str().expect("utf-8 page path"));
    rust(&argv, root)
}

/// Both exit 0 and stdout is byte-identical. When `page` is given, so is the written page.
fn same(args: &[&str], root: &Path, page: Option<&Path>) {
    let want = match page {
        Some(path) => js_out(args, path, root),
        None => js(args, root),
    };
    assert_eq!(
        want.status.code(),
        Some(0),
        "js {args:?}: {}",
        String::from_utf8_lossy(&want.stderr)
    );
    let want_page = page.map(take_page);
    let got = match page {
        Some(path) => rust_out(args, path, root),
        None => rust(args, root),
    };
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
    if let (Some(want_page), Some(path)) = (want_page, page) {
        let got_page = take_page(path);
        assert_eq!(
            got_page,
            want_page,
            "the page differs for {args:?} ({} vs {} bytes)",
            got_page.len(),
            want_page.len()
        );
    }
}

/// One row: a base invocation, the flag appended, whether the flag must move the JS output, and whether it writes a page.
struct Row<'a> {
    base: &'a [&'a str],
    flag: &'a [&'a str],
    changed: bool,
    page: bool,
}

fn run_rows(label: &str, rows: &[Row<'_>], page_name: &str) {
    let root = save_root(label);
    let page = root.join(page_name);
    for row in rows {
        let plain: Vec<&str> = row.base.to_vec();
        let mut with: Vec<&str> = row.base.to_vec();
        with.extend_from_slice(row.flag);
        let (want_base, base_page) = match row.page {
            true => {
                let out = js_out(&plain, &page, &root);
                (out, Some(take_page(&page)))
            }
            false => (js(&plain, &root), None),
        };
        let want = match row.page {
            true => js_out(&with, &page, &root),
            false => js(&with, &root),
        };
        assert_eq!(
            want_base.status.code(),
            Some(0),
            "js base {plain:?}: {}",
            String::from_utf8_lossy(&want_base.stderr)
        );
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {with:?}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        // The base page is taken first, so the flag run wrote the same path fresh.
        let flag_page = row.page.then(|| take_page(&page));
        let changed = want_base.stdout != want.stdout
            || match (base_page, flag_page) {
                (Some(a), Some(b)) => a != b,
                _ => false,
            };
        assert_eq!(
            changed,
            row.changed,
            "the flag {:?} must {}change the JS output on {plain:?}",
            row.flag,
            if row.changed { "" } else { "not " }
        );
        if !row.page && !want.stdout.is_empty() && want.stdout == want_base.stdout && row.changed {
            panic!("{with:?}: the flag moved only the status, this case proves nothing");
        }
        same(&with, &root, row.page.then_some(page.as_path()));
        assert!(
            !page.exists(),
            "the page is removed after the comparison ({:?})",
            row.flag
        );
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// The offline save shape the other CLI files use: a main hand and an off hand.
fn offline_save() -> String {
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
    let skills = (0..35)
        .map(|i| (40 + i % 10).to_string())
        .collect::<Vec<_>>()
        .join(",");
    format!(
        r#"{{"name":"Fixture","level":30,"raceId":1,"race":"Breton","gender":"female",
"reflexes":2,"health":90,"maxHealth":120,"magicka":30,"maxMagicka":80,
"stats":{{{stats}}},"skills":[{skills}],"masterSkills":true,"masteredSkills":[11,29],
"martialPath":"blademaster",
"items":[
{{"group":"Weapons","templateIndex":121,"equipSlot":19,"name":"Iron Longsword","material":9,"currentCondition":100,"maxCondition":100}},
{{"group":"Weapons","templateIndex":122,"equipSlot":21,"name":"Iron Dagger","material":9,"currentCondition":100,"maxCondition":100}}]}}"#
    )
}

fn save_root(label: &str) -> PathBuf {
    let root = temp_root(label);
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("fixture save folder");
    fs::write(dir.join("SaveData.txt"), offline_save()).expect("fixture save");
    common::pin_mtime(&dir.join("SaveData.txt"));
    root
}

#[test]
fn spam_changes_the_bow_card() {
    // `--spam` (BOW_FAST stacks to its most, x0.2 pull) is read by `scenarioOf` for every card that prices a swing. A
    // one-handed blade in a subtle-build card does not move; the theory bow does.
    let root = temp_root("all-spam");
    let rows: [(&str, &[&str]); 4] = [
        ("build", &["build", "--theory", "--weapon", "129:9"]),
        ("theory", &["theory", "--weapon", "129:9"]),
        (
            "compare",
            &[
                "compare",
                "--theory",
                "--stat",
                "strength=110",
                "--weapon",
                "129:9",
            ],
        ),
        (
            "scale",
            &[
                "scale", "--theory", "--stat", "strength", "--from", "100", "--to", "101",
                "--weapon", "129:9",
            ],
        ),
    ];
    for (name, base) in rows {
        let want_base = js(base, &root);
        let got_base = rust(base, &root);
        assert_eq!(
            String::from_utf8_lossy(&got_base.stdout),
            String::from_utf8_lossy(&want_base.stdout),
            "{name} base differs"
        );
        let mut with: Vec<&str> = base.to_vec();
        with.push("--spam");
        let want = js(&with, &root);
        assert_eq!(
            want.status.code(),
            Some(0),
            "js {name}: {}",
            String::from_utf8_lossy(&want.stderr)
        );
        assert!(
            want.stdout != want_base.stdout,
            "--spam must change the JS {name} card (else this case is vacuous)"
        );
        let got = rust(&with, &root);
        assert_eq!(got.status.code(), Some(0), "rust {name}");
        assert_eq!(
            String::from_utf8_lossy(&got.stdout),
            String::from_utf8_lossy(&want.stdout),
            "{name} --spam differs"
        );
    }
    // The graph page carries the same curve, so `--spam` moves the points too.
    let page = root.join("spam.html");
    let base = [
        "graph",
        "--theory",
        "--series",
        "stat:strength",
        "--from",
        "100",
        "--to",
        "101",
        "--weapon",
        "129:9",
    ];
    let mut base_out: Vec<&str> = base.to_vec();
    base_out.push("--out");
    base_out.push(page.to_str().unwrap());
    let want_base = js(&base_out, &root);
    assert_eq!(want_base.status.code(), Some(0));
    let base_page = take_page(&page);
    let mut with = base_out.clone();
    with.push("--spam");
    let want = js(&with, &root);
    assert_eq!(want.status.code(), Some(0));
    let flag_page = take_page(&page);
    assert!(
        base_page != flag_page,
        "--spam must change the JS graph page"
    );
    same(&with, &root, Some(&page));
    // The report page prices the same scenario.
    let report = root.join("spam-report.html");
    let base = ["report", "--theory", "--weapon", "129:9"];
    let mut base_out: Vec<&str> = base.to_vec();
    base_out.push("--out");
    base_out.push(report.to_str().unwrap());
    let want_base = js(&base_out, &root);
    assert_eq!(want_base.status.code(), Some(0));
    let base_page = take_page(&report);
    let mut with = base_out.clone();
    with.push("--spam");
    let want = js(&with, &root);
    assert_eq!(want.status.code(), Some(0));
    let flag_page = take_page(&report);
    assert!(
        base_page != flag_page,
        "--spam must change the JS report page"
    );
    same(&with, &root, Some(&report));
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn build_flags_are_priced_like_the_js() {
    // `--armor`, `--star-skill` and `--weapon` move the theory card; `--unaware`, `--first-blow`, both health shares,
    // `--potency`, `--pierce` and `--pair` feed `scenarioOf` but a theory long blade's card has no path, spell or
    // pistol to read them, so the JS card is byte-identical and the rows pin that instead.
    let rows = [
        Row {
            base: &["build", "--theory", "--target", "boss"],
            flag: &["--armor", "500"],
            changed: true,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--star-skill", "34=10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--unaware"],
            changed: false,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--first-blow"],
            changed: false,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--self-health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--potency", "10"],
            changed: false,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--pierce", "10"],
            changed: false,
            page: false,
        },
        Row {
            base: &["build", "--theory"],
            flag: &["--pair"],
            changed: false,
            page: false,
        },
    ];
    run_rows("build-flags", &rows, "build.html");
}

/// The save-backed rows the theory card cannot price: a Cutthroat's `--unaware`, an Assassin's `--first-blow`, a
/// Berserker's own health share and a paired Pistolet's `--pair`.
#[test]
fn save_backed_path_flags_are_priced_like_the_js() {
    let cases: [(&str, &str, &[&str]); 4] = [
        ("cutthroat", "", &["--unaware"]),
        ("assassin", "", &["--first-blow"]),
        ("berserker", "", &["--self-health-share", "0.2"]),
        (
            "blademaster",
            ",{\"group\":\"Weapons\",\"templateIndex\":562,\"equipSlot\":21,\"name\":\"Off\",\"material\":9,\"currentCondition\":100,\"maxCondition\":100}",
            &["--pair"],
        ),
    ];
    let root = temp_root("save-path-flags");
    let dir = root.join("Saves").join("SAVE1");
    fs::create_dir_all(&dir).expect("fixture save folder");
    for (path, off, flag) in cases {
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
        let main = if path == "blademaster" { 562 } else { 121 };
        let text = format!(
            r#"{{"name":"Fixture","level":30,"raceId":1,"race":"Breton","gender":"female",
"reflexes":2,"health":90,"maxHealth":120,"stats":{{{stats}}},
"skills":[{}],"martialPath":"{path}","items":[
{{"group":"Weapons","templateIndex":{main},"equipSlot":19,"name":"Thing","material":9,"currentCondition":100,"maxCondition":100}}{off}]}}"#,
            (0..35).map(|_| "150").collect::<Vec<_>>().join(",")
        );
        fs::write(dir.join("SaveData.txt"), text).expect("save fixture");
        common::pin_mtime(&dir.join("SaveData.txt"));
        for command in [&["build"][..], &["compare", "--stat", "strength=110"][..]] {
            let want_base = js(command, &root);
            assert_eq!(
                want_base.status.code(),
                Some(0),
                "js base {command:?}: {}",
                String::from_utf8_lossy(&want_base.stderr)
            );
            let mut with: Vec<&str> = command.to_vec();
            with.extend_from_slice(flag);
            let want = js(&with, &root);
            assert_eq!(
                want.status.code(),
                Some(0),
                "js {with:?}: {}",
                String::from_utf8_lossy(&want.stderr)
            );
            assert!(
                want.stdout != want_base.stdout,
                "{flag:?} must change the JS {command:?} card for a {path}"
            );
            let got = rust(&with, &root);
            assert_eq!(got.status.code(), Some(0), "rust {with:?}");
            assert_eq!(
                String::from_utf8_lossy(&got.stdout),
                String::from_utf8_lossy(&want.stdout),
                "{with:?} differs"
            );
        }
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

/// One template's four modes in its own temp root: every run prices a whole plan, so one `#[test]` per template lets
/// libtest run the templates side by side (the gate's thread budget bounds the total).
fn plan_template(tpl: &str) {
    let root = temp_root("plan-weapon");
    let page = root.join("plan.html");
    let out = page.to_str().unwrap();
    for mode in [
        &[][..],
        &["--uncapped"][..],
        &["--all"][..],
        &["--json"][..],
    ] {
        let args = vec!["enchant-plan", "--theory", "--weapon", tpl, "--out", out];
        let args: Vec<&str> = args.into_iter().chain(mode.iter().copied()).collect();
        same(&args, &root, Some(&page));
    }
    fs::remove_dir_all(&root).expect("cleanup");
}

// `--weapon` other than 121: two-handers, a blade, the gun and fists. The audit suspected the two `expect`s in
// `enchant_plan_command` (a plan that cannot be built panics); every legal template prices and the page is byte-identical.
#[test]
fn enchant_plan_prices_the_two_handers_the_audit_named() {
    for tpl in ["113", "115", "122"] {
        plan_template(tpl);
    }
}

#[test]
fn enchant_plan_prices_the_bows_the_audit_named() {
    for tpl in ["127", "129", "130"] {
        plan_template(tpl);
    }
}

#[test]
fn enchant_plan_prices_the_gun_and_fists_the_audit_named() {
    for tpl in ["560", "562", "563"] {
        plan_template(tpl);
    }
}

#[test]
fn enchant_plan_refuses_ammunition_as_a_weapon() {
    let root = temp_root("plan-ammo");
    let page = root.join("plan.html");
    let out = page.to_str().unwrap();
    // Ammunition is not a weapon: both refuse it with the same line.
    let ammo = vec!["enchant-plan", "--theory", "--weapon", "131", "--out", out];
    let want = js(&ammo, &root);
    let got = rust(&ammo, &root);
    assert_eq!(want.status.code(), Some(2), "js ammo");
    assert_eq!(got.status.code(), Some(2), "rust ammo");
    assert_eq!(
        String::from_utf8_lossy(&got.stderr).trim_end(),
        String::from_utf8_lossy(&want.stderr).trim_end()
    );
    assert!(!page.exists(), "no page for ammunition");
    fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn compare_flags_are_priced_like_the_js() {
    let rows = [
        Row {
            base: &[
                "compare",
                "--theory",
                "--stat",
                "strength=110",
                "--weapon",
                "115:9",
            ],
            flag: &["--traits", "curbing"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--blow-x", "2"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--stat", "strength=110", "--target", "tough"],
            flag: &["--stacks", "3"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--backstab", "0.5"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--blade", "129"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--gear-lb", "100"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--gear-cs", "100"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--damage-pct", "10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--star-skill", "34=10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--star-stat", "strength=10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--star-damage", "10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--base-stats", "60"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--stat", "strength=110", "--target", "tough"],
            flag: &["--no-passive"],
            changed: true,
            page: false,
        },
        Row {
            base: &["compare", "--stat", "strength=110", "--target", "tough"],
            flag: &["--passive", "none"],
            changed: true,
            page: false,
        },
        // The rest are read by `scenarioOf` but a theory long-blade comparison has nothing to move.
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--armor", "500"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--rhythm"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--unaware"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--first-blow"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--self-health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--pair"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--dual"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--potency", "10"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--pierce", "10"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--bare"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--no-effects"],
            changed: false,
            page: false,
        },
        Row {
            base: &["compare", "--theory", "--stat", "strength=110"],
            flag: &["--offline"],
            changed: false,
            page: false,
        },
    ];
    run_rows("compare-flags", &rows, "compare.html");
}

#[test]
fn theory_flags_are_priced_like_the_js() {
    let rows = [
        Row {
            base: &["theory"],
            flag: &["--level", "30"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--vampire"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--star-stat", "strength=10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--star-skill", "34=10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--star-damage", "10"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--weapon", "121:5"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--core", "classic"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--no-rri"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--players", "2"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--swing", "StrikeLeft"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--stacks", "3"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--backstab", "0.5"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--blow-x", "2"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--no-passive"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--behind"],
            changed: true,
            page: false,
        },
        Row {
            base: &["theory", "--target", "boss"],
            flag: &["--traits", "curbing"],
            changed: true,
            page: false,
        },
        // The card has no path, spell or pistol in the theory setup it prices.
        Row {
            base: &["theory"],
            flag: &["--health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--self-health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--pair"],
            changed: false,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--dual"],
            changed: false,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--rhythm"],
            changed: false,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--unaware"],
            changed: false,
            page: false,
        },
        Row {
            base: &["theory"],
            flag: &["--first-blow"],
            changed: false,
            page: false,
        },
    ];
    run_rows("theory-flags", &rows, "theory.html");
}

#[test]
fn report_flags_are_priced_like_the_js() {
    let rows = [
        Row {
            base: &["report", "--theory", "--target", "boss"],
            flag: &["--armor", "500"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--level", "30"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--target", "tough"],
            flag: &["--stacks", "3"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--behind"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--backstab", "0.5"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--no-rri"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--target", "tough"],
            flag: &["--no-passive"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--base-stats", "60"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--blow-x", "2"],
            changed: true,
            page: true,
        },
        Row {
            base: &["report", "--theory", "--weapon", "129:9"],
            flag: &["--spam"],
            changed: true,
            page: true,
        },
        // The report's own tables are HP-based snapshots: a health share, a path passive, an unread swing modifier or a
        // proc setting does not move this theory page.
        Row {
            base: &["report", "--theory"],
            flag: &["--rhythm"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--unaware"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--first-blow"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--health-share", "0.5"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--self-health-share", "0.5"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--no-crit-damage"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--bare"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--no-effects"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--pair"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--dual"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--potency", "10"],
            changed: false,
            page: true,
        },
        Row {
            base: &["report", "--theory"],
            flag: &["--pierce", "10"],
            changed: false,
            page: true,
        },
    ];
    run_rows("report-flags", &rows, "report.html");
}

#[test]
fn scale_and_graph_flags_are_priced_like_the_js() {
    let scale = [
        "scale", "--theory", "--stat", "strength", "--from", "100", "--to", "104",
    ];
    let rows = [
        Row {
            base: &scale,
            flag: &["--swing", "StrikeLeft"],
            changed: true,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--backstab", "0.5"],
            changed: true,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--blow-x", "2"],
            changed: true,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--behind"],
            changed: true,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--no-rri"],
            changed: true,
            page: false,
        },
        Row {
            base: &[
                "scale", "--stat", "strength", "--from", "50", "--to", "54", "--target", "tough",
            ],
            flag: &["--stacks", "3"],
            changed: true,
            page: false,
        },
        // The curve re-analyses at a fixed full-health snapshot: these do not move it.
        Row {
            base: &scale,
            flag: &["--health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--self-health-share", "0.5"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--players", "2"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--pair"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--dual"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--potency", "10"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--pierce", "10"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--unaware"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--first-blow"],
            changed: false,
            page: false,
        },
        Row {
            base: &scale,
            flag: &["--rhythm"],
            changed: false,
            page: false,
        },
    ];
    run_rows("scale-flags", &rows, "scale.html");

    let graph = [
        "graph",
        "--theory",
        "--series",
        "stat:strength",
        "--from",
        "100",
        "--to",
        "104",
    ];
    let rows = [
        Row {
            base: &graph,
            flag: &["--swing", "StrikeLeft"],
            changed: true,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--backstab", "0.5"],
            changed: true,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--blow-x", "2"],
            changed: true,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--behind"],
            changed: true,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--no-rri"],
            changed: true,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--players", "2"],
            changed: true,
            page: true,
        },
        Row {
            base: &[
                "graph",
                "--series",
                "stat:strength",
                "--from",
                "50",
                "--to",
                "54",
                "--target",
                "tough",
            ],
            flag: &["--stacks", "3"],
            changed: true,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--health-share", "0.5"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--self-health-share", "0.5"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--pair"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--dual"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--potency", "10"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--pierce", "10"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--unaware"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--first-blow"],
            changed: false,
            page: true,
        },
        Row {
            base: &graph,
            flag: &["--rhythm"],
            changed: false,
            page: true,
        },
    ];
    run_rows("graph-flags", &rows, "graph.html");
}
