//! The Forge's gear: build a player item from explicit parts, and preview wearing it in the main hand. Plain data in,
//! plain data out, and **no input is mutated**: the builder answers a new item, and the wear preview answers the
//! character it would leave together with the gear it takes off.
//!
//! The rules are the game's own, reused rather than restated:
//! - the legal line budget is [`crate::gear_profile::validate_plan`] (the `validatePlan` the max profile is checked
//!   with), which reads the vendored `AFFIX_RANGES`, `AFFIX_COUNTS`, `AFFIX_KINDS` and Legendary registry;
//! - the condition is [`crate::durability::mint_condition`] (`mintCondition`, itemTemplates.js:336-350) and the name is
//!   `setItemFields`' `item.name ?? templateByIndex(templateIndex)?.name` (itemTemplates.js:186-187), over the game's
//!   own template-name table;
//! - a Legendary item is the record's own `affixes`, `enchantment` and `name`, exactly the fields `applyRarity` writes
//!   for its `legendary` arm (lootRarity.js:1479-1498), never a player-picked line;
//! - the hand law, the slot and the pieces a wear takes off are [`crate::gear::can_hold_main_hand`] and
//!   `leavers_for` (`characters/equipTable.js:33-126`, `systems/equip.js:251,404-414`); and
//! - the character the wear leaves is `characterFromSave`'s own reads of the worn list and bag (`src/save.js:244-305`):
//!   the main/off hand, `wraps`, `_mods`, `_enchantMods` and `legendaries`, rebuilt by the ported
//!   [`crate::save::rebuild_mods`] and [`crate::save::rebuild_enchant_mods`].
//!
//! The API mints a *player* item, not a loot drop: no rarity roll, no imprint, no optimization. It persists nothing and
//! never writes a game save (a Forge edit acts on a build and returns a new build).

use crate::boot::RriSwitches;
use crate::durability::mint_condition;
use crate::gear::{can_hold_main_hand, leavers_for, table_of_worn, Ctx};
use crate::gear_profile::{legendaries_for, validate_plan};
use crate::generated::data::WEAPONS;
use crate::generated::enchant_data::ITEM_ENCHANTMENT_NAMES;
use crate::generated::item_facts::HAND_WRAPS_TEMPLATE;
use crate::generated::paperdoll::EQUIP_SLOTS;
use crate::save::{rebuild_enchant_mods, rebuild_mods};
use crate::value::{
    number_to_string,
    Value::{self, Arr, Null, Num, Obj, Str},
};

fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    let mut out = Obj(vec![]);
    for (key, value) in pairs {
        out.set(key, value);
    }
    out
}

fn s(text: &str) -> Value {
    Str(text.to_owned())
}

fn str_at(map: &'static [(i64, &'static str)], key: f64) -> Option<&'static str> {
    map.iter().find(|(k, _)| *k as f64 == key).map(|(_, v)| *v)
}

// ─── (1) BUILD AN ITEM ─────────────────────────────────────────────

/// What a player item is built from: a template, a material, and either a rarity with its lines or a Legendary record
/// id. It is the same shape [`crate::gear_profile::validate_plan`] checks, so a GUI can show a refusal beside the fields
/// that caused it.
#[derive(Debug, Clone, PartialEq)]
pub struct GearSpec {
    /// `templateIndex`: a `WEAPONS` row for a weapon, 102..=112 for armour (109..=112 are shields), 133..=139 for
    /// jewellery, or a clothing template (the `SLOT_RULES` rows).
    pub template: f64,
    /// The game's material id: 0..=9 on the weapon ladder, DFU's raw armour value (0 leather, 0x0100 chain, 0x0200+
    /// plate), or 0 for jewellery and clothing.
    pub material: f64,
    /// `magic` or `rare` for explicit lines, `legendary` with a `record`; anything else is refused by the validator.
    pub rarity: String,
    /// The lines the piece carries, in the player's order: `{ id, param?, value }` records. Ignored for a Legendary
    /// (its record owns the lines).
    pub lines: Vec<Value>,
    /// The Legendary record id, when `rarity` is `legendary`.
    pub record: Option<String>,
}

