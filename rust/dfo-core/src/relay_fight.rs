//! Seeded relay fights (`src/relayFight.js`). A batch cache never outlives its scenario.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
use crate::{
    analyze::Hands,
    blow_outcomes::{blow_fight_tier, Hand, SamplerIndex, Tier},
    boss_traits::resist_spell,
    cws::{self, Cast, Caster},
    fight::{at, edited, health_thresholds, num, obj, scenario},
    flow_state::FlowState,
    model_blow::{create_carry_state, echo_chances, weapon_of, weapon_powers, Carry},
    relay_claim::{ClaimResult, Options, RelayClaimEngine},
    rng::{check_seed, Rng},
    rolls::Rolls,
    round::{js_max, js_min, math_round, to_uint32},
    simulate_fight::{
        blow_budget, create_attack_schedule, health_segment, horizon, paired_fight_seeds,
        summarize, wilson_interval,
    },
    spells::{Spellbook, MAGIC_ROUND_SECONDS},
    value::Value::{self, Arr, Bool, Null, Num, Str, Undefined},
};
use std::collections::{hash_map::Entry, HashMap};

fn s(text: &str) -> Value {
    Str(text.into())
}
fn n(value: impl Into<f64>) -> Value {
    Num(value.into())
}
fn yes(v: &Value) -> bool {
    matches!(v, Bool(true))
}
fn hand_name(hand: Hand) -> &'static str {
    if hand == Hand::Main {
        "main"
    } else {
        "off"
    }
}
fn log(rows: Option<Vec<Value>>) -> Value {
    rows.map_or(Null, Arr)
}

const KINDS: [&str; 3] = ["blow", "proc", "dot"];
const SOURCES: [&str; 3] = ["blow", "cws", "dot"];
const RANGED: &str = "simulateRelayFight: bow and gun builds are not supported on either hand until their release/landing timing and ward/Flow behaviour are modelled";
type Cache = HashMap<(usize, Hand, u64), (Tier, SamplerIndex)>;

fn by_kind(xs: [f64; 3]) -> Value {
    obj(std::array::from_fn::<_, 3, _>(|i| (KINDS[i], Num(xs[i]))))
}

struct Ledger {
    engine: RelayClaimEngine,
    claims: [f64; 3],
    dealt: [f64; 3],
    clipped: [f64; 3],
    last_billed: f64,
    source: Option<&'static str>,
    log: Option<Vec<Value>>,
}

impl Ledger {
    fn send(
        &mut self,
        t: f64,
        kind: usize,
        damage: f64,
        hand: Value,
    ) -> Result<Option<ClaimResult>, String> {
        let claim = math_round(damage);
        if !(claim >= 1.0) {
            return Ok(None);
        }
        let r = self.engine.claim(t, claim).map_err(|e| match e {
            crate::relay_claim::ClaimError::Type(m) | crate::relay_claim::ClaimError::Range(m) => m,
        })?;
        self.claims[kind] += 1.0;
        self.dealt[kind] += r.got;
        self.clipped[kind] += r.clipped;
        self.last_billed = js_max(self.last_billed, t);
        if let Some(rows) = &mut self.log {
            rows.push(obj([
                ("t", Num(t)),
                ("kind", s(KINDS[kind])),
                ("hand", hand),
                ("claim", Num(claim)),
                ("got", Num(r.got)),
                ("accepted", Bool(r.accepted)),
                ("reason", s(r.reason.as_str())),
                ("clipped", Num(r.clipped)),
                ("bucket", Num(r.bucket_after)),
                ("tokens", Num(r.tokens_after)),
                ("hp", Num(r.hp_after)),
            ]));
        }
        if self.engine.killed() && self.source.is_none() {
            self.source = Some(SOURCES[kind]);
        }
        Ok(Some(r))
    }
}

