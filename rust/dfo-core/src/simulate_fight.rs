//! Seeded ordinary fights (`src/simulateFight.js`). The spellbook is explicit.
#![allow(clippy::neg_cmp_op_on_partial_ord)] // JS rejects NaN in negated guards.
use crate::analyze::{analyze, Analysis, Hands};
use crate::blow_outcomes::{blow_fight_tier, Hand, SamplerIndex, Tier};
use crate::cws::{self, Cast, Caster};
use crate::dual_wield::{off_hand_hold, FLURRY_TICKS, SINGLE_TICKS};
use crate::durability::{self, condition_pct, Owner};
use crate::fight::{at, edited, health_thresholds, num, obj, scenario};
use crate::generated::{
    data::CLASSIC_UPDATE_INTERVAL,
    hands_law::DUAL,
    paperdoll::EQUIP_SLOTS,
    weapon_states::{BOW_DRAWN_HOLD_FRAME, HIT_FRAME_BOW, HIT_FRAME_MELEE, MELEE_NUM_FRAMES},
};
use crate::model_blow::{condition_multiplier, weapon_of, weapon_powers, Carry};
use crate::rng::{check_seed, Rng};
use crate::rolls::Rolls;
use crate::round::{js_max, js_min};
use crate::spells::{Spellbook, MAGIC_ROUND_SECONDS};
use crate::value::Value::{self, Arr, Bool, Null, Num, Str, Undefined};
use std::collections::HashMap;

const PAIR: &str = "simulateFight: Pistolet pair is not supported in Stage 3.2";
const FLURRY_HIT_FRAME: f64 = HIT_FRAME_MELEE - DUAL.flurry_from_frame;
const TAIL_TICKS: f64 = MELEE_NUM_FRAMES.strike_down - HIT_FRAME_MELEE;

fn s(s: &str) -> Value {
    Str(s.into())
}
fn present(v: &Value) -> Value {
    if v.is_nullish() {
        Null
    } else {
        v.clone()
    }
}
fn yes(v: &Value) -> bool {
    matches!(v, Bool(true))
}
fn main(hand: Hand) -> bool {
    hand == Hand::Main
}
fn hand_name(hand: Hand) -> &'static str {
    if main(hand) {
        "main"
    } else {
        "off"
    }
}
fn opposite(hand: Hand) -> Hand {
    if main(hand) {
        Hand::Off
    } else {
        Hand::Main
    }
}
fn off_weapon(probe: &Analysis) -> &Value {
    match &probe.hands {
        Hands::Dual { off_hand, .. } => &off_hand.weapon,
        _ => &Null,
    }
}

#[derive(Debug, Clone)]
pub struct AttackEvent {
    pub t: f64,
    pub hand: Hand,
    pub start: f64,
    pub fresh: bool,
    pub tail: Option<f64>,
    pub hold_ticks: f64,
}

#[derive(Debug)]
enum Timing {
    Single {
        first: f64,
        seconds: f64,
        i: f64,
        ranged: bool,
    },
    Dual {
        main_tick: f64,
        off_tick: f64,
        main_seconds: f64,
        off_seconds: f64,
        burden: f64,
        start: f64,
        hand: Hand,
        first: bool,
        carry: f64,
    },
}

#[derive(Debug)]
pub struct AttackSchedule {
    pub probe: Analysis,
    pub health: f64,
    pub assumptions: Value,
    timing: Timing,
}

impl Iterator for AttackSchedule {
    type Item = AttackEvent;
    fn next(&mut self) -> Option<Self::Item> {
        Some(match &mut self.timing {
            Timing::Single {
                first,
                seconds,
                i,
                ranged,
            } => {
                let t = *first + *i * *seconds;
                *i += 1.0;
                AttackEvent {
                    t,
                    hand: Hand::Main,
                    start: t - *first,
                    fresh: true,
                    tail: (!*ranged).then_some(TAIL_TICKS),
                    hold_ticks: 0.0,
                }
            }
            Timing::Dual {
                main_tick,
                off_tick,
                main_seconds,
                off_seconds,
                burden,
                start,
                hand,
                first,
                carry,
            } => {
                let (t, hold_ticks, duration) = if main(*hand) {
                    let (frame, duration) = if *first {
                        (HIT_FRAME_MELEE, SINGLE_TICKS * *main_tick)
                    } else {
                        (FLURRY_HIT_FRAME, *main_seconds)
                    };
                    (*start + frame * *main_tick, 0.0, duration)
                } else {
                    let (hold, rem) = off_hand_hold(*burden, FLURRY_TICKS, *off_tick, *carry);
                    *carry = rem;
                    (*start + FLURRY_HIT_FRAME * *off_tick, hold, *off_seconds)
                };
                let ev = AttackEvent {
                    t,
                    hand: *hand,
                    start: *start,
                    fresh: *first,
                    tail: Some(TAIL_TICKS),
                    hold_ticks,
                };
                *start += duration;
                *first = false;
                *hand = opposite(*hand);
                ev
            }
        })
    }
}