impl GearSpec {
    /// A Magic or Rare piece: its template, material, rarity and the lines it carries.
    pub fn lines_of(template: f64, material: f64, rarity: &str, lines: Vec<Value>) -> GearSpec {
        GearSpec {
            template,
            material,
            rarity: rarity.to_owned(),
            lines,
            record: None,
        }
    }

    /// A Legendary piece of a record: its fixed lines and enchantment are the record's own.
    pub fn legendary(template: f64, material: f64, record: &str) -> GearSpec {
        GearSpec {
            template,
            material,
            rarity: "legendary".to_owned(),
            lines: Vec::new(),
            record: Some(record.to_owned()),
        }
    }

    /// Read the spec a GUI holds as a record: `{ template, material, rarity, lines?, record? }`.
    pub fn from_value(v: &Value) -> Result<GearSpec, GearFault> {
        if !matches!(v, Obj(_)) {
            return Err(GearFault::Spec("a gear spec must be an object".to_owned()));
        }
        let template = match v.get("template") {
            Num(n) if n.is_finite() => *n,
            _ => {
                return Err(GearFault::Spec(
                    "the spec needs a numeric template".to_owned(),
                ))
            }
        };
        let material = match v.get("material") {
            Num(n) if n.is_finite() => *n,
            _ => {
                return Err(GearFault::Spec(
                    "the spec needs a numeric material".to_owned(),
                ))
            }
        };
        let Some(rarity) = v.get("rarity").as_str() else {
            return Err(GearFault::Spec("the spec needs a rarity".to_owned()));
        };
        let lines: Vec<Value> = match v.get("lines") {
            Value::Undefined | Null => Vec::new(),
            Value::Arr(items) => {
                if let Some(bad) = items.iter().find(|a| !matches!(a, Obj(_))) {
                    return Err(GearFault::Spec(format!(
                        "a line must be a record, not {}",
                        bad.to_js_string()
                    )));
                }
                items.clone()
            }
            other => {
                return Err(GearFault::Spec(format!(
                    "lines must be a list, not {}",
                    other.to_js_string()
                )))
            }
        };
        Ok(GearSpec {
            template,
            material,
            rarity: rarity.to_owned(),
            lines,
            record: v.get("record").as_str().map(str::to_owned),
        })
    }
}

/// Why an item cannot be built or worn.
#[derive(Debug, Clone, PartialEq)]
pub enum GearFault {
    /// The value is not a gear spec at all (not an object, no numeric template, no rarity).
    Spec(String),
    /// The template is not one the game's own slot tables hold.
    UnknownTemplate(f64),
    /// The lines are not legal for this piece: [`crate::gear_profile::validate_plan`]'s sentences, unchanged.
    Illegal(Vec<String>),
    /// A Legendary record id that does not fit this template and group.
    UnknownRecord(String),
    /// The piece cannot be worn in the main hand: its hands are none, or only the left one.
    NotMainHand,
    /// The character carries no `worn` list to wear a piece on.
    NoWornList,
}

impl GearFault {
    /// A one-line reason a player can read.
    pub fn message(&self) -> String {
        match self {
            GearFault::Spec(why) => why.clone(),
            GearFault::UnknownTemplate(t) => format!("no item template {}", number_to_string(*t)),
            GearFault::Illegal(bad) => bad.join("; "),
            GearFault::UnknownRecord(id) => format!("no Legendary record \"{id}\" fits this piece"),
            GearFault::NotMainHand => "that piece cannot be held in the main hand".to_owned(),
            GearFault::NoWornList => {
                "the character carries no worn list, so nothing can be worn".to_owned()
            }
        }
    }
}

