//! The enemy's gear: the rolls and the placement behind `gearEnemy` (src/target.js:555-567) (milestone R3b).
//!
//! Ported arms (JS file:line in each function's doc):
//! - the classic loadout, `rollEnemyEquipment` (combat/enemyEquipment.js:238-276) and `assignEnemyEquipment` (:228);
//! - the Roleplay & Realism enemy arm the Enemy Expansion delegate runs, `assignRriEnemyEquipment` (combat/
//!   rriEnemyEquipment.js:240-425), with the copy's reads of the DEX table (systems/enemyExpansion/dexEquipment.js),
//!   `convertOrcish` (rriEnemyEquipment.js:434-466, the armour and the weapons it changes), and the poisoned-weapon
//!   roll (systems/poisons.js:250-263);
//! - the equip table the arm places pieces with: `getItemHands`, `createEquipTable().getEquipSlot`, `wearLeavers`
//!   (characters/equipTable.js:33-129; systems/equip.js:404-414).
//!
//! The item a piece becomes in the target (`armourPiece`, target.js:489-494, which re-mints each piece through
//! `armorOfMaterial`) is [`mint_armour`]: the template's hit points by the plate ladder, and the custom class's chain
//! fold. Every roll is an explicit [`Rolls`] argument, in the order the JS draws it.
//!
//! Not ported (provably unobservable on the target path; the reason is beside each): `markFound` (foundMark.js, a mark
//! on the piece, not in the target), the item values and names (`setItemFields`'s `value`/`name`), the weapons' own
//! condition (`wornCondition`'s draw is ported, its result is not read), the arrow pile of an archer (its draws are
//! ported, the item is in `items` only, never worn), the loot `items` list, and `equipmentItems`.

use crate::boot::{Boot, RriSwitches};
use crate::generated::armor_materials::ARMOR_MATERIAL as AM;
use crate::generated::create_item_rows::MENS_PLAIN_ROBES;
use crate::generated::dex_equipment::DEX_EQUIPMENT_TABLE;
use crate::generated::enemy_entity::KNIGHT_CITYWATCH_ID;
use crate::generated::enemy_equipment::{ARMOR_ENUM, MATERIALS_BY_MODIFIER, WEAPONS_ENUM};
use crate::generated::equip::EQUIP_SLOT_NAMES;
use crate::generated::equip_rules::{SHIELD_INDICES, SLOT_RULES, WEAPON_HANDS};
use crate::generated::item_templates::ITEM_TEMPLATE_FACTS;
use crate::generated::mobile_types::MOBILE_TYPES as MT;
use crate::generated::paperdoll::EQUIP_SLOTS;
use crate::generated::poisons::POISON_START_VALUE;
use crate::generated::weapons::{CONDITION_MULTIPLIERS_BY_MATERIAL, WEAPON_MATERIALS as WM};
use crate::rolls::Rolls;
use crate::round::{js_max, js_min, to_int32, to_uint32, trunc};
use crate::target::{Career, Item, Target};
use crate::vendored::{custom_item_class, enemy_armor_values_with, ArmourPieceRef};

/// `ITEM_GROUPS` values the arms branch on (equipRules.js:12-43).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    /// `ItemGroups.Weapons` (3).
    Weapons,
    /// `ItemGroups.Armor` (2).
    Armor,
    /// `ItemGroups.MensClothing` (6).
    MensClothing,
    /// `ItemGroups.WomensClothing` (12).
    WomensClothing,
}

/// A minted piece as the arms carry it: its group, template and material. Weapons carry no condition here (their
/// condition is never read, see the module doc).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Piece {
    pub group: Group,
    pub template: f64,
    pub material: f64,
}

/// A left-hand item: a shield the classic loadout holds as a bare marker (`{ templateIndex, shield: true }`), or a
/// minted item (a weapon, or an armour shield of the arm).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hand {
    Shield(f64),
    Item(Piece),
}

/// One armour piece as the loadout lists it (`armorPieces`): its template, material, and whether it is a shield.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PieceRef {
    pub piece: f64,
    pub material: f64,
    pub shield: bool,
}

/// What an arm answers (`{ rightHand, leftHand, armorPieces, armorValues }`, plus the poisoned right hand's type).
#[derive(Debug, Clone, PartialEq)]
pub struct GearOut {
    pub right: Option<Piece>,
    pub left: Option<Hand>,
    pub armor_pieces: Vec<PieceRef>,
    pub armor_values: [f64; 7],
    /// `rightHand.poisonType` (the poison roll of a monster's weapon), `None` when no poison was rolled.
    pub poison: Option<f64>,
}

/// The entity the arms read: the target as `gearEnemy` spreads it (target.js:559, `{ ...target, armor }`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Entity {
    /// `mobileType`.
    pub mobile_type: Option<f64>,
    /// `isClass` (truthiness).
    pub is_class: bool,
    /// `level` (the class arm's item level; `None` falls to the player level).
    pub level: Option<f64>,
    /// `armor` (`armorValues[0] ?? 0`): a monster's cap on the seven values.
    pub armor: f64,
    /// `career` (the DEX copy reads its forbidden armour).
    pub career: Option<Career>,
    /// `basics.team` (the mint row's team; `convertOrcish` reads it).
    pub team: Option<&'static str>,
}

/// `ARROW_TEMPLATE` (systems/inventory.js:142, `WEAPONS.Arrow`): 131 (`ARROW_TEMPLATE_INDEX`, scenes/corpseMarker.js:29).
/// The arm draws a roll for the arrow pile only when a template is this one, so the vectors check it.
const ARROW_TEMPLATE: f64 = 131.0;

fn weapon(name: &str) -> f64 {
    WEAPONS_ENUM
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(f64::NAN, |(_, v)| *v)
}

fn slot_named(name: &str) -> f64 {
    EQUIP_SLOT_NAMES
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(EQUIP_SLOTS.none, |(_, id)| *id)
}

/// `Math.floor(rolls() * 100) < chance` (formulas.js:51).
fn dice100(chance: f64, roll: f64) -> bool {
    (roll * 100.0).floor() < chance
}

