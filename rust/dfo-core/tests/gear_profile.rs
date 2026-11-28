mod common;
use dfo_core::{
    gear_profile as g,
    value::Value::{Arr, Bool, Num, Str},
};

#[test]
fn gear_profile() {
    common::planning::replay(
        "gear_profile",
        &[
            "all",
            "slot",
            "exalt",
            "totals",
            "budget",
            "validate",
            "constants",
        ],
        false,
        |k, v, _| match k {
            "all" => Arr(g::all_records().to_vec()),
            "constants" => Arr(vec![
                Arr(g::SKILL_IDS.iter().copied().map(Num).collect()),
                Arr([
                    g::SKILL_BAND_TOP.magic,
                    g::SKILL_BAND_TOP.rare,
                    g::SKILL_BAND_TOP.legendary,
                ]
                .map(Num)
                .to_vec()),
                Arr([
                    g::AFFIX_DAMAGE_TOP.magic,
                    g::AFFIX_DAMAGE_TOP.rare,
                    g::AFFIX_DAMAGE_TOP.legendary,
                ]
                .map(Num)
                .to_vec()),
                Num(g::EXALTED_SKILL_FLOOR),
            ]),
            "slot" => {
                let (t, g, skill) = (v(), v(), v());
                Arr(vec![
                    Arr(g::rolled_skills(&t, &g).into_iter().map(Num).collect()),
                    Bool(g::can_roll_skill(&t, &g, &skill)),
                    Bool(g::can_exalt_skill_here(&t, &g)),
                    g::records_for(&t, &g),
                    g::slot_options(&t, &g, &skill),
                ])
            }
            "totals" => {
                let o = v();
                Arr(vec![
                    g::slots_for(&o),
                    g::legal_totals(&o),
                    g::legal_point_totals(&o),
                    Num(g::max_point_total(&o)),
                    Num(g::max_single_skill(&o)),
                ])
            }
            "validate" => g::validate_plan(&v()),
            "budget" => {
                let o = v();
                let channels = |points: dfo_core::value::Value| {
                    Arr(points
                        .items()
                        .iter()
                        .map(|p| Arr(["lb", "cs", "dmg"].map(|k| p.get(k).clone()).to_vec()))
                        .collect())
                };
                Arr(vec![
                    channels(g::legal_totals(&o)),
                    channels(g::legal_point_totals(&o)),
                ])
            }
            "exalt" => Arr(g::exalted_kinds(&v(), &v())
                .into_iter()
                .map(|s| Str(s.to_owned()))
                .collect()),
            _ => panic!("unexpected vector kind {k}"),
        },
    );
}