pub fn create_attack_schedule(
    ch: &Value,
    args: &Value,
    book: &Spellbook,
) -> Result<Option<AttackSchedule>, String> {
    let args = scenario(args);
    if args.get("pair").truthy() || ch.get("_pair").truthy() {
        return Err(PAIR.into());
    }
    let health = num(
        args.get("health"),
        num(args.get("target").get("maxHealth"), 0.0),
    );
    let wants_dual =
        (args.get("dual").truthy() || ch.get("_dual").truthy()) && ch.get("offWeapon").truthy();
    let mut opts = at(&args, health, 1.0);
    if wants_dual {
        opts.set("dual", Bool(true));
    }
    let probe = analyze(ch, &opts, book);
    if wants_dual && matches!(probe.hands, Hands::Pair) {
        return Err(PAIR.into());
    }
    let cad = &probe.cadence;
    let seconds = cad.get("seconds").to_number();
    // mutation: equivalent - analyzed cadence is a positive frame interval or NaN, never zero.
    if !(seconds > 0.0) {
        return Ok(None);
    }
    if !probe.weapon.truthy() {
        return Err("simulateFight: fist scheduling is not supported (the unarmed StrikeLeft eight-tick list is not in the analytical cadence)".into());
    }
    let (timing, assumptions) = if let (true, Hands::Dual { off_hand, schedule }) =
        (wants_dual, &probe.hands)
    {
        // mutation: equivalent - a dual card with positive seconds has two finite positive swing ticks.
        let main_tick = num(cad.get("tick"), 0.0);
        let off_tick = num(off_hand.cadence.get("tick"), main_tick);
        // mutation: equivalent - dual seconds is the sum of two positive finite flurry intervals; both ticks have passed the swing-frame floor.
        if !(main_tick > 0.0) || !(off_tick > 0.0) {
            return Ok(None);
        }
        let main_seconds = num(cad.get("mainSeconds"), FLURRY_TICKS * main_tick);
        let off_seconds = num(cad.get("offSeconds"), FLURRY_TICKS * off_tick);
        // mutation: equivalent - the dual schedule's hold is clamped by the finite off-hand swing tick; the fallback cannot be selected.
        let hold = Num(schedule.hold).finite_or(js_max(0.0, off_seconds / off_tick - FLURRY_TICKS));
        (Timing::Dual { main_tick, off_tick, main_seconds, off_seconds, burden: 1.0 + hold / FLURRY_TICKS,
            start: 0.0, hand: Hand::Main, first: true, carry: 0.0 }, obj([
            ("schedule", s("dual")), ("mainTick", Num(main_tick)), ("offTick", Num(off_tick)),
            ("mainSeconds", Num(main_seconds)), ("offSeconds", Num(off_seconds)), ("offHandHoldTicks", Num(hold)),
            ("firstLead", Num(SINGLE_TICKS * main_tick)), ("flurryLead", Num(main_seconds)),
            ("firstHit", Str(format!("fresh lead at {HIT_FRAME_MELEE} ticks; flurry hit at {FLURRY_HIT_FRAME} tick"))),
            ("note", s("fresh lead, then lead/off flurries with the off hand burden")),
        ]))
    } else {
        let ranged = probe.weapon.get("ranged").truthy();
        let gun = probe.weapon.get("gun").truthy();
        let bow = ranged && !gun;
        let (frame, note) = if gun {
            (1.0, "the shot lands on its own frame 1")
        } else if bow {
            (
                if args.get("bowDrawback").truthy() {
                    HIT_FRAME_BOW
                } else {
                    HIT_FRAME_BOW - BOW_DRAWN_HOLD_FRAME
                },
                "the loose is HIT_FRAME_BOW of the classic draw clock",
            )
        } else {
            (HIT_FRAME_MELEE, "first hit is the melee hit frame")
        };
        let tick = if bow {
            CLASSIC_UPDATE_INTERVAL
        } else {
            num(cad.get("tick"), seconds / SINGLE_TICKS)
        };
        let first = frame * tick;
        (
            Timing::Single {
                first,
                seconds,
                i: 0.0,
                ranged: gun || bow,
            },
            obj([
                ("schedule", s("single")),
                ("interval", Num(seconds)),
                ("firstHit", Num(first)),
                ("hitFrame", Num(frame)),
                ("tick", Num(tick)),
                ("ranged", Bool(ranged)),
                ("bow", Bool(bow)),
                ("gun", Bool(gun)),
                ("note", s(note)),
            ]),
        )
    };
    Ok(Some(AttackSchedule {
        probe,
        health,
        assumptions,
        timing,
    }))
}

pub fn health_segment(bounds: &[f64], share: f64) -> usize {
    bounds[1..]
        .iter()
        .position(|lo| share >= *lo)
        .unwrap_or(bounds.len() - 2)
}

fn horizon(args: &Value) -> f64 {
    num(args.get("maxSeconds"), 3600.0)
}

pub fn summarize(values: &[Value], opts: &Value) -> Value {
    let mut xs: Vec<_> = values
        .iter()
        .filter_map(|v| match v {
            Num(x) if x.is_finite() => Some(*x),
            _ => None,
        })
        .collect();
    if xs.is_empty() {
        return Null;
    }
    // JS `xs.sort((a, b) => a - b)`: every value here is finite (the filter above), so a difference is never NaN and
    // `partial_cmp` is total; `total_cmp` would wrongly order `-0` before `+0` (JS ties them), changing `min`'s sign.
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = xs.len() as f64;
    let mean = xs.iter().fold(0.0, |a, x| a + x) / n;
    let sd = if n > 1.0 {
        (xs.iter().fold(0.0, |a, x| {
            let d = x - mean;
            a + d * d
        }) / (n - 1.0))
            .sqrt()
    } else {
        0.0
    };
    // mutation: equivalent - for n == 1, sd is +0 and sqrt(n) is 1; both arms return +0.
    let se = if n > 1.0 { sd / n.sqrt() } else { 0.0 };
    let q = |key, fallback| match opts.get(key) {
        Undefined => fallback,
        v => v.to_number(),
    };
    let quantile = |p: f64| {
        let i = js_min(n - 1.0, js_max(0.0, ((n - 1.0) * p).floor()));
        if i.is_nan() {
            Undefined
        } else {
            Num(xs[i as usize])
        }
    };
    obj([
        ("n", Num(n)),
        ("mean", Num(mean)),
        ("sd", Num(sd)),
        ("se", Num(se)),
        ("ci95", Num(1.96 * se)),
        ("min", Num(xs[0])),
        ("max", Num(xs[xs.len() - 1])),
        ("median", quantile(0.5)),
        ("p10", quantile(q("p10", 0.1))),
        ("p90", quantile(q("p90", 0.9))),
    ])
}

pub fn wilson_interval(kills: f64, trials: f64, z: f64) -> Value {
    if !(trials > 0.0) {
        return Null;
    }
    let p = kills / trials;
    let den = 1.0 + (z * z) / trials;
    let mid = (p + (z * z) / (2.0 * trials)) / den;
    let half = (z * ((p * (1.0 - p)) / trials + (z * z) / (4.0 * trials * trials)).sqrt()) / den;
    obj([
        ("p", Num(p)),
        ("lo", Num(js_min(p, js_max(0.0, mid - half)))),
        ("hi", Num(js_max(p, js_min(1.0, mid + half)))),
        ("n", Num(trials)),
    ])
}

fn safe_seed(v: &Value) -> Option<f64> {
    match v {
        Num(seed) if check_seed(*seed).is_ok() => Some(*seed),
        _ => None,
    }
}

pub fn paired_fight_seeds(count: &Value, seed: &Value) -> Vec<Value> {
    let n = js_max(0.0, num(count, 0.0).floor()) as usize;
    let mut rng = Rng::new(safe_seed(seed).unwrap_or(0.0)).unwrap();
    let stream = rng.stream_str("seeds").unwrap();
    (0..n).map(|_| Num(f64::from(stream.next_u32()))).collect()
}

#[derive(Debug, PartialEq, Eq, Hash)]
enum TierKey {
    Fixed(usize, Hand),
    Wearing(u64, usize, Hand, u64, u64),
}

struct Distribution {
    tier: Tier,
    sampler: SamplerIndex,
    mid: f64,
    band: f64,
}

/// A cache belongs to one build and scenario. Durability clones never reuse an item id.
#[derive(Default)]
pub struct TierCache {
    tiers: HashMap<TierKey, Distribution>,
    next_item: u64,
}

pub fn create_tier_cache() -> TierCache {
    TierCache::default()
}

impl TierCache {
    fn item_id(&mut self, item: &Value) -> Option<u64> {
        if !item.truthy() {
            return None;
        }
        // mutation: equivalent - item ids are opaque; a stride of two is also injective among the live clones.
        self.next_item += 1;
        Some(self.next_item)
    }
}

fn remove(v: &mut Value, keys: &[&str]) {
    if let Value::Obj(entries) = v {
        entries.retain(|(k, _)| !keys.contains(&k.as_str()));
    }
}

fn slot(hand: Hand) -> f64 {
    if main(hand) {
        EQUIP_SLOTS.right_hand
    } else {
        EQUIP_SLOTS.left_hand
    }
}
fn hand_index(hand: Hand) -> usize {
    usize::from(!main(hand))
}
fn item_broken(item: &Value) -> bool {
    item.get("currentCondition").finite_or(f64::NAN) <= 0.0
}
fn weapon_broken(item: &Value) -> bool {
    // mutation: equivalent - maxCondition == 0 never changes condition in lower_condition, so it cannot contribute a transition at either threshold comparison.
    item.get("maxCondition").to_number() > 0.0 && item_broken(item)
}