/// The classic enemy equipment's `range(lo, hi)` (enemyEquipment.js:239): `lo..=hi`, both ends counted.
fn range_incl(r: &mut dyn Rolls, lo: f64, hi: f64) -> f64 {
    lo + (r.roll() * (hi + 1.0 - lo)).floor()
}

/// The Roleplay & Realism arm's `range(rolls, lo, hi)` (rriEnemyEquipment.js:78): `lo..hi`, `hi` not counted.
fn range_excl(r: &mut dyn Rolls, lo: f64, hi: f64) -> f64 {
    lo + (r.roll() * (hi - lo)).floor()
}

/// `randomMaterial(playerLevel, rolls)` (enemyEquipment.js:100-112): one roll, then the metal the ladder lands on. The
/// formula override registry (`formulaOverride`, combat/formulas.js) is empty on this path: no mod registers one.
pub fn random_material(player_level: f64, r: &mut dyn Rolls) -> f64 {
    let mut level_mod = player_level - 10.0;
    level_mod *= if level_mod >= 0.0 { 2.0 } else { 4.0 };
    let random_mod = (r.roll() * 256.0).floor();
    let mut combined = js_max(0.0, js_min(256.0, level_mod + random_mod));
    let mut material = 0usize;
    while material < MATERIALS_BY_MODIFIER.len() && MATERIALS_BY_MODIFIER[material] < combined {
        combined -= MATERIALS_BY_MODIFIER[material];
        material += 1;
    }
    material as f64
}

/// `randomArmorMaterial(playerLevel, rolls)` (enemyEquipment.js:116-125): leather, chain, or plate (the metal is one
/// more `randomMaterial` roll).
pub fn random_armor_material(player_level: f64, r: &mut dyn Rolls) -> f64 {
    let roll = 1.0 + (r.roll() * 100.0).floor();
    if roll >= 70.0 {
        if roll >= 90.0 {
            return AM.iron + random_material(player_level, r);
        }
        return AM.chain;
    }
    AM.leather
}

/// The RRI copy's `coinFlip` (rriEnemyEquipment.js:79): `range(rolls, 0, 2) === 0`.
fn coin_flip(r: &mut dyn Rolls) -> bool {
    range_excl(r, 0.0, 2.0) == 0.0
}

/// `ARMOR_FLAG` (dexEquipment.js:48): the forbidden armour bits (`WeaponArmorShieldsBitfield >> 6 & 7`).
fn forbidden_armors(career: Option<&Career>) -> u32 {
    let bits = career
        .and_then(|c| c.weapon_armor_shields_bitfield)
        .unwrap_or(0.0);
    (to_uint32(bits) >> 6) & 0x07
}

// ---- the item classes and the equip table ------------------------------------------------------------------------

const HAND_RIGHT_ONLY: u8 = 1;
const HAND_LEFT_ONLY: u8 = 2;
const HAND_EITHER: u8 = 3;
const HAND_BOTH: u8 = 4;

/// The settings the equip table and the arms read: the RRI switches and the bow (`BowLeftHandWithSwitching`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ctx {
    pub rri: RriSwitches,
    pub bow_left_hand: bool,
}

/// `customItemClass(templateIndex)` (rriItems.js:626) with the boot's switches.
fn custom(template: f64, ctx: &Ctx) -> Option<crate::vendored::CustomClass> {
    custom_item_class(template, Some(&ctx.rri))
}

/// `getItemHands(item, { bowLeftHand })` (characters/equipTable.js:33-77), the arms' cases only: a bow by the setting,
/// a custom class's hands, the classic weapon table, the shields. The thunderlock, pistolet and hand-wrap rows are
/// unreachable from the enemy arms (their templates are never minted here).
fn item_hands(p: &Piece, ctx: &Ctx) -> u8 {
    if p.group != Group::Weapons && p.group != Group::Armor {
        return 0;
    }
    if p.group == Group::Weapons && (p.template == 129.0 || p.template == 130.0) {
        return if ctx.bow_left_hand {
            HAND_LEFT_ONLY
        } else {
            HAND_BOTH
        };
    }
    if let Some(h) = custom(p.template, ctx).and_then(|c| c.item_hands) {
        return hands_named(h);
    }
    if let Some((_, h)) = WEAPON_HANDS.iter().find(|(k, _)| *k as f64 == p.template) {
        return hands_named(h);
    }
    if SHIELD_INDICES.contains(&p.template) {
        return HAND_LEFT_ONLY;
    }
    0
}

/// `ITEM_HANDS[name]` (equipTable.js:27).
fn hands_named(name: &str) -> u8 {
    match name {
        "RightOnly" => HAND_RIGHT_ONLY,
        "LeftOnly" => HAND_LEFT_ONLY,
        "Either" => HAND_EITHER,
        "Both" => HAND_BOTH,
        _ => 0,
    }
}

/// The equip table of one entity (`createEquipTable`, equipTable.js:79): 27 slots, each the index of the piece in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub slots: [Option<usize>; 27],
    pub items: Vec<Piece>,
}

impl Table {
    fn new() -> Table {
        Table {
            slots: [None; 27],
            items: Vec::new(),
        }
    }

    /// The slot index of an equip slot id, when it is a real slot (`None` for the None slot and anything out of range).
    fn index(slot: f64) -> Option<usize> {
        if (0.0..27.0).contains(&slot) {
            Some(slot as usize)
        } else {
            None
        }
    }

    /// The piece in an equip slot (`slots[slot]`).
    fn at(&self, slot: f64) -> Option<Piece> {
        Table::index(slot)
            .and_then(|i| self.slots[i])
            .map(|k| self.items[k])
    }

    /// `isSlotOpen(slot)` (equipTable.js:82): a real slot, and empty.
    fn open(&self, slot: f64) -> bool {
        slot != EQUIP_SLOTS.none && Table::index(slot).is_some_and(|i| self.slots[i].is_none())
    }

    /// `getFirstSlot(a, b)` (equipTable.js:83): the first open of the two, else the first.
    fn first_slot(&self, a: f64, b: f64) -> f64 {
        if self.open(a) {
            a
        } else if self.open(b) {
            b
        } else {
            a
        }
    }
}

