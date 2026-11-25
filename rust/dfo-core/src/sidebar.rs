//! The read-only Forge sidebar's numbers (`DFO Forge`): the character's maxima and its worn armour, after gear and
//! Firmament, with no save written and no input mutated.
//!
//! ## The workflow: import once, then discard the document
//!
//! A GUI calls [`import_save`] with the raw imported document and the **normalized build**
//! (`save::character_from_save`), and keeps the returned [`Imported`] facts; neither input is retained ([`Imported`]
//! holds no reference to either, and nothing here is generic over one). Real upstream saves carry `items[].equipSlot` or
//! `equipSlots`, never a `worn` list - the build is what normalizes them - so the worn pieces and the enchantment fold are
//! read from the build, and the maxima and pools from the raw save.
//!
//! ```no_run
//! use dfo_core::sidebar::{armor_display, armor_fold_parts, firmament_armor_parts, firmament_layer, import_save,
//!                         vitals, Layer};
//! # fn demo(save: dfo_core::value::Value, build: dfo_core::value::Value, plan_totals: dfo_core::value::Value) {
//! let facts = import_save(&save, &build);             // raw maxima + the build's normalized worn list
//! let sky = firmament_layer(&facts, &plan_totals);    // the Firmament's share over the floored body
//! let eff = vitals(&facts, &Layer::default(), &sky);  // stored (save) + online (caller) + sky, once
//! let _ = (eff.health, eff.magicka, eff.snapshot);
//! let fold = armor_fold_parts(&facts.worn, &firmament_armor_parts(&plan_totals)); // affixes + sky, ONCE
//! let _display = armor_display(&facts.worn, &facts.enchant_mods, &fold);
//! // A gear edit: the edited build's worn list, and one workflow through the same functions.
//! let after = facts.after_gear(&build.get("worn").items().to_vec());
//! let _ = vitals(&after, &Layer::default(), &firmament_layer(&after, &plan_totals));
//! # }
//! ```
//!
//! ## What a save actually stores (and what it does not)
//!
//! - `maxHealth` is `entity.rawMaxHealth` (`full:systems/save/save.js:342-346`): the stored value with **no limiter**.
//!   The lycanthrope's `maxHealthLimiter` is not saved at all; it is a live-entity fact, and this module never applies
//!   one to a save.
//! - `maxMagicka` is the **offline** accessor (`offlineVitals`, `systems/renownLayer.js:152-168`): `floor(LiveInt x
//!   careerMultiplier) + maxMagickaModifier`, with Renown's and the folds' terms already taken OFF. It therefore INCLUDES
//!   the ExtraSpellPts channel and EXCLUDES the online layer. `maxMagickaModifier` itself is not saved, so the number is
//!   read whole and never re-derived from the attributes.
//! - Current `health` and `magicka` are snapshots: no rule derives a maximum from them.
//! - Absent maxima stay [`Fact::Unknown`]. The normalized build's `max(1, health)` and `0` defaults are NOT the game's
//!   numbers, so nothing here reads a build for a maximum.
//!
//! ## What is unknown, and why
//!
//! - **A gear edit's effective maximum Spell Points.** An ExtraSpellPts row adds its +75 only when its condition holds
//!   (`systems/enchantments.js:604-619`: a season, a moon phase, a nearby affinity), and the answer is not in the save. A
//!   gear edit that changes which ExtraSpellPts rows are worn therefore has an unknown activation, and
//!   [`Imported::after_gear`] carries that through ONE workflow: the effective base becomes `Unknown`, so
//!   [`firmament_layer`]'s Spell-Point share and [`vitals`]'s magicka are `Unknown` too, never the stale pre-edit
//!   number.
//! - **Renown's and the Spire's terms.** `renownBonus` is a vendored stub (`vendor/upstream/a3eb1605/src/net/renown.js:51`),
//!   so the caller states them in [`Layer`].
//! - **The Firmament.** Its tree is the account service's. The vendored `firmamentTree` is an inert stub, but
//!   `firmamentLive` is real code: it takes its tree from the host and reports no stats until a tree is set and the page
//!   is online (`systems/firmamentLive.js:35-36, :81-83`). The caller passes the law's capped totals, and an absent total
//!   is [`Fact::Unknown`], never 0.
//! - **Movement, regeneration, leech, the ordered route.** Not in this slice; deliberately absent rather than stubbed.
//!
//! ## Rules, each cited
//!
//! - **Max Health.** The save keeps the unlimited stored value; the live accessor is that value capped by the limiter
//!   (`systems/chargen.js:351-357`), plus the composed online layer `renown + spire + hp-share + floor`
//!   (`systems/renownLayer.js:83-85`).
//! - **Max Spell Points.** `floor(LiveInt x multiplier)` (`combat/formulas.js:127`; table `systems/chargen.js:204-207`) plus
//!   `maxMagickaModifier` (`systems/enchantments.js:1173-1179`), plus Renown's magicka and the folds' magicka, floored at 0
//!   (`systems/chargen.js:395-421`).
//! - **The Firmament's layer.** `systems/firmamentPowers.js:253-273`: `capAt("hp", hp + pctOf(floored, hpPct))` where
//!   `floored = baseHp + evenHpOf(entity, stats.endurance + end)`, and `capAt("mp", mp + pctOf(baseMp, mpPct))` where
//!   `baseMp = maxMagicka - renownMp`. `end` is `capAt("endurance", flat + pctOf(stats.endurance, pct.endurance))`.
//!   `pctOf` is `Math.floor(base * pct / 100)` for a positive finite base (`net/firmament/firmamentLaw.js:229`), and
//!   **both reads use the PERMANENT `entity.stats`**, never `liveStat` (`firmamentPowers.js:128`, `renownLayer.js:84`).
//! - **LEVEL-EVEN.** `evenHpOf` (`systems/levelEven.js:39-45`) over the level-10 average roll, on the stored maximum.
//! - **Armour.** `systems/equip.js:416-491`: seven struck-part values from 100, each worn piece subtracting its
//!   `itemArmorValue` x5 on the part its slot covers, a shield on every part it protects. The executable paperdoll term is
//!   `entityArmorDisplayMod` = `Decreased - Increased + armorParts[part]` (`systems/entityMods.js:200-204`); the
//!   `armorParts` fold is the gear affixes (`systems/loot/lootRarity.js:2386`) plus the Firmament's `armor` star
//!   (`systems/firmamentPowers.js:158-159`). The doll's `(100 - armorValues[part]) / 5` is a C# cite in a vendored
//!   comment (`systems/equip.js:422-423`), so [`armor_display`] composes it as DOCUMENTED and [`armor_display_mod`] is
//!   the part a differential can prove.

