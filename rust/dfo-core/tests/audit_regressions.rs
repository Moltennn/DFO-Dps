mod common;
use dfo_core::cws::roll_magnitude;
use dfo_core::rolls::Rolls;
use dfo_core::simulate_fight::simulate_fight;
use dfo_core::spells::{spells_by_index_map, Spellbook};
use dfo_core::value::Value::{self, Arr, Bool, Null, Num, Obj, Str};

/// A fixed 0.5 roll stream for the magnitude probes.
struct Half;
impl Rolls for Half {
    fn roll(&mut self) -> f64 {
        0.5
    }
}

/// R1: `rollMagnitude` follows the JS chain - `?? 0` on the RAW field, every `+` an ECMAScript `+`, and `-`/`*`/`/`
/// numeric. A string `magnitudePerLevel` must NOT become NaN (`num_or` did: it is `?? d`, not `Number(x)`).
/// The expected values are the live JS (`rollMagnitude(e, 10, () => 0.5)`).
#[test]
fn roll_magnitude_reads_a_string_or_boolean_field_like_the_js() {
    let effect = |low: Value, high: Value, per: Value| {
        Obj(vec![
            ("type".into(), Num(4.0)),
            ("subType".into(), Num(0.0)),
            ("magnitudeBaseLow".into(), low),
            ("magnitudeBaseHigh".into(), high),
            ("magnitudeLevelBase".into(), Num(0.0)),
            ("magnitudeLevelHigh".into(), Num(0.0)),
            ("magnitudePerLevel".into(), per),
        ])
    };
    // `{10, 20, per:"5"}`: 15 (was NaN after the lost-price commit).
    assert_eq!(
        roll_magnitude(
            &effect(Num(10.0), Num(20.0), Str("5".into())),
            10.0,
            &mut Half
        ),
        Num(15.0)
    );
    // `{10, "20"}`: 105 (`'20' + 1` is `'201'`, minus 10 is 191, half is 95, 10 + 95).
    assert_eq!(
        roll_magnitude(
            &effect(Num(10.0), Str("20".into()), Num(1.0)),
            10.0,
            &mut Half
        ),
        Num(105.0)
    );
    // `{"10", 20}`: the JS yields the STRING `'1050'` (`'105' + 0`), not the number 105.
    assert_eq!(
        roll_magnitude(
            &effect(Str("10".into()), Num(20.0), Num(1.0)),
            10.0,
            &mut Half
        ),
        Str("1050".into())
    );
    // `{10, 20, per:true}`: 1; `{true, 20}`: 11; a null per is 1.
    assert_eq!(
        roll_magnitude(&effect(Num(10.0), Num(20.0), Bool(true)), 10.0, &mut Half),
        Num(15.0)
    );
    assert_eq!(
        roll_magnitude(&effect(Bool(true), Num(20.0), Num(1.0)), 10.0, &mut Half),
        Num(11.0)
    );
    assert_eq!(
        roll_magnitude(&effect(Num(10.0), Num(20.0), Null), 10.0, &mut Half),
        Num(15.0)
    );
}

/// The numeric reading of a string magnitude (`roll_magnitude_num`) is what the CWS landing's arithmetic sees, so the
/// string case still bills 1050, not NaN.
#[test]
fn a_string_magnitude_still_bills_its_number() {
    let e = Obj(vec![
        ("type".into(), Num(4.0)),
        ("subType".into(), Num(0.0)),
        ("magnitudeBaseLow".into(), Str("10".into())),
        ("magnitudeBaseHigh".into(), Num(20.0)),
        ("magnitudeLevelBase".into(), Num(0.0)),
        ("magnitudeLevelHigh".into(), Num(0.0)),
        ("magnitudePerLevel".into(), Num(1.0)),
    ]);
    assert_eq!(
        dfo_core::cws::roll_magnitude_num(&e, 10.0, &mut Half),
        1050.0
    );
}