/// The group a template is built as, read from the game's own tables: a `WEAPONS` row is `Weapons`, a
/// `SLOT_RULES.jewellery` row is `Jewellery`, the armour rows are `Armor`, and the rest of the slot rules are the two
/// clothing groups. `None` for a template no table names — including a fractional one, which names no row
/// (`102.5 as i64` used to truncate onto armour 102).
fn group_of(template: f64) -> Option<&'static str> {
    if template.trunc() != template {
        return None;
    }
    if WEAPONS.iter().any(|(k, _)| *k as f64 == template) {
        return Some("Weapons");
    }
    let t = template as i64;
    let rules = &crate::generated::equip_rules::SLOT_RULES;
    if rules.jewellery.iter().any(|(k, _)| *k == t) {
        return Some("Jewellery");
    }
    if rules.armor.iter().any(|(k, _)| *k == t) {
        return Some("Armor");
    }
    if rules.mens_clothing.iter().any(|(k, _)| *k == t) {
        return Some("MensClothing");
    }
    if rules.womens_clothing.iter().any(|(k, _)| *k == t) {
        return Some("WomensClothing");
    }
    None
}

/// `templateByIndex(templateIndex)?.name` (itemTemplates.js:187), from the game's own template-name table.
fn template_name(template: f64) -> Option<&'static str> {
    str_at(ITEM_ENCHANTMENT_NAMES, template)
}

/// The Forge's own strictness over a spec, checked in [`build_item`] only. `validatePlan` is a max-profile checker: it
/// compares each line's value against the band's TOP and trusts the record it is handed, and it never asks whether a
/// template is whole or a material is one the item's group has. That is enough for a plan the game would have rolled and
/// not enough for a record a GUI sends, so this adds the rest: a whole-number template, a material the group's ladder
/// holds, and lines that are records with a finite, positive value. Every sentence here is the Forge's, not the JS's
/// (the JS would mint these records); `rust/FORGE-API.md` lists exactly what is and is not added.
fn strict_spec(spec: &GearSpec, group: &str) -> Vec<String> {
    let mut bad = Vec::new();
    let t = number_to_string(spec.template);
    if spec.template.trunc() != spec.template {
        bad.push(format!("{t}: a template is a whole number"));
    }
    if !material_fits(group, spec.material) {
        bad.push(format!(
            "{t}: material {} is not one a {group} piece takes",
            number_to_string(spec.material)
        ));
    }
    if spec.rarity == "legendary" {
        // A Legendary's lines are its record's own; only the record check (`legendaries_for`) judges them.
        return bad;
    }
    for a in &spec.lines {
        if !matches!(a, Obj(_)) {
            bad.push(format!("{t}: a line must be a record"));
            continue;
        }
        let id = a.get("id").to_js_string();
        let value = a.get("value");
        if !matches!(value, Num(n) if n.is_finite()) {
            bad.push(format!(
                "{t}: {id} {} is not a number",
                value.to_js_string()
            ));
            continue;
        }
        // Every generated band starts at 1, so a zero or negative line is not one the game rolled. The band's FLOOR and
        // the kind's `groups` are deliberately NOT enforced: the golden corpus prices lines the JS mints below a floor
        // and an armour line on clothing, so refusing them would break JS parity (see `rust/FORGE-API.md`). A GUI offers
        // only the kinds a slot rolls, from the affix registry.
        if value.to_number() < 1.0 {
            bad.push(format!(
                "{t}: {id} {} is not a positive line",
                value.to_js_string()
            ));
        }
    }
    bad
}

/// Whether a material is one the group's own ladder holds (`systems/armorMaterials.js`): the weapon metal 0..=9, an
/// armour material (leather, chain, chain2, plate iron..daedric), or 0 for jewellery and clothing.
fn material_fits(group: &str, material: f64) -> bool {
    use crate::generated::armor_materials::ARMOR_MATERIAL as A;
    if material.trunc() != material {
        return false;
    }
    match group {
        "Weapons" => (0.0..=9.0).contains(&material),
        "Armor" => {
            material == A.leather
                || material == A.chain
                || material == A.chain2
                || (A.iron..=A.daedric).contains(&material)
        }
        _ => material == 0.0,
    }
}

