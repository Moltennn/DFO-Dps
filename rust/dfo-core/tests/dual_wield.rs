mod common;
use dfo_core::{dual_wield::*, value::Value};

#[test]
fn hands_match_js() {
    let (defs, cases) = common::load_with_defs("dual_wield");
    assert!(cases.len() >= 2000);
    for mut c in cases {
        assert_eq!(c.kind, "hands");
        let args = c.value(&defs);
        let f = |i| args.at(i).to_number();
        let s = |i| args.at(i).as_str().unwrap_or("");
        let n = Value::Num;
        let b = Value::Bool;
        let obj = |rows: Vec<(&str, Value)>| {
            Value::Obj(rows.into_iter().map(|(k, v)| (k.into(), v)).collect())
        };
        let (hold, carry) = off_hand_hold(f(0), f(2), f(1), args.at(3).num_or(0.0));
        let (hand, flurry, off) = strike_hand_of(s(7), s(8), s(9), f(10));
        let sch = dual_schedule(f(1), f(1) * 0.9, f(0));
        c.check_out(
            "hands",
            &Value::Arr(vec![
                n(off_hand_to_hit(f(4))),
                n(off_hand_burden(f(5), f(6))),
                n(off_hand_damage(f(11))),
                n(average_off_hand_hold(f(0), f(2), f(1))),
                obj(vec![("hold", n(hold)), ("carry", n(carry))]),
                obj(vec![
                    ("hand", Value::Str(hand.into())),
                    ("flurry", b(flurry)),
                    ("off", b(off)),
                ]),
                obj(vec![
                    ("mainTicks", n(sch.main_ticks)),
                    ("offTicks", n(sch.off_ticks)),
                    ("hold", n(sch.hold)),
                    ("period", n(sch.period)),
                    ("swingsPerSecond", n(sch.swings_per_second)),
                    ("blowsPerSecondPerHand", n(sch.blows_per_second_per_hand)),
                    ("mainSeconds", n(sch.main_seconds)),
                    ("offSeconds", n(sch.off_seconds)),
                    ("singlePeriod", n(sch.single_period)),
                ]),
                n(swings_ratio(&sch)),
                n(damage_ratio(&sch, 5.5, f(11))),
            ]),
        );
        c.done();
    }
}