fn live_dot(target: &Value) -> bool {
    // mutation: equivalent - extra ticks with no strictly positive continuousDamage rounds neither draw nor make claims, and cannot change an effect seen by a later cast (cast-capable fights already enable the clock).
    target.get("activeEffects").items().iter().any(|a| {
        a.get("kind").is_str("continuousDamage") && a.get("roundsRemaining").to_number() > 0.0
    })
}

fn element(v: &Value) -> Option<usize> {
    match v {
        Num(x) if (0.0..5.0).contains(x) && x.fract() == 0.0 => Some(*x as usize),
        _ => None,
    }
}

struct Rounds<'a> {
    target: Value,
    traits: &'a [Value],
    rolls: &'a mut dyn Rolls,
    shield: f64,
    next: f64,
    enabled: bool,
}

impl Rounds<'_> {
    fn run(
        &mut self,
        ledger: &mut Ledger,
        at: f64,
        inclusive: bool,
        drain: bool,
    ) -> Result<(), String> {
        while self.enabled
            && (self.next < at || (inclusive && self.next == at))
            && !ledger.engine.killed()
            && (!drain || live_dot(&self.target))
        {
            let mut total = 0.0;
            cws::tick_active_effects(
                &mut self.target,
                Some(&mut |damage, info| {
                    // mutation: equivalent - dot_round only calls the sink with strictly positive damage.
                    let resisted = if damage > 0.0 {
                        resist_spell(
                            self.traits,
                            damage,
                            info.and_then(|v| element(v.get("element"))),
                        )
                    } else {
                        damage
                    };
                    total += js_max(0.0, resisted);
                    true
                }),
                &mut || self.rolls.roll(),
            );
            // mutation: equivalent - send rounds zero to zero and returns before touching the ledger.
            if total > 0.0 && self.next >= self.shield && !self.target.get("warded").truthy() {
                ledger.send(self.next, 2, total, Null)?;
            }
            self.next += MAGIC_ROUND_SECONDS;
        }
        Ok(())
    }
}

pub fn simulate_relay_fight(ch: &Value, args: &Value, book: &Spellbook) -> Result<Value, String> {
    simulate_relay_fight_with_rolls(ch, args, book, None)
}

pub fn simulate_relay_fight_with_rolls(
    ch: &Value,
    args: &Value,
    book: &Spellbook,
    rolls: Option<&mut dyn Rolls>,
) -> Result<Value, String> {
    run(ch, args, book, None, rolls)
}

pub fn simulate_relay_fight_with(
    ch: &Value,
    args: &Value,
    edit: &Value,
    book: &Spellbook,
) -> Result<Value, String> {
    simulate_relay_fight(ch, &edited(args, edit), book)
}