use crate::generated::armor_materials::BODY_PARTS;
use crate::round::{js_max, js_min};
use crate::value::Value;

/// A number the port can or cannot establish. `Unknown` is a missing source fact; no path turns it into a zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fact {
    Known(f64),
    Unknown,
}

impl Fact {
    fn of(v: Option<f64>) -> Fact {
        match v {
            Some(n) if n.is_finite() => Fact::Known(n),
            _ => Fact::Unknown,
        }
    }

    /// The number, or `None` for `Unknown`.
    pub fn value(&self) -> Option<f64> {
        match self {
            Fact::Known(n) => Some(*n),
            Fact::Unknown => None,
        }
    }

    fn map_known(self, f: impl FnOnce(f64) -> f64) -> Fact {
        match self {
            Fact::Known(n) => Fact::Known(f(n)),
            Fact::Unknown => Fact::Unknown,
        }
    }
}

fn finite(v: &Value, key: &str) -> Option<f64> {
    let n = v.get(key).finite_or(f64::NAN);
    n.is_finite().then_some(n)
}

// ── The import: the one read of the raw document ─────────────────────

/// The typeless, compact facts a GUI keeps after importing a save. No reference to the document survives here.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    /// `save.maxHealth` = the entity's `rawMaxHealth` (`save.js:346`), UNLIMITED - a save has no `maxHealthLimiter`.
    pub max_health: Fact,
    /// `save.maxMagicka`/`maxSpellPoints`: the offline live accessor (career base + the ExtraSpellPts channel).
    pub max_magicka: Fact,
    /// The saved current Health: a snapshot.
    pub health: Fact,
    /// The saved current Spell Points: a snapshot.
    pub magicka: Fact,
    /// `level`, the LEVEL-EVEN floor's own input.
    pub level: Fact,
    /// **Permanent** `stats.endurance` (`firmamentPowers.js:128`, `renownLayer.js:84` read `entity.stats`, not the live
    /// value). A fortify effect never moves it.
    pub endurance: Fact,
    /// `career.hitPointsPerLevel`.
    pub hit_points_per_level: Fact,
    /// `career.abilityFlagsAndSpellPointsBitfield`, for the Spell-Points multiplier.
    pub spell_point_bitfield: Fact,
    /// The live `intelligence`, the accessor's own input (`systems/chargen.js:405-408`). Kept for a caller that needs to
    /// explain the base; the maxima never recompute from it.
    pub intelligence: Fact,
    /// The **normalized build's** `worn` list - the equipped pieces the armour readers take. Real upstream saves carry
    /// `items[].equipSlot` / `equipSlots` instead (`src/save.js:251-259`), so this comes from `save::character_from_save`.
    pub worn: Vec<Value>,
    /// The build's `_enchantMods`: the held enchantment fold, for the display channel. Never a maximum.
    pub enchant_mods: Value,
}

/// Project the raw save and its **normalized build** into [`Imported`], once. Nothing is defaulted: a missing key is
/// [`Fact::Unknown`], so the build's `max(1, health)` / `0` never masquerade as the game's numbers (`src/save.js:277-282`).
///
/// `save` is the raw imported document: a save holds the maxima and the pools, and it does NOT hold `worn` (upstream
/// writes `items[].equipSlot`, or a live `equipSlots`). `build` is `save::character_from_save(&save, opts)`, whose `worn`
/// and `_enchantMods` are that normalization's own reads (`src/save.js:251-305`). The maxima are read from the RAW save,
/// never from the build's defaults; the worn list and the enchant fold are read from the BUILD, because that is where they
/// exist.
pub fn import_save(save: &Value, build: &Value) -> Imported {
    let career = save.get("career");
    Imported {
        // A save writes the UNLIMITED stored value, so no limiter is applied here (`save.js:342-346`).
        max_health: Fact::of(finite(save, "maxHealth")),
        max_magicka: Fact::of(
            finite(save, "maxMagicka").or_else(|| finite(save, "maxSpellPoints")),
        ),
        health: Fact::of(finite(save, "health")),
        magicka: Fact::of(finite(save, "magicka").or_else(|| finite(save, "spellPoints"))),
        level: Fact::of(finite(save, "level")),
        // PERMANENT stats: the vendor reads `entity.stats?.endurance`, never `liveStat` (`renownLayer.js:84`).
        endurance: Fact::of(finite(save.get("stats"), "endurance")),
        hit_points_per_level: Fact::of(finite(career, "hitPointsPerLevel")),
        spell_point_bitfield: Fact::of(finite(career, "abilityFlagsAndSpellPointsBitfield")),
        intelligence: Fact::of(live_intelligence(build)),
        // The normalized build's own reads: a raw save has `items`/`equipSlots`, never `worn` (`src/save.js:251-259`).
        worn: build.get("worn").items().to_vec(),
        enchant_mods: build.get("_enchantMods").clone(),
    }
}

/// `liveStat(entity, 'intelligence')` (`src/save.js:167-181`), which the Spell-Points accessor reads. Used by
/// [`spell_points_from_career`] only, never by the maxima.
fn live_intelligence(ch: &Value) -> Option<f64> {
    let base = ch.get("stats").get("intelligence").finite_or(0.0);
    let mut m = 0.0;
    for a in ch.get("activeEffects").items() {
        if !a.truthy() || a.get("ended").truthy() {
            continue;
        }
        let names = a.get("stat").is_str("intelligence");
        match a.get("kind").as_str() {
            Some("disease" | "poison" | "artifact") => {
                m += a.get("statMods").get("intelligence").num_or(0.0);
            }
            Some("racialOverride") => {
                let v = a.get("statMods").get("intelligence").num_or(0.0);
                if v > 0.0 {
                    m += v;
                }
            }
            Some("fortifyAttribute") if names => m += a.get("magnitude").num_or(0.0),
            Some("drainAttribute" | "transferAttribute") if names => {
                m -= a.get("magnitude").num_or(0.0)
            }
            _ => {}
        }
    }
    m += ch.get("_mods").get("stats").get("intelligence").num_or(0.0);
    let max_mod = js_max(
        0.0,
        ch.get("_mods")
            .get("statMax")
            .get("intelligence")
            .num_or(0.0),
    );
    let v = js_max(0.0, js_min(100.0 + max_mod, base + m));
    v.is_finite().then_some(v)
}

