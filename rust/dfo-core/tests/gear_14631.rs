//! The 0.1.14631 weapon-gear law and `brand` power, as LOCAL INVARIANTS cited from the shipped `dist:` build
//! (weak evidence: `CHANGELOG-MECHANICS.md` GEAR-14631 / BRAND-14631, `test/build14631.test.js`).
//!
//! These pin the port's own guards and ranges, not the game: parity with the JS (`tests/model_blow.rs` and the
//! `gameBuild` cases `tools/rust-blow-vectors.mjs` appends) is what proves the port. The default build is `14631`, so
//! every case here also states that the cut's behaviour is untouched when the option is absent.

use dfo_core::model_blow::{
    damage_model, gear_blow_add, loot_power_terms, mastery_pct, JsRangeError, DEFAULT_GAME_BUILD,
    GAME_BUILDS, MAX_ADD_ARRAY_LENGTH, MAX_ENUMERATED_BLOWS,
};
use dfo_core::target::Target;
use dfo_core::value::Value;
use dfo_core::value::Value::{Arr, Bool, Null, Num, Obj, Str};

fn obj(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Obj(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

/// A player-shaped attacker with `gear` points on `skill` (the `skillModOf` channel), online.
fn attacker(skill: f64, gear: f64) -> Value {
    let num = |id: f64| Num(if skill == id { gear } else { 0.0 });
    obj([
        ("online", Bool(true)),
        (
            "skills",
            obj([
                ("29", Num(200.0)),
                ("30", Num(200.0)),
                ("31", Num(200.0)),
                ("32", Num(200.0)),
            ]),
        ),
        ("masterSkills", Bool(true)),
        (
            "masteredSkills",
            Arr(vec![Num(29.0), Num(30.0), Num(31.0), Num(32.0)]),
        ),
        (
            "_mods",
            obj([(
                "skills",
                obj([
                    ("29", num(29.0)),
                    ("30", num(30.0)),
                    ("31", num(31.0)),
                    ("32", num(32.0)),
                ]),
            )]),
        ),
        (
            "stats",
            obj([
                ("strength", Num(50.0)),
                ("speed", Num(50.0)),
                ("agility", Num(50.0)),
            ]),
        ),
    ])
}

/// A weapon record with just the fields `gear_blow_add` and the roll enumeration read.
fn weapon(skill: f64, min: f64, max: f64) -> Value {
    obj([
        ("skillId", Num(skill)),
        ("min", Num(min)),
        ("max", Num(max)),
        ("damagePct", Num(0.0)),
        ("bonusDamage", Num(0.0)),
        ("material", Num(1.0)),
        ("twoHanded", Bool(false)),
        ("powers", Arr(vec![])),
    ])
}

/// An ordinary foe: not a player, not warded (`referenceFoe(5, 'tough')`'s shape).
fn foe() -> Target {
    Target {
        is_player: false,
        warded: false,
        level: Some(5.0),
        career: dfo_core::target::Career::default(),
        ..Default::default()
    }
}

fn opts(pairs: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    obj(pairs)
}

#[test]
fn the_accepted_builds_and_default_are_the_js_list() {
    assert_eq!(GAME_BUILDS, ["14512", "14631"]);
    assert_eq!(DEFAULT_GAME_BUILD, "14631", "the default is the live build");
}

#[test]
fn the_add_range_is_floor_over_ten_to_floor_over_five() {
    // dist:weaponMastery-AR4ipaqT.js@0.1.14631 `b()`: floor(s/10)..floor(s/5).
    for (gear, want) in [
        (0.0, None),
        (9.0, Some((0.0, 1.0))),
        (250.0, Some((25.0, 50.0))),
        (700.0, Some((70.0, 140.0))),
    ] {
        let ch = attacker(29.0, gear);
        let got = gear_blow_add(
            &ch,
            &weapon(29.0, 100.0, 100.0),
            Some(&foe()),
            &opts([("gameBuild", Str("14631".into()))]),
        );
        assert_eq!(got, want, "gear {gear}");
    }
}

#[test]
fn every_guard_turns_the_add_off() {
    let on = opts([("gameBuild", Str("14631".into()))]);
    let goes = |ch: &Value, w: &Value, t: Option<&Target>| gear_blow_add(ch, w, t, &on).is_some();
    assert!(goes(
        &attacker(29.0, 700.0),
        &weapon(29.0, 1.0, 1.0),
        Some(&foe())
    ));
    // The build gate: only an explicit 14512 selects the cut, so only it refuses the add; the live default and an
    // unknown string (which the CLI refuses before a formula) price it.
    for build in ["14513", "1463", ""] {
        let live = opts([("gameBuild", Str(build.into()))]);
        assert!(
            gear_blow_add(
                &attacker(29.0, 700.0),
                &weapon(29.0, 1.0, 1.0),
                Some(&foe()),
                &live
            )
            .is_some(),
            "{build} prices the live build"
        );
    }
    assert!(
        gear_blow_add(
            &attacker(29.0, 700.0),
            &weapon(29.0, 1.0, 1.0),
            Some(&foe()),
            &opts([("gameBuild", Str("14512".into()))])
        )
        .is_none(),
        "only 14512 refuses the add"
    );
    // An absent key is the live build, which enables the add (only an explicit 14512 runs the blocked arm).
    assert!(gear_blow_add(
        &attacker(29.0, 700.0),
        &weapon(29.0, 1.0, 1.0),
        Some(&foe()),
        &opts([])
    )
    .is_some());
    // The attacker's guards.
    for key in ["peer", "_mentor", "isInBeastForm"] {
        let mut ch = attacker(29.0, 700.0);
        ch.set(key, Bool(true));
        assert!(
            !goes(&ch, &weapon(29.0, 1.0, 1.0), Some(&foe())),
            "{key} turns it off"
        );
    }
    let mut offline = attacker(29.0, 700.0);
    offline.set("online", Bool(false));
    assert!(!goes(&offline, &weapon(29.0, 1.0, 1.0), Some(&foe())));
    // Fists never add, and a non-integer skill id is not a weapon skill.
    assert!(!goes(
        &attacker(30.0, 700.0),
        &weapon(30.0, 1.0, 1.0),
        Some(&foe())
    ));
    assert!(!goes(
        &attacker(29.0, 700.0),
        &weapon(f64::NAN, 1.0, 1.0),
        Some(&foe())
    ));
    // The target's guards: a player, a warded body and a missing target.
    let mut player = foe();
    player.is_player = true;
    assert!(!goes(
        &attacker(29.0, 700.0),
        &weapon(29.0, 1.0, 1.0),
        Some(&player)
    ));
    let mut warded = foe();
    warded.warded = true;
    assert!(!goes(
        &attacker(29.0, 700.0),
        &weapon(29.0, 1.0, 1.0),
        Some(&warded)
    ));
    assert!(!goes(&attacker(29.0, 700.0), &weapon(29.0, 1.0, 1.0), None));
    // The weapon's own guard: `!w` (`model.js:664`), a bare-fisted or null weapon never adds, and neither does a
    // missing attacker (`!ch`). The card reads both before it builds any roll.
    for nullish in [Value::Null, Value::Undefined] {
        assert!(
            !goes(&attacker(29.0, 700.0), &nullish, Some(&foe())),
            "a {nullish:?} weapon never adds"
        );
        assert!(
            !goes(&nullish, &weapon(29.0, 1.0, 1.0), Some(&foe())),
            "a {nullish:?} attacker never adds"
        );
    }
    assert!(!goes(
        &Value::Bool(false),
        &weapon(29.0, 1.0, 1.0),
        Some(&foe())
    ));
    assert!(!goes(&Value::Bool(false), &Value::Null, None));
    // And through the card: bare fists carry no `gearAdd`.
    let drift = opts([
        ("gameBuild", Str("14631".into())),
        ("core", Str("classic".into())),
    ]);
    let card = damage_model(
        &attacker(29.0, 700.0),
        &Value::Null,
        Some(&foe()),
        "StrikeLeft",
        "classic",
        &drift,
        &mut Default::default(),
    );
    assert!(matches!(card.get("parts").get("gearAdd"), Value::Undefined));
    // A zero gear points add is no add.
    assert!(!goes(
        &attacker(29.0, 0.0),
        &weapon(29.0, 1.0, 1.0),
        Some(&foe())
    ));
    // Each disjunct alone suffices: the guard is an `||` chain, so a case where exactly one clause is true still
    // refuses. Without these a `||` -> `&&` mutant survives, because the happy path has every clause false.
    assert!(
        !goes(&Value::Null, &weapon(29.0, 1.0, 1.0), Some(&foe())),
        "only !ch"
    );
    assert!(
        !goes(&attacker(29.0, 700.0), &Value::Null, Some(&foe())),
        "only !w"
    );
    // The build gate alone: `14631` is the only string that passes, and only `14512` reaches the gear percent.
    assert!(goes(
        &attacker(29.0, 700.0),
        &weapon(29.0, 1.0, 1.0),
        Some(&foe())
    ));
    // The skill clause alone: a non-finite id is refused, an integer one passes (both with online, peer, mentor and
    // beast all false and a real target).
    assert!(!goes(
        &attacker(29.0, 700.0),
        &weapon(f64::INFINITY, 1.0, 1.0),
        Some(&foe())
    ));
    assert!(goes(
        &attacker(31.0, 700.0),
        &weapon(31.0, 1.0, 1.0),
        Some(&foe())
    ));
}

#[test]
fn the_card_enumerates_the_add_and_reports_its_range() {
    // A 100 roll: the mean add is the average blow; the support is [100 + lo, 100 + hi].
    let ch = attacker(29.0, 700.0);
    let w = weapon(29.0, 100.0, 100.0);
    let drift = obj([
        ("gameBuild", Str("14631".into())),
        ("core", Str("classic".into())),
    ]);
    let card = damage_model(
        &ch,
        &w,
        Some(&foe()),
        "StrikeLeft",
        "classic",
        &drift,
        &mut Default::default(),
    );
    let parts = card.get("parts");
    assert_eq!(parts.get("gearAdd").get("lo").to_number(), 70.0);
    assert_eq!(parts.get("gearAdd").get("hi").to_number(), 140.0);
    assert_eq!(parts.get("gearAdd").get("mean").to_number(), 105.0);
    // The band is the whole integer range, not one sampled add: 71 blows for one roll of 100.
    assert_eq!(card.get("plainRolls").items().len(), 71);
    // `rollOf` folds the weapon's own damage modifier over the gear-added roll (`(r + add) * (1 + damagePct/100)`),
    // so a 10% line moves the add too. A raw-100 attacker has no mastery climb, so the finished blow is the roll alone
    // and the mutant on that `1.0` is caught.
    let plain = {
        let mut ch = attacker(29.0, 700.0);
        ch.set(
            "skills",
            obj([
                ("29", Num(100.0)),
                ("30", Num(100.0)),
                ("31", Num(100.0)),
                ("32", Num(100.0)),
            ]),
        );
        ch
    };
    let mut ten_pct = w.clone();
    ten_pct.set("damagePct", Num(10.0));
    let uplifted = damage_model(
        &plain,
        &ten_pct,
        Some(&foe()),
        "StrikeLeft",
        "classic",
        &drift,
        &mut Default::default(),
    );
    let rolls: Vec<f64> = uplifted
        .get("plainRolls")
        .items()
        .iter()
        .map(|v| v.to_number())
        .collect();
    assert_eq!(rolls.len(), 71);
    assert_eq!(
        rolls[0],
        ((100.0f64 + 70.0) * 1.1).trunc(),
        "the low add is folded"
    );
    assert_eq!(
        rolls[70],
        ((100.0f64 + 140.0) * 1.1).trunc(),
        "and so is the high add"
    );
    // The cut prices the same roll alone (the gear is a percent there, not an add), so its band is one blow wide.
    // The cut names the vendored build explicitly: a bare `core` is now the live default.
    let cut = obj([
        ("core", Str("classic".into())),
        ("gameBuild", Str("14512".into())),
    ]);
    let base = damage_model(
        &ch,
        &w,
        Some(&foe()),
        "StrikeLeft",
        "classic",
        &cut,
        &mut Default::default(),
    );
    assert!(matches!(base.get("parts").get("gearAdd"), Value::Undefined));
    assert_eq!(base.get("plainRolls").items().len(), 1);
    // And the add is what a gear-0 card lacks: the same card, same build, one blow wide and no wider band.
    let zero = attacker(29.0, 0.0);
    let none = damage_model(
        &zero,
        &w,
        Some(&foe()),
        "StrikeLeft",
        "classic",
        &drift,
        &mut Default::default(),
    );
    assert_eq!(none.get("plainRolls").items().len(), 1);
    assert!(matches!(none.get("parts").get("gearAdd"), Value::Undefined));
    // Every blow is the 100 roll plus its own add before the blow channels: the support moved by the add's bounds or
    // more (the mastery percent scales it), never less.
    assert!(card.get("min").to_number() - none.get("min").to_number() >= 70.0);
    assert!(card.get("max").to_number() - none.get("max").to_number() >= 140.0);
}

#[test]
fn the_mastery_percent_is_the_climb_only_under_14631() {
    // The climb at raw 200 is 40 (effectiveSkill(200) = 140). Gear 700 buys no percent under 14631 and
    // min(320, 700 x 0.44) = 308 under the cut.
    let ch = attacker(29.0, 700.0);
    let w = weapon(29.0, 1.0, 1.0);
    assert_eq!(
        mastery_pct(&ch, &w, &opts([("gameBuild", Str("14631".into()))])),
        40.0
    );
    assert_eq!(
        mastery_pct(&ch, &w, &opts([("gameBuild", Str("14512".into()))])),
        348.0
    );
    // Axe/Blunt lose the half line: both read the sword's single climb under 14631, and the cut's x2 / 0 under it.
    for (skill, cut_low, cut_high) in [(31.0, 80.0, 0.0), (32.0, 0.0, 80.0)] {
        let ch = attacker(skill, 0.0);
        let w = weapon(skill, 1.0, 1.0);
        for share in [0.49, 0.9] {
            let o = opts([
                ("gameBuild", Str("14631".into())),
                ("healthShare", Num(share)),
            ]);
            let got = mastery_pct(&ch, &w, &o);
            assert_eq!(got, 40.0, "skill {skill} at {share}");
        }
        let low = opts([
            ("healthShare", Num(0.49)),
            ("gameBuild", Str("14512".into())),
        ]);
        let high = opts([
            ("healthShare", Num(0.9)),
            ("gameBuild", Str("14512".into())),
        ]);
        assert_eq!(mastery_pct(&ch, &w, &low), cut_low, "cut, low share");
        assert_eq!(mastery_pct(&ch, &w, &high), cut_high, "cut, high share");
    }
}

#[test]
fn brand_adds_flat_elemental_damage_only_under_14631() {
    let retribution = obj([
        ("kind", Str("brand".into())),
        ("element", Str("fire".into())),
        ("flat", Num(8.0)),
    ]);
    let powers = [retribution];
    let go = |t: Option<&Target>, extra: &[(&'static str, Value)]| {
        let mut pairs = vec![("gameBuild", Str("14631".into()))];
        pairs.extend_from_slice(extra);
        let (pct, flat) = loot_power_terms(&powers, t, &opts(pairs));
        (pct, flat)
    };
    assert_eq!(go(Some(&foe()), &[]), (0.0, 8.0));
    let mut resistant = foe();
    resistant.career.resistance_flags = Some(8.0);
    assert_eq!(
        go(Some(&resistant), &[]),
        (0.0, 4.0),
        "resistant: half, floored"
    );
    let mut immune = foe();
    immune.career.immunity_flags = Some(8.0);
    assert_eq!(go(Some(&immune), &[]), (0.0, 0.0), "immune: none");
    // The under-half-health doubling is venom's, not brand's.
    assert_eq!(go(Some(&foe()), &[("healthShare", Num(0.1))]), (0.0, 8.0));
    // A missing element shares as an unknown name does: 1.
    let no_element = obj([("kind", Str("brand".into())), ("flat", Num(8.0))]);
    let (_, flat) = loot_power_terms(
        &[no_element],
        Some(&foe()),
        &opts([("gameBuild", Str("14631".into()))]),
    );
    assert_eq!(flat, 8.0);
    // An absent key is the live build, so the power still adds; only an explicit '14512' has no brand arm.
    assert_eq!(
        loot_power_terms(&powers, Some(&foe()), &opts([])),
        (0.0, 8.0)
    );
    assert_eq!(
        loot_power_terms(
            &powers,
            Some(&foe()),
            &opts([("gameBuild", Str("14512".into()))])
        ),
        (0.0, 0.0)
    );
    // A null target is no immunity: it still adds, as `elementShare` shares 1.
    assert_eq!(
        loot_power_terms(
            &powers,
            None,
            &opts([("gameBuild", Str("14631".into())), ("x", Null)])
        ),
        (0.0, 8.0)
    );
    // A `brand` with no `flat` reads 0 (`num(p.flat, 0)`), so it adds nothing rather than 1.
    let no_flat = obj([
        ("kind", Str("brand".into())),
        ("element", Str("fire".into())),
    ]);
    let (_, flat) = loot_power_terms(
        &[no_flat],
        Some(&foe()),
        &opts([("gameBuild", Str("14631".into()))]),
    );
    assert_eq!(flat, 0.0, "a missing flat is 0, not 1");
}

#[test]
fn the_enumeration_refuses_at_the_js_boundaries() {
    // The two thresholds `check_enumeration` applies, each from one side. A hit is a panic (the CLI turns it into the
    // JS's exit 1 `RangeError`); a miss prices. The card's blow count is adds x rolls.
    let throws = |ch: &Value, w: &Value, opts: &Value| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            damage_model(
                ch,
                w,
                Some(&foe()),
                "StrikeLeft",
                "classic",
                opts,
                &mut Default::default(),
            );
        }))
        .is_err()
    };
    let drift = obj([
        ("gameBuild", Str("14631".into())),
        ("core", Str("classic".into())),
    ]);
    // One roll: blows == adds == `floor(g/5) - floor(g/10) + 1`.
    let one_roll = weapon(29.0, 100.0, 100.0);
    // Under the cap: 5000 points is 1,001 blows, prices.
    assert!(!throws(&attacker(29.0, 5000.0), &one_roll, &drift));
    // `MAX_ENUMERATED_BLOWS` itself is a miss (the guard is strict) and one blow more panics: the mutant that widens
    // or narrows it by one is caught from both sides.
    let cap = MAX_ENUMERATED_BLOWS.floor();
    // Solve floor(g/5) - floor(g/10) + 1 == blows: every g in [10k, 10k+4] gives k+1 adds; use 10k.
    let gear_for = |blows: f64| {
        let k = blows - 1.0;
        10.0 * k
    };
    let at_cap = attacker(29.0, gear_for(cap));
    assert_eq!(
        gear_blow_add(&at_cap, &one_roll, Some(&foe()), &drift).map(|(lo, hi)| hi - lo + 1.0),
        Some(cap),
        "the fixture sits exactly on the cap"
    );
    assert!(
        !throws(&at_cap, &one_roll, &drift),
        "exactly the cap prices"
    );
    assert!(
        throws(&attacker(29.0, gear_for(cap + 1.0)), &one_roll, &drift),
        "one blow past the cap refuses"
    );
    // And the 2^32-1 `Array.from` bound. Exactly the JS length is not the array arm (it reaches the blow cap and
    // raises the spread message), while one add past it is the invalid length: the strict `>` is caught from both sides.
    let at_length = attacker(29.0, gear_for(MAX_ADD_ARRAY_LENGTH));
    let at_length_payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        damage_model(
            &at_length,
            &one_roll,
            Some(&foe()),
            "StrikeLeft",
            "classic",
            &drift,
            &mut Default::default(),
        );
    }))
    .expect_err("at the array length the blow cap still refuses");
    assert_eq!(
        at_length_payload
            .downcast_ref::<JsRangeError>()
            .map(|e| e.0.as_str())
            .unwrap_or(""),
        "RangeError: Maximum call stack size exceeded",
        "the array-length arm is the 'past', not 'at'"
    );
    let over_length = MAX_ADD_ARRAY_LENGTH + 1.0;
    let wide = attacker(29.0, gear_for(over_length));
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        damage_model(
            &wide,
            &one_roll,
            Some(&foe()),
            "StrikeLeft",
            "classic",
            &drift,
            &mut Default::default(),
        );
    }))
    .expect_err("over the array length");
    let message = payload
        .downcast_ref::<JsRangeError>()
        .map(|e| e.0.as_str())
        .unwrap_or("");
    assert_eq!(message, "RangeError: Invalid array length");
}
