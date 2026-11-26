//! The sampled shortlist's four forwarding sites (`git show 311c991`, `loadout_shortlist.rs`), as LOCAL INVARIANTS: the
//! CLI differential next door (`dfo-cli/tests/planner_shortlist.rs`) proves the numbers against the real JS, and costs the
//! JS's own 1,000-trial sampler twice over. These pin the same wiring without spawning Node.
//!
//! The sites:
//!   `ShortlistOpts::from_value`'s `game_build`                         (`an_absent_or_unknown_build_is_the_cut`)
//!   `eligible_universe_with`'s forward to the universe                (`the_shortlist_moves_with_the_shipped_build`)
//!   the candidates' `StageOpts { game_build }`                        (same test, the proc column)
//!   the ranking scenario's `gameBuild`                                (`the_shortlist_ranks_at_its_own_build`)
//!
//! The numbers are not oracle-checked in this file and the comments say so.

use dfo_core::loadout_shortlist::{shortlist_loadouts_with, ShortlistOpts};
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{self, Bool, Num, Str};

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Value::Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

/// The stock spellbook, read from the launcher's `SPELLS.STD` (the samplers price spells; no book is a hard panic).
fn stock_book() -> Spellbook {
    let home = std::env::var_os("HOME")
        .map_or_else(|| std::path::PathBuf::from(""), std::path::PathBuf::from);
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let user_data = std::env::var_os("DAGGER_USER_DATA").map_or_else(
        || base.join("Daggerfall JavaScript"),
        std::path::PathBuf::from,
    );
    let text = std::fs::read_to_string(user_data.join("config.json"))
        .expect("the launcher config is required: SPELLS.STD prices the sampled shortlist");
    let at = text
        .find("\"arena2Path\"")
        .expect("the launcher config names no arena2Path")
        + "\"arena2Path\"".len();
    let rest = &text[at..];
    let open = rest.find('"').expect("arena2Path is a JSON string");
    let close = rest[open + 1..]
        .find('"')
        .expect("arena2Path is a JSON string");
    let dir = std::path::PathBuf::from(&rest[open + 1..open + 1 + close]);
    let bytes = std::fs::read(dir.join("SPELLS.STD")).expect("SPELLS.STD is readable");
    dfo_core::spells::spells_by_index_map(dfo_core::spells::read_spells_std(&bytes))
}

/// A one-row shortlist at a named build, the shape every case below uses.
fn shortlist(build: &str, book: &Spellbook) -> Value {
    let opts = ShortlistOpts::from_value(&obj([
        ("k", Num(1.0)),
        ("mode", Str("uncapped".to_owned())),
        ("trials", Num(1000.0)),
        ("seed", Num(7.0)),
        ("maxSeconds", Num(60.0)),
        ("maxBlows", Num(6000.0)),
        ("health", Num(5000.0)),
        ("vampire", Bool(false)),
        ("gameBuild", Str(build.to_owned())),
    ]));
    assert_eq!(opts.game_build, build, "from_value reads the key");
    shortlist_loadouts_with(&opts, &mut dfo_core::maxprofile::Profiles::new(book))
        .expect("shortlistLoadouts")
}

/// The first row's named column.
fn column(r: &Value, key: &str) -> f64 {
    r.get("rows").items()[0].get(key).to_number()
}

/// A LOCAL INVARIANT: the universe row and the staged candidate's proc DPS are priced at the shortlist's own build. Two of
/// the four sites show here (`eligible_universe_with`'s forward, and the candidates' `StageOpts`).
#[test]
fn the_shortlist_moves_with_the_shipped_build() {
    let book = stock_book();
    let cut = shortlist("14512", &book);
    let drift = shortlist("14631", &book);
    assert_ne!(
        column(&cut, "deterministicTotalDps"),
        column(&drift, "deterministicTotalDps"),
        "the universe row moves with the shipped build"
    );
    assert_ne!(
        column(&cut, "deterministicProcDps"),
        column(&drift, "deterministicProcDps"),
        "and so does the staged candidate's proc DPS"
    );
}

