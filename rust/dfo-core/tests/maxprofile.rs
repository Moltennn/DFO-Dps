mod common;
use dfo_core::{maxprofile as m, spells::Spellbook, value::Value};

#[test]
fn maxprofile() {
    // Keep the replay's caller-owned cache tied to one copy of the explicit stock book.
    let stock = common::stream("maxprofile")
        .next()
        .expect("fixture spellbook");
    let book: Spellbook = common::planning::spellbook(stock);
    let mut profiles = m::Profiles::new(&book);
    common::planning::replay(
        "maxprofile",
        &[
            ("build", 3129),
            ("run", 3129),
            ("frontier", 115),
            ("legal", 346),
            ("max", 92),
            ("plan", 1),
            ("refusal", 2),
        ],
        true,
        |k, v, _| match k {
            "build" => m::build_max(&v(), &v()).unwrap(),
            "run" => {
                let mut ch = m::build_max(&v(), &v()).unwrap();
                for (k, x) in v().entries() {
                    ch.set(k, x.clone());
                }
                m::max_run(&ch, &v(), &book).to_value()
            }
            "frontier" => profiles.legal_frontier(&v(), &v()).unwrap().clone(),
            "legal" => profiles.legal_gear(&v(), &v()).unwrap(),
            "max" => profiles.max_character(&v(), &v()).unwrap(),
            "plan" => profiles.legal_gear_plan(&v(), &v()).unwrap(),
            "refusal" => Value::Str(profiles.legal_gear(&v(), &v()).unwrap_err()),
            _ => panic!("unexpected vector kind {k}"),
        },
    );
}