struct Durability {
    ids: [Option<u64>; 2],
    items: [Value; 2],
    supplied_broken: [bool; 2],
    owner: Owner,
    breaks: Vec<Value>,
    wear: f64,
    ended: bool,
    worn_indices: [Option<usize>; 2],
    ch_indices: [Option<usize>; 2],
}

impl Durability {
    fn prepare(ch: &mut Value, args: &mut Value, cache: &mut TierCache) -> Self {
        let explicit = !matches!(args.get("weapon"), Undefined);
        let override_item = args.get("weapon").get("item");
        let source = if !explicit {
            ch.get("weapon")
        } else if override_item.truthy() {
            override_item
        } else {
            args.get("weapon")
        };
        // The build's own hand entries, read before `ch` is mutated: `worn` is only rewritten for a hand whose item IS the
        // build's occupant (`src/simulateFight.js:219-226`, `cloneRef`'s identity lookup). An override piece is a fresh
        // clone the JS never puts in `worn`, so its OWN `equipSlot` (a what-if weapon may carry the slot it was minted
        // for - the A2 note at `src/cws.js:217-220`) must never move a worn entry: the reported case was an override
        // with `equipSlot: 4` displacing the ring there and zeroing its potency.
        let occupants = [ch.get("weapon").clone(), ch.get("offWeapon").clone()];
        let mut items = [
            durability::clone_item(source),
            durability::clone_item(ch.get("offWeapon")),
        ];
        // Value inputs have no object references; a worn entry's slot identifies the build's own hand item.
        let worn: Vec<_> = ch
            .get("worn")
            .items()
            .iter()
            .filter(|item| item.truthy())
            .cloned()
            .collect();
        let worn_indices = [Hand::Main, Hand::Off].map(|hand| {
            // The JS maps by identity: only a hand item that IS the occupant (no override for that hand) reaches `worn`.
            let overridden = explicit && main(hand);
            if overridden {
                return None;
            }
            let occ = &occupants[hand_index(hand)];
            let at = occ.get("equipSlot");
            if !occ.truthy() || at.is_nullish() {
                return None;
            }
            worn.iter().position(|w| w.get("equipSlot").strict_eq(at))
        });
        for hand in [Hand::Main, Hand::Off] {
            let item = &mut items[hand_index(hand)];
            if item.truthy() {
                item.set("equipSlot", Num(slot(hand)));
            }
        }
        let ids = items.each_ref().map(|item| cache.item_id(item));
        let dur = Self {
            ids,
            supplied_broken: items.each_ref().map(weapon_broken),
            owner: durability::make_owner(ids[0], ids[1]),
            items,
            breaks: vec![],
            wear: 0.0,
            ended: false,
            worn_indices,
            ch_indices: [Some(0), Some(1)],
        };
        ch.set("worn", Arr(worn));
        ch.set("wraps", durability::clone_item(ch.get("wraps")));
        dur.sync(ch);
        if override_item.truthy() {
            let mut weapon = args.get("weapon").clone();
            weapon.set("item", dur.items[0].clone());
            args.set("weapon", weapon);
        }
        dur
    }

    fn sync(&self, ch: &mut Value) {
        for (i, key) in self.ch_indices.into_iter().zip(["weapon", "offWeapon"]) {
            ch.set(key, i.map_or(Null, |i| self.items[i].clone()));
        }
        let mut worn = ch.get("worn").items().to_vec();
        for (i, index) in self.worn_indices.into_iter().enumerate() {
            if let Some(index) = index {
                worn[index] = self.items[i].clone();
            }
        }
        ch.set("worn", Arr(worn));
    }

    fn index(&self, hand: Hand) -> Option<usize> {
        let id = if main(hand) {
            self.owner.right
        } else {
            self.owner.left
        }?;
        self.ids.iter().position(|key| *key == Some(id))
    }

    #[allow(clippy::too_many_arguments)]
    fn break_item(
        &mut self,
        i: usize,
        t: f64,
        hand: Hand,
        reason: &str,
        amount: f64,
        again: bool,
        after: bool,
    ) {
        let mut event = obj([
            ("t", Num(t)),
            ("hand", s(hand_name(hand))),
            ("reason", s(reason)),
            ("amount", Num(amount)),
            ("item", present(self.items[i].get("name"))),
        ]);
        if after {
            event.set("afterKill", Bool(true));
        }
        if again {
            event.set("again", Bool(true));
        }
        self.breaks.push(event);
    }

    fn wear_item(&mut self, i: usize, amount: f64) -> bool {
        durability::wear_item(
            &mut self.owner,
            self.ids[i].unwrap(),
            &mut self.items[i],
            amount,
        )
    }

    fn conditions(&self, pct: bool) -> Value {
        let val = |it: &Value| {
            if pct {
                condition_pct(it)
            } else {
                present(it.get("currentCondition"))
            }
        };
        obj([("main", val(&self.items[0])), ("off", val(&self.items[1]))])
    }
}

fn bounds(main: &Value, off: &Value, dual: bool, args: &Value) -> Vec<f64> {
    let mut powers = weapon_powers(main, args);
    // mutation: equivalent - callers pass a real off weapon only for a dual schedule; the promotion passes Null with dual false.
    if dual && off.truthy() {
        powers.extend(weapon_powers(off, args));
    }
    health_thresholds(&powers)
}

fn share(hp: f64, pool: f64) -> f64 {
    // mutation: equivalent - hp starts at pool and can only decrease, so its ratio never exceeds 1.
    js_max(0.0, js_min(1.0, hp / pool))
}
fn mid(bounds: &[f64], i: usize) -> f64 {
    (bounds[i] + bounds[i + 1]) / 2.0
}
fn number(v: &Value, key: &str) -> f64 {
    v.get(key).to_number()
}

#[derive(Default)]
struct Segment {
    index: usize,
    hand: Option<Hand>,
    share: f64,
    blows: f64,
    damage: f64,
    cws: f64,
    echo: f64,
    wear: f64,
}

impl Segment {
    fn value(&self) -> Value {
        obj([
            ("segment", Num(self.index as f64)),
            ("hand", s(hand_name(self.hand.unwrap()))),
            ("share", Num(self.share)),
            ("blows", Num(self.blows)),
            ("damage", Num(self.damage)),
            ("cwsDamage", Num(self.cws)),
            ("echoDamage", Num(self.echo)),
            ("wear", Num(self.wear)),
        ])
    }
}

struct FightState {
    hp: f64,
    pool: f64,
    t: f64,
    blows: f64,
    dealt: f64,
    cws: f64,
    dot: f64,
    echo: f64,
    melee: f64,
    casts: f64,
    kills: f64,
    ttk: Option<f64>,
    source: Option<&'static str>,
    last_hand: Hand,
    used: Vec<Segment>,
    trace: Option<Vec<Value>>,
    cws_trace: Option<Vec<Value>>,
}