fn run(
    ch: &Value,
    args: &Value,
    book: &Spellbook,
    shared: Option<&mut Cache>,
    rolls: Option<&mut dyn Rolls>,
) -> Result<Value, String> {
    let mut args = scenario(args);
    if args.get("carry").is_nullish() {
        args.set("carry", Bool(true));
    }
    let target = args.get("target");
    let spec = target.get("allowance");
    if !spec.truthy() {
        return Ok(Null);
    }
    let health = num(args.get("health"), num(target.get("maxHealth"), 0.0));
    let pool = health / js_max(1.0, num(spec.get("players"), 1.0));
    if !(pool > 0.0) {
        return Ok(Null);
    }
    if yes(args.get("durability")) {
        return Err("simulateRelayFight: relay durability is not supported; omit durability or pass durability: false".into());
    }
    let off = weapon_of(ch.get("offWeapon"), false);
    let main = match args.get("weapon") {
        Undefined => weapon_of(ch.get("weapon"), false),
        w => w.clone(),
    };
    if main.get("ranged").truthy() || off.get("ranged").truthy() {
        return Err(RANGED.into());
    }
    let mut schedule_opts = args.clone();
    schedule_opts.set("health", Num(health));
    let Some(mut schedule) = create_attack_schedule(ch, &schedule_opts, book)? else {
        return Ok(Null);
    };
    let dual = schedule.assumptions.get("schedule").is_str("dual");
    let probe_off = match &schedule.probe.hands {
        Hands::Dual { off_hand, .. } => &off_hand.weapon,
        _ => &Null,
    };
    let main = &schedule.probe.weapon;
    let check_off = if probe_off.is_nullish() {
        &off
    } else {
        probe_off
    };
    // mutation: equivalent - the earlier ranged check examines the same explicit or decoded weapons; analyze's rri variant changes damage, not ranged classification.
    if main.get("ranged").truthy() || check_off.get("ranged").truthy() {
        return Err(RANGED.into());
    }
    let main_powers = weapon_powers(main, &args);
    // mutation: equivalent - only a dual schedule probe can supply a non-null off weapon here; weapon_powers(null, undefined) is empty.
    let off_powers = if dual && probe_off.truthy() {
        weapon_powers(probe_off, &Undefined)
    } else {
        vec![]
    };
    let main_echoes = echo_chances(&main_powers).len();
    let off_echoes = echo_chances(&off_powers).len();
    // mutation: equivalent - the generated off-hand descriptor has at most one item echo and no scenario imprints are appended to it.
    if main_echoes > 1 || off_echoes > 1 {
        return Err(
            "simulateRelayFight: more than one Many Endings power on a hand is not supported"
                .into(),
        );
    }
    if main_echoes + off_echoes > 0 && !yes(target.get("relayBody")) {
        return Err(
            "simulateRelayFight: a relay body is required for Many Endings (echo) support".into(),
        );
    }
    let flow_powers =
        [&main_powers, &off_powers].map(|ps| ps.iter().find(|p| p.get("kind").is_str("flow")));
    let flow_power = flow_powers[0].or(flow_powers[1]);
    let flow_option = |key, default| {
        flow_power.map_or(Num(0.0), |p| {
            let v = p.get(key);
            if v.is_nullish() {
                Num(default)
            } else {
                v.clone()
            }
        })
    };
    let mut flow = FlowState::new(&obj([
        ("max", flow_option("max", 5.0)),
        ("seconds", flow_option("seconds", 6.0)),
    ]));
    let seed = match args.get("seed") {
        Undefined => 0.0,
        Num(seed) if check_seed(*seed).is_ok() => *seed,
        _ => return Err("simulateRelayFight: seed must be a safe integer".into()),
    };
    let mut rng = Rng::new(seed).unwrap();
    let mut blow_stream = rng.stream_str("blow").unwrap().clone();
    let mut cws_stream = rng.stream_str("cws").unwrap().clone();
    if rolls.is_none() && !matches!(args.get("cwsRolls"), Undefined) {
        return Err("simulateRelayFight: cwsRolls must be a function".into());
    }
    let can_share = share_tiers(args.get("carryState"), rolls.is_some());
    let mut default_rolls = move || cws_stream.float();
    let rolls: &mut dyn Rolls = match rolls {
        Some(r) => r,
        None => &mut default_rolls,
    };
    let mut fight_target = target.clone();
    fight_target.set(
        "activeEffects",
        Arr(target.get("activeEffects").items().to_vec()),
    );
    let traits = if args.get("traits").is_nullish() {
        target.get("bossTraits")
    } else {
        args.get("traits")
    };
    let strike_items = [main.get("item").clone(), probe_off.get("item").clone()];
    let casts_cws = strike_items
        .iter()
        .any(|item| !cws::cws_rows(item, book).is_empty());
    let power = if casts_cws {
        let worn = cws::equipped_for_fight(
            ch,
            strike_items.each_ref(),
            [ch.get("weapon"), ch.get("offWeapon")],
        )?;
        cws::spell_power_inputs(
            ch,
            &obj([
                ("potencyPct", args.get("potencyPct").clone()),
                ("pierce", args.get("pierce").clone()),
                ("worn", Arr(worn)),
            ]),
            None,
        )?
    } else {
        Null
    };
    let shield = num(args.get("shieldUntil"), 0.0);
    let level = spec.get("level");
    let mut ledger = Ledger {
        engine: RelayClaimEngine::new(Options {
            level: if matches!(level, Undefined) {
                1.0
            } else {
                level.to_number()
            },
            share: pool,
            fresh: !matches!(args.get("fresh"), Bool(false)),
            shield_until: shield,
            law: None,
        })
        .map_err(|e| e.to_string())?,
        claims: [0.0; 3],
        dealt: [0.0; 3],
        clipped: [0.0; 3],
        last_billed: 0.0,
        source: None,
        log: yes(args.get("trace")).then(Vec::new),
    };
    let flow_by_hand = flow_powers.map(|p| p.is_some());
    let bounds = health_thresholds(&[main_powers, off_powers].concat());
    let max_seconds = horizon(&args);
    let max_blows = blow_budget(&args);
    let mut trace = yes(args.get("trace")).then(Vec::new);
    let mut trace_all = yes(args.get("traceAll")).then(Vec::new);
    let provided = match args.get("events") {
        Undefined => None,
        Arr(events) if yes(args.get("__relayEventsTest")) => Some(events),
        _ => return Err("simulateRelayFight: events is a test-only option (use test/harness/relayEventSeam.mjs)".into()),
    };
    let mut local = Cache::new();
    // Spellbook is a fixed Rust map and cannot have a JS-style overridden get().
    let cache = if can_share {
        shared.unwrap_or(&mut local)
    } else {
        &mut local
    };
    let mut carry = yes(args.get("carry")).then(create_carry_state);
    let mut next_round = Rounds {
        enabled: casts_cws || live_dot(&fight_target),
        target: fight_target,
        traits: traits.items(),
        rolls,
        shield,
        next: MAGIC_ROUND_SECONDS,
    };
    let (
        mut attacks,
        mut warded_attacks,
        mut zero,
        mut rounded_zero,
        mut flow_builds,
        mut last_attack,
    ) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut termination = loop {
        if attacks >= max_blows {
            break "maxBlows";
        }
        let (t, hand, event) = if let Some(events) = provided {
            let Some(event) = events.get(attacks as usize).filter(|e| e.truthy()) else {
                break "schedule";
            };
            let hand = event.get("hand");
            (
                event.get("t").to_number(),
                if hand.is_nullish() {
                    s("main")
                } else {
                    hand.clone()
                },
                Some(event.get("outcome")),
            )
        } else {
            let Some(next) = schedule.next() else {
                break "schedule";
            };
            (next.t, s(hand_name(next.hand)), None)
        };
        if t > max_seconds {
            break "horizon";
        }
        next_round.run(&mut ledger, t, false, false)?;
        if ledger.engine.killed() {
            break "kill";
        }
        attacks += 1.0;
        last_attack = t;
        // mutation: equivalent - positive finite pool is the initial HP and claims never increase HP, so hp / pool cannot exceed 1.
        let share = js_max(0.0, js_min(1.0, ledger.engine.hp() / pool));
        let segment = health_segment(&bounds, share);
        let stacks = flow.stacks_at(t);
        let hand_index = usize::from(hand.is_str("off"));
        let (blow, echo, hit, whole, mask, formula, strikes, tier_stacks, tier_hand) =
            if let Some(e) = event {
                (
                    e.get("blow").to_number(),
                    js_max(0.0, num(e.get("echoDamage"), 0.0)),
                    e.get("hit").clone(),
                    e.get("whole").clone(),
                    e.get("echoMask").clone(),
                    yes(e.get("formulaPositive")),
                    yes(e.get("strikesPositive")),
                    Null,
                    Null,
                )
            } else {
                // mutation: equivalent - either comparison only swaps the opaque keys; tier construction still uses the original hand string.
                let which = if hand_index == 0 {
                    Hand::Main
                } else {
                    Hand::Off
                };
                let key = (segment, which, stacks.to_bits());
                let (tier, sampler) = match cache.entry(key) {
                    Entry::Occupied(e) => e.into_mut(),
                    Entry::Vacant(e) => {
                        let mut opts =
                            at(&args, health, (bounds[segment] + bounds[segment + 1]) / 2.0);
                        opts.set("hand", hand.clone());
                        opts.set("flowStacks", Num(stacks));
                        // mutation: equivalent - a main-hand tier on a single schedule cannot take the dualOff path; on dual schedules args.dual is already true or is promoted.
                        if dual && !args.get("dual").truthy() {
                            opts.set("dual", Bool(true));
                        }
                        let tier = blow_fight_tier(ch, &opts)
                            .map_err(|e| format!("simulateRelayFight: {e:?}"))?;
                        let sampler = SamplerIndex::new(&tier)
                            .map_err(|e| format!("simulateRelayFight: {e:?}"))?;
                        e.insert((tier, sampler))
                    }
                };
                let sampled = &tier.outcomes[sampler.sample(blow_stream.float())];
                let outcome = if let Some(resolve) = &tier.carry_resolve {
                    // mutation: equivalent - +2 is another injective relabeling of both opaque per-hand carry channel keys.
                    let key = hand_index as u64 + 1;
                    resolve.resolve(
                        sampled,
                        &mut Carry {
                            state: carry.as_mut(),
                            weapon_key: key,
                            loot_key: key,
                        },
                    )
                } else {
                    sampled.clone()
                };
                (
                    outcome.blow,
                    0.0,
                    Bool(outcome.hit),
                    Bool(outcome.whole),
                    n(outcome.echo_mask),
                    outcome.formula_positive,
                    outcome.strikes_positive,
                    tier.meta.get("flowStacks").clone(),
                    tier.meta.get("hand").clone(),
                )
            };
        let warded = t < shield;
        if !warded && casts_cws {
            let item = &strike_items[hand_index];
            if cws::cws_eligible(&next_round.target, strikes, yes(&whole), item, book) {
                for (_, spell) in cws::cws_rows(item, book) {
                    let Some(spell) = spell else {
                        continue;
                    };
                    let mut damage = 0.0;
                    cws::resolve_cws_cast(
                        spell,
                        &mut next_round.target,
                        &Cast {
                            caster: Caster::Entity(ch),
                            level: num(ch.get("level"), 1.0),
                            pierce: power.get("pierce").to_number(),
                            potency_pct: power.get("potencyPct").to_number(),
                        },
                        &mut || next_round.rolls.roll(),
                        Some(&mut |amount, _| {
                            damage += amount;
                            true
                        }),
                    );
                    // mutation: equivalent - proof resistance of exactly one point still returns one (the resistance floor).
                    if damage >= 1.0 {
                        damage =
                            resist_spell(next_round.traits, damage, element(spell.get("element")));
                    }
                    // mutation: equivalent - send rounds zero to zero and returns before touching the ledger.
                    if damage > 0.0 {
                        ledger.send(t, 1, damage, hand.clone())?;
                    }
                    if ledger.engine.killed() {
                        break;
                    }
                }
            }
            if ledger.engine.killed() {
                break "kill";
            }
        }
        let mut raw = Null;
        let mut claim = Null;
        let mut result = None;
        let (after, built, reason) = if warded {
            warded_attacks += 1.0;
            (stacks, false, "warded")
        } else {
            let damage = blow + echo;
            raw = Num(damage);
            let fl = flow.hit(
                t,
                // `flow.hit(t, { whole: outcome.whole, ... })` (`src/relayFight.js:352`): a DESTRUCTURING default, so an
                // event outcome with no `whole` key is a whole blow (`flowState.js:24`). A supplied `false`/`null` is
                // not. `truthy()` would make the missing key a non-whole blow, and a whole blow is what refreshes Flow.
                whole.is_nullish() || whole.truthy(),
                formula && (hand.is_str("main") || hand.is_str("off")) && flow_by_hand[hand_index],
            );
            if fl.built {
                flow_builds += 1.0;
            }
            let reason = if !(damage > 0.0) {
                zero += 1.0;
                "zero"
            } else {
                let rounded = math_round(damage);
                if !(rounded >= 1.0) {
                    rounded_zero += 1.0;
                    "rounded-zero"
                } else {
                    claim = Num(rounded);
                    let r = ledger
                        .send(t, 0, damage, hand.clone())?
                        .expect("same host rounding");
                    let why = r.reason.as_str();
                    result = Some(r);
                    why
                }
            };
            (fl.after, fl.built, reason)
        };
        // mutation: equivalent - the inner trace/traceAll guards still decide whether either record is emitted.
        if trace_all.is_some() || (trace.is_some() && result.is_some()) {
            let fields = [
                ("t", Num(t)),
                ("hand", hand),
                ("segment", Num(segment as f64)),
                ("share", Num(share)),
            ];
            let sampled = [
                ("tierStacks", tier_stacks),
                ("tierHand", tier_hand),
                ("hit", hit),
                ("whole", whole),
                ("echoMask", mask.clone()),
                ("echoHits", n(to_uint32(mask.to_number()).count_ones())),
                ("stacksBefore", Num(stacks)),
                ("stacksAfter", Num(after)),
                ("flowUntil", Num(flow.until)),
                ("flowBuilt", Bool(built)),
                ("got", Num(result.as_ref().map_or(0.0, |r| r.got))),
            ];
            let tail = [
                (
                    "accepted",
                    Bool(result.as_ref().is_some_and(|r| r.accepted)),
                ),
                ("reason", s(reason)),
                ("bucket", Num(ledger.engine.bucket())),
                ("tokens", Num(ledger.engine.tokens())),
                ("hp", Num(ledger.engine.hp())),
            ];
            if let Some(rows) = &mut trace_all {
                rows.push(record(
                    fields
                        .iter()
                        .cloned()
                        .chain([
                            ("warded", Bool(warded)),
                            ("raw", raw),
                            ("claim", claim.clone()),
                        ])
                        .chain(sampled.iter().cloned())
                        .chain(tail.iter().cloned()),
                ));
            }
            if let (Some(rows), Some(r)) = (&mut trace, result) {
                rows.push(record(
                    fields
                        .into_iter()
                        .chain([("claim", claim)])
                        .chain(sampled)
                        .chain([
                            ("clipped", Num(r.clipped)),
                            ("bucketClip", Num(r.bucket_clip)),
                            ("capClip", Num(r.cap_clip)),
                            ("healthClip", Num(r.health_clip)),
                        ])
                        .chain(tail),
                ));
            }
        }
        next_round.run(&mut ledger, t, true, false)?;
        if ledger.engine.killed() {
            break "kill";
        }
    };
    next_round.run(&mut ledger, max_seconds, true, true)?;
    let r = ledger.engine.summary();
    if r.killed {
        termination = "kill";
    }
    let time = r.killed_at.unwrap_or_else(|| {
        if termination == "horizon" {
            max_seconds
        } else {
            js_max(last_attack, ledger.last_billed)
        }
    });
    Ok(obj([
        ("seed", Num(seed)),
        ("kill", Bool(r.killed)),
        ("ttk", r.killed_at.map_or(Null, Num)),
        ("time", Num(time)),
        ("claimTime", Num(r.time)),
        ("lastAttackAt", Num(last_attack)),
        ("termination", s(termination)),
        ("censored", Bool(!r.killed)),
        ("censoredAt", if r.killed { Null } else { Num(time) }),
        ("health", Num(pool)),
        ("remainingHealth", Num(r.hp)),
        ("overkill", Num(r.health_clip)),
        ("damageDealt", Num(r.dealt)),
        ("offered", Num(r.offered)),
        ("clipped", Num(r.clipped)),
        ("refusedDamage", Num(r.refused_offer)),
        ("capClip", Num(r.cap_clip)),
        ("bucketClip", Num(r.bucket_clip)),
        ("healthClip", Num(r.health_clip)),
        ("claims", Num(r.claims as f64)),
        ("claimsByKind", by_kind(ledger.claims)),
        ("dealtByKind", by_kind(ledger.dealt)),
        ("clippedByKind", by_kind(ledger.clipped)),
        ("killSource", ledger.source.map_or(Null, s)),
        ("claimLog", log(ledger.log)),
        ("attacks", Num(attacks)),
        ("wardedAttacks", Num(warded_attacks)),
        ("zeroDamage", Num(zero)),
        ("roundedZero", Num(rounded_zero)),
        ("flowBuilds", Num(flow_builds)),
        ("flow", flow.state(time)),
        ("accepted", Num(r.accepted as f64)),
        ("refused", Num(r.refused as f64)),
        ("invalid", Num(r.invalid as f64)),
        ("shielded", Num(r.shielded as f64)),
        ("noToken", Num(r.no_token as f64)),
        ("empty", Num(r.empty as f64)),
        ("saturated", Bool(r.saturated)),
        ("dryAt", r.dry_at.map_or(Null, Num)),
        ("bucket", Num(r.bucket)),
        ("bucketCapacity", Num(r.bucket_capacity)),
        ("tokens", Num(r.tokens)),
        ("tokenCapacity", Num(r.token_capacity)),
        ("remainingShare", Num(r.remaining_share)),
        (
            "outputDps",
            if time > 0.0 {
                Num(r.dealt / time)
            } else {
                Null
            },
        ),
        ("killDps", r.kill_dps.map_or(Null, Num)),
        ("landedShare", Num(r.landed_share)),
        (
            "law",
            obj([
                ("level", level.clone()),
                ("ref", r.reference.map_or(Null, Num)),
                ("depth", Num(r.bucket_capacity)),
                ("rate", Num(r.bucket_rate)),
                ("cap", Num(r.cap)),
                ("hitHz", Num(r.token_rate)),
                ("share", Num(pool)),
            ]),
        ),
        ("schedule", schedule.assumptions),
        ("target", target.clone()),
        ("trace", log(trace)),
        ("traceAll", log(trace_all)),
    ]))
}