// ── The online terms: the caller's, because a save keeps none ─────────

/// The online terms over the maxima (`systems/renownLayer.js:15-23`: a save keeps none). A term left `None` is 0 - the
/// vendor's own "never negative" answer (`systems/renownLayer.js:44-57`) - which is exactly right for a save import
/// (Renown 1, no Spire, no folds).
///
/// `composed` marks a layer read from a LIVE entity's already-composed `renownHp` ([`Layer::laid`]): that field already
/// holds the sky's share and the floor, so pairing it with a real [`Sky`] would count them twice. [`vitals`] and
/// [`health_layer`] answer `Unknown` for that mix rather than a wrong number.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Layer {
    /// Renown's health bonus alone (`systems/renownLayer.js:45`).
    pub renown_hp: Option<f64>,
    /// The Spire's Stoneskin (`systems/renownLayer.js:47`).
    pub spire_hp: Option<f64>,
    /// Renown's magicka (`systems/renownLayer.js:51`).
    pub renown_mp: Option<f64>,
    /// The folds' magicka (`systems/renownLayer.js:54-57`).
    pub fold_mp: Option<f64>,
    /// True only for [`Layer::laid`]: `renown_hp` is the entity's whole composed layer, sky and floor included.
    pub composed: bool,
}

impl Layer {
    /// An entity's ALREADY composed layer: `renownHp` (Renown + sky + floor), `spireHp`, `renownMp`. Pair with
    /// [`Sky::asleep`]; a real sky beside it is refused as `Unknown` rather than double-counted.
    pub fn laid(entity: &Value) -> Layer {
        Layer {
            renown_hp: finite(entity, "renownHp"),
            spire_hp: finite(entity, "spireHp"),
            renown_mp: finite(entity, "renownMp"),
            fold_mp: None,
            composed: true,
        }
    }
}

fn whole_of(v: Option<f64>) -> f64 {
    match v {
        Some(n) if n.is_finite() && n > 0.0 => n.trunc(),
        _ => 0.0,
    }
}

/// The online Health layer (`systems/renownLayer.js:85`): `renown + spire + sky + even`, or `Unknown` for a composed
/// layer mixed with a real sky (a term would be counted twice) and for any [`Fact::Unknown`] term.
pub fn health_layer(layer: &Layer, sky: &Sky) -> Fact {
    if layer.composed && !sky.is_asleep() {
        return Fact::Unknown;
    }
    match (sky.hp, sky.even) {
        (Fact::Known(hp), Fact::Known(even)) => {
            Fact::Known(whole_of(layer.renown_hp) + whole_of(layer.spire_hp) + hp + even)
        }
        _ => Fact::Unknown,
    }
}

/// The online Spell-Point layer (`systems/renownLayer.js:85`, `:51-57`), with the same unknown propagation.
pub fn magicka_layer(layer: &Layer, sky: &Sky) -> Fact {
    if layer.composed && !sky.is_asleep() {
        return Fact::Unknown;
    }
    match sky.mp {
        Fact::Known(mp) => Fact::Known(whole_of(layer.renown_mp) + whole_of(layer.fold_mp) + mp),
        Fact::Unknown => Fact::Unknown,
    }
}

// ── Composition ──────────────────────────────────────────────────────

/// The maximum Health and Spell Points, plus the saved current pools. Every field is a [`Fact`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Vitals {
    /// The maximum a GUI prints: `stored + online`.
    pub health: Fact,
    pub stored_health: Fact,
    pub online_health: Fact,
    pub magicka: Fact,
    pub stored_magicka: Fact,
    pub online_magicka: Fact,
    /// The saved current pools, kept apart from the maxima.
    pub snapshot: Snapshot,
}

/// The current pools a save stores: a snapshot, not a maximum.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Snapshot {
    pub health: Fact,
    pub magicka: Fact,
}

fn add(a: Fact, b: Fact) -> Fact {
    match (a, b) {
        (Fact::Known(x), Fact::Known(y)) => Fact::Known(x + y),
        _ => Fact::Unknown,
    }
}

/// The maxima, composed once: `stored + renown + spire + sky + even` for Health and `stored + renown + folds + sky` for
/// Spell Points, floored at 0 exactly as the accessors are. A term the vendor cannot state stays `Unknown`.
pub fn vitals(facts: &Imported, layer: &Layer, sky: &Sky) -> Vitals {
    let online_health = health_layer(layer, sky);
    let online_magicka = magicka_layer(layer, sky);
    Vitals {
        health: add(facts.max_health, online_health),
        stored_health: facts.max_health,
        online_health,
        // `systems/chargen.js:414`: the accessor floors at 0.
        magicka: add(facts.max_magicka, online_magicka).map_known(|v| js_max(0.0, v)),
        stored_magicka: facts.max_magicka,
        online_magicka,
        snapshot: Snapshot {
            health: facts.health,
            magicka: facts.magicka,
        },
    }
}

/// The effective maximum Spell Points after a gear edit, as a whole [`Imported`], so the unknown reaches everything that
/// depends on it - including the Firmament's Spell-Point share, which is a percentage of this base.
///
/// An ExtraSpellPts row adds +75 only while its season/moon/affinity condition holds (`systems/enchantments.js:604-619`),
/// and the save never records which rows were active. If the edit leaves the worn ExtraSpellPts rows exactly as they were,
/// the save's base stands; if it changes them, the effective base is genuinely unknown, so this copy carries
/// `max_magicka: Unknown`, and [`firmament_layer`] then yields `Sky { mp: Unknown }` and [`vitals`] `magicka: Unknown`
/// rather than the stale pre-edit number.
impl Imported {
    /// This import re-worn: `worn` becomes `edited_worn`, and `max_magicka` stays or becomes `Unknown` as above.
    pub fn after_gear(&self, edited_worn: &[Value]) -> Imported {
        let changed = extra_spell_pts_rows(&self.worn) != extra_spell_pts_rows(edited_worn);
        Imported {
            max_magicka: if changed {
                Fact::Unknown
            } else {
                self.max_magicka
            },
            worn: edited_worn.to_vec(),
            ..self.clone()
        }
    }
}