impl FightState {
    fn new(pool: f64, trace: bool) -> Self {
        Self {
            hp: pool,
            pool,
            t: 0.0,
            blows: 0.0,
            dealt: 0.0,
            cws: 0.0,
            dot: 0.0,
            echo: 0.0,
            melee: 0.0,
            casts: 0.0,
            kills: 0.0,
            ttk: None,
            source: None,
            last_hand: Hand::Main,
            used: vec![],
            trace: trace.then(Vec::new),
            cws_trace: trace.then(Vec::new),
        }
    }

    fn segment(&mut self, index: usize, hand: Hand, share: f64) -> &mut Segment {
        let i = self
            .used
            .iter()
            .position(|seg| seg.index == index && seg.hand == Some(hand))
            .unwrap_or_else(|| {
                self.used.push(Segment {
                    index,
                    hand: Some(hand),
                    share,
                    ..Default::default()
                });
                self.used.len() - 1
            });
        &mut self.used[i]
    }

    fn tick_round(&mut self, at: f64, target: &mut Value, bounds: &[f64], rolls: &mut impl Rolls) {
        cws::tick_active_effects(
            target,
            Some(&mut |n, info| {
                // mutation: equivalent - dot_round calls the hurt sink only for strictly positive damage.
                if !(n > 0.0) {
                    return false;
                }
                let index = health_segment(bounds, share(self.hp, self.pool));
                self.hp = js_max(0.0, self.hp - n);
                self.cws += n;
                self.dot += n;
                self.dealt += n;
                let seg = self.segment(index, self.last_hand, mid(bounds, index));
                seg.damage += n;
                seg.cws += n;
                if let Some(trace) = &mut self.cws_trace {
                    let read = |key| info.map_or(Null, |it| present(it.get(key)));
                    trace.push(obj([
                        ("t", Num(at)),
                        ("round", Bool(true)),
                        ("hand", Null),
                        ("row", Null),
                        ("spell", read("spell")),
                        ("index", read("index")),
                        ("damage", Num(n)),
                        ("remaining", Num(self.hp)),
                        ("kill", Bool(self.hp <= 0.0)),
                    ]));
                }
                if self.hp <= 0.0 {
                    self.ttk = Some(at);
                    self.source = Some("dot");
                }
                self.t = at;
                // mutation: equivalent - tick_active_effects discards dot_round's killed bit; only this callback's state changes determine death.
                self.hp > 0.0
            }),
            rolls,
        );
    }
}

/// Function-valued JS options are supplied as explicit Rust roll sources.
#[derive(Default)]
pub struct FightRolls<'a> {
    pub cws: Option<&'a mut dyn Rolls>,
    pub condition: Option<&'a mut dyn Rolls>,
}

pub fn simulate_fight(ch: &Value, args: &Value, book: &Spellbook) -> Result<Value, String> {
    simulate_fight_cached(
        ch,
        args,
        book,
        &mut create_tier_cache(),
        FightRolls::default(),
    )
}

pub fn simulate_fight_with(
    ch: &Value,
    args: &Value,
    edit: &Value,
    book: &Spellbook,
) -> Result<Value, String> {
    simulate_fight(ch, &edited(args, edit), book)
}