/// `createEquipTable().getEquipSlot(item)` (equipTable.js:91-126): the slot a piece is worn in, given the table as it
/// stands. A custom armour class names its slot; armour and clothing go by the generated rule; a weapon by its hands,
/// and a two-hander in the right hand pulls the next weapon into it.
fn get_equip_slot(t: &Table, p: &Piece, ctx: &Ctx) -> f64 {
    if p.group == Group::Armor {
        if let Some(slot) = custom(p.template, ctx).and_then(|c| c.equip_slot) {
            return slot_named(slot);
        }
    }
    match p.group {
        Group::Armor | Group::MensClothing | Group::WomensClothing => {
            let rule = match p.group {
                Group::Armor => SLOT_RULES
                    .armor
                    .iter()
                    .find(|(k, _)| *k as f64 == p.template)
                    .map(|(_, r)| (Some(r.slot), None)),
                Group::MensClothing => SLOT_RULES
                    .mens_clothing
                    .iter()
                    .find(|(k, _)| *k as f64 == p.template)
                    .map(|(_, r)| (r.slot, r.pair)),
                _ => SLOT_RULES
                    .womens_clothing
                    .iter()
                    .find(|(k, _)| *k as f64 == p.template)
                    .map(|(_, r)| (r.slot, r.pair)),
            };
            match rule {
                None => EQUIP_SLOTS.none,
                Some((Some(slot), _)) => slot_named(slot),
                Some((None, Some(pair))) => t.first_slot(slot_named(pair[0]), slot_named(pair[1])),
                Some((None, None)) => EQUIP_SLOTS.none,
            }
        }
        Group::Weapons => {
            if let Some(right) = t.at(EQUIP_SLOTS.right_hand) {
                if item_hands(&right, ctx) == HAND_BOTH && item_hands(p, ctx) != HAND_LEFT_ONLY {
                    return EQUIP_SLOTS.right_hand;
                }
            }
            match item_hands(p, ctx) {
                HAND_RIGHT_ONLY | HAND_BOTH => EQUIP_SLOTS.right_hand,
                HAND_LEFT_ONLY => EQUIP_SLOTS.left_hand,
                HAND_EITHER => t.first_slot(EQUIP_SLOTS.right_hand, EQUIP_SLOTS.left_hand),
                _ => EQUIP_SLOTS.none,
            }
        }
    }
}

/// `wearLeavers(entity, item, slot)` (systems/equip.js:404-414): the slots a wear takes off first (a two-hander both
/// hands; a shield a held two-hander; the slot's own occupant). Pure: the table is read, never written.
fn wear_leavers(t: &Table, p: &Piece, slot: f64, ctx: &Ctx) -> Vec<f64> {
    if slot == EQUIP_SLOTS.none {
        return Vec::new();
    }
    let mut out = Vec::new();
    if p.group == Group::Weapons && item_hands(p, ctx) == HAND_BOTH {
        out.push(EQUIP_SLOTS.left_hand);
        out.push(EQUIP_SLOTS.right_hand);
    }
    if slot == EQUIP_SLOTS.left_hand {
        if let Some(right) = t.at(EQUIP_SLOTS.right_hand) {
            if item_hands(&right, ctx) == HAND_BOTH {
                out.push(EQUIP_SLOTS.right_hand);
            }
        }
    }
    out.push(slot);
    out
}

/// `add(item, equip)` of the RRI class arm (rriEnemyEquipment.js:261-273): `wornCondition` draws one roll (every group
/// the arm adds takes it, :501-511), the piece joins `items`, and, when `equip`, it is worn in its slot after the
/// leavers come off. Returns the piece's index in `items`.
fn add(t: &mut Table, r: &mut dyn Rolls, ctx: &Ctx, p: Piece, equip: bool) -> usize {
    let _ = r.roll();
    let index = t.items.len();
    t.items.push(p);
    let slot = if equip {
        get_equip_slot(t, &p, ctx)
    } else {
        EQUIP_SLOTS.none
    };
    if slot != EQUIP_SLOTS.none {
        for s in wear_leavers(t, &p, slot, ctx) {
            if let Some(i) = Table::index(s) {
                t.slots[i] = None;
            }
        }
        if let Some(i) = Table::index(slot) {
            t.slots[i] = Some(index);
        }
    }
    index
}

// ---- minting ---------------------------------------------------------------------------------------------------

/// The fold a custom class's variant setter runs on a freshly minted piece (rriItems.js:506-519): a light piece of
/// Chain is Fur, which is Leather with `message` 1. Every other material is kept.
fn fold_material(template: f64, material: f64, ctx: &Ctx) -> f64 {
    let folds = custom(template, ctx).is_some_and(|c| c.folds_chain_to_fur);
    if folds && material == AM.chain {
        AM.leather
    } else {
        material
    }
}

/// `mintCondition`'s maximum for an armour piece (itemTemplates.js:336-350): the template's hit points, and a plate
/// piece scaled by its metal's multiplier (`trunc(max x mult / 4)`). A template with no row (every RRI class) is 0.
fn armour_max(template: f64, material: f64) -> f64 {
    let hit = ITEM_TEMPLATE_FACTS
        .iter()
        .find(|(k, _)| *k as f64 == template)
        .and_then(|(_, f)| f.hit_points)
        .unwrap_or(0.0);
    let mut max = hit;
    if max > 0.0 && material >= AM.iron {
        let mult = if material <= AM.daedric {
            CONDITION_MULTIPLIERS_BY_MATERIAL
                .get((material - AM.iron) as usize)
                .copied()
                .unwrap_or(4.0)
        } else {
            4.0
        };
        max = trunc(max * mult / 4.0);
    }
    max
}

/// The worn piece's material after the mint (`setItemFields` then `armorOfMaterial`, itemTemplates.js:186-205).
fn mint_piece_armour(template: f64, material: f64, ctx: &Ctx) -> Piece {
    Piece {
        group: Group::Armor,
        template,
        material: fold_material(template, material, ctx),
    }
}