/// (1) Build a player item (a NEW `Value`; nothing is mutated).
///
/// The piece is checked by [`crate::gear_profile::validate_plan`] with this one piece, exactly as a max-profile plan is,
/// so a Rare's line count and bands, a Magic's, and a Legendary's fixed record are the game's own limits. A legal Magic
/// or Rare item is `setItemFields`' record (its group, template, material, rarity, lines and name) plus
/// [`mint_condition`]'s condition; a legal Legendary is `applyRarity`'s (the record's name, lines and enchantment).
/// The trade `value` is not computed: no battle reads it, and it needs the template price tables.
pub fn build_item(spec: &GearSpec) -> Result<Value, GearFault> {
    let group = group_of(spec.template).ok_or(GearFault::UnknownTemplate(spec.template))?;
    legal(Arr(strict_spec(spec, group)
        .into_iter()
        .map(|m| s(&m))
        .collect()))?;
    if spec.rarity == "legendary" {
        let id = spec.record.as_deref().unwrap_or("");
        let record = legendaries_for(&Num(spec.template), &s(group))
            .into_iter()
            .find(|r| r.get("id").is_str(id))
            .ok_or_else(|| GearFault::UnknownRecord(id.to_owned()))?;
        let mut lines: Vec<Value> = Vec::new();
        for a in record.get("affixes").items() {
            if !a.get("id").is_str("gem") {
                lines.push(a.clone());
            }
        }
        legal(validate_plan(&Arr(vec![obj([
            ("template", Num(spec.template)),
            ("group", s(group)),
            ("rarity", s("legendary")),
            ("record", s(id)),
            ("lines", Arr(lines.clone())),
        ])])))?;
        // `applyRarity`'s assignment order: the record's mark and name, then its tier, lines, enchantment and price.
        let mut out = obj([
            ("group", s(group)),
            ("templateIndex", Num(spec.template)),
            ("material", Num(cloth_material(spec))),
            ("legendary", s(id)),
            (
                "name",
                s(record
                    .get("name")
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .unwrap_or(id)),
            ),
            ("rarity", s("legendary")),
            ("affixes", Arr(lines)),
        ]);
        let enchantment = record.get("enchantment");
        if matches!(enchantment, Obj(_)) {
            out.set(
                "enchantments",
                Arr(vec![obj([
                    ("type", enchantment.get("type").clone()),
                    ("param", enchantment.get("param").clone()),
                ])]),
            );
        }
        mint_condition(&mut out);
        return Ok(out);
    }
    legal(validate_plan(&Arr(vec![obj([
        ("template", Num(spec.template)),
        ("group", s(group)),
        ("rarity", s(&spec.rarity)),
        ("lines", Arr(spec.lines.clone())),
    ])])))?;
    // `setItemFields`' record: the item spread, its name, then `mintCondition`'s two fields.
    let material = cloth_material(spec);
    let mut out = obj([
        ("group", s(group)),
        ("templateIndex", Num(spec.template)),
        ("material", Num(material)),
        ("rarity", s(&spec.rarity)),
        ("affixes", Arr(spec.lines.clone())),
        // `item.name ?? templateByIndex(...)?.name`: a template the name table does not hold leaves `undefined`.
        (
            "name",
            template_name(spec.template).map_or(Value::Undefined, s),
        ),
    ]);
    mint_condition(&mut out);
    Ok(out)
}

/// `setItemFields` folds a Hand Wraps piece to cloth (`named.material = 0`, itemTemplates.js:189).
fn cloth_material(spec: &GearSpec) -> f64 {
    if spec.template == HAND_WRAPS_TEMPLATE {
        0.0
    } else {
        spec.material
    }
}

/// `validatePlan`'s sentences as a [`GearFault::Illegal`], or nothing when the plan is legal.
fn legal(bad: Value) -> Result<(), GearFault> {
    if bad.items().is_empty() {
        return Ok(());
    }
    Err(GearFault::Illegal(
        bad.items()
            .iter()
            .map(Value::to_js_string)
            .collect::<Vec<_>>(),
    ))
}

