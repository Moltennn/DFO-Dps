mod common;
use dfo_core::{
    imprints as i, maxprofile as m,
    value::Value::{Null, Num, Obj},
};

#[test]
fn imprints() {
    let book = common::planning::spellbook(
        common::stream("imprints")
            .next()
            .expect("fixture spellbook"),
    );
    let mut profiles = m::Profiles::new(&book);
    common::planning::replay(
        "imprints",
        &[
            ("fit", 20),
            ("power", 2048),
            ("rank", 90),
            ("rank_all", 12),
            ("lookup", 7),
        ],
        true,
        |k, v, _| match k {
            "fit" => i::imprints_for(&v()),
            "lookup" => i::imprint_family_by_id(&v()).cloned().unwrap_or(Null),
            "rank" => i::rank_family(&v(), &v(), &mut profiles).unwrap(),
            "rank_all" => i::rank_all(&v(), &mut profiles).unwrap(),
            "power" => {
                let p = v();
                let ch = m::build_max(&v(), &v()).unwrap();
                let target = v();
                let args = Obj(vec![
                    ("target".into(), target.clone()),
                    ("health".into(), target.get("maxHealth").clone()),
                    (
                        "core".into(),
                        dfo_core::value::Value::Str("overhaul".into()),
                    ),
                    ("rri".into(), dfo_core::value::Value::Bool(true)),
                    ("healthShare".into(), Num(1.0)),
                    ("passiveOn".into(), dfo_core::value::Value::Bool(true)),
                    ("stacks".into(), Num(5.0)),
                    (
                        "pair".into(),
                        dfo_core::value::Value::Bool(ch.get("_pair").truthy()),
                    ),
                    ("dual".into(), dfo_core::value::Value::Bool(false)),
                ]);
                Num(i::power_dps(
                    &p,
                    &ch,
                    &args,
                    v().truthy(),
                    v().truthy(),
                    &book,
                ))
            }
            _ => panic!("unexpected vector kind {k}"),
        },
    );
}