/// `armourPiece(templateIndex, { material })` (target.js:489-494) as the target holds it: the item the piece mints to
/// (`armorOfMaterial`, combat/enemyEquipment.js:210), at full condition (`condition` 1).
pub fn mint_armour(template: f64, material: f64, rri: Option<&RriSwitches>) -> Item {
    let ctx = Ctx {
        rri: rri.copied().unwrap_or(RriSwitches {
            enabled: false,
            new_weapons: false,
            new_armor: false,
            realistic_enemy_equipment: false,
        }),
        bow_left_hand: false,
    };
    let material = if rri.is_some() {
        fold_material(template, material, &ctx)
    } else {
        material
    };
    let max = armour_max(template, material);
    Item {
        is_armor: true,
        template_index: Some(template),
        material: Some(material),
        artifact: false,
        max_condition: Some(max),
        current_condition: Some(max),
    }
}

// ---- the classic loadout ---------------------------------------------------------------------------------------

/// The classic loadout's draws (enemyEquipment.js:238-276): the weapons, the left hand, and the six armour pieces.
#[derive(Debug, Clone, PartialEq)]
pub struct Rolled {
    pub right: Option<Piece>,
    pub left: Option<Hand>,
    pub armor_pieces: Vec<PieceRef>,
}

/// `rollEnemyEquipment(entity, variant, playerLevel, rolls)` (enemyEquipment.js:238-276). The city watch's item level
/// is 1. `variant` `None` (JS null) takes the `else` arm with no chance. Each `dice100(chance, rolls())` draws its roll
/// before it is tested, even at a chance of 0.
pub fn roll_enemy_equipment(
    e: &Entity,
    variant: Option<f64>,
    player_level: f64,
    r: &mut dyn Rolls,
) -> Rolled {
    let item_level = if e.is_class && e.mobile_type == Some(KNIGHT_CITYWATCH_ID) {
        1.0
    } else {
        player_level
    };
    let right;
    let mut left = None;
    let mut armor_pieces = Vec::new();
    let mut chance = 0.0;
    if variant == Some(0.0) {
        let t = range_incl(r, weapon("Broadsword"), weapon("Longsword"));
        let m = random_material(item_level, r);
        right = Some(Piece {
            group: Group::Weapons,
            template: t,
            material: m,
        });
        chance = 50.0;
        let shield = range_incl(r, ARMOR_ENUM.buckler, ARMOR_ENUM.round_shield);
        if dice100(chance, r.roll()) {
            left = Some(Hand::Shield(shield));
            let mat = random_armor_material(item_level, r);
            armor_pieces.push(PieceRef {
                piece: shield,
                material: mat,
                shield: true,
            });
        } else if dice100(chance, r.roll()) {
            let t2 = range_incl(r, weapon("Dagger"), weapon("Shortsword"));
            let m2 = random_material(item_level, r);
            left = Some(Hand::Item(Piece {
                group: Group::Weapons,
                template: t2,
                material: m2,
            }));
        }
    } else {
        let t = range_incl(r, weapon("Claymore"), weapon("Battle Axe"));
        let m = random_material(item_level, r);
        right = Some(Piece {
            group: Group::Weapons,
            template: t,
            material: m,
        });
        if variant == Some(1.0) {
            chance = 75.0;
        } else if variant == Some(2.0) {
            chance = 90.0;
        }
    }
    for piece in [
        ARMOR_ENUM.helm,
        ARMOR_ENUM.right_pauldron,
        ARMOR_ENUM.left_pauldron,
        ARMOR_ENUM.cuirass,
        ARMOR_ENUM.greaves,
        ARMOR_ENUM.boots,
    ] {
        if dice100(chance, r.roll()) {
            let mat = random_armor_material(item_level, r);
            armor_pieces.push(PieceRef {
                piece,
                material: mat,
                shield: false,
            });
        }
    }
    Rolled {
        right,
        left,
        armor_pieces,
    }
}

/// `enemyArmorValues(entity, armorPieces)` (enemyEquipment.js:298-325) over the pieces the arms list: the armour
/// values, with the custom classes' body parts when the switches are given.
fn armour_values(e: &Entity, pieces: &[PieceRef], rri: Option<&RriSwitches>) -> [f64; 7] {
    let refs: Vec<ArmourPieceRef> = pieces
        .iter()
        .map(|p| ArmourPieceRef {
            piece: Some(p.piece),
            material: Some(p.material),
            shield: p.shield,
        })
        .collect();
    enemy_armor_values_with(e.is_class, e.armor, &refs, rri)
}

/// `assignEnemyEquipment(entity, variant, playerLevel, rolls)` (enemyEquipment.js:228-231): the classic loadout and its
/// armour values. The delegate's default when Enemy Expansion is off.
pub fn assign_enemy_equipment(
    e: &Entity,
    variant: Option<f64>,
    player_level: f64,
    r: &mut dyn Rolls,
) -> GearOut {
    let rolled = roll_enemy_equipment(e, variant, player_level, r);
    let armor_values = armour_values(e, &rolled.armor_pieces, None);
    GearOut {
        right: rolled.right,
        left: rolled.left,
        armor_pieces: rolled.armor_pieces,
        armor_values,
        poison: None,
    }
}

/// `equipmentVariantFor(careerIndex, isClass, rolls)` (enemyEquipment.js:397-402): the loadout a career gets. A class
/// draws `Range(0, 2)`; a monster with no table row has none.
pub fn equipment_variant_for(
    career_index: Option<f64>,
    is_class: bool,
    r: &mut dyn Rolls,
) -> Option<f64> {
    match career_index {
        Some(c) if c == 7.0 || c == 21.0 => Some(0.0),
        Some(c) if c == 8.0 || c == 12.0 => Some(1.0),
        Some(24.0) => Some(2.0),
        _ => {
            if is_class {
                Some((r.roll() * 2.0).floor())
            } else {
                None
            }
        }
    }
}

// ---- the Roleplay & Realism arm (the Enemy Expansion delegate) ------------------------------------------------