/// Whether a `Value` item can be worn in the main hand under the shipped boot: the hand law lets it be held right
/// (`Either`, `RightOnly` or `Both`). A GUI can grey a shield out with it.
pub fn can_wear_main_hand(item: &Value) -> bool {
    can_hold_main_hand(item, &shipped_ctx())
}

fn shipped_ctx() -> Ctx {
    Ctx {
        rri: RriSwitches::shipped(),
        bow_left_hand: false,
    }
}

// ─── (2) A MAIN-HAND WEAR ──────────────────────────────────────────

/// What a main-hand wear would do: the character it leaves, and the pieces it takes off. Both are new values; the item
/// and the input character are never mutated.
#[derive(Debug, Clone, PartialEq)]
pub struct EquipPreview {
    /// The character after the wear: its bag and worn list, main and off hand, `wraps`, the gear fold and
    /// `legendaries`, answered as `characterFromSave` reads them.
    pub character: Value,
    /// The displaced pieces (each without an `equipSlot`, as `unequipSlot` leaves it), in `wearLeavers`' order.
    pub displaced: Vec<Value>,
    /// The `equipSlot` the item was worn in (`EQUIP_SLOTS.right_hand` for a main-hand wear).
    pub slot: f64,
}

/// (2) Preview wearing `item` in the main hand.
///
/// The hand law decides first: [`crate::gear::can_hold_main_hand`] must let the piece be held right (`Either`,
/// `RightOnly` or `Both`); a shield's `LeftOnly` is [`GearFault::NotMainHand`]. The wear then takes off exactly
/// `wearLeavers`' pieces (`systems/equip.js:404-414`): a two-hander clears both hands, a shield bumps a held
/// two-hander, and the destination's occupant swaps out. Each leaver loses its `equipSlot` (`unequipSlot`, :120-126),
/// and the arrival joins the bag and the worn list with its new mark (`equipItem`, :249-284).
///
/// The character is rebuilt as `characterFromSave` reads the new list (`src/save.js:260-305`): `worn`, `items`,
/// `weapon`, `offWeapon`, `wraps`, `_mods`' gear channels, `_enchantMods` and `legendaries`. The gear channels are a
/// DELTA on the character's existing `_mods`, so a Firmament already folded in survives — the game re-runs every fold
/// on an equip change (`systems/entityMods.js:179-196`), and a re-fold of the gear beside what the character already
/// carries answers the same numbers.
///
/// The boot is the shipped one ([`crate::boot::Boot::shipped`]'s Roleplay & Realism switches, and a bow in both hands),
/// which is the hand law [`can_wear_main_hand`] answers with.
pub fn preview_equip_main_hand(character: &Value, item: &Value) -> Result<EquipPreview, GearFault> {
    let worn_value = character.get("worn");
    if !matches!(worn_value, Arr(_)) {
        return Err(GearFault::NoWornList);
    }
    let ctx = shipped_ctx();
    if !can_hold_main_hand(item, &ctx) {
        return Err(GearFault::NotMainHand);
    }
    let old_worn: Vec<Value> = worn_value.items().to_vec();
    let table = table_of_worn(&old_worn);
    // `equipItem`'s hand drop computes the slot ONCE (systems/equip.js:251): a `RightHand` argument the hand law admits
    // is the slot, whatever `getEquipSlot` would pick for an empty table.
    let slot = EQUIP_SLOTS.right_hand;
    let leavers = leavers_for(&table, item, slot, &ctx);
    let mut next_worn: Vec<Value> = Vec::new();
    let mut displaced: Vec<Value> = Vec::new();
    // The wearer takes the leavers off in `wearLeavers`' order (`unequipSlot` per slot, systems/equip.js:272-275), so
    // the displaced list is that order, not the worn list's. A slot listed twice (a two-hander's own hand) takes its
    // occupant once: the second pass finds the slot already empty.
    let mut taken: Vec<usize> = Vec::new();
    for slot_id in &leavers {
        let Some(i) = index_of_slot_id(*slot_id) else {
            continue;
        };
        let found = old_worn
            .iter()
            .enumerate()
            .find(|(at, e)| index_of_slot(e) == Some(i) && !taken.contains(at));
        if let Some((at, entry)) = found {
            displaced.push(without_key(entry, "equipSlot"));
            taken.push(at);
        }
    }
    for (at, entry) in old_worn.iter().enumerate() {
        if !taken.contains(&at) {
            next_worn.push(entry.clone());
        }
    }
    let mut worn_item = item.clone();
    if matches!(worn_item, Obj(_)) {
        worn_item.set("equipSlot", Num(slot));
    }
    next_worn.push(worn_item.clone());
    // Items stay in the bag and carry `equipSlot` when worn (`systems/equip.js:9-12`). The bag holds the same objects
    // as the worn list, so a leaver's mark is cleared there too (`unequipSlot`'s `delete item.equipSlot`); a `Value`
    // carries no identity, so the match is by value.
    let taken_items: Vec<Value> = taken.iter().map(|at| old_worn[*at].clone()).collect();
    let mut bag: Vec<Value> = character
        .get("items")
        .items()
        .iter()
        .map(|it| {
            if taken_items.iter().any(|t| t == it) {
                without_key(it, "equipSlot")
            } else {
                it.clone()
            }
        })
        .collect();
    bag.push(worn_item);
    let character = rebuild_character(character, &old_worn, next_worn, bag);
    Ok(EquipPreview {
        character,
        displaced,
        slot,
    })
}