/// `ENCHANTMENT_TYPES.ExtraSpellPts` is 3 (`formats/magicDef.js`); the rows a piece wears, as `(type, param)`.
fn extra_spell_pts_rows(worn: &[Value]) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for item in worn {
        for e in item.get("enchantments").items() {
            if e.get("type").strict_eq(&Value::Num(3.0)) {
                out.push((3.0, e.get("param").finite_or(f64::NAN)));
            }
        }
    }
    out.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

// ── The Firmament's channels ────────────────────────────────────────

/// `capAt` (`systems/firmamentPowers.js:121-124`): a channel's value held to its budget.
pub fn cap_at(key: &str, v: f64) -> f64 {
    match crate::firmament_law::stat_def(key) {
        Some(d) => js_max(d.min, js_min(d.max, v)),
        None => v,
    }
}

/// `pctOf` (`net/firmament/firmamentLaw.js:229`): `pct` percent of a positive finite base, floored.
pub fn pct_of(base: f64, pct: f64) -> f64 {
    if base.is_finite() && base > 0.0 && pct > 0.0 {
        (base * pct / 100.0).floor()
    } else {
        0.0
    }
}

/// `hitPointsModifier` (`systems/chargen.js:214`): `floor(endurance / 10) - 5`.
pub fn hit_points_modifier(endurance: f64) -> f64 {
    (endurance / 10.0).floor() - 5.0
}

/// `averageLevelHp` (`systems/levelEven.js:26-29`).
pub fn average_level_hp(h: f64, endurance: f64) -> f64 {
    (h.trunc() / 2.0 + h) / 2.0 + hit_points_modifier(endurance)
}

/// `evenHpFloor` (`systems/levelEven.js:30-37`).
pub fn even_hp_floor(h: f64, level: f64, endurance: f64) -> f64 {
    if !(h > 0.0 && level >= 1.0 && endurance.is_finite()) {
        return 0.0;
    }
    (25.0 + h + (level.trunc() - 1.0) * js_max(1.0, average_level_hp(h, endurance))).floor()
}

/// `evenHpOf` (`systems/levelEven.js:39-45`): the floor's health over the stored maximum, whole, never negative.
pub fn even_hp_of(stored: f64, h: f64, level: f64, endurance: f64) -> f64 {
    js_max(0.0, even_hp_floor(h, level, endurance) - stored)
}

/// The Firmament's own contribution, as `setOnlineLayerExtra` takes it (`systems/renownLayer.js:108-117`). The default is
/// the sky asleep, which adds nothing (`systems/firmamentLive.js:34-37`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sky {
    pub hp: Fact,
    pub mp: Fact,
    /// `evenHpOf(stored, permanent Endurance + the stars' Endurance)` (`systems/renownLayer.js:84`).
    pub even: Fact,
}

impl Sky {
    /// The sky asleep: every channel 0, which is what a character with no tree in force has.
    pub fn asleep() -> Sky {
        Sky {
            hp: Fact::Known(0.0),
            mp: Fact::Known(0.0),
            even: Fact::Known(0.0),
        }
    }

    fn is_asleep(&self) -> bool {
        self == &Sky::asleep()
    }
}

impl Default for Sky {
    fn default() -> Self {
        Sky::asleep()
    }
}

/// The Firmament's layer over the imported facts and the law's capped totals, exactly as `firmamentPowers.js:253-273`
/// composes it:
///
/// ```text
/// end        = capAt("endurance", totals.endurance + pctOf(stats.endurance, totals["pct.endurance"]))
/// floored    = maxHealth + evenHpOf(maxHealth, level, stats.endurance + end)
/// hp         = capAt("hp", totals.hp + pctOf(floored, totals.hpPct))
/// mp         = capAt("mp", totals.mp + pctOf(maxMagicka, totals.mpPct))
/// ```
///
/// **Every base is the PERMANENT `entity.stats`** (`firmamentPowers.js:128`, `renownLayer.js:84`), never the live value,
/// so a fortify effect cannot move the floor or the share. An absent fact yields `Fact::Unknown` for that channel.
pub fn firmament_layer(facts: &Imported, totals: &Value) -> Sky {
    let read = |key: &str| totals.get(key).finite_or(0.0);
    let endurance = facts.endurance.value();
    let end = match endurance {
        Some(e) => cap_at(
            "endurance",
            read("endurance") + pct_of(e, read("pct.endurance")),
        ),
        None => f64::NAN,
    };
    let hp = match (
        facts.max_health.value(),
        facts.hit_points_per_level.value(),
        facts.level.value(),
        endurance,
    ) {
        (Some(stored), Some(h), Some(level), Some(e)) => {
            let floored = stored + even_hp_of(stored, h, level, e + end);
            cap_at("hp", read("hp") + pct_of(floored, read("hpPct")))
        }
        _ => f64::NAN,
    };
    let mp = match facts.max_magicka.value() {
        Some(base) => cap_at("mp", read("mp") + pct_of(base, read("mpPct"))),
        None => f64::NAN,
    };
    // `setOnlineLayerExtra` (`systems/renownLayer.js:110-112`): whole, never negative, and NaN stays Unknown.
    let even = if end.is_finite() {
        match (
            facts.max_health.value(),
            facts.hit_points_per_level.value(),
            facts.level.value(),
            endurance,
        ) {
            (Some(stored), Some(h), Some(level), Some(e)) => {
                Fact::Known(even_hp_of(stored, h, level, e + end))
            }
            _ => Fact::Unknown,
        }
    } else {
        Fact::Unknown
    };
    Sky {
        hp: Fact::of((hp.is_finite()).then(|| js_max(0.0, hp.trunc()))),
        mp: Fact::of((mp.is_finite()).then(|| js_max(0.0, mp.trunc()))),
        even,
    }
}

/// The Firmament's armour star on all seven parts (`systems/firmamentPowers.js:158-159`), held to its budget. All zeros
/// with the sky asleep; `Unknown` totals read 0 because the channel is genuinely absent (`statDef` answers 0 anyway).
pub fn firmament_armor_parts(totals: &Value) -> [f64; 7] {
    [cap_at("armor", totals.get("armor").finite_or(0.0)); 7]
}

// ── Armour, by body part ────────────────────────────────────────────

