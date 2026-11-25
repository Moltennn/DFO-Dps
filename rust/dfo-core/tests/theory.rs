mod common;
use dfo_core::{
    theory as t,
    value::Value::{Arr, Num, Str},
};

#[test]
fn theory() {
    common::planning::replay(
        "theory",
        &[
            ("character", 3136),
            ("fists", 3129),
            ("blade", 3128),
            ("refusal", 7),
            ("constants", 1),
        ],
        false,
        |k, v, _| match k {
            "character" => t::theory_character(&v()).unwrap(),
            "fists" => t::theory_fists(&v()),
            "blade" => t::theory_blade(&t::theory_character(&v()).unwrap(), &v(), &v()).unwrap(),
            "refusal" => Str(t::theory_character(&v()).unwrap_err()),
            "constants" => {
                Arr(
                    std::iter::once(Arr(t::LONG_BLADES.iter().copied().map(Num).collect()))
                        .chain(
                            [
                                t::GEAR_LINE_MAX,
                                t::DAMAGE_AFFIX_MAX,
                                t::GEAR_MASTERY_CAP,
                                t::GEAR_MASTERY_POINTS,
                                t::GEAR_LB_LINES,
                                t::GEAR_CS_LINES,
                                t::GEAR_SKILL_LINES,
                                t::GEAR_H2_H_LINES,
                            ]
                            .into_iter()
                            .map(Num),
                        )
                        .collect(),
                )
            }
            _ => panic!("unexpected vector kind {k}"),
        },
    );
}

/// A LOCAL INVARIANT, cited from the shipped `dist:` build 0.1.14631 (weak evidence): the cap sheet's gear row is
/// prose, but it must not tell a `14631` reader to cap the gear at 320%. `theory.js:56-70`.
#[test]
fn the_cap_sheet_follows_the_shipped_build() {
    let cut = t::theory_caps("14512");
    assert_eq!(
        cut,
        t::THEORY_CAPS.to_vec(),
        "the 14512 sheet is the frozen table"
    );
    let drifted = t::theory_caps("14631");
    let row = |list: &[t::TheoryCapsItem]| {
        let found = list
            .iter()
            .find(|c| c.channel == "Gear Long Blade")
            .expect("the gear row");
        (found.formula.to_owned(), found.cap.to_owned())
    };
    assert!(row(&drifted).0.contains("flat uniform"));
    assert!(!row(&drifted).0.contains("0.44"));
    assert_eq!(
        drifted.len(),
        t::THEORY_CAPS.len(),
        "only the gear row changes"
    );
    assert_eq!(
        drifted
            .iter()
            .filter(|c| c.channel != "Gear Long Blade")
            .collect::<Vec<_>>(),
        t::THEORY_CAPS
            .iter()
            .filter(|c| c.channel != "Gear Long Blade")
            .collect::<Vec<_>>()
    );
    // An unknown build prices as the cut, the one normalisation point.
    assert_eq!(t::theory_caps("14513"), cut);
    // And the formula-cap row itself: 14512 still needs 728 points, 14631 has no such cap at all.
    assert_eq!(
        t::gear_mastery_points("14512"),
        Some(t::GEAR_MASTERY_POINTS)
    );
    assert_eq!(t::gear_mastery_points("14631"), None);
}