pub fn simulate_fight_cached(
    ch: &Value,
    args: &Value,
    book: &Spellbook,
    cache: &mut TierCache,
    mut rolls: FightRolls<'_>,
) -> Result<Value, String> {
    let mut args = scenario(args);
    remove(&mut args, &["_tierCache"]);
    if args.get("carry").is_nullish() {
        args.set("carry", Bool(true));
    }
    if args.get("pair").truthy() || ch.get("_pair").truthy() {
        return Err(PAIR.into());
    }
    let main_weapon = if matches!(args.get("weapon"), Undefined) {
        weapon_of(ch.get("weapon"), false)
    } else {
        args.get("weapon").clone()
    };
    let off = weapon_of(ch.get("offWeapon"), false);
    if main_weapon.get("ranged").truthy() || off.get("ranged").truthy() {
        return Err("simulateFight: bow and gun builds are not supported on either hand".into());
    }
    let durability = yes(args.get("durability"));
    let mut ch = ch.clone();
    let mut dur = durability.then(|| Durability::prepare(&mut ch, &mut args, cache));
    let Some(mut schedule) = create_attack_schedule(&ch, &args, book)? else {
        return Ok(Null);
    };
    let pool = schedule.health;
    if !(pool > 0.0) {
        return Ok(Null);
    }
    let seed = match args.get("seed") {
        Undefined => 0.0,
        seed => safe_seed(seed).ok_or("simulateFight: seed must be a safe integer")?,
    };
    let mut rng = Rng::new(seed).unwrap();
    let mut blow_stream = rng.stream_str("blow").unwrap().clone();
    let mut cws_stream = rng.stream_str("cws").unwrap().clone();
    let mut condition_stream = durability.then(|| rng.stream_str("condition").unwrap().clone());
    if rolls.cws.is_none() && !matches!(args.get("cwsRolls"), Undefined) {
        return Err("simulateFight: cwsRolls must be a function".into());
    }
    if durability && rolls.condition.is_none() && !matches!(args.get("conditionRolls"), Undefined) {
        return Err("simulateFight: conditionRolls must be a function".into());
    }
    let mut cws_rolls = || match rolls.cws.as_deref_mut() {
        Some(r) => r.roll(),
        None => cws_stream.float(),
    };
    let mut condition_rolls = || match rolls.condition.as_deref_mut() {
        Some(r) => r.roll(),
        None => condition_stream.as_mut().unwrap().float(),
    };
    let mut target = present(&schedule.probe.target);
    if target.truthy() {
        target.set(
            "activeEffects",
            Arr(target.get("activeEffects").items().to_vec()),
        );
    }
    let strike_items = [
        present(schedule.probe.weapon.get("item")),
        present(off_weapon(&schedule.probe).get("item")),
    ];
    let casts_cws = strike_items
        .iter()
        .any(|it| !cws::cws_rows(it, book).is_empty());
    if target.get("relayBody").truthy() || target.get("spareGear").truthy() {
        return Err(
            "simulateFight: relay stand-ins and spareGear targets are not ordinary targets".into(),
        );
    }
    if target.get("isBoss").truthy()
        || !target.get("bossTraits").items().is_empty()
        || target.get("phaseShields").truthy()
        || ["shieldPool", "revenant", "bout", "companion"]
            .iter()
            .any(|k| !target.get(k).is_nullish())
    {
        return Err("simulateFight: the supported target contract is a plain ordinary foe (no boss traits/caps/phase shields/shield pool/revenant/bout/companion)".into());
    }
    if casts_cws && target.get("hitCap").truthy() {
        return Err("simulateFight: a target per-hit cap is not supported with Cast When Strikes (the cast is not capped)".into());
    }
    if casts_cws && !args.get("traits").items().is_empty() {
        return Err("simulateFight: boss `traits` are not supported with Cast When Strikes (the cast ignores them)".into());
    }
    let mut table = Null;
    let occupants = [ch.get("weapon"), ch.get("offWeapon")];
    if durability {
        table = Arr(cws::equip_table_for_fight(
            &ch,
            strike_items.each_ref(),
            occupants,
        )?);
    } else if casts_cws {
        table = Arr(cws::equipped_for_fight(
            &ch,
            strike_items.each_ref(),
            occupants,
        )?);
    }
    let power_opts = obj([
        ("potencyPct", args.get("potencyPct").clone()),
        ("pierce", args.get("pierce").clone()),
    ]);
    let power = |ch: &Value, table: &Value| -> Result<Value, String> {
        if !casts_cws {
            // mutation: equivalent - without a striking CWS row the power record is never read.
            return Ok(obj([("potencyPct", Num(0.0)), ("pierce", Num(0.0))]));
        }
        let mut opts = power_opts.clone();
        opts.set("worn", table.clone());
        Ok(cws::spell_power_inputs(ch, &opts, None)?)
    };
    let mut cws_power = power(&ch, &table)?;
    let mut dual = matches!(schedule.timing, Timing::Dual { .. });
    let mut bounds_now = bounds(
        &schedule.probe.weapon,
        off_weapon(&schedule.probe),
        dual,
        &args,
    );
    let max_seconds = horizon(&args);
    let max_blows = js_max(1.0, num(args.get("maxBlows"), 1000000.0).floor());
    let capped = args.get("damageMode").is_str("capped");
    let mut carry = yes(args.get("carry")).then(crate::model_blow::create_carry_state);
    // mutation: equivalent - cache epochs are opaque and only compared for equality within each globally distinct item id.
    let mut epoch = 0;
    let mut f = FightState::new(pool, yes(args.get("trace")));
    let assumptions = schedule.assumptions.clone();
    let mut clock = 0.0;
    let mut next_round = MAGIC_ROUND_SECONDS;
    let mut next = schedule.next().unwrap();
    // At most one continuous effect is owned by CWS; its JS caster references fightCh.
    let mut joined_dot = false;
    let has_dot = |target: &Value| {
        target
            .get("activeEffects")
            .items()
            .iter()
            .any(|a| a.get("kind").is_str("continuousDamage"))
    };
    // mutation: equivalent - the outer hp guard can admit zero only to the pre-blow hp <= 0 break; the round loop still stops on zero.
    while f.hp > 0.0 && f.blows < max_blows && clock + next.t <= max_seconds {
        let t = clock + next.t;
        // mutation: equivalent - melee gaps are under one 5 s magic round, even after promotion (3 tail + at most 2 hold + 2 fresh-hit ticks, each at most 0.4 s), so a lethal round cannot be followed by another due round here.
        while next_round < t && f.hp > 0.0 {
            f.tick_round(next_round, &mut target, &bounds_now, &mut cws_rolls);
            next_round += MAGIC_ROUND_SECONDS;
        }
        if f.hp <= 0.0 {
            break;
        }
        let hand = if dual { next.hand } else { Hand::Main };
        f.last_hand = hand;
        let item_index = dur.as_ref().and_then(|dur| dur.index(hand));
        if let (Some(dur), None) = (&mut dur, item_index) {
            dur.ended = true;
            break;
        }
        let item = item_index.map_or(&strike_items[hand_index(hand)], |i| {
            &dur.as_ref().unwrap().items[i]
        });
        let share = share(f.hp, pool);
        let index = health_segment(&bounds_now, share);
        // mutation: equivalent - in a durability blow the earlier slot guard ensures a held item; otherwise band is not used as a key or reported.
        let band = if durability && item.truthy() {
            condition_multiplier(&weapon_of(item, false), false)
        } else {
            // mutation: equivalent - the fallback band belongs only to stateless fights, where neither the tier key nor the trace reports the band.
            1.0
        };
        // mutation: equivalent - either offset is an injective relabeling in its own fight; wear and stateless ids never mix.
        let carry_id = item_index.map_or(u64::from(!main(hand)) + 1, |i| i as u64 + 1);
        let key = if let Some(i) = item_index {
            TierKey::Wearing(
                epoch,
                index,
                hand,
                dur.as_ref().unwrap().ids[i].unwrap(),
                band.to_bits(),
            )
        } else {
            TierKey::Fixed(index, hand)
        };
        use std::collections::hash_map::Entry;
        let dist = match cache.tiers.entry(key) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => {
                let mid = mid(&bounds_now, index);
                let mut opts = at(&args, pool, mid);
                opts.set("target", target.clone());
                opts.set("hand", s(hand_name(hand)));
                // mutation: equivalent - setting dual on a single main-hand tier can't trigger dualOff; blow_fight_tier overwrites dual with false after resolving the hand.
                if dual && !args.get("dual").truthy() {
                    opts.set("dual", Bool(true));
                }
                if durability && main(hand) {
                    opts.set("weapon", weapon_of(item, false));
                }
                let tier =
                    blow_fight_tier(&ch, &opts).map_err(|e| format!("simulateFight: {e:?}"))?;
                let sampler =
                    SamplerIndex::new(&tier).map_err(|e| format!("simulateFight: {e:?}"))?;
                e.insert(Distribution {
                    tier,
                    sampler,
                    mid,
                    band,
                })
            }
        };
        let sampled = &dist.tier.outcomes[dist.sampler.sample(blow_stream.float())];
        let outcome = if let Some(resolve) = &dist.tier.carry_resolve {
            resolve.resolve(
                sampled,
                &mut Carry {
                    state: carry.as_mut(),
                    weapon_key: carry_id,
                    loot_key: carry_id,
                },
            )
        } else {
            sampled.clone()
        };
        let blow_damage = if capped { outcome.claim } else { outcome.blow };
        let mut echo_damage = Num(outcome.echo_damage).finite_or(0.0);
        f.t = t;
        f.blows += 1.0;
        let mut wear = 0.0;
        let mut broke_now = false;
        if let (Some(dur), Some(i)) = (&mut dur, item_index) {
            // mutation: equivalent - blow_wear(0) returns zero without rolling, and zero wear is ignored.
            if outcome.strikes_damage > 0.0 {
                wear = durability::blow_wear(outcome.strikes_damage, &mut condition_rolls);
                if wear > 0.0 {
                    let item = &dur.items[i];
                    let before = match item.get("currentCondition") {
                        Num(n) if n.is_finite() => Num(*n),
                        _ => present(item.get("maxCondition")),
                    };
                    let again = item_broken(item);
                    broke_now = dur.wear_item(i, wear);
                    if !before.is_nullish() {
                        wear = js_max(
                            0.0,
                            before.to_number()
                                - present(dur.items[i].get("currentCondition")).to_number(),
                        );
                    }
                    dur.wear += wear;
                    dur.sync(&mut ch);
                    if broke_now {
                        dur.break_item(i, t, hand, "wear", wear, again, false);
                        drop_table_item(&mut table, hand);
                        cws_power = power(&ch, &table)?;
                    }
                }
            }
        }
        let mut cws_damage = 0.0;
        let mut casts_this = 0.0;
        let mut cws_kill = false;
        let mut dot_this = 0.0;
        let mut killed_by_dot = false;
        let mut broke_after_kill = false;
        let item = item_index.map_or(&strike_items[hand_index(hand)], |i| {
            &dur.as_ref().unwrap().items[i]
        });
        if cws::cws_eligible(&target, outcome.strikes_positive, outcome.whole, item, book) {
            for (param, spell) in cws::cws_rows(item, book) {
                let mut row_broke = false;
                let mut killed = false;
                let after = cws_kill;
                let level = num(ch.get("level"), 1.0);
                let potency_pct = number(&cws_power, "potencyPct");
                let pierce = number(&cws_power, "pierce");
                let mut cast = Null;
                if let Some(spell) = spell.filter(|_| !after) {
                    let had_dot = has_dot(&target);
                    cast = cws::resolve_cws_cast(
                        spell,
                        &mut target,
                        &Cast {
                            caster: Caster::Entity(&ch),
                            level,
                            pierce,
                            potency_pct,
                        },
                        &mut cws_rolls,
                        Some(&mut |n, _| {
                            f.hp = js_max(0.0, f.hp - n);
                            f.hp > 0.0
                        }),
                    );
                    joined_dot |= !had_dot && has_dot(&target);
                    cws_damage += number(&cast, "damage") + number(&cast, "dotDamage");
                    dot_this += number(&cast, "dotDamage");
                    casts_this += 1.0;
                    killed = f.hp <= 0.0;
                    if killed {
                        f.hp = 0.0;
                        cws_kill = true;
                        f.kills += 1.0;
                        killed_by_dot = yes(cast.get("dotKill"));
                    }
                }
                let mut bill = 0.0;
                if let (Some(dur), Some(i)) = (&mut dur, item_index) {
                    bill = durability::cws_bill(None); // Spare-gear foes have already been refused.
                    let again = item_broken(&dur.items[i]);
                    row_broke = dur.wear_item(i, bill);
                    dur.sync(&mut ch);
                    if row_broke {
                        if after {
                            broke_after_kill = true;
                        } else {
                            broke_now = true;
                        }
                        dur.break_item(i, t, hand, "cws", bill, again, after);
                        drop_table_item(&mut table, hand);
                        cws_power = power(&ch, &table)?;
                    }
                }
                if let Some(trace) = &mut f.cws_trace {
                    let item = item_index.map_or(&Null, |i| &dur.as_ref().unwrap().items[i]);
                    let mut row = obj([
                        ("t", Num(t)),
                        ("hand", s(hand_name(hand))),
                        ("swing", Num(f.blows)),
                        ("row", Num(param)),
                        ("spell", spell.map_or(Null, |sp| present(sp.get("name")))),
                        ("index", spell.map_or(Null, |sp| present(sp.get("index")))),
                        ("missing", Bool(spell.is_none())),
                        ("casterLevel", Num(level)),
                        (
                            "damage",
                            Num(if cast.truthy() {
                                number(&cast, "damage") + number(&cast, "dotDamage")
                            } else {
                                0.0
                            }),
                        ),
                    ]);
                    if cast.truthy() {
                        for key in [
                            "absorbed",
                            "reflected",
                            "resisted",
                            "deferred",
                            "effects",
                            "dotDamage",
                        ] {
                            row.set(key, cast.get(key).clone());
                        }
                        if yes(cast.get("dotKill")) {
                            row.set("dotKill", Bool(true));
                        }
                    }
                    row.set("kill", Bool(killed));
                    if after {
                        row.set("afterKill", Bool(true));
                        row.set("cast", Bool(false));
                    }
                    for (key, value) in [
                        ("bill", Num(bill)),
                        ("broke", Bool(row_broke)),
                        ("potencyPct", Num(potency_pct)),
                        ("pierce", Num(pierce)),
                        ("condition", present(item.get("currentCondition"))),
                        ("conditionPct", condition_pct(item)),
                    ] {
                        row.set(key, value);
                    }
                    trace.push(row);
                }
                if killed && !durability {
                    break;
                }
            }
        }
        let mut echo_hits = outcome.echo_hits;
        let mut suppressed = false;
        if broke_after_kill {
            suppressed = echo_damage > 0.0;
        } else if broke_now {
            let dur = dur.as_ref().unwrap();
            let ids = dur
                .index(opposite(hand))
                .map_or_else(Vec::new, |i| crate::loot::power_ids_of(&dur.items[i]));
            let mut mask = 0;
            for (i, p) in dist.tier.meta.get("echoPowers").items().iter().enumerate() {
                if p.get("source").is_str("item")
                    && p.get("id").truthy() // mutation: equivalent - item echo entries always have a nonempty string id, and what-if entries have null and cannot match another item's string id.
                    && ids.iter().any(|id| id.strict_eq(p.get("id")))
                {
                    // mutation: equivalent - the unique item echo is always first in echo_powers, at index zero; what-if powers never pass this test.
                    mask |= 1i32 << (i % 32);
                }
            }
            let per_hit = if outcome.echo_hits > 0 {
                outcome.echo_damage / f64::from(outcome.echo_hits)
            } else {
                // mutation: equivalent - zero sampled echo hits implies the sampled mask has no set bits, so the multiplier is zero.
                0.0
            };
            echo_hits = (outcome.echo_mask & mask).count_ones() as i32;
            echo_damage = f64::from(echo_hits) * per_hit;
            suppressed = mask == 0;
        }
        if suppressed {
            echo_damage = 0.0;
        }
        // mutation: equivalent - applying zero changes neither positive hp nor any subsequent echo kill test, and sampled echo damage is nonnegative +0 or positive.
        let echo_applied = if !cws_kill && echo_damage > 0.0 {
            f.hp = js_max(0.0, f.hp - echo_damage);
            echo_damage
        } else {
            0.0
        };
        let echo_kill = echo_applied > 0.0 && f.hp <= 0.0;
        if cws_kill {
            f.source = Some(if killed_by_dot { "dot" } else { "cws" });
        } else if echo_kill {
            f.source = Some("echo");
        }
        // mutation: equivalent - applying +0 leaves positive hp and the amount applied unchanged when the CWS and echo kill guards are both false.
        let melee_damage = if !cws_kill && !echo_kill && blow_damage > 0.0 {
            f.hp = js_max(0.0, f.hp - blow_damage);
            blow_damage
        } else {
            0.0
        };
        f.cws += cws_damage;
        f.dot += dot_this;
        f.echo += echo_applied;
        f.melee += melee_damage;
        f.casts += casts_this;
        let dealt = cws_damage + echo_applied + melee_damage;
        f.dealt += dealt;
        let seg = f.segment(index, hand, dist.mid);
        seg.blows += 1.0;
        seg.damage += dealt;
        seg.cws += cws_damage;
        seg.echo += echo_applied;
        seg.wear += wear;
        if let Some(trace) = &mut f.trace {
            let mut row = obj([
                ("t", Num(t)),
                ("hand", s(hand_name(hand))),
                ("swing", Num(f.blows)),
                ("segment", Num(index as f64)),
                ("share", Num(share)),
                ("damage", Num(melee_damage)),
                ("blowDamage", Num(blow_damage)),
                ("echoDamage", Num(echo_damage)),
                ("echoApplied", Num(echo_applied)),
                ("cwsDamage", Num(cws_damage)),
                ("cwsCasts", Num(casts_this)),
                ("cwsKill", Bool(cws_kill)),
                ("echoKill", Bool(echo_kill)),
                ("meleeApplied", Bool(melee_damage > 0.0)),
                ("strikesPositive", Bool(outcome.strikes_positive)),
                ("strikesDamage", Num(outcome.strikes_damage)),
                ("formulaPositive", Bool(outcome.formula_positive)),
                ("whole", Bool(outcome.whole)),
                ("hit", Bool(outcome.hit)),
                ("crit", Bool(outcome.crit)),
                ("blow", Num(outcome.blow)),
                ("claim", Num(outcome.claim)),
                ("cappedDamage", Num(outcome.capped_damage)),
                ("echoHits", Num(f64::from(echo_hits))),
                ("remaining", Num(js_max(0.0, f.hp))),
            ]);
            if let (Some(dur), Some(i)) = (&dur, item_index) {
                let item = &dur.items[i];
                for (key, value) in [
                    ("wear", Num(wear)),
                    ("broke", Bool(broke_now || broke_after_kill)),
                    ("echoSuppressed", Bool(suppressed)),
                    ("condition", present(item.get("currentCondition"))),
                    ("conditionPct", condition_pct(item)),
                    ("band", Num(band)),
                    ("tierBand", Num(dist.band)),
                    (
                        "equippedAfter",
                        obj([
                            ("main", Bool(dur.owner.right.is_some())),
                            ("off", Bool(dur.owner.left.is_some())),
                        ]),
                    ),
                ] {
                    row.set(key, value);
                }
            }
            trace.push(row);
        }
        if f.hp <= 0.0 {
            f.ttk = Some(t);
            break;
        }
        // mutation: equivalent - on entry this blow hasn't killed, and if the tied round kills, the next round is strictly later than f.t, independently of the hp guard.
        while next_round <= f.t && f.hp > 0.0 {
            f.tick_round(next_round, &mut target, &bounds_now, &mut cws_rolls);
            next_round += MAGIC_ROUND_SECONDS;
        }
        if f.hp <= 0.0 {
            break;
        }
        if broke_now {
            let dur = dur.as_mut().unwrap();
            let Some(i) = dur.index(opposite(hand)) else {
                dur.ended = true;
                break;
            };
            dur.owner = durability::make_owner(dur.ids[i], None);
            dur.items[i].set("equipSlot", Num(slot(Hand::Main)));
            if main(hand) {
                if let Arr(items) = &mut table {
                    if let Some(item) = items.iter_mut().find(|it| in_slot(it, Hand::Off)) {
                        item.set("equipSlot", Num(slot(Hand::Main)));
                    }
                }
            }
            dur.ch_indices = [Some(i), None];
            dur.sync(&mut ch);
            ch.set("_dual", Bool(false));
            dual = false;
            if main(hand) {
                remove(&mut args, &["imprints", "loot", "potentVs"]);
            }
            let weapon = weapon_of(&dur.items[i], false);
            let mut opts = args.clone();
            opts.set("dual", Bool(false));
            opts.set("weapon", weapon.clone());
            let Some(single) = create_attack_schedule(&ch, &opts, book)? else {
                dur.ended = true;
                break;
            };
            // mutation: equivalent - simulate_fight rejects ranged weapons; every melee event supplies a tail, so unwrap_or's fallback is unreachable.
            clock = t
                + (next.tail.unwrap_or(0.0) + next.hold_ticks)
                    * number(&single.assumptions, "tick");
            schedule = single;
            bounds_now = bounds(&weapon, &Null, dual, &args);
            // mutation: equivalent - the epoch is opaque; adding either one or two makes it different from the only earlier epoch.
            epoch += 1;
            cws_power = power(&ch, &table)?;
        }
        next = schedule.next().unwrap();
    }
    while f.hp > 0.0 && next_round <= max_seconds {
        f.tick_round(next_round, &mut target, &bounds_now, &mut cws_rolls);
        next_round += MAGIC_ROUND_SECONDS;
    }
    if joined_dot && durability {
        let mut effects = target.get("activeEffects").items().to_vec();
        for a in effects
            .iter_mut()
            .filter(|a| a.get("kind").is_str("continuousDamage"))
        {
            a.set("caster", ch.clone());
        }
        target.set("activeEffects", Arr(effects));
    }
    let kill = f.ttk.is_some();
    let ended = dur.as_ref().is_some_and(|d| d.ended);
    let end = if kill {
        "kill"
    } else if ended {
        "noWeaponLeft"
    } else if f.blows >= max_blows {
        "blowBudget"
    } else {
        "horizon"
    };
    let broken = dur.as_ref().map_or(0, |d| {
        d.items
            .iter()
            .zip(d.supplied_broken)
            .filter(|(it, start)| !start && weapon_broken(it))
            .count()
    });
    // `[...f.used].sort((a, b) => b.share - a.share)`: every share is a finite threshold midpoint, so a difference is
    // never NaN; `unwrap_or(Equal)` is JS's tie (and keeps `-0`/`+0` equal, as `total_cmp` would not).
    f.used.sort_by(|a, b| {
        b.share
            .partial_cmp(&a.share)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut result = obj([
        ("seed", Num(seed)),
        ("kill", Bool(kill)),
        (
            "killSource",
            if kill {
                s(f.source.unwrap_or("melee"))
            } else {
                Null
            },
        ),
        ("ttk", f.ttk.map_or(Null, Num)),
        ("time", Num(f.t)),
        ("health", Num(pool)),
        ("remainingHealth", Num(js_max(0.0, f.hp))),
        ("overkill", Num(js_max(0.0, f.dealt - pool))),
        ("damageDealt", Num(f.dealt)),
        ("cwsDamage", Num(f.cws)),
        ("dotDamage", Num(f.dot)),
        ("echoDamage", Num(f.echo)),
        ("meleeDamage", Num(f.melee)),
        ("cwsCasts", Num(f.casts)),
        ("cwsKills", Num(f.kills)),
        ("cwsCapable", Bool(casts_cws)),
        ("blows", Num(f.blows)),
        ("endReason", s(end)),
        ("weaponsBroken", Num(broken as f64)),
        ("damageMode", s(if capped { "capped" } else { "uncapped" })),
        (
            "outputDps",
            if f.t > 0.0 { Num(f.dealt / f.t) } else { Null },
        ),
        ("killDps", f.ttk.map_or(Null, |ttk| Num(pool / ttk))),
        (
            "expectedPerSwing",
            if f.blows > 0.0 {
                Num(f.dealt / f.blows)
            } else {
                Null
            },
        ),
        ("segments", Arr(f.used.iter().map(Segment::value).collect())),
        ("schedule", assumptions),
        ("bounds", Arr(bounds_now.into_iter().map(Num).collect())),
        ("target", target),
        ("trace", f.trace.map_or(Null, Arr)),
        ("cwsTrace", f.cws_trace.map_or(Null, Arr)),
        ("durability", Bool(durability)),
    ]);
    result.set(
        "condition",
        dur.as_ref().map_or(Null, |d| d.conditions(false)),
    );
    if let Some(dur) = &dur {
        result.set("conditionPct", dur.conditions(true));
    }
    let (breaks, wear) = dur.map_or((vec![], 0.0), |d| (d.breaks, d.wear));
    result.set("breaks", Arr(breaks));
    result.set("wear", Num(wear));
    result.set("endedByBreak", Bool(ended));
    Ok(result)
}

fn in_slot(item: &Value, hand: Hand) -> bool {
    item.get("equipSlot").strict_eq(&Num(slot(hand)))
}

fn drop_table_item(table: &mut Value, hand: Hand) {
    if let Arr(items) = table {
        items.retain(|it| !in_slot(it, hand));
    }
}

fn summary(rows: &[Value], key: &str) -> Value {
    summarize(
        &rows
            .iter()
            .map(|row| row.get(key).clone())
            .collect::<Vec<_>>(),
        &Undefined,
    )
}

pub fn durability_stats(rows: &[Value]) -> Value {
    let trials = rows.len() as f64;
    let first_distinct = |row: &Value| {
        row.get("breaks")
            .items()
            .iter()
            .position(|b| !b.get("again").truthy())
    };
    let mut times = Vec::new();
    let mut at_risk = Vec::new();
    let mut counts = [0.0; 3];
    let mut with_break = 0.0;
    let (mut wear, mut cws, mut after, mut repeats, mut stopped) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut distinct = 0.0;
    for row in rows {
        let breaks = row.get("breaks").items();
        if let Some(i) = first_distinct(row) {
            with_break += 1.0;
            times.push(breaks[i].get("t").clone());
        } else {
            at_risk.push(row.get("time").clone());
        }
        counts[js_min(2.0, number(row, "weaponsBroken")) as usize] += 1.0;
        for b in breaks {
            if b.get("again").truthy() {
                repeats += 1.0;
            } else {
                distinct += 1.0;
                if b.get("reason").is_str("wear") {
                    wear += 1.0;
                }
                if b.get("reason").is_str("cws") {
                    cws += 1.0;
                }
                if b.get("afterKill").truthy() {
                    after += 1.0;
                }
            }
        }
        if row.get("endReason").is_str("noWeaponLeft") {
            stopped += 1.0;
        }
    }
    let hand = |name| {
        let (raw, pct): (Vec<_>, Vec<_>) = rows
            .iter()
            .filter_map(|r| {
                let raw = r.get("condition").get(name);
                (!raw.is_nullish()).then(|| (raw.clone(), r.get("conditionPct").get(name).clone()))
            })
            .unzip();
        obj([
            ("n", Num(raw.len() as f64)),
            ("raw", summarize(&raw, &Undefined)),
            ("pct", summarize(&pct, &Undefined)),
            (
                "broken",
                Num(raw.iter().filter(|v| v.to_number() <= 0.0).count() as f64),
            ),
        ])
    };
    obj([
        ("trials", Num(trials)),
        ("fightsWithBreak", Num(with_break)),
        (
            "breakProbability",
            wilson_interval(with_break, trials, 1.96),
        ),
        ("timeToFirstBreak", summarize(&times, &Undefined)),
        ("timeAtRiskWithoutBreak", summarize(&at_risk, &Undefined)),
        (
            "weaponsBroken",
            obj([
                ("counts", Arr(counts.into_iter().map(Num).collect())),
                (
                    "mean",
                    Num(if trials > 0.0 {
                        (counts[1] + 2.0 * counts[2]) / trials
                    } else {
                        0.0
                    }),
                ),
            ]),
        ),
        (
            "breakEvents",
            obj([
                ("distinct", Num(distinct)),
                ("byReason", obj([("wear", Num(wear)), ("cws", Num(cws))])),
                ("afterKill", Num(after)),
                ("repeats", Num(repeats)),
            ]),
        ),
        (
            "noWeaponLeft",
            obj([
                ("count", Num(stopped)),
                ("probability", wilson_interval(stopped, trials, 1.96)),
            ]),
        ),
        (
            "endCondition",
            obj([("main", hand("main")), ("off", hand("off"))]),
        ),
    ])
}

fn batch_seeds(args: &Value) -> Vec<Value> {
    if let Arr(seeds) = args.get("seeds") {
        return seeds.clone();
    }
    let count = js_max(1.0, num(args.get("trials"), 1000.0).floor());
    paired_fight_seeds(&Num(count), &Num(num(args.get("seed"), 0.0)))
}

pub fn simulate_fights(ch: &Value, args: &Value, book: &Spellbook) -> Result<Value, String> {
    let seeds = batch_seeds(args);
    if seeds.is_empty() {
        return Err("simulateFights: at least one seed is required".into());
    }
    let mut cache = create_tier_cache();
    let mut opts = args.clone();
    let mut rows = Vec::with_capacity(seeds.len());
    for seed in &seeds {
        opts.set("seed", seed.clone());
        rows.push(simulate_fight_cached(
            ch,
            &opts,
            book,
            &mut cache,
            FightRolls::default(),
        )?);
    }
    drop(cache);
    if rows.iter().any(|r| matches!(r, Null)) {
        return Ok(Null);
    }
    let kills: Vec<_> = rows
        .iter()
        .filter(|r| r.get("kill").truthy())
        .cloned()
        .collect();
    let n = rows.len() as f64;
    let killed = kills.len() as f64;
    let count = |reason| {
        Num(rows
            .iter()
            .filter(|r| r.get("endReason").is_str(reason))
            .count() as f64)
    };
    let ttk = summary(&kills, "ttk");
    Ok(obj([
        ("trials", Num(n)),
        ("seeds", Arr(seeds)),
        ("health", rows[0].get("health").clone()),
        ("kills", Num(killed)),
        ("censored", Num(n - killed)),
        (
            "outcomes",
            obj([
                ("killed", Num(killed)),
                ("noWeaponLeft", count("noWeaponLeft")),
                ("horizonCensored", count("horizon")),
                ("blowBudgetCensored", count("blowBudget")),
            ]),
        ),
        (
            "durability",
            if yes(args.get("durability")) {
                durability_stats(&rows)
            } else {
                Null
            },
        ),
        ("ttk", ttk.clone()),
        ("ttkConditional", ttk),
        ("killProbability", wilson_interval(killed, n, 1.96)),
        ("horizonSeconds", Num(horizon(args))),
        ("damageMode", rows[0].get("damageMode").clone()),
        ("outputDps", summary(&rows, "outputDps")),
        ("killDps", summary(&kills, "killDps")),
        ("damageDealt", summary(&rows, "damageDealt")),
        ("overkill", summary(&rows, "overkill")),
        ("remainingHealth", summary(&rows, "remainingHealth")),
        ("blows", summary(&rows, "blows")),
        ("expectedPerSwing", summary(&rows, "expectedPerSwing")),
        ("rows", Arr(rows)),
    ]))
}

pub fn simulate_fights_with(
    ch: &Value,
    args: &Value,
    edit: &Value,
    book: &Spellbook,
) -> Result<Value, String> {
    simulate_fights(ch, &edited(args, edit), book)
}

pub fn simulate_paired_fights(
    entries: &[Value],
    args: &Value,
    book: &Spellbook,
) -> Result<Value, String> {
    if entries.is_empty() {
        return Err("simulatePairedFights: at least one entry is required".into());
    }
    let seeds = batch_seeds(args);
    let n = seeds.len() as f64;
    let mut opts = Value::Obj(args.entries().to_vec());
    opts.set("seeds", Arr(seeds.clone()));
    let rows = entries
        .iter()
        .map(|e| {
            Ok(obj([
                ("id", e.get("id").clone()),
                ("result", simulate_fights(e.get("ch"), &opts, book)?),
            ]))
        })
        .collect::<Result<_, String>>()?;
    Ok(obj([
        ("seeds", Arr(seeds)),
        ("trials", Num(n)),
        ("rows", Arr(rows)),
    ]))
}