/// `convertOrcish(entity, eq, rolls)` (rriEnemyEquipment.js:434-466): an Orcs-team foe's Ebony-and-up (a Warlord's
/// Mithril-and-up) is Orcish 80% of the time. One roll is drawn only for an Orcs-team foe. The weapons and the armour
/// it names take the Orcish material. The loot `items` of the entity are not on the target, so they are not visited.
fn convert_orcish(e: &Entity, mob: Option<f64>, eq: &mut Rolled, r: &mut dyn Rolls) {
    if e.team != Some("Orcs") {
        return;
    }
    if !dice100(80.0, r.roll()) {
        return;
    }
    let convert_from = if mob == Some(MT.orc_warlord) {
        WM.mithril
    } else {
        WM.ebony
    };
    let orcish = |m: f64| f64::from(to_int32(m) & 0xff) >= convert_from;
    if let Some(p) = eq.right.as_mut() {
        if p.group == Group::Weapons && orcish(p.material) {
            p.material = WM.orcish;
        }
    }
    if let Some(Hand::Item(p)) = eq.left.as_mut() {
        if p.group == Group::Weapons && orcish(p.material) {
            p.material = WM.orcish;
        }
    }
    for a in eq.armor_pieces.iter_mut() {
        if orcish(a.material) {
            a.material = AM.orcish;
        }
    }
}

/// `rollEnemyWeaponPoison(mobileType, playerLevel, rolls)` (systems/poisons.js:250-263): a class, an Orc, a Centaur or
/// an Orc Sergeant, above player level 1; 5% (60% for an Assassin); the poison is `128 + Range(0, 8)`.
pub fn roll_enemy_weapon_poison(
    mob: Option<f64>,
    player_level: f64,
    r: &mut dyn Rolls,
) -> Option<f64> {
    if player_level <= 1.0 {
        return None;
    }
    let mob = mob?;
    let is_class = (to_int32(mob) & 128) != 0 && mob != MT.none;
    if !is_class && mob != MT.orc && mob != MT.centaur && mob != MT.orc_sergeant {
        return None;
    }
    let chance = if mob == MT.assassin { 60.0 } else { 5.0 };
    if !dice100(chance, r.roll()) {
        return None;
    }
    Some(POISON_START_VALUE + (r.roll() * 8.0).floor())
}

/// The DEX copy's `dexClassTable(mobileId, propsOf)` (dexEquipment.js:39-45): the class a foe's kit is drawn by. The
/// table's `equipmentTable` names it (`Guard` is the City Watch's); with no table the foe is its own class. `None` is a
/// table naming no class the arm knows.
fn dex_class_table(mobile: f64, mudex: bool) -> Option<f64> {
    if !crate::round::is_integer(mobile) {
        return None;
    }
    let key = format!("{}/{}", u8::from(mudex), mobile as i64);
    match DEX_EQUIPMENT_TABLE.iter().find(|(k, _)| *k == key.as_str()) {
        None => Some(mobile),
        Some((_, table)) => {
            let name = table.to_lowercase();
            if name == "guard" {
                Some(MT.knight_city_watch)
            } else {
                class_by_name(&name)
            }
        }
    }
}

/// `CLASS_BY_NAME` (dexEquipment.js:31-35): the eighteen classes by their lowercased names (the City Watch is "guard").
fn class_by_name(name: &str) -> Option<f64> {
    let m = MT;
    Some(match name {
        "mage" => m.mage,
        "spellsword" => m.spellsword,
        "battlemage" => m.battlemage,
        "sorcerer" => m.sorcerer,
        "healer" => m.healer,
        "nightblade" => m.nightblade,
        "bard" => m.bard,
        "burglar" => m.burglar,
        "rogue" => m.rogue,
        "acrobat" => m.acrobat,
        "thief" => m.thief,
        "assassin" => m.assassin,
        "monk" => m.monk,
        "archer" => m.archer,
        "ranger" => m.ranger,
        "barbarian" => m.barbarian,
        "warrior" => m.warrior,
        "knight" => m.knight,
        _ => return None,
    })
}

/// The arm's class, as its switch tests it (`switch (cls)` in rriEnemyEquipment.js:283-376).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cls {
    Archer,
    Ranger,
    Barbarian,
    Knight,
    CityWatch,
    Monk,
    Spellsword,
    Warrior,
    Rogue,
    Mage,
    Sorcerer,
    Healer,
    Assassin,
    Battlemage,
    Acrobat,
    Bard,
    Burglar,
    Nightblade,
    Thief,
    /// A class the arm does not name (its default arm).
    Unknown,
}

fn cls_of(id: Option<f64>) -> Cls {
    let Some(id) = id else {
        return Cls::Unknown;
    };
    let m = MT;
    let table = [
        (m.archer, Cls::Archer),
        (m.ranger, Cls::Ranger),
        (m.barbarian, Cls::Barbarian),
        (m.knight, Cls::Knight),
        (m.knight_city_watch, Cls::CityWatch),
        (m.monk, Cls::Monk),
        (m.spellsword, Cls::Spellsword),
        (m.warrior, Cls::Warrior),
        (m.rogue, Cls::Rogue),
        (m.mage, Cls::Mage),
        (m.sorcerer, Cls::Sorcerer),
        (m.healer, Cls::Healer),
        (m.assassin, Cls::Assassin),
        (m.battlemage, Cls::Battlemage),
        (m.acrobat, Cls::Acrobat),
        (m.bard, Cls::Bard),
        (m.burglar, Cls::Burglar),
        (m.nightblade, Cls::Nightblade),
        (m.thief, Cls::Thief),
    ];
    table
        .iter()
        .find(|(k, _)| *k == id)
        .map_or(Cls::Unknown, |(_, c)| *c)
}

/// The arm's piece for one slot of the armour pass (rriEnemyEquipment.js:378-382): the DEX copy's template (its coin is
/// drawn only past the first two tests), the material (drawn whether or not a piece is minted), then the add.
fn armour_slot(
    t: &mut Table,
    r: &mut dyn Rolls,
    ctx: &Ctx,
    item_level: f64,
    career: Option<&Career>,
    slot: &str,
) {
    let template = dex_armour_template(slot, career, &ctx.rri, r);
    let material = random_armor_material(item_level, r);
    if template != -1.0 {
        let p = mint_piece_armour(template, material, ctx);
        add(t, r, ctx, p, true);
    }
}