fn as_item(v: &Value) -> crate::target::Item {
    let opt = |v: &Value| (!v.is_nullish()).then(|| v.num_or(f64::NAN));
    crate::target::Item {
        is_armor: v.get("group").is_str("Armor"),
        template_index: opt(v.get("templateIndex")),
        material: opt(v.get("material")),
        artifact: v.get("artifact").truthy(),
        max_condition: opt(v.get("maxCondition")),
        current_condition: opt(v.get("currentCondition")),
    }
}

/// `armorBodyParts(item)` (`systems/equip.js:452-458`), through the vendored port.
pub fn armor_body_parts_of(item: &Value) -> Vec<f64> {
    crate::vendored::armor_body_parts(Some(&as_item(item)))
}

fn is_shield(item: &Value) -> bool {
    crate::vendored::is_shield_template(as_item(item).template_index)
}

fn clothing_footwear(item: &Value) -> bool {
    let t = item.get("templateIndex").finite_or(f64::NAN);
    (item.get("group").is_str("MensClothing") && (147.0..=149.0).contains(&t))
        || (item.get("group").is_str("WomensClothing") && (186.0..=188.0).contains(&t))
}

/// The seven struck-part armour values of a worn set (`UpdateEquippedArmorValues`, `systems/equip.js:416-491`). Two
/// pieces claiming one slot: the equip table keeps the first (`fillEquipTable`, `:360-368`).
pub fn armor_values(worn: &[Value]) -> [f64; 7] {
    let mut av = [100.0_f64; 7];
    let mut claimed = [false; 27];
    for item in worn {
        let slot = item.get("equipSlot");
        if slot.is_nullish() {
            continue;
        }
        let slot = slot.to_number();
        if !(slot.is_finite() && slot.trunc() == slot && (0.0..27.0).contains(&slot)) {
            continue;
        }
        let slot = slot as usize;
        if claimed[slot] {
            continue;
        }
        claimed[slot] = true;
        let is_armor = item.get("group").is_str("Armor");
        let footwear = clothing_footwear(item);
        if !is_armor && !footwear {
            continue;
        }
        let value = crate::vendored::item_armor_value(Some(&as_item(item))) * 5.0;
        if !is_armor {
            av[BODY_PARTS.feet as usize] -= value;
        } else if is_shield(item) {
            for part in armor_body_parts_of(item) {
                av[part as usize] -= value;
            }
        } else {
            let mut parts = armor_body_parts_of(item);
            if parts.is_empty() && footwear {
                parts.push(BODY_PARTS.feet);
            }
            for part in parts {
                av[part as usize] -= value;
            }
        }
    }
    av
}

/// The paperdoll's armour rating by body part (`systems/equip.js:422-423`: `(100 - av) / 5`). DOCUMENTED: that line is a
/// C# cite, not executable here.
pub fn armor_rating(values: &[f64; 7]) -> [f64; 7] {
    let mut out = [0.0_f64; 7];
    for (i, v) in values.iter().enumerate() {
        out[i] = (100.0 - v) / 5.0;
    }
    out
}

/// The loot-rarity armour affix's points by body part (`systems/loot/lootRarity.js:2386`).
pub fn affix_armor_points(worn: &[Value]) -> [f64; 7] {
    let mut out = [0.0_f64; 7];
    for item in worn {
        for a in crate::gear_lines::valid_item_lines(item) {
            if !a.get("id").is_str("armor") {
                continue;
            }
            let v = crate::round::to_int32(a.get("value").to_number());
            for part in armor_body_parts_of(item) {
                out[part as usize] += f64::from(v);
            }
        }
    }
    out
}

/// The `armorParts` fold (`systems/entityMods.js:187-204`): the gear affixes plus the Firmament's armour star, summed
/// ONCE. A caller with no tree in force passes `[0.0; 7]`.
pub fn armor_fold_parts(worn: &[Value], firmament: &[f64; 7]) -> [f64; 7] {
    let affixes = affix_armor_points(worn);
    let mut out = [0.0_f64; 7];
    for i in 0..7 {
        out[i] = affixes[i] + firmament[i];
    }
    out
}

/// `entityArmorDisplayMod` (`systems/entityMods.js:200-204`), the vendored term, exactly:
/// `Decreased - Increased + armorParts[part]`. This is the differentially proven part.
pub fn armor_display_mod(enchant: &Value, fold: &[f64; 7]) -> [f64; 7] {
    let mods = enchant.get("decreasedArmorMod").finite_or(0.0)
        - enchant.get("increasedArmorMod").finite_or(0.0);
    let mut out = [0.0_f64; 7];
    for i in 0..7 {
        out[i] = mods + fold[i];
    }
    out
}

/// The paperdoll's armour by body part, the one documented composition: the worn pieces' protection
/// `(100 - armorValues[part]) / 5` (DOCUMENTED, a C# cite at `systems/equip.js:422-423`) plus
/// [`armor_display_mod`] (differentially proven). `fold` is folded exactly once.
pub fn armor_display(worn: &[Value], enchant: &Value, fold: &[f64; 7]) -> [f64; 7] {
    let rating = armor_rating(&armor_values(worn));
    let mods = armor_display_mod(enchant, fold);
    let mut out = [0.0_f64; 7];
    for i in 0..7 {
        out[i] = rating[i] + mods[i];
    }
    out
}

// ── The career Spell-Points formula (documentation of the base, not the save's read) ──

/// `spellPointMultiplier` (`systems/chargen.js:204-207`).
pub fn spell_point_multiplier(bitfield: f64) -> f64 {
    const TABLE: &[(f64, f64)] = &[
        (0.0, 3.0),
        (4.0, 2.0),
        (8.0, 1.75),
        (12.0, 1.5),
        (16.0, 1.0),
        (20.0, 0.5),
    ];
    let key = f64::from((crate::round::to_int32(bitfield) & 0x1c00) >> 8);
    TABLE
        .iter()
        .find(|(k, _)| *k == key)
        .map_or(1.0, |(_, v)| *v)
}

/// `FormulaHelper.SpellPoints` (`combat/formulas.js:127`).
pub fn spell_points(intelligence: f64, multiplier: f64) -> f64 {
    (intelligence * multiplier).floor()
}