/// An object without one key (the JS `delete item.equipSlot`).
fn without_key(v: &Value, key: &str) -> Value {
    Value::Obj(
        v.entries()
            .iter()
            .filter(|(k, _)| k != key)
            .cloned()
            .collect(),
    )
}

/// The slot an entry's `equipSlot` names, when it names a real one (`Number.isInteger` and inside the table).
fn index_of_slot(item: &Value) -> Option<usize> {
    slot_number(item.get("equipSlot"))
}

/// A `wearLeavers` slot id as a table index, when it names a real slot.
fn index_of_slot_id(slot: f64) -> Option<usize> {
    slot_number(&Num(slot))
}

/// The table index a JS slot value names: a finite integer in `0..27` (`createEquipTable`'s own slots). Anything else
/// (a null-ish slot, a fraction, a slot outside the table, NaN) names none.
fn slot_number(v: &Value) -> Option<usize> {
    match v {
        Num(n) if (0.0..27.0).contains(n) && n.trunc() == *n => Some(*n as usize),
        _ => None,
    }
}

/// `old + (after - before)` for one channel, over the keys `old` and the two folds carry: a fold re-run beside what
/// `_mods` already holds. A channel that lands on exactly 0 and is absent from `after` is dropped: the JS fold keeps a
/// stale 0 key, but every reader is `?? 0`, so the two are the same number and the record a fresh `characterFromSave`
/// builds is the one a GUI can compare.
fn refold(old: &Value, before: &Value, after: &Value) -> Value {
    let mut keys: Vec<String> = Vec::new();
    for source in [old, before, after] {
        for (k, _) in source.entries() {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
    }
    let mut out = Obj(vec![]);
    for k in keys {
        let was = old.get(&k).num_or(0.0);
        let from = before.get(&k).num_or(0.0);
        let to = after.get(&k).num_or(0.0);
        let value = was - from + to;
        if value == 0.0 && !after.has(&k) {
            continue;
        }
        out.set(&k, Num(value));
    }
    out
}

/// `characterFromSave`'s reads of the worn list and bag (`src/save.js:260-305`), applied to an existing character. The
/// gear channels are deltas (see [`preview_equip_main_hand`]); every other field is `characterFromSave`'s own read.
fn rebuild_character(
    character: &Value,
    old_worn: &[Value],
    worn: Vec<Value>,
    bag: Vec<Value>,
) -> Value {
    let worn_value = Arr(worn.clone());
    let mut ch = character.clone();
    ch.set("worn", worn_value.clone());
    ch.set("items", Arr(bag));
    let before = rebuild_mods(&Arr(old_worn.to_vec()));
    let after = rebuild_mods(&worn_value);
    let mut mods = ch.get("_mods").clone();
    if !matches!(mods, Obj(_)) {
        mods = Obj(vec![]);
    }
    mods.set(
        "stats",
        refold(mods.get("stats"), before.get("stats"), after.get("stats")),
    );
    mods.set(
        "skills",
        refold(
            mods.get("skills"),
            before.get("skills"),
            after.get("skills"),
        ),
    );
    ch.set("_mods", mods);
    ch.set("weaponDamagePct", after.get("weaponDamagePct").clone());
    ch.set("slayer", after.get("slayer").clone());
    // `onEquipChange` re-folds `_enchantMods` the same way (`systems/enchantments.js:1336-1338`); the other fields (a
    // live `maxMagicka`, the armour pair) are the character's own and are kept.
    let before_ench = rebuild_enchant_mods(&Arr(old_worn.to_vec()));
    let after_ench = rebuild_enchant_mods(&worn_value);
    let mut ench = ch.get("_enchantMods").clone();
    if matches!(ench, Obj(_)) {
        ench.set(
            "skillMods",
            refold(
                ench.get("skillMods"),
                before_ench.get("skillMods"),
                after_ench.get("skillMods"),
            ),
        );
    } else {
        ench = after_ench;
    }
    ch.set("_enchantMods", ench);
    let wraps_template = 563.0;
    let is_weapon = |it: &Value| {
        it.get("group").is_str("Weapons") && it.get("templateIndex").to_number() != wraps_template
    };
    let right = worn
        .iter()
        .find(|it| is_weapon(it) && it.get("equipSlot").strict_eq(&Num(EQUIP_SLOTS.right_hand)))
        .or_else(|| {
            worn.iter().find(|it| {
                is_weapon(it) && it.get("equipSlot").strict_eq(&Num(EQUIP_SLOTS.left_hand))
            })
        });
    let off = worn.iter().find(|it| {
        Some(*it) != right
            && is_weapon(it)
            && (it.get("equipSlot").strict_eq(&Num(EQUIP_SLOTS.left_hand))
                || it.get("equipSlot").strict_eq(&Num(EQUIP_SLOTS.right_hand)))
    });
    ch.set("weapon", right.cloned().unwrap_or(Null));
    ch.set("offWeapon", off.cloned().unwrap_or(Null));
    ch.set(
        "wraps",
        worn.iter()
            .find(|it| {
                it.get("group").is_str("Weapons")
                    && it.get("templateIndex").strict_eq(&Num(wraps_template))
            })
            .cloned()
            .unwrap_or(Null),
    );
    ch.set(
        "legendaries",
        Arr(worn
            .iter()
            .filter(|it| it.get("legendary").truthy())
            .map(|it| {
                obj([
                    ("id", it.get("legendary").clone()),
                    ("name", it.get("name").clone()),
                ])
            })
            .collect()),
    );
    ch
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(template: f64, material: f64, rarity: &str, lines: Vec<Value>) -> GearSpec {
        GearSpec::lines_of(template, material, rarity, lines)
    }

    fn line(id: &str, param: Option<&str>, value: f64) -> Value {
        let mut a = obj([("id", s(id)), ("value", Num(value))]);
        if let Some(p) = param {
            a.set("param", s(p));
        }
        a
    }

    #[test]
    fn a_legal_rare_is_the_game_mint() {
        let item = build_item(&spec(123.0, 9.0, "rare", vec![line("damage", None, 25.0)])).unwrap();
        // `setItemFields` + `mintCondition`: Daedric Dai-katana at 12800 condition.
        assert_eq!(item.get("group"), &s("Weapons"));
        assert_eq!(item.get("name"), &s("Dai-katana"));
        assert_eq!(item.get("rarity"), &s("rare"));
        assert_eq!(item.get("maxCondition"), &Num(12800.0));
        assert_eq!(item.get("currentCondition"), &Num(12800.0));
        assert_eq!(item.get("affixes").items().len(), 1);
    }

    #[test]
    fn an_illegal_line_is_the_validator_sentence() {
        let err = build_item(&spec(124.0, 0.0, "rare", vec![line("damage", None, 26.0)]))
            .expect_err("above the band");
        match err {
            GearFault::Illegal(bad) => {
                assert!(bad[0].contains("above the rare band"), "{bad:?}");
            }
            other => panic!("expected Illegal, got {other:?}"),
        }
        let err = build_item(&spec(
            124.0,
            0.0,
            "magic",
            vec![
                line("damage", None, 12.0),
                line("stat", Some("strength"), 5.0),
                line("skill", Some("34"), 10.0),
            ],
        ))
        .expect_err("too many lines");
        assert!(matches!(err, GearFault::Illegal(_)));
    }

    #[test]
    fn an_unknown_template_and_record_are_refused() {
        assert_eq!(
            build_item(&spec(999.0, 0.0, "rare", vec![])).unwrap_err(),
            GearFault::UnknownTemplate(999.0)
        );
        assert_eq!(
            build_item(&GearSpec::legendary(123.0, 9.0, "the-warden")).unwrap_err(),
            GearFault::UnknownRecord("the-warden".to_owned())
        );
    }

    #[test]
    fn a_legendary_is_its_record() {
        let item = build_item(&GearSpec::legendary(123.0, 9.0, "wyrmbane")).unwrap();
        assert_eq!(item.get("legendary"), &s("wyrmbane"));
        assert_eq!(item.get("name"), &s("Wyrmbane"));
        assert_eq!(item.get("rarity"), &s("legendary"));
        assert_eq!(item.get("affixes").items().len(), 3);
        assert_eq!(item.get("enchantments").items().len(), 1);
    }

    #[test]
    fn hands_decide_the_main_hand() {
        let blade = obj([("group", s("Weapons")), ("templateIndex", Num(123.0))]);
        assert!(can_wear_main_hand(&blade));
        let shield = obj([("group", s("Armor")), ("templateIndex", Num(112.0))]);
        assert!(!can_wear_main_hand(&shield));
    }

    #[test]
    fn a_fractional_worn_mark_never_holds_a_slot() {
        // LOCAL INVARIANT for a hand-made character (a save's builder keeps integer marks only): a worn entry whose mark
        // is 19.5 occupies no table slot, so a main-hand wear displaces the piece really at 19 and leaves 19.5 worn
        // (`createEquipTable` sets `slots['19.5']`, never `slots[19]`).
        let mut fractional = obj([("group", s("Weapons")), ("templateIndex", Num(118.0))]);
        fractional.set("equipSlot", Num(19.5));
        let mut real = obj([("group", s("Weapons")), ("templateIndex", Num(121.0))]);
        real.set("equipSlot", Num(19.0));
        let mut ch = obj([
            ("worn", Arr(vec![fractional.clone(), real.clone()])),
            ("items", Arr(vec![fractional.clone(), real.clone()])),
        ]);
        ch.set(
            "_mods",
            obj([("stats", Obj(vec![])), ("skills", Obj(vec![]))]),
        );
        let mace = obj([("group", s("Weapons")), ("templateIndex", Num(124.0))]);
        let preview = preview_equip_main_hand(&ch, &mace).expect("a mace is a main-hand piece");
        assert_eq!(preview.displaced, vec![without_key(&real, "equipSlot")]);
        assert!(preview
            .character
            .get("worn")
            .items()
            .iter()
            .any(|it| it.get("equipSlot").strict_eq(&Num(19.5))));
        // A slot id cannot be a fraction either (`wearLeavers` answers whole slot ids by construction).
        assert_eq!(index_of_slot_id(19.5), None);
    }
}