fn record<'a>(fields: impl IntoIterator<Item = (&'a str, Value)>) -> Value {
    Value::Obj(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

pub fn simulate_relay_fights(ch: &Value, args: &Value, book: &Spellbook) -> Result<Value, String> {
    simulate_relay_fights_with_rolls(ch, args, book, None)
}

pub fn simulate_relay_fights_with(
    ch: &Value,
    args: &Value,
    edit: &Value,
    book: &Spellbook,
) -> Result<Value, String> {
    simulate_relay_fights(ch, &edited(args, edit), book)
}

pub fn simulate_relay_fights_with_rolls(
    ch: &Value,
    args: &Value,
    book: &Spellbook,
    mut rolls: Option<&mut dyn Rolls>,
) -> Result<Value, String> {
    let seeds = if let Arr(seeds) = args.get("seeds") {
        seeds.clone()
    } else {
        let trials = js_max(1.0, num(args.get("trials"), 1000.0).floor());
        paired_fight_seeds(&Num(trials), &Num(num(args.get("seed"), 0.0)))
    };
    if seeds.is_empty() {
        return Err("simulateRelayFights: at least one seed is required".into());
    }
    let mut cache = Cache::new();
    let mut rows = Vec::with_capacity(seeds.len());
    for seed in &seeds {
        let mut opts = args.clone();
        opts.set("seed", seed.clone());
        let trial_rolls = rolls.as_mut().map(|r| &mut **r as &mut dyn Rolls);
        rows.push(run(ch, &opts, book, Some(&mut cache), trial_rolls)?);
    }
    if rows.iter().any(|r| matches!(r, Null)) {
        return Ok(Null);
    }
    let kills = rows
        .iter()
        .filter(|r| yes(r.get("kill")))
        .collect::<Vec<_>>();
    let summary = |key| {
        summarize(
            &rows.iter().map(|r| r.get(key).clone()).collect::<Vec<_>>(),
            &Undefined,
        )
    };
    let conditional = |key| {
        summarize(
            &kills.iter().map(|r| r.get(key).clone()).collect::<Vec<_>>(),
            &Undefined,
        )
    };
    let count = |key, kind| Num(rows.iter().filter(|r| r.get(key).is_str(kind)).count() as f64);
    let totals = |key| {
        record(KINDS.map(|kind| {
            (
                kind,
                Num(rows
                    .iter()
                    .fold(0.0, |a, r| a + r.get(key).get(kind).to_number())),
            )
        }))
    };
    let ttk = conditional("ttk");
    Ok(obj([
        ("trials", Num(rows.len() as f64)),
        ("seeds", Arr(seeds)),
        (
            "health",
            rows.first().expect("nonempty seeds").get("health").clone(),
        ),
        ("kills", Num(kills.len() as f64)),
        ("censored", Num((rows.len() - kills.len()) as f64)),
        ("ttk", ttk.clone()),
        ("ttkConditional", ttk),
        (
            "killProbability",
            wilson_interval(kills.len() as f64, rows.len() as f64, 1.96),
        ),
        ("horizonSeconds", Num(num(args.get("maxSeconds"), 3600.0))),
        ("time", summary("time")),
        ("claimTime", summary("claimTime")),
        ("lastAttackAt", summary("lastAttackAt")),
        (
            "terminations",
            record(
                ["kill", "horizon", "maxBlows", "schedule"]
                    .map(|kind| (kind, count("termination", kind))),
            ),
        ),
        ("damageDealt", summary("damageDealt")),
        ("offered", summary("offered")),
        ("clipped", summary("clipped")),
        ("refusedDamage", summary("refusedDamage")),
        ("overkill", summary("overkill")),
        ("accepted", summary("accepted")),
        ("refused", summary("refused")),
        ("claims", summary("claims")),
        ("claimsByKind", totals("claimsByKind")),
        ("dealtByKind", totals("dealtByKind")),
        (
            "killSource",
            record(SOURCES.map(|kind| (kind, count("killSource", kind)))),
        ),
        ("wardedAttacks", summary("wardedAttacks")),
        ("zeroDamage", summary("zeroDamage")),
        ("roundedZero", summary("roundedZero")),
        ("flowBuilds", summary("flowBuilds")),
        (
            "flowStacks",
            summarize(
                &rows
                    .iter()
                    .map(|r| r.get("flow").get("stacks").clone())
                    .collect::<Vec<_>>(),
                &Undefined,
            ),
        ),
        ("bucket", summary("bucket")),
        ("tokens", summary("tokens")),
        (
            "saturated",
            Num(rows.iter().filter(|r| yes(r.get("saturated"))).count() as f64),
        ),
        ("outputDps", summary("outputDps")),
        ("killDps", conditional("killDps")),
        ("rows", Arr(rows)),
    ]))
}

fn share_tiers(carry_state: &Value, scripted: bool) -> bool {
    !carry_state.truthy() && !scripted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutable_inputs_disable_batch_cache_independently() {
        let state = obj([]);
        assert!(share_tiers(&Undefined, false));
        assert!(!share_tiers(&state, false));
        assert!(!share_tiers(&Undefined, true));
    }
}