/// A LOCAL INVARIANT: the shortlist's ranking scenario carries the build (`loadout_shortlist.rs:250`). The test above
/// moves because the two builds' CANDIDATES differ, which would hide a dropped key. Here the `14631` shortlist's value is
/// re-priced from its own staged candidate at both scenarios: it must equal the drift price, so dropping the key leaves the
/// cut price and fails.
#[test]
fn the_shortlist_ranks_at_its_own_build() {
    use dfo_core::objectives::rank_builds;
    use dfo_core::real_build::{real_build_stages_with, StageOpts};
    use dfo_core::simulate_fight::paired_fight_seeds;
    use dfo_core::value::Value::Arr;

    let book = stock_book();
    let ranking = shortlist("14631", &book);
    let row = &ranking.get("rows").items()[0];
    let value = row.get("value").to_number();
    let stage = real_build_stages_with(
        row.get("template"),
        &obj([("key", row.get("key").clone())]),
        &StageOpts {
            mode: "uncapped".to_owned(),
            vampire: false,
            dual: row.get("dual").truthy(),
            encounter: "breach".to_owned(),
            game_build: "14631".to_owned(),
        },
        &mut dfo_core::maxprofile::Profiles::new(&book),
    )
    .expect("realBuildStages");
    let price = |game_build: &str| {
        let scenario = obj([
            ("core", Str("overhaul".to_owned())),
            ("rri", Bool(true)),
            ("passiveOn", Bool(true)),
            ("stacks", Num(5.0)),
            ("gameBuild", Str(game_build.to_owned())),
            ("objective", Str("stochastic-ttk".to_owned())),
            ("target", stage.target.clone()),
            ("health", Num(5000.0)),
            ("seeds", Arr(paired_fight_seeds(&Num(1000.0), &Num(7.0)))),
            ("maxSeconds", Num(60.0)),
            ("maxBlows", Num(6000.0)),
        ]);
        let entries = vec![obj([
            ("id", Num(0.0)),
            ("ch", stage.ench_ch.clone()),
            (
                "scenario",
                obj([("imprint", stage.imprint.get("power").clone())]),
            ),
        ])];
        rank_builds(&entries, &scenario, &book)
            .expect("rankBuilds")
            .get("rows")
            .items()[0]
            .get("value")
            .to_number()
    };
    let drift = price("14631");
    let cut = price("14512");
    assert!(
        (drift - cut).abs() > 1e-9,
        "the fixture's own candidate must price differently at each build (drift {drift}, cut {cut})"
    );
    assert!(
        (value - drift).abs() <= 1e-9,
        "the shortlist must rank at its own build (value {value}, drift {drift}, cut {cut})"
    );
}

/// A LOCAL INVARIANT: the parsed option defaults are the JS destructured defaults (`loadoutShortlist.js:15-20`), and an
/// explicit `0` stays `0` (`num_or_default`'s `v == 0.0` arm, not a made-up 1). A sampled run cannot show these without a
/// 900-second horizon, so this pins the struct the run is built from.
#[test]
fn the_shortlist_option_defaults_are_the_js_defaults() {
    let absent = ShortlistOpts::from_value(&obj([
        ("k", Num(1.0)),
        ("mode", Str("uncapped".to_owned())),
    ]));
    assert_eq!(absent.trials, 1000.0, "MIN_STOCHASTIC_TRIALS");
    assert_eq!(absent.seed, 0.0);
    assert_eq!(absent.max_seconds, 900.0);
    assert_eq!(absent.max_blows, 6000.0);
    assert!(absent.health.is_nullish());
    assert_eq!(absent.encounter, "breach");
    // An explicit zero is the JS default too, and every other number is itself.
    let explicit = ShortlistOpts::from_value(&obj([
        ("k", Num(1.0)),
        ("mode", Str("uncapped".to_owned())),
        ("seed", Num(0.0)),
        ("maxSeconds", Num(1.0)),
        ("maxBlows", Num(20.0)),
    ]));
    assert_eq!(explicit.seed, 0.0, "an explicit zero seed stays zero");
    assert_eq!(explicit.max_seconds, 1.0);
    assert_eq!(explicit.max_blows, 20.0);
    // `num_or_default`'s NaN arm: a key the JS `Number()` cannot read (NaN) takes the same default as an absent one.
    let nan = ShortlistOpts::from_value(&obj([
        ("k", Num(1.0)),
        ("mode", Str("uncapped".to_owned())),
        ("seed", Num(f64::NAN)),
        ("maxSeconds", Num(f64::NAN)),
        ("maxBlows", Num(f64::NAN)),
    ]));
    assert_eq!(nan.seed, 0.0, "NaN seed -> 0");
    assert_eq!(nan.max_seconds, 900.0, "NaN maxSeconds -> 900");
    assert_eq!(nan.max_blows, 6000.0, "NaN maxBlows -> 6000");
}

