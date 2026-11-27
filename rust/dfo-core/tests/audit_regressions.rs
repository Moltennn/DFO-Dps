mod common;
use dfo_core::simulate_fight::simulate_fight;
use dfo_core::spells::{spells_by_index_map, Spellbook};
use dfo_core::value::Value::{self, Arr, Bool, Null, Num, Obj, Str};

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