/// The accessor's own career base from the imported facts (`systems/chargen.js:404-409`), before `maxMagickaModifier`.
/// This is NOT the save's maximum: `maxMagickaModifier` is not saved, so this exists only to explain or check the base,
/// and [`Imported::max_magicka`] is what a GUI shows.
pub fn spell_points_from_career(facts: &Imported) -> Fact {
    match (
        facts.intelligence.value(),
        facts.spell_point_bitfield.value(),
    ) {
        (Some(intelligence), Some(bitfield)) => Fact::Known(spell_points(
            // `liveStat` clamps to 0..=100 (`src/save.js:167-181`), and the accessor reads that clamped value.
            intelligence.min(100.0),
            spell_point_multiplier(bitfield),
        )),
        _ => Fact::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Value::{Arr, Num, Obj, Str};

    fn s(text: &str) -> Value {
        Str(text.to_owned())
    }

    fn obj<const N: usize>(pairs: [(&str, Value); N]) -> Value {
        let mut out = Obj(vec![]);
        for (k, v) in pairs {
            out.set(k, v);
        }
        out
    }

    /// A worn piece as a raw save holds it: `items[]` with `equipSlot`, or a live `equipSlots` entry (`src/save.js:251-259`).
    fn raw_item(group: &str, template: f64, material: f64, slot: f64) -> Value {
        obj([
            ("group", s(group)),
            ("templateIndex", Num(template)),
            ("material", Num(material)),
            ("equipSlot", Num(slot)),
            ("affixes", Arr(vec![])),
        ])
    }

    /// A save shaped like real upstream: `items[]` carrying `equipSlot`, and NO `worn` (only `character_from_save`
    /// derives that, `src/save.js:251-259`). This is the shape the armour path must survive.
    fn upstream_save(items: Vec<Value>) -> Value {
        obj([
            (
                "career",
                obj([
                    ("hitPointsPerLevel", Num(12.0)),
                    ("abilityFlagsAndSpellPointsBitfield", Num(0x1000 as f64)),
                ]),
            ),
            ("level", Num(10.0)),
            (
                "stats",
                obj([("intelligence", Num(77.0)), ("endurance", Num(60.0))]),
            ),
            ("activeEffects", Arr(vec![])),
            ("health", Num(180.0)),
            ("maxHealth", Num(240.0)),
            ("magicka", Num(40.0)),
            ("maxMagicka", Num(77.0)),
            ("items", Arr(items)),
        ])
    }

    /// The normalized build `save::character_from_save` gives for an upstream save: `worn` derived from `items[].equipSlot`
    /// (`src/save.js:251-305`), `_mods` rebuilt, and its own `max(1, health)` / `0` maximum defaults.
    fn normalized(save: &Value) -> Value {
        let mut ch = crate::save::character_from_save(
            save,
            &obj([
                ("online", crate::value::Value::Bool(true)),
                ("martialPath", crate::value::Value::Undefined),
                ("slot", crate::value::Value::Null),
                ("file", crate::value::Value::Null),
            ]),
        );
        ch.set(
            "_enchantMods",
            obj([("skillMods", Obj(vec![])), ("chanceToHitMod", Num(0.0))]),
        );
        ch
    }

    #[test]
    fn the_import_reads_maxima_from_the_save_and_worn_from_the_build() {
        // ORACLE (vendored `src/save.js` probe): `characterFromSave({health:40})` answers `maxHealth: 40`,
        // `maxMagicka: 0`, and it KEEPS NEITHER `worn`, `rawMaxHealth` nor the limiter on the save. The maxima must come
        // from the raw save, so an absent one is Unknown - never the build's `max(1, health)` / `0`.
        let bare = obj([("health", Num(40.0))]);
        let facts = import_save(&bare, &normalized(&bare));
        assert_eq!(facts.max_health, Fact::Unknown);
        assert_eq!(facts.max_magicka, Fact::Unknown);
        assert_eq!(facts.health, Fact::Known(40.0));
        assert_eq!(facts.magicka, Fact::Unknown);
        assert_eq!(facts.endurance, Fact::Unknown);
        // A real upstream save: `items[]` with `equipSlot` and NO `worn`. The armour list is the BUILD's.
        let save = upstream_save(vec![raw_item("Armor", 102.0, 0.0, 18.0)]);
        assert!(!save.has("worn"));
        let facts = import_save(&save, &normalized(&save));
        assert_eq!(facts.max_health, Fact::Known(240.0));
        assert_eq!(facts.max_magicka, Fact::Known(77.0));
        assert_eq!(facts.endurance, Fact::Known(60.0));
        assert_eq!(facts.hit_points_per_level, Fact::Known(12.0));
        // The worn list is non-empty: the armour path is not silently empty on a real save shape.
        assert_eq!(facts.worn.len(), 1);
        assert_eq!(facts.worn[0].get("equipSlot"), &Num(18.0));
        // A classic save's `spellPoints`/`maxSpellPoints` names are read too (`src/save.js:279-280`).
        let classic = obj([("spellPoints", Num(9.0)), ("maxSpellPoints", Num(99.0))]);
        let facts = import_save(&classic, &normalized(&classic));
        assert_eq!(facts.magicka, Fact::Known(9.0));
        assert_eq!(facts.max_magicka, Fact::Known(99.0));
    }

    #[test]
    fn the_save_max_health_is_the_unlimited_stored_value() {
        // ORACLE: `full:systems/save/save.js:342-346` - a save writes `entity.rawMaxHealth`, and the limiter is not saved.
        // A stray `maxHealthLimiter` in a document (a live entity's, not a save's) must not be applied by this module.
        let save = obj([("maxHealth", Num(240.0)), ("maxHealthLimiter", Num(100.0))]);
        let facts = import_save(&save, &normalized(&save));
        assert_eq!(facts.max_health, Fact::Known(240.0));
    }

    #[test]
    fn the_saved_max_magicka_is_the_offline_accessor() {
        // The save stores the OFFLINE accessor (`offlineVitals`, `systems/renownLayer.js:152-168`): the career base plus
        // the ExtraSpellPts channel, with Renown's and the folds' terms already taken OFF. So it INCLUDES ExtraSpellPts
        // and EXCLUDES the layer, and this module re-adds only the layer's terms (Renown at Renown 1 = 0).
        let save = upstream_save(vec![]);
        let facts = import_save(&save, &normalized(&save));
        assert_eq!(facts.max_magicka, Fact::Known(77.0));
        // Renown 1 / no Spire / no folds: the effective maximum is the save's own.
        let v = vitals(&facts, &Layer::default(), &Sky::asleep());
        assert_eq!(v.magicka, Fact::Known(77.0));
        // A non-zero Renown term is added ON TOP, never inside the save's number.
        let layer = Layer {
            renown_hp: Some(0.0),
            spire_hp: None,
            renown_mp: Some(8.0),
            fold_mp: None,
            composed: false,
        };
        assert_eq!(
            vitals(&facts, &layer, &Sky::asleep()).magicka,
            Fact::Known(85.0)
        );
        // The career formula is a documentation helper and is NOT the save's read: a record whose Wise base would give
        // 231 (x3.00) still reads the stored 77.
        assert_eq!(spell_points(77.0, 3.0), 231.0);
        assert_eq!(facts.max_magicka, Fact::Known(77.0));
    }

    #[test]
    fn the_floor_reads_the_permanent_endurance() {
        // ORACLE: `systems/renownLayer.js:84` reads `entity.stats.endurance`, never `liveStat`. A fortify effect is
        // INVISIBLE to it, so a permanent 60 with a temporary +20 must floor exactly as a permanent 60.
        let mut save = upstream_save(vec![]);
        save.set(
            "activeEffects",
            Arr(vec![obj([
                ("kind", s("fortifyAttribute")),
                ("stat", s("endurance")),
                ("magnitude", Num(20.0)),
            ])]),
        );
        let facts = import_save(&save, &normalized(&save));
        assert_eq!(facts.endurance, Fact::Known(60.0));
        let totals = obj([
            ("hp", Num(28.0)),
            ("hpPct", Num(7.0)),
            ("mp", Num(8.0)),
            ("endurance", Num(13.0)),
            ("pct.endurance", Num(9.0)),
        ]);
        let sky = firmament_layer(&facts, &totals);
        // Even over a stored 240: no floor at 60 or at 60+20, so the share is 28 + floor(240 x 7%) = 44 either way.
        assert_eq!(sky.hp, Fact::Known(44.0));
        assert_eq!(sky.even, Fact::Known(0.0));
        assert_eq!(even_hp_floor(12.0, 10.0, 60.0), 127.0);
        assert_eq!(even_hp_floor(12.0, 10.0, 75.0), 136.0);
        assert_eq!(even_hp_of(100.0, 12.0, 10.0, 75.0), 36.0);
    }

    #[test]
    fn the_sky_is_unknown_not_zero_when_a_fact_is_missing() {
        // A missing permanent Endurance or stored maximum cannot yield a channel: `Unknown`, never 0.
        let totals = obj([("hp", Num(28.0)), ("hpPct", Num(7.0)), ("mp", Num(8.0))]);
        let save = obj([("maxHealth", Num(240.0)), ("maxMagicka", Num(77.0))]);
        let bare = import_save(&save, &normalized(&save));
        let sky = firmament_layer(&bare, &totals);
        assert_eq!(sky.hp, Fact::Unknown);
        assert_eq!(sky.mp, Fact::Known(8.0));
        // And an unknown sky propagates into the maxima rather than becoming 0.
        let v = vitals(&bare, &Layer::default(), &sky);
        assert_eq!(v.online_health, Fact::Unknown);
        assert_eq!(v.health, Fact::Unknown);
        // The sky asleep is the one honest zero when the facts are known.
        let save = upstream_save(vec![]);
        let facts = import_save(&save, &normalized(&save));
        let v = vitals(&facts, &Layer::default(), &Sky::asleep());
        assert_eq!(v.health, Fact::Known(240.0));
        assert_eq!(v.magicka, Fact::Known(77.0));
    }

    #[test]
    fn the_layer_composes_the_vendored_sum_once() {
        // ORACLE (vendored `setRenownLayer` + `setOnlineLayerExtra`): stored 240 + extras {hp 44, mp 8, even 0} reads
        // 284; a laid layer beside a real sky would double-count, so it is Unknown.
        let save = upstream_save(vec![]);
        let facts = import_save(&save, &normalized(&save));
        let sky = Sky {
            hp: Fact::Known(44.0),
            mp: Fact::Known(8.0),
            even: Fact::Known(0.0),
        };
        assert_eq!(health_layer(&Layer::default(), &sky), Fact::Known(44.0));
        assert_eq!(
            vitals(&facts, &Layer::default(), &sky).health,
            Fact::Known(284.0)
        );
        let layer = Layer {
            renown_hp: Some(80.0),
            spire_hp: None,
            renown_mp: Some(11.0),
            fold_mp: None,
            composed: true,
        };
        assert_eq!(health_layer(&layer, &Sky::asleep()), Fact::Known(80.0));
        assert_eq!(health_layer(&layer, &sky), Fact::Unknown);
        let v = vitals(&facts, &layer, &Sky::asleep());
        assert_eq!(v.health, Fact::Known(320.0));
        assert_eq!(v.magicka, Fact::Known(88.0));
    }

    #[test]
    fn a_gear_edit_that_moves_an_extra_spell_points_row_makes_the_workflow_unknown() {
        // LOCAL INVARIANT (no vendored function answers this): an ExtraSpellPts row is active only under a condition the
        // save does not record (`systems/enchantments.js:604-619`). ONE workflow: the changed effective base is Unknown,
        // and the Firmament's Spell-Point share - a percent of that base - and `vitals.magicka` are Unknown with it.
        let row = |param: f64| {
            let mut it = raw_item("Armor", 102.0, 0.0, 18.0);
            it.set(
                "enchantments",
                Arr(vec![obj([("type", Num(3.0)), ("param", Num(param))])]),
            );
            it
        };
        let save = upstream_save(vec![row(2.0)]);
        let facts = import_save(&save, &normalized(&save));
        let totals = obj([
            ("hp", Num(28.0)),
            ("hpPct", Num(7.0)),
            ("mp", Num(8.0)),
            ("mpPct", Num(5.0)),
        ]);
        // The same worn rows: the baseline stands, and so does the sky's share (8 + floor(77 x 5%) = 11).
        let same = facts.after_gear(&[row(2.0)]);
        assert_eq!(same.max_magicka, Fact::Known(77.0));
        assert_eq!(firmament_layer(&same, &totals).mp, Fact::Known(11.0));
        // A different row set: the base is Unknown, and the sky's MP share and the effective maximum follow it.
        let changed = facts.after_gear(&[row(1.0)]);
        assert_eq!(changed.max_magicka, Fact::Unknown);
        assert_eq!(firmament_layer(&changed, &totals).mp, Fact::Unknown);
        assert_eq!(
            vitals(
                &changed,
                &Layer::default(),
                &firmament_layer(&changed, &totals)
            )
            .magicka,
            Fact::Unknown
        );
        // A reordered but equal row set is unchanged: the baseline stands.
        let reordered = upstream_save(vec![row(0.0), row(2.0)]);
        let facts = import_save(&reordered, &normalized(&reordered));
        assert_eq!(
            facts.after_gear(&[row(2.0), row(0.0)]).max_magicka,
            Fact::Known(77.0)
        );
    }

    #[test]
    fn the_armour_path_survives_a_real_upstream_save() {
        // A save with `items[]`+`equipSlot` and no `worn`: the normalized build's list is what the armour readers take,
        // and it is not empty. Before/after a wear, on the SAME seed shape.
        let save = upstream_save(vec![
            raw_item("Armor", 102.0, 0.0, 18.0),
            raw_item("Armor", 109.0, 0.0, 21.0),
        ]);
        let facts = import_save(&save, &normalized(&save));
        assert_eq!(facts.worn.len(), 2);
        // Leather cuirass 15 off the chest; buckler 1 off the left arm and hands.
        assert_eq!(
            armor_values(&facts.worn),
            [100.0, 100.0, 95.0, 85.0, 95.0, 100.0, 100.0]
        );
        let fold = armor_fold_parts(&facts.worn, &[0.0; 7]);
        assert_eq!(fold, [0.0; 7]);
        assert_eq!(armor_display_mod(&facts.enchant_mods, &fold), [0.0; 7]);
        // After a wear the edited build's list replaces it, and the table moves.
        let edited = imported_worn(&normalized(&upstream_save(vec![raw_item(
            "Armor", 102.0, 0.0, 18.0,
        )])));
        let after = facts.after_gear(&edited);
        assert_eq!(after.worn.len(), 1);
        assert_eq!(armor_values(&after.worn)[2], 100.0);
    }

    #[test]
    fn the_module_never_mutates_its_input() {
        let save = upstream_save(vec![raw_item("Armor", 102.0, 0.0, 18.0)]);
        let build = normalized(&save);
        let before = (crate::value::write(&save), crate::value::write(&build));
        let facts = import_save(&save, &build);
        let totals = obj([("hp", Num(28.0)), ("hpPct", Num(7.0)), ("mp", Num(8.0))]);
        let sky = firmament_layer(&facts, &totals);
        let _ = vitals(&facts, &Layer::default(), &sky);
        let _ = facts.after_gear(&facts.worn);
        let _ = armor_values(&facts.worn);
        let _ = armor_fold_parts(&facts.worn, &[1.0; 7]);
        let _ = armor_display(&facts.worn, &facts.enchant_mods, &[1.0; 7]);
        assert_eq!(before.0, crate::value::write(&save));
        assert_eq!(before.1, crate::value::write(&build));
    }

    fn imported_worn(build: &Value) -> Vec<Value> {
        build.get("worn").items().to_vec()
    }

    #[test]
    fn the_budget_holds_a_channel() {
        // ORACLE: `net/firmament/firmamentLaw.js` `statDef`, read through `systems/firmamentPowers.js:121-124`.
        assert_eq!(cap_at("hp", 999.0), 75.0);
        assert_eq!(cap_at("mp", -5.0), 0.0);
        assert_eq!(cap_at("armor", 99.0), 10.0);
        assert_eq!(pct_of(240.0, 5.0), 12.0);
        assert_eq!(pct_of(0.0, 5.0), 0.0);
    }

    #[test]
    fn the_armour_table_is_the_vendored_one() {
        // ORACLE (vendored `equip.js` probes): leather cuirass 15 on the chest, chain pauldron 6 on the left arm,
        // buckler 1 on the left arm and hands, mithril helm 15 on the head, leather boots 15 on the feet.
        let worn = vec![
            raw_item("Armor", 102.0, 0.0, 18.0),
            raw_item("Armor", 105.0, 0x0100 as f64, 15.0),
            raw_item("Armor", 109.0, 0.0, 21.0),
            raw_item("Armor", 107.0, 0x0205 as f64, 12.0),
            raw_item("Armor", 108.0, 0.0, 26.0),
        ];
        assert_eq!(
            armor_values(&worn),
            [25.0, 100.0, 65.0, 85.0, 95.0, 100.0, 85.0]
        );
        assert_eq!(
            armor_rating(&armor_values(&worn)),
            [15.0, 0.0, 7.0, 3.0, 1.0, 0.0, 3.0]
        );
        assert_eq!(
            armor_values(&[raw_item("Armor", 112.0, 0.0, 21.0)]),
            [80.0, 100.0, 80.0, 100.0, 80.0, 80.0, 100.0]
        );
        assert_eq!(
            armor_values(&[raw_item("MensClothing", 147.0, 0.0, 26.0)])[6],
            85.0
        );
        assert_eq!(
            armor_values(&[raw_item("MensClothing", 150.0, 0.0, 26.0)]),
            [100.0; 7]
        );
        assert_eq!(
            armor_values(&[
                raw_item("Armor", 109.0, 0.0, 21.0),
                raw_item("Armor", 112.0, 0.0, 21.0)
            ]),
            [100.0, 100.0, 95.0, 100.0, 95.0, 100.0, 100.0]
        );
    }

    #[test]
    fn the_fold_and_the_display_are_the_vendored_term() {
        // ORACLE: `systems/loot/lootRarity.js:2386`, `systems/firmamentPowers.js:158-159`, `entityMods.js:200-204`.
        let mut cuirass = raw_item("Armor", 102.0, 0.0, 18.0);
        cuirass.set(
            "affixes",
            Arr(vec![obj([("id", s("armor")), ("value", Num(15.0))])]),
        );
        let fold = armor_fold_parts(&[cuirass.clone()], &[2.0; 7]);
        assert_eq!(fold, [2.0, 2.0, 2.0, 17.0, 2.0, 2.0, 2.0]);
        let enchant = obj([
            ("increasedArmorMod", Num(-5.0)),
            ("decreasedArmorMod", Num(0.0)),
        ]);
        assert_eq!(
            armor_display_mod(&enchant, &fold),
            [7.0, 7.0, 7.0, 22.0, 7.0, 7.0, 7.0]
        );
        assert_eq!(armor_display(&[cuirass], &enchant, &fold)[3], 25.0);
        assert_eq!(
            firmament_armor_parts(&obj([("armor", Num(20.0))])),
            [10.0; 7]
        );
    }
}