/// A LOCAL INVARIANT: `--shortlist <K>` refuses one past the eligible pool and accepts exactly the pool (`>` not `>=`,
/// `loadout_shortlist.rs:201`). The refused case short-circuits before any sampling, so it is cheap; the accepted one needs
/// the exact eligible count, which is one universe away at the cut.
#[test]
fn the_k_boundary_is_the_eligible_count() {
    let book = stock_book();
    let opts = |k: f64| {
        ShortlistOpts::from_value(&obj([
            ("k", Num(k)),
            ("mode", Str("uncapped".to_owned())),
            ("trials", Num(1000.0)),
            ("seed", Num(7.0)),
            ("maxSeconds", Num(0.001)),
            ("maxBlows", Num(1.0)),
        ]))
    };
    let mut profiles = dfo_core::maxprofile::Profiles::new(&book);
    let universe = dfo_core::loadout_shortlist::eligible_universe_with(&opts(1.0), &mut profiles)
        .expect("the eligible universe");
    let len = universe.len() as f64;
    assert!(len > 1.0, "the eligible pool has more than one row");
    let refused = shortlist_loadouts_with(&opts(len + 1.0), &mut profiles);
    assert_eq!(
        refused.err(),
        Some(format!(
            "--shortlist: {} exceeds the {} eligible loadouts",
            len + 1.0,
            len
        )),
        "one past the pool refuses"
    );
    // Exactly the pool is not a refusal (`>=` would reject it); the run is one horizon tick so the sampling is trivial.
    let accepted = shortlist_loadouts_with(&opts(len), &mut profiles);
    assert!(
        accepted.is_ok(),
        "exactly the eligible count is accepted: {:?}",
        accepted.err()
    );
    assert_eq!(
        accepted
            .expect("the accepted shortlist")
            .get("rows")
            .items()
            .len() as f64,
        len,
        "and it carries every eligible row"
    );
}

/// A LOCAL INVARIANT: the default and an unknown spelling are the cut, in the one place that reads the key.
#[test]
fn an_absent_or_unknown_build_is_the_cut() {
    let plain = ShortlistOpts::from_value(&obj([
        ("k", Num(1.0)),
        ("mode", Str("uncapped".to_owned())),
        ("trials", Num(1000.0)),
        ("seed", Num(7.0)),
        ("maxSeconds", Num(1.0)),
        ("maxBlows", Num(1.0)),
    ]));
    assert_eq!(plain.game_build, "14512");
    let bogus = ShortlistOpts::from_value(&obj([
        ("k", Num(1.0)),
        ("mode", Str("uncapped".to_owned())),
        ("trials", Num(1000.0)),
        ("seed", Num(7.0)),
        ("maxSeconds", Num(1.0)),
        ("maxBlows", Num(1.0)),
        ("gameBuild", Str("1463".to_owned())),
    ]));
    assert_eq!(bogus.game_build, "14512", "a bogus build is the cut");
}
