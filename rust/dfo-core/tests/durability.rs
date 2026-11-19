mod common;
use dfo_core::{durability::*, target::Target, value::Value};

#[test]
fn wear_matches_js_and_consumes_the_same_rolls() {
    let (defs, cases) = common::load_with_defs("durability");
    let mut wear_cases = 0;
    let mut break_cases = 0;
    for mut c in cases {
        if c.kind == "break" {
            break_cases += 1;
            let item = c.value(&defs);
            let main = c.value(&defs).truthy();
            let off = c.value(&defs).truthy();
            let same = c.value(&defs).truthy();
            let amount = c.value(&defs).to_number();
            let mut held = clone_item(&item);
            let mut owner = make_owner(main.then_some(1), off.then_some(if same { 1 } else { 2 }));
            let broke = wear_item(&mut owner, 1, &mut held, amount);
            let other = if same {
                held.clone()
            } else {
                clone_item(&item)
            };
            let b = Value::Bool;
            c.check_out(
                "break",
                &Value::Arr(vec![
                    b(broke),
                    held,
                    b(owner.right.is_some()),
                    b(owner.left.is_some()),
                    b(owner.weapon.is_some()),
                    other,
                ]),
            );
            c.done();
            continue;
        }
        wear_cases += 1;
        assert_eq!(c.kind, "wear");
        let damage = c.value(&defs).to_number();
        let script = c.value(&defs);
        let item = c.value(&defs);
        let target = Target {
            spare_gear: c.value(&defs).truthy(),
            ..Default::default()
        };
        let mut rolls = script.items().iter();
        let wear = blow_wear(damage, &mut || {
            rolls
                .next()
                .unwrap_or_else(|| c.fail("unexpected wear roll"))
                .to_number()
        });
        assert!(rolls.next().is_none(), "unconsumed wear rolls");
        c.check_out(
            "wear",
            &Value::Arr(vec![
                Value::Num(wear),
                Value::Num(cws_bill(Some(&target))),
                condition_pct(&item),
            ]),
        );
        c.done();
    }
    assert!(wear_cases >= 2000 && break_cases >= 2000);
}