/// `DEX_RRICompat.GetArmorTemplateIndex` (dexEquipment.js:83-90): the classic piece, or with newArmor and plate
/// forbidden a coin between it and the chain set (the chain then the leather), else nothing (-1).
fn dex_armour_template(
    slot: &str,
    career: Option<&Career>,
    rri: &RriSwitches,
    r: &mut dyn Rolls,
) -> f64 {
    let forbidden = forbidden_armors(career);
    if !rri.module(rri.new_armor) || (forbidden & 4) == 0 || coin_flip(r) {
        return classic_piece(slot);
    }
    if (forbidden & 2) == 0 {
        return chain_piece(slot);
    }
    if (forbidden & 1) == 0 {
        return leather_piece(slot);
    }
    -1.0
}

/// `CLASSIC_PIECE` (dexEquipment.js:53-61).
fn classic_piece(slot: &str) -> f64 {
    match slot {
        "ChestArmor" => ARMOR_ENUM.cuirass,
        "LegsArmor" => ARMOR_ENUM.greaves,
        "LeftArm" => ARMOR_ENUM.left_pauldron,
        "RightArm" => ARMOR_ENUM.right_pauldron,
        "Feet" => ARMOR_ENUM.boots,
        "Gloves" => ARMOR_ENUM.gauntlets,
        "Head" => ARMOR_ENUM.helm,
        _ => -1.0,
    }
}

/// `CHAIN_PIECE` (dexEquipment.js:62-70); the RRI item indices of rriEnemyEquipment.js:53-68 (`RRI_ITEM`).
fn chain_piece(slot: &str) -> f64 {
    match slot {
        "ChestArmor" => 515.0,
        "LegsArmor" => 516.0,
        "LeftArm" => 517.0,
        "RightArm" => 518.0,
        "Feet" => 519.0,
        "Gloves" => 524.0,
        "Head" => 522.0,
        _ => -1.0,
    }
}

/// `LEATHER_PIECE` (dexEquipment.js:71-79).
fn leather_piece(slot: &str) -> f64 {
    match slot {
        "ChestArmor" => 520.0,
        "LegsArmor" => 521.0,
        "LeftArm" => 525.0,
        "RightArm" => 526.0,
        "Feet" => 523.0,
        "Gloves" => 524.0,
        "Head" => 522.0,
        _ => -1.0,
    }
}

/// `mintClothing(female, templateIndex, rolls)` (rriEnemyEquipment.js:185-195): the robes of the sex, a variant drawn
/// when the template has variants. The player is absent, so the sex is male (`female` false) and the robes are the
/// men's (createItemRows.js:36).
fn mint_clothing(r: &mut dyn Rolls, template: f64) -> Piece {
    let variants = ITEM_TEMPLATE_FACTS
        .iter()
        .find(|(k, _)| *k as f64 == template)
        .and_then(|(_, f)| f.variants)
        .unwrap_or(0.0);
    if variants > 0.0 {
        let _ = range_excl(r, 0.0, variants);
    }
    Piece {
        group: Group::MensClothing,
        template,
        material: 0.0,
    }
}

/// `mintWeapon(templateIndex, material, rolls)` (rriEnemyEquipment.js:163-176): a custom weapon by its SetItem writes,
/// a classic one by `createWeapon`; neither draws a roll (only the arrow does, and no arm mints one here).
fn mint_weapon(template: f64, material: f64) -> Piece {
    Piece {
        group: Group::Weapons,
        template,
        material,
    }
}

/// `createWeapon(templateIndex, material, rolls)` (enemyEquipment.js:146-180): the arrow draws its stack (one roll).
fn create_weapon(template: f64, material: f64, r: &mut dyn Rolls) -> Piece {
    if template == ARROW_TEMPLATE {
        let _ = (r.roll() * 20.0).floor();
    }
    mint_weapon(template, material)
}

/// The arm's weapon-choice helpers (rriEnemyEquipment.js:71-119).
fn random_bow(r: &mut dyn Rolls) -> f64 {
    range_excl(r, weapon("Short Bow"), weapon("Long Bow") + 1.0)
}

fn random_longblade(r: &mut dyn Rolls) -> f64 {
    range_excl(r, weapon("Broadsword"), weapon("Longsword") + 1.0)
}

fn random_shortblade(r: &mut dyn Rolls) -> f64 {
    if dice100(40.0, r.roll()) {
        weapon("Shortsword")
    } else {
        range_excl(r, weapon("Dagger"), weapon("Wakazashi") + 1.0)
    }
}

/// `oneOf(rolls, array)`: `array[range(rolls, 0, length)]`, one roll.
fn one_of(r: &mut dyn Rolls, array: &[f64]) -> f64 {
    array[range_excl(r, 0.0, array.len() as f64) as usize]
}

fn random_blunt(r: &mut dyn Rolls, newer: bool) -> f64 {
    let blunt = [weapon("Mace"), weapon("Flail"), weapon("Warhammer")];
    let blunt_new = [weapon("Mace"), weapon("Flail"), weapon("Warhammer"), 514.0];
    if newer {
        one_of(r, &blunt_new)
    } else {
        one_of(r, &blunt)
    }
}

fn random_axe(r: &mut dyn Rolls, newer: bool) -> f64 {
    let axe = [weapon("Battle Axe"), weapon("War Axe")];
    let axe_new = [weapon("Battle Axe"), weapon("War Axe"), 513.0];
    if newer {
        one_of(r, &axe_new)
    } else {
        one_of(r, &axe)
    }
}

fn random_axe_or_blade(r: &mut dyn Rolls, newer: bool) -> f64 {
    if coin_flip(r) {
        random_axe(r, newer)
    } else {
        random_longblade(r)
    }
}

fn random_blunt_or_blade(r: &mut dyn Rolls, newer: bool) -> f64 {
    if coin_flip(r) {
        random_blunt(r, newer)
    } else {
        random_longblade(r)
    }
}

fn random_big_weapon(r: &mut dyn Rolls) -> f64 {
    let mut w = range_excl(r, weapon("Claymore"), weapon("War Axe") + 1.0);
    if w == weapon("Dai-Katana") && dice100(90.0, r.roll()) {
        w = weapon("Claymore");
    }
    w
}

