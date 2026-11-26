//! The planners price the shipped build, as LOCAL INVARIANTS (the 14631 law is `dist:` evidence, so parity with the JS
//! is what proves the port; this file pins the Rust API's own wiring).
//!
//! The ticket's warning was real: `legal_gear` picks the legal frontier point by DPS, and the 14631 gear law (a flat add
//! per gear point, no mastery percent) can move that winner - measured on 118, `250 / 370 / 25%` at `14512` becomes
//! `350 / 252 / 38%` at `14631`. So every ladder below re-prices, and the shared caches key on the build.

use dfo_core::enchant_plan::{plan_enchants, plan_matrix};
use dfo_core::imprints::{imprint_family_by_id, rank_all};
use dfo_core::maxprofile::{max_run, Profiles};
use dfo_core::real_build::{real_build_stages, real_weapon_loadouts, StageOpts};
use dfo_core::spells::Spellbook;
use dfo_core::value::Value::{self, Num, Str};

fn obj(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Obj(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

fn opts(build: &str) -> Value {
    obj([("gameBuild", Str(build.to_owned()))])
}

fn family(key: &str) -> &'static Value {
    imprint_family_by_id(&Str(key.to_owned())).expect("a known family")
}

/// A LOCAL INVARIANT: the legal frontier is re-priced, so its WINNER moves under 14631 while both points stay legal.
#[test]
fn the_legal_frontier_winner_moves_with_the_build() {
    let book = Spellbook::default();
    let mut profiles = Profiles::new(&book);
    let point = |p: &Value| {
        (
            p.get("lb").to_number(),
            p.get("cs").to_number(),
            p.get("dmg").to_number(),
        )
    };
    let cut = profiles
        .legal_gear(&Num(118.0), &opts("14512"))
        .expect("the cut frontier");
    let drift = profiles
        .legal_gear(&Num(118.0), &opts("14631"))
        .expect("the drift frontier");
    assert_ne!(
        point(&cut),
        point(&drift),
        "14631 re-picks the legal point (a flat add beats Critical Strike points)"
    );
    assert_eq!(
        cut.get("violations").items().len(),
        0,
        "the cut point is legal"
    );
    assert_eq!(
        drift.get("violations").items().len(),
        0,
        "the drift point is legal"
    );
    // The cache key carries the build: asking again in either order returns each build's own winner.
    let again = profiles
        .legal_gear(&Num(118.0), &opts("14512"))
        .expect("cached");
    assert_eq!(point(&again), point(&cut));
    let again = profiles
        .legal_gear(&Num(118.0), &opts("14631"))
        .expect("cached");
    assert_eq!(point(&again), point(&drift));
    // An unknown build prices the LIVE build (`game_build_name`'s one normalisation point): only `14512` cuts.
    let bogus = profiles
        .legal_gear(&Num(118.0), &opts("1463"))
        .expect("the live frontier");
    assert_eq!(point(&bogus), point(&drift));
}

/// A LOCAL INVARIANT: `max_run` reads the scenario key, so the shipped build reaches the card.
#[test]
fn a_max_run_card_moves_with_the_build() {
    let book = Spellbook::default();
    let mut profiles = Profiles::new(&book);
    let ch = profiles
        .max_character(&Num(118.0), &obj([]))
        .expect("a max character");
    let cut = max_run(&ch, &opts("14512"), &book);
    let drift = max_run(&ch, &opts("14631"), &book);
    assert_ne!(
        cut.card.fields.capped_dps, drift.card.fields.capped_dps,
        "the carried figure moves"
    );
    // An unset key is the LIVE build.
    let plain = max_run(&ch, &obj([]), &book);
    assert_eq!(plain.card.fields.capped_dps, drift.card.fields.capped_dps);
}

/// A LOCAL INVARIANT: the imprint ranking and the enchant plan ride the same card.
#[test]
fn the_imprint_and_enchant_plans_move_with_the_build() {
    let book = Spellbook::default();
    let mut profiles = Profiles::new(&book);
    let cut = rank_all(&opts("14512"), &mut profiles).expect("the cut ranking");
    let drift = rank_all(&opts("14631"), &mut profiles).expect("the drift ranking");
    let base = |list: &Value, key: &str| {
        list.items()
            .iter()
            .find(|f| f.get("key").is_str(key))
            .map(|f| f.get("base").get("carriedCappedDps").to_number())
            .expect("the family")
    };
    assert_ne!(
        base(&cut, "LongBlade"),
        base(&drift, "LongBlade"),
        "the ranked base moves"
    );
    let plan = |build: &str| {
        plan_enchants(
            &obj([("weapon", Num(118.0)), ("gameBuild", Str(build.to_owned()))]),
            &book,
        )
        .expect("the plan")
    };
    assert_ne!(
        plan("14512").get("carriedBaseDps").to_number(),
        plan("14631").get("carriedBaseDps").to_number(),
        "the enchant baseline moves"
    );
    let matrix = plan_matrix(&opts("14631"), &book).expect("the matrix");
    assert!(matrix.items().iter().all(|f| f.get("plan").truthy()));
}

/// A LOCAL INVARIANT: the real-loadout chain takes the build through `StageOpts` (the field is additive: a
/// `Default` caller is the live build), and every row of the universe moves.
#[test]
fn the_real_loadout_chain_takes_the_build() {
    let book = Spellbook::default();
    let universe = |build: &str| {
        real_weapon_loadouts(&["uncapped".to_owned()], false, "breach", build, &book)
            .expect("the universe")
    };
    let cut = universe("14512");
    let drift = universe("14631");
    assert_eq!(cut.len(), drift.len(), "the same rows");
    let row = |rows: &[Value], t: f64| {
        rows.iter()
            .find(|r| r.get("template").strict_eq(&Num(t)) && !r.get("dual").truthy())
            .map(|r| r.get("treeDps").to_number())
            .expect("the row")
    };
    assert_ne!(row(&cut, 118.0), row(&drift, 118.0), "the tree stage moves");
    // An unknown build name normalises to the LIVE build rather than inventing a third law.
    let bogus = universe("1463");
    assert_eq!(row(&bogus, 118.0), row(&drift, 118.0));
    // `StageOpts::from_value` reads the key; a default struct is the LIVE build.
    assert_eq!(StageOpts::from_value(&opts("14512")).game_build, "14512");
    let mut live_opts = StageOpts::default();
    assert_eq!(live_opts.game_build, "14631");
    let live_stage = real_build_stages(&Num(118.0), family("LongBlade"), &live_opts, &book)
        .expect("the live stage");
    live_opts.game_build = "14512".to_owned();
    let cut_stage = real_build_stages(&Num(118.0), family("LongBlade"), &live_opts, &book)
        .expect("the cut stage");
    assert_ne!(
        live_stage.tree_run.totals.carried_capped_dps, cut_stage.tree_run.totals.carried_capped_dps,
        "the stage's tree run moves"
    );
}