/// P2: `ShortlistOpts::from_value` keeps `k`/`trials` strict (`Number.isSafeInteger`), while `seed`/`maxSeconds`/
/// `maxBlows` are the JS `num(v, d)` coercion. `k: "3"` and `trials: "1000"` must NOT become numbers (the JS throws);
/// `seed: "3"` must be 3 (the JS `num` accepts a numeric string).
#[test]
fn shortlist_options_keep_the_js_integer_guards() {
    use dfo_core::loadout_shortlist::ShortlistOpts;
    let opts = |pairs: Vec<(&str, Value)>| {
        ShortlistOpts::from_value(&Obj(pairs
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect()))
    };
    let strict = opts(vec![
        ("k", Str("3".into())),
        ("trials", Str("1000".into())),
        ("seed", Str("7".into())),
        ("maxSeconds", Str("1".into())),
        ("maxBlows", Str("1".into())),
    ]);
    assert!(strict.k.is_nan(), "a string k is not a safe integer");
    assert!(
        strict.trials.is_nan(),
        "a string trials is not a safe integer"
    );
    assert_eq!(strict.seed, 7.0, "seed is the JS num coercion");
    assert_eq!(strict.max_seconds, 1.0);
    assert_eq!(strict.max_blows, 1.0);
    // Missing keys take the JS defaults.
    let empty = opts(vec![]);
    assert_eq!(empty.k, 0.0);
    assert_eq!(
        empty.trials,
        dfo_core::objectives::MIN_STOCHASTIC_TRIALS as f64
    );
    assert_eq!(empty.seed, 0.0);
    assert_eq!(empty.max_seconds, 900.0);
    assert_eq!(empty.max_blows, 6000.0);
    // A real number keeps its value.
    let numbers = opts(vec![("k", Num(3.0)), ("trials", Num(1000.0))]);
    assert_eq!(numbers.k, 3.0);
    assert_eq!(numbers.trials, 1000.0);
}

fn s(v: &str) -> Value {
    Str(v.into())
}

/// The stock book from the fight/simulate fixtures (the reader's record shapes), so a template-based character prices.
fn book() -> Spellbook {
    // A two-record synthetic book is enough: index 1 damage, index 2 a DoT.
    let mut records = Vec::new();
    for index in [1u32, 2] {
        let mut b = vec![0u8; 0x59];
        b[0] = if index == 2 { 1 } else { 4 }; // DoT health is effect 1; direct is 4
        b[1] = 0;
        b[2] = 0xFF;
        b[3] = 0xFF;
        b[4] = 0xFF;
        b[5] = 0xFF;
        b[6] = 4;
        b[7] = 0;
        b[8..10].copy_from_slice(&12u16.to_le_bytes());
        b[16] = 1;
        b[32] = 20;
        b[33] = 20;
        b[36] = 1;
        b[47..52].copy_from_slice(b"Stock");
        b[73] = index as u8;
        records.push(b);
    }
    spells_by_index_map(dfo_core::spells::read_spells_std(&records.concat()))
}

fn item(template: f64, slot: f64) -> Value {
    Obj(vec![
        ("group".into(), s("Weapons")),
        ("templateIndex".into(), Num(template)),
        ("equipSlot".into(), Num(slot)),
        ("name".into(), s("Blade")),
        ("material".into(), Num(9.0)),
        ("currentCondition".into(), Num(100.0)),
        ("maxCondition".into(), Num(100.0)),
    ])
}

fn target() -> Value {
    Obj(vec![
        ("isPlayer".into(), Bool(false)),
        ("armorValue".into(), Num(0.0)),
        ("health".into(), Num(5000.0)),
        ("maxHealth".into(), Num(5000.0)),
        ("career".into(), Obj(vec![])),
        ("mobileType".into(), Num(1.0)),
        ("activeEffects".into(), Arr(vec![])),
    ])
}