fn secondary_weapon(r: &mut dyn Rolls, newer: bool) -> f64 {
    match range_excl(r, 0.0, 4.0) as i64 {
        0 => weapon("Dagger"),
        1 => weapon("Shortsword"),
        2 => {
            if newer {
                513.0
            } else {
                weapon("Short Bow")
            }
        }
        _ => weapon("Short Bow"),
    }
}

fn combat_class_weapon(cls: Cls, r: &mut dyn Rolls, newer: bool) -> f64 {
    match cls {
        Cls::Barbarian => random_big_weapon(r),
        Cls::Knight => {
            if coin_flip(r) {
                random_blunt(r, newer)
            } else {
                random_longblade(r)
            }
        }
        Cls::CityWatch => random_axe_or_blade(r, newer),
        Cls::Monk => random_blunt(r, newer),
        _ => random_longblade(r),
    }
}

/// `DEX_RRICompat`'s arm, the class branch of `assignRriEnemyEquipment` (rriEnemyEquipment.js:283-376 with the copy's
/// reads, dexEquipment.js:94-99: `unknownArmed`, `equipsSecondary`). The class's kit, its armour pass, then the worn
/// set and the armour values (the class clamp to 60).
fn assign_class(
    e: &Entity,
    mobile: f64,
    cls_id: Option<f64>,
    variant: Option<f64>,
    player_level: f64,
    ctx: &Ctx,
    r: &mut dyn Rolls,
) -> GearOut {
    let cls = cls_of(cls_id);
    let newer = ctx.rri.module(ctx.rri.new_weapons);
    let item_level = if mobile == MT.knight_city_watch {
        1.0
    } else {
        e.level.unwrap_or(player_level)
    };
    let chance = 50.0;
    let mut armored = 100.0;
    let mut t = Table::new();
    match cls {
        Cls::Archer | Cls::Ranger => {
            let w = random_bow(r);
            let m = random_material(item_level, r);
            let bow = create_weapon(w, m, r);
            add(&mut t, r, ctx, bow, true);
            let w2 = if mobile == MT.ranger {
                random_longblade(r)
            } else {
                random_shortblade(r)
            };
            let m2 = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w2, m2), false);
            // The arrow pile: its stack (CreateWeapon, one roll) and `range(rolls, 4, 17)` (one roll). Never worn.
            let _ = create_weapon(ARROW_TEMPLATE, WM.iron, r);
            let _ = range_excl(r, 4.0, 17.0);
            armored = 60.0;
        }
        Cls::Barbarian
        | Cls::Knight
        | Cls::CityWatch
        | Cls::Monk
        | Cls::Spellsword
        | Cls::Warrior
        | Cls::Rogue => {
            if variant == Some(0.0) {
                let w = combat_class_weapon(cls, r, newer);
                let m = random_material(item_level, r);
                add(&mut t, r, ctx, mint_weapon(w, m), true);
                if dice100(chance, r.roll()) {
                    let shield = random_shield(r);
                    let mat = random_armor_material(item_level, r);
                    add(&mut t, r, ctx, mint_piece_armour(shield, mat, ctx), true);
                } else if dice100(chance, r.roll()) {
                    let w2 = secondary_weapon(r, newer);
                    let m2 = random_material(item_level, r);
                    add(&mut t, r, ctx, mint_weapon(w2, m2), true);
                }
                if !(cls == Cls::Knight || cls == Cls::Warrior) {
                    armored = 80.0;
                }
            } else {
                let w = random_big_weapon(r);
                let m = random_material(item_level, r);
                add(&mut t, r, ctx, mint_weapon(w, m), true);
                if !(cls == Cls::Knight || cls == Cls::Warrior) {
                    armored = 90.0;
                }
            }
            if cls == Cls::Barbarian {
                armored = 30.0;
            }
        }
        Cls::Mage | Cls::Sorcerer | Cls::Healer => {
            let m = random_material(item_level, r);
            let staff = create_weapon(weapon("Staff"), m, r);
            add(&mut t, r, ctx, staff, true);
            if dice100(chance, r.roll()) {
                let w = random_shortblade(r);
                let m2 = random_material(item_level, r);
                add(&mut t, r, ctx, mint_weapon(w, m2), false);
            }
            let robes = mint_clothing(r, MENS_PLAIN_ROBES);
            add(&mut t, r, ctx, robes, true);
            armored = 35.0;
        }
        Cls::Assassin => {
            let w = random_axe_or_blade(r, newer);
            let m = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w, m), true);
            let w2 = random_axe_or_blade(r, newer);
            let m2 = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w2, m2), false);
            armored = 65.0;
        }
        Cls::Battlemage => {
            let w = random_blunt_or_blade(r, newer);
            let m = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w, m), true);
            let w2 = random_blunt_or_blade(r, newer);
            let m2 = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w2, m2), false);
            armored = 75.0;
        }
        Cls::Acrobat | Cls::Bard | Cls::Burglar | Cls::Nightblade | Cls::Thief => {
            let w = random_shortblade(r);
            let m = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w, m), true);
            if dice100(chance, r.roll()) {
                let w2 = secondary_weapon(r, newer);
                let m2 = random_material(trunc(item_level / 2.0), r);
                add(&mut t, r, ctx, mint_weapon(w2, m2), true);
            }
            armored = 50.0;
        }
        Cls::Unknown => {
            // The copy's `unknownArmed` (dexEquipment.js:97): a longblade, armored 50.
            let w = random_longblade(r);
            let m = random_material(item_level, r);
            add(&mut t, r, ctx, mint_weapon(w, m), true);
            armored = 50.0;
        }
    }

    // The armour pass (rriEnemyEquipment.js:383-399): the torso, the legs, the feet, the head, then the arms and gloves.
    // A barbarian's legs and head draw a second chance, only when the first fails (JS `||`).
    let barbarian = mobile == MT.barbarian;
    let career = e.career;
    if dice100(armored, r.roll()) {
        armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "ChestArmor");
    }
    armored -= 10.0;
    if dice100(armored, r.roll()) || (barbarian && dice100(armored + 50.0, r.roll())) {
        armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "LegsArmor");
    }
    armored -= 10.0;
    if dice100(armored, r.roll()) {
        armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "Feet");
    }
    armored -= 10.0;
    if dice100(armored, r.roll()) || (barbarian && dice100(armored + 50.0, r.roll())) {
        armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "Head");
    }
    armored -= 20.0;
    if armored > 0.0 {
        if dice100(armored, r.roll()) {
            armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "RightArm");
        }
        if dice100(armored, r.roll()) {
            armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "LeftArm");
        }
        if dice100(armored, r.roll()) {
            armour_slot(&mut t, r, ctx, item_level, career.as_ref(), "Gloves");
        }
    }

    // The table as the last EquipItem left it: the worn pieces in add order, the two hands.
    let mut armor_pieces = Vec::new();
    for (i, p) in t.items.iter().enumerate() {
        let worn = t.slots.contains(&Some(i));
        if worn && p.group == Group::Armor {
            armor_pieces.push(PieceRef {
                piece: p.template,
                material: p.material,
                shield: (ARMOR_ENUM.buckler..=ARMOR_ENUM.tower_shield).contains(&p.template),
            });
        }
    }
    let right = t.at(EQUIP_SLOTS.right_hand);
    let left = t.at(EQUIP_SLOTS.left_hand).map(Hand::Item);
    let armor_values = armour_values(e, &armor_pieces, Some(&ctx.rri));
    GearOut {
        right,
        left,
        armor_pieces,
        armor_values,
        poison: None,
    }
}

