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