fn fight_ch(worn: Vec<Value>, weapon: Value, off: Value) -> Value {
    let mut ch = Obj(vec![
        ("name".into(), s("T")),
        ("level".into(), Num(40.0)),
        ("raceId".into(), Num(1.0)),
        ("race".into(), s("Breton")),
        ("online".into(), Bool(true)),
        ("health".into(), Num(400.0)),
        ("maxHealth".into(), Num(400.0)),
        ("magicka".into(), Num(40.0)),
        ("maxMagicka".into(), Num(80.0)),
        (
            "stats".into(),
            Obj(vec![
                ("strength".into(), Num(50.0)),
                ("agility".into(), Num(50.0)),
                ("speed".into(), Num(50.0)),
                ("luck".into(), Num(50.0)),
                ("endurance".into(), Num(50.0)),
                ("willpower".into(), Num(50.0)),
            ]),
        ),
        (
            "skills".into(),
            Obj((0..35).map(|i| (i.to_string(), Num(80.0))).collect()),
        ),
        ("career".into(), Obj(vec![])),
        (
            "_mods".into(),
            Obj(vec![
                ("stats".into(), Obj(vec![])),
                ("skills".into(), Obj(vec![])),
            ]),
        ),
        (
            "_enchantMods".into(),
            Obj(vec![("skillMods".into(), Obj(vec![]))]),
        ),
        ("worn".into(), Arr(worn)),
        ("weapon".into(), weapon),
        ("offWeapon".into(), off),
    ]);
    ch.set("masteredSkills", Arr(vec![]));
    ch
}

fn scenario(ch: &Value, durability: bool, extra: &[(&str, Value)]) -> Value {
    let mut args = Obj(vec![
        ("target".into(), target()),
        ("health".into(), Num(5000.0)),
        ("durability".into(), Bool(durability)),
        ("trace".into(), Bool(true)),
        ("seed".into(), Num(1.0)),
        ("maxSeconds".into(), Num(5.0)),
        ("maxBlows".into(), Num(6.0)),
        ("trials".into(), Num(1.0)),
        ("potencyPct".into(), Num(0.0)),
        ("pierce".into(), Num(0.0)),
    ]);
    for (k, v) in extra {
        args.set(k, v.clone());
    }
    let _ = ch;
    args
}

fn potency_of(result: &Value) -> f64 {
    // The card's `cwsPower` is not always printed; read the fight's own trace, whose first blow's CWS rows carry it.
    // `simulateFight` does not return `cwsPower`, so the observable is whether the CWS cast landed at all: a potency
    // of 10 on the ring makes index 1's damage 22 vs 20. The result's `cwsDamage`/`segments` show it.
    result.get("cwsDamage").to_number()
}

/// A2/A: an override weapon whose own `equipSlot` collides with a worn ring's slot must not displace that ring (the JS
/// matches the build's own hand item by identity, never the what-if's minted slot). The ring's potency feeds a CWS cast,
/// so a displaced ring is a visible zero.
#[test]
fn an_override_slot_does_not_displace_a_worn_piece() {
    let sword = item(121.0, 19.0);
    let ring = Obj(vec![
        ("group".into(), s("Jewelry")),
        ("templateIndex".into(), Num(4.0)),
        ("equipSlot".into(), Num(4.0)),
        ("name".into(), s("Ring")),
        ("material".into(), Num(9.0)),
        ("currentCondition".into(), Num(100.0)),
        ("maxCondition".into(), Num(100.0)),
        (
            "affixes".into(),
            Arr(vec![Obj(vec![
                ("id".into(), s("potency")),
                ("value".into(), Num(10.0)),
            ])]),
        ),
    ]);
    let mut weapon = sword.clone();
    // The weapon carries a Cast When Strikes row so a potency difference shows as `cwsDamage`.
    weapon.set(
        "enchantments",
        Arr(vec![Obj(vec![
            ("type".into(), Num(2.0)),
            ("param".into(), Num(1.0)),
        ])]),
    );
    let ch = fight_ch(vec![weapon.clone(), ring.clone()], weapon.clone(), Null);
    let plain = simulate_fight(&ch, &scenario(&ch, true, &[]), &book()).expect("plain fight");
    // The same fight with an override whose own equipSlot is the ring's 4: the JS keeps the ring, so the CWS damage is
    // unchanged; a slot-based match would drop the ring and the cast would be smaller.
    let mut override_item = weapon.clone();
    override_item.set("equipSlot", Num(4.0));
    let mut override_weapon = Obj(vec![]);
    override_weapon.set("item", override_item);
    let with_override = simulate_fight(
        &ch,
        &scenario(&ch, true, &[("weapon", override_weapon)]),
        &book(),
    )
    .expect("override fight");
    assert_eq!(
        potency_of(&plain),
        potency_of(&with_override),
        "the override's equipSlot must not move the ring"
    );
    assert!(potency_of(&plain) > 0.0, "the cast landed");
}