/// `random_shield` (rriEnemyEquipment.js:81): `range(rolls, Buckler, Round_Shield + 1)`.
fn random_shield(r: &mut dyn Rolls) -> f64 {
    range_excl(r, ARMOR_ENUM.buckler, ARMOR_ENUM.round_shield + 1.0)
}

/// `assignRriEnemyEquipment(entity, variant, playerLevel, { read })` (rriEnemyEquipment.js:240-257) through the Enemy
/// Expansion copy (`createDexEquipmentAssigner`, dexEquipment.js:104-107). `None` where the realistic switch is off
/// (the caller then runs ItemHelper's arm). A monster runs the classic loadout, then the poison and the Orcish pass; a
/// class runs its own arm. `mudex` is the table set the copy reads (`Meaner Monsters` beside DEX, dexInstall.js:190).
pub fn assign_rri_enemy_equipment(
    e: &Entity,
    variant: Option<f64>,
    player_level: f64,
    mudex: bool,
    boot: &Boot,
    r: &mut dyn Rolls,
) -> Option<GearOut> {
    if !boot.rri.module(boot.rri.realistic_enemy_equipment) {
        return None;
    }
    let ctx = Ctx {
        rri: boot.rri,
        bow_left_hand: boot.bow_left_hand,
    };
    if !e.is_class {
        let mut eq = roll_enemy_equipment(e, variant, player_level, r);
        let poison = if eq.right.is_some() {
            roll_enemy_weapon_poison(e.mobile_type, player_level, r)
        } else {
            None
        };
        convert_orcish(e, e.mobile_type, &mut eq, r);
        let armor_values = armour_values(e, &eq.armor_pieces, Some(&boot.rri));
        return Some(GearOut {
            right: eq.right,
            left: eq.left,
            armor_pieces: eq.armor_pieces,
            armor_values,
            poison,
        });
    }
    let mob = e.mobile_type?;
    let cls_id = dex_class_table(mob, mudex);
    Some(assign_class(e, mob, cls_id, variant, player_level, &ctx, r))
}

// ---- gearEnemy ---------------------------------------------------------------------------------------------------

/// The entity `gearEnemy` hands the arms (target.js:559): the target's fields with `armor` = `armorValues[0] ?? 0`.
pub fn entity_of(t: &Target) -> Entity {
    Entity {
        mobile_type: t.mobile_type,
        is_class: t.is_class == Some(true),
        level: t.level,
        armor: t.armor_values.first().copied().unwrap_or(0.0),
        career: if t.has_career { Some(t.career) } else { None },
        team: t.basics.and_then(|b| b.team),
    }
}

/// `equipArmour(target, pieces)` (target.js:503-523) for the descriptors `gearEnemy` passes (no `group`, so each mints
/// through `armourPiece`). Each goes to its body part's slot (a shield to the left hand) when that slot is empty.
pub fn equip_armour_descriptors(
    target: &mut Target,
    descs: &[(f64, f64)],
    rri: Option<&RriSwitches>,
) {
    let items: Vec<Item> = descs
        .iter()
        .map(|(template, material)| mint_armour(*template, *material, rri))
        .collect();
    crate::target::equip_armour_with(target, &items, false, rri);
}

/// `gearEnemy(target, { playerLevel, rolls })` (target.js:555-567). The loadout is the variant's (a career's, or a
/// class's `Range(0, 2)`); under Enemy Expansion the delegate's arm answers first, else the classic loadout. The pieces
/// are worn (`equipArmour`), and the target's armour values are the loadout's. A target with no variant is unchanged.
/// `player_level` `None` is `target.level ?? 1` (the JS default).
pub fn gear_enemy(target: &mut Target, boot: &Boot, player_level: Option<f64>, r: &mut dyn Rolls) {
    let pl = player_level.unwrap_or_else(|| target.level.unwrap_or(1.0));
    let Some(variant) =
        equipment_variant_for(target.career_index, target.is_class == Some(true), r)
    else {
        return;
    };
    let e = entity_of(target);
    let mudex = boot.enemy_expansion && boot.meaner_monsters;
    let delegated = if boot.enemy_expansion {
        assign_rri_enemy_equipment(&e, Some(variant), pl, mudex, boot, r)
    } else {
        None
    };
    let eq = match delegated {
        Some(eq) => eq,
        None => assign_enemy_equipment(&e, Some(variant), pl, r),
    };
    let descs: Vec<(f64, f64)> = eq
        .armor_pieces
        .iter()
        .map(|a| (a.piece, a.material))
        .collect();
    equip_armour_descriptors(target, &descs, Some(&boot.rri));
    target.armor_values = eq.armor_values.to_vec();
}
