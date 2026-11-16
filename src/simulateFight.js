/*
 * dfo-dps - seeded, blow-only stochastic fight simulation (Stage 3.2).
 *
 * A fight is a sequence of sampled blows from the Stage 3.1 fight-tier distribution. There is NO second damage formula:
 * each blow is one draw from `blowFightTier` (src/blowOutcomes.js), built with the same `analyze`/`hitModel`/`damageModel`
 * pipeline. The target's health at the moment of the blow selects the distribution: a health-dependent term (axe/blunt
 * mastery at half, venom at half, execute below its threshold) changes the distribution, so a new sampling table is built
 * when the remaining pool crosses one of `healthThresholds`.
 *
 * Scheduling (the model's assumptions are explicit in `assumptions`):
 *
 *   single melee   the attack starts at t=0; the hit lands at HIT_FRAME_MELEE x tick, then one swing every
 *                  `cadence.seconds` (five ticks). The existing `analyze` cadence is the interval.
 *   single ranged  the first hit is one frame into the cycle (`cadence.tick`) and the cycle is
 *                  `cadence.seconds`; the bow/gun host's first-hit frame is not exposed by the analytical cadence.
 *   dual wield     a fresh lead opens (five ticks, hit on frame 2), then the flurry exchange from `dualSchedule`:
 *                  lead (four ticks, hit one tick in), off (four ticks plus the off hand's held burden, hit one tick in).
 *                  This is the sched/order the model already uses for dual DPS; `dualSchedule` is the source.
 *
 * `simulateFight` is one seeded fight. `simulateFights` runs trials and reports the distribution. `simulatePairedFights`
 * runs several builds on the SAME seed list, which is the form a comparison should use. A Pistolet pair is refused:
 * its own machine and reload law are not part of this stage.
 *
 * Included since Stage 3.5.1: Cast When Strikes DIRECT DAMAGE on an ordinary foe, resolved before the melee blow with
 * its own injectable stream. A CWS fight takes no per-hit cap and no scenario boss traits (the cast path knows neither;
 * a melee-only fight supports both). Excluded: relay bucket/token/claim, CWS condition costs and wear, DoTs, other spell
 * families, Flow, ward lifecycle, ranged support, incoming damage, attacker health/death and pair support. The
 * simulation does not pretend those are present.
 */
import { analyze, weaponOf, weaponPowers } from './model.js';
import { blowFightTier, createBlowSampler } from './blowOutcomes.js';
import { cwsEligible, cwsRows, equippedForFight, resolveCwsCast, spellPowerInputs } from './cws.js';
import { createRng } from './rng.js';
import { healthThresholds } from './fight.js';
import { DUAL, FLURRY_TICKS } from './dualWield.js';
import {
  HIT_FRAME_MELEE, HIT_FRAME_BOW, BOW_DRAWN_HOLD_FRAME, CLASSIC_UPDATE_INTERVAL,
} from '../vendor/upstream/a3eb1605/src/characters/weaponStates.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** `with({ imprint })` is the same shorthand `fight()` takes: the power rides the item for the probe and the walk. */
function normalizeScenario(args) {
  const scenario = { ...args };
  if (scenario.imprint) {
    scenario.imprints = [...(scenario.imprints ?? []), scenario.imprint];
    delete scenario.imprint;
  }
  return scenario;
}

/** The first-hit frame of a flurry: the hit frame reached from FLURRY_FROM_FRAME. */
const FLURRY_HIT_FRAME = HIT_FRAME_MELEE - DUAL.FLURRY_FROM_FRAME;
/** The Thunderlock's shot lands on frame 1 (`characters/weaponStates.js:568-570`, the FIELD-GUN7 comment; the full
 *  checkout's `combat/gun/gunFeel.js` says "hit on frame 1", but its vendored binding is an inert stub). */
const GUN_HIT_FRAME = 1;

/**
 * The attack schedule for one build, without sampling. The returned `next()` is a deterministic sequence of
 * `{ t, hand, start, fresh }` hits; `assumptions` says where the timing came from.
 */
export function createAttackSchedule(ch, args = {}) {
  const scenario = normalizeScenario(args);
  if (scenario.pair || ch._pair) throw new Error('simulateFight: Pistolet pair is not supported in Stage 3.2');
  const target = scenario.target ?? null;
  const health = num(scenario.health, num(target?.maxHealth, 0));
  const wantsDual = !!(scenario.dual || ch._dual) && !!ch.offWeapon;
  // A `ch._dual` build is analysed as a pair even when the caller omits `dual`; the probe decides whether the pair is
  // a Pistolet pair (refused) or a melee exchange (supported).
  const probe = analyze(ch, { ...scenario, ...(wantsDual ? { dual: true } : {}), healthShare: 1, health });
  // `analyze` refuses a pair it cannot exchange (a two-handed or gun off hand); the simulator follows the same card
  // rather than alternating hands on a single-weapon analysis.
  const dual = wantsDual && !!probe.offHand && !probe.pair;
  if (wantsDual && probe.pair) throw new Error('simulateFight: Pistolet pair is not supported in Stage 3.2');
  const cad = probe.cadence;
  if (!cad || !(cad.seconds > 0)) return null;
  if (!probe.weapon) {
    throw new Error('simulateFight: fist scheduling is not supported (the unarmed StrikeLeft eight-tick list is not in the analytical cadence)');
  }

  if (!dual) {
    const ranged = !!probe.weapon?.ranged;
    const gun = !!probe.weapon?.gun;
    const bow = ranged && !gun;
    const tick = num(cad.tick, cad.seconds / 5);
    // A melee blow lands on HIT_FRAME_MELEE; a gun on GUN_HIT_FRAME of its own 14 fps clock; a bow looses on
    // HIT_FRAME_BOW of the classic 16 Hz draw clock, from the drawn idle (BOW_DRAWN_HOLD_FRAME) unless BowDrawback is on.
    const hitFrame = gun ? GUN_HIT_FRAME
      : bow ? (scenario.bowDrawback ? HIT_FRAME_BOW : HIT_FRAME_BOW - BOW_DRAWN_HOLD_FRAME)
        : HIT_FRAME_MELEE;
    const clock = bow ? CLASSIC_UPDATE_INTERVAL : tick;
    const first = hitFrame * clock;
    let i = 0;
    return {
      kind: 'single', hand: 'main', probe, target: probe.target, health,
      assumptions: {
        schedule: 'single',
        interval: cad.seconds,
        firstHit: first,
        hitFrame,
        tick: clock,
        ranged,
        bow,
        gun,
        note: gun ? 'the shot lands on its own frame 1'
          : bow ? 'the loose is HIT_FRAME_BOW of the classic draw clock'
            : 'first hit is the melee hit frame',
      },
      next() {
        const t = first + i * cad.seconds;
        i += 1;
        return { t, hand: 'main', start: t - first, fresh: true };
      },
    };
  }

  const mainTick = num(probe.cadence.tick, 0);
  const offTick = num(probe.offHand?.cadence?.tick, mainTick);
  if (!(mainTick > 0) || !(offTick > 0)) return null;
  const mainSeconds = num(probe.cadence.mainSeconds, FLURRY_TICKS * mainTick);
  const offSeconds = num(probe.cadence.offSeconds, FLURRY_TICKS * offTick);
  // the off hand's long-run held burden, in ticks, exactly as analyze's dual arm scheduled it
  const offHandHoldTicks = num(probe.schedule?.hold, Math.max(0, offSeconds / offTick - FLURRY_TICKS));
  let start = 0;
  let hand = 'main';
  let first = true;
  return {
    kind: 'dual', probe, target: probe.target, health,
    assumptions: {
      schedule: 'dual',
      mainTick, offTick, mainSeconds, offSeconds, offHandHoldTicks,
      firstLead: 5 * mainTick,
      flurryLead: mainSeconds,
      firstHit: `fresh lead at ${HIT_FRAME_MELEE} ticks; flurry hit at ${FLURRY_HIT_FRAME} tick`,
      note: 'fresh lead, then lead/off flurries with the off hand burden',
    },
    next() {
      if (hand === 'main') {
        const hit = start + (first ? HIT_FRAME_MELEE * mainTick : FLURRY_HIT_FRAME * mainTick);
        const duration = first ? 5 * mainTick : mainSeconds;
        const ev = { t: hit, hand: 'main', start, fresh: first };
        start += duration;
        first = false;
        hand = 'off';
        return ev;
      }
      const hit = start + FLURRY_HIT_FRAME * offTick;
      const ev = { t: hit, hand: 'off', start, fresh: false };
      start += offSeconds;
      hand = 'main';
      return ev;
    },
  };
}

/**
 * The health segment a pool share sits in. `healthThresholds` returns the bounds DESCENDING (1, 0.5, ..., 0).
 * A share exactly ON a threshold takes the segment above it: every health term upstream reads is a strict `<`
 * (axe/blunt mastery's halves, venom, execute) or blunt's `>=`, and at equality all of them read the not-below side.
 */
export function healthSegment(bounds, share) {
  for (let i = 0; i < bounds.length - 1; i++) if (share >= bounds[i + 1]) return i;
  return bounds.length - 2;
}

/** One seeded battle. The result is one of the samples `simulateFights` summarises. `seed` defaults to 0, so even an
 *  unseeded call is deterministic (the path never touches `Math.random`). */
export function simulateFight(ch, args = {}) {
  const scenario = normalizeScenario(args);
  if (scenario.pair || ch._pair) throw new Error('simulateFight: Pistolet pair is not supported in Stage 3.2');
  // Refuse ranged/gun on either hand before the schedule; a mixed melee + Pistolet pair must not fall through to melee.
  const mainWeapon = scenario.weapon === undefined ? (ch.weapon ? weaponOf(ch.weapon) : null) : scenario.weapon;
  const offWeapon = ch.offWeapon ? weaponOf(ch.offWeapon) : null;
  if (mainWeapon?.ranged || offWeapon?.ranged) {
    throw new Error('simulateFight: bow and gun builds are not supported on either hand');
  }
  const schedule = createAttackSchedule(ch, scenario);
  if (!schedule) return null;
  const pool = schedule.health;
  if (!(pool > 0)) return null;
  if (scenario.seed !== undefined && !Number.isSafeInteger(scenario.seed)) {
    throw new TypeError('simulateFight: seed must be a safe integer');
  }
  const seed = Number.isSafeInteger(scenario.seed) ? scenario.seed : 0;
  const rng = createRng(seed);
  const blowStream = rng.stream('blow');
  const cwsStream = rng.stream('cws');
  const cwsRolls = scenario.cwsRolls === undefined ? () => cwsStream.float() : scenario.cwsRolls;
  if (typeof cwsRolls !== 'function') throw new TypeError('simulateFight: cwsRolls must be a function');
  const standard = scenario.standard;
  const target = schedule.target;
  const probe = schedule.probe;
  const strikeItems = [probe.weapon?.item, probe.offHand?.weapon?.item].filter(Boolean);
  // A CWS row can only ride the item that struck: `doItemEnchantmentPayloads(Strikes, item, ...)`
  // (enchantments.js:1031-1072). No CWS row on a striking item means no cast, so no spell-power path is resolved.
  const castsCws = strikeItems.some((it) => cwsRows(it, standard).length > 0);
  // The ordinary-enemy boundary. Upstream sends spareGear/relay bodies to the relay's own spell door
  // (hostEnchant.js:215) and its boss/shield/revenant/bout/companion arms are host additions; this simulator supports a
  // plain ordinary foe only (no `spareGear`, no relay body, no boss traits/caps/phase shields/shield pool, no revenant
  // last stand, no bout/companion). The flags are read by truthiness: the tier reads `!!tgt.relayBody`
  // (blowOutcomes.js:148), so a truthy non-`true` flag must not slip through a `=== true` guard.
  if (target) {
    if (!!target.relayBody || !!target.spareGear) {
      throw new Error('simulateFight: relay stand-ins and spareGear targets are not ordinary targets');
    }
    if (
      !!target.isBoss || (target.bossTraits?.length ?? 0) > 0
      || !!target.phaseShields || target.shieldPool != null
      || target.revenant != null || target.bout != null || target.companion != null
    ) {
      throw new Error('simulateFight: the supported target contract is a plain ordinary foe (no boss traits/caps/phase shields/shield pool/revenant/bout/companion)');
    }
  }
  // A per-hit cap and scenario boss traits are resolved by the MELEE blow only (blowOutcomes.js:111,:138; model.js:1232).
  // A CWS cast would be resolved by the direct-damage path, which knows neither, so the two halves of one fight would
  // follow different rules. Refused rather than silently mixed; without a CWS row both are the Stage 3.2/3.3 melee
  // contract and stay supported.
  if (castsCws) {
    if (!!target?.hitCap) {
      throw new Error('simulateFight: a target per-hit cap is not supported with Cast When Strikes (the cast is not capped)');
    }
    if ((scenario.traits?.length ?? 0) > 0) {
      throw new Error('simulateFight: boss `traits` are not supported with Cast When Strikes (the cast ignores them)');
    }
  }
  const cwsPower = castsCws
    ? spellPowerInputs(ch, {
      potencyPct: scenario.potencyPct, pierce: scenario.pierce,
      worn: equippedForFight(ch, [probe.weapon?.item ?? null, probe.offHand?.weapon?.item ?? null]),
    })
    : { potencyPct: 0, pierce: 0 };
  const dual = schedule.kind === 'dual';
  const powers = [
    ...weaponPowers(probe.weapon, scenario),
    ...(dual && probe.offHand?.weapon ? weaponPowers(probe.offHand.weapon, scenario) : []),
  ];
  const bounds = healthThresholds(powers);
  const maxSeconds = num(scenario.maxSeconds, 3600);
  const maxBlows = Math.max(1, Math.floor(num(scenario.maxBlows, 1000000)));
  const damageMode = scenario.damageMode === 'capped' ? 'capped' : 'uncapped';

  const cache = new Map();
  const distribution = (index, hand) => {
    const key = `${index}|${hand}`;
    let s = cache.get(key);
    if (s) return s;
    const mid = (bounds[index] + bounds[index + 1]) / 2;
    const tier = blowFightTier(ch, {
      ...scenario, target, health: pool, healthShare: mid, hand,
      ...(dual && !scenario.dual ? { dual: true } : {}),
    });
    s = { tier, sampler: createBlowSampler(tier), mid };
    cache.set(key, s);
    return s;
  };

  let hp = pool;
  let t = 0;
  let blows = 0;
  let dealt = 0;
  let cwsDealt = 0;
  let echoDealt = 0;
  let meleeDealt = 0;
  let cwsCasts = 0;
  let cwsKills = 0;
  let killSource = null;
  let ttk = null;
  const trace = scenario.trace === true ? [] : null;
  const cwsTrace = scenario.trace === true ? [] : null;
  const used = new Map();
  let next = schedule.next();
  while (hp > 0 && blows < maxBlows && next && next.t <= maxSeconds) {
    const share = clamp(hp / pool, 0, 1);
    const index = healthSegment(bounds, share);
    const hand = dual ? next.hand : 'main';
    const dist = distribution(index, hand);
    const outcome = dist.sampler.sample(blowStream);
    const blowDamage = damageMode === 'capped' ? outcome.claim : outcome.blow; // the host's melee blow
    const echoDamage = num(outcome.echoDamage, 0); // the strike listener's separate hit, before the host's blow
    t = next.t;
    blows += 1;
    // CWS runs inside the blow's formula, before the strike listener (echo) and the host's melee blow. Its guard is the
    // PRE-payload damage (`strikesPositive`), not the post-Potent-Vs `formulaPositive` Flow/echo read.
    const item = hand === 'off' ? (probe.offHand?.weapon?.item ?? null) : (probe.weapon?.item ?? null);
    let cwsDamage = 0;
    let cwsCastsThis = 0;
    let cwsKill = false;
    if (cwsEligible({
      target, strikesPositive: outcome.strikesPositive === true, whole: outcome.whole === true, item, standard,
    })) {
      for (const row of cwsRows(item, standard)) {
        if (!row.spell) {
          cwsTrace?.push({
            t, hand, swing: blows, row: row.param, spell: null, index: null, damage: 0, missing: true,
          });
          continue;
        }
        // The sink is the host's landing: later effects still roll, but they stop being counted/applied at death.
        const hurt = (n) => { hp = Math.max(0, hp - n); return hp > 0; };
        const cast = resolveCwsCast({
          spell: row.spell, caster: { entity: ch }, casterLevel: num(ch.level, 1), target, rolls: cwsRolls,
          pierce: cwsPower.pierce, potencyPct: cwsPower.potencyPct, hurt,
        });
        cwsDamage += cast.damage;
        cwsCastsThis += 1;
        const killed = hp <= 0;
        if (killed) { hp = 0; cwsKill = true; cwsKills += 1; }
        cwsTrace?.push({
          t, hand, swing: blows, row: row.param, spell: row.spell.name ?? null, index: row.spell.index ?? null,
          casterLevel: num(ch.level, 1), damage: cast.damage, absorbed: cast.absorbed, reflected: cast.reflected,
          resisted: cast.resisted, deferred: cast.deferred, effects: cast.effects, kill: killed,
        });
        if (killed) break; // the host's applySpellToTarget finds no live foe for a later row
      }
    }
    // Upstream order after the formula: the strike listener's echo lands as its own hit (`hurtFoe`) first; the host's
    // melee blow lands after. A CWS kill (or an echo kill) makes `damageFoe` see `foe.dead`, so the later hit is not
    // applied. The swing still happened, so `blows` and the trace keep it.
    let echoApplied = 0;
    let echoKill = false;
    let meleeDamage = 0;
    if (!cwsKill && echoDamage > 0) {
      echoApplied = echoDamage;
      hp = Math.max(0, hp - echoApplied);
      echoKill = hp <= 0;
    }
    if (cwsKill) killSource = 'cws';
    else if (echoKill) killSource = 'echo';
    if (!cwsKill && !echoKill && blowDamage > 0) {
      meleeDamage = blowDamage;
      hp = Math.max(0, hp - meleeDamage);
    }
    if (hp < 0) hp = 0;
    cwsDealt += cwsDamage;
    echoDealt += echoApplied;
    meleeDealt += meleeDamage;
    cwsCasts += cwsCastsThis;
    dealt += cwsDamage + echoApplied + meleeDamage;
    const key = `${index}|${hand}`;
    const u = used.get(key) ?? { segment: index, hand, share: dist.mid, blows: 0, damage: 0, cwsDamage: 0, echoDamage: 0 };
    u.blows += 1;
    u.damage += cwsDamage + echoApplied + meleeDamage;
    u.cwsDamage += cwsDamage;
    u.echoDamage += echoApplied;
    used.set(key, u);
    if (trace) trace.push({
      t, hand, swing: blows, segment: index, share, damage: meleeDamage, blowDamage, echoDamage, echoApplied,
      cwsDamage, cwsCasts: cwsCastsThis, cwsKill, echoKill, meleeApplied: meleeDamage > 0,
      strikesPositive: outcome.strikesPositive === true, formulaPositive: outcome.formulaPositive === true,
      whole: outcome.whole === true, hit: outcome.hit, crit: outcome.crit,
      blow: outcome.blow, claim: outcome.claim, cappedDamage: outcome.cappedDamage,
      echoHits: outcome.echoHits, remaining: Math.max(0, hp),
    });
    if (hp <= 0) { ttk = t; break; }
    next = schedule.next();
  }
  if (hp < 0) hp = 0;
  const remainingHealth = Math.max(0, hp);
  const kill = ttk !== null;
  if (kill && killSource == null) killSource = 'melee';
  return {
    seed,
    kill,
    killSource: kill ? killSource : null,
    ttk,
    time: t,
    health: pool,
    remainingHealth,
    overkill: Math.max(0, dealt - pool),
    damageDealt: dealt,
    cwsDamage: cwsDealt,
    echoDamage: echoDealt,
    meleeDamage: meleeDealt,
    cwsCasts,
    cwsKills,
    cwsCapable: castsCws,
    blows,
    damageMode,
    outputDps: t > 0 ? dealt / t : null,
    killDps: kill ? pool / ttk : null,
    expectedPerSwing: blows > 0 ? dealt / blows : null,
    segments: [...used.values()].sort((a, b) => b.share - a.share),
    schedule: schedule.assumptions,
    bounds,
    target,
    trace,
    cwsTrace,
    with: (edit = {}) => simulateFight(ch, { ...args, ...edit }),
  };
}

/** Sample moments. `ttk` is null for no-kill runs and is summarised only over kills. */
export function summarize(values, { p10 = 0.1, p90 = 0.9 } = {}) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  const at = (q) => xs[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * q)))];
  return {
    n, mean, sd, se, ci95: 1.96 * se, min: xs[0], max: xs[n - 1],
    median: at(0.5), p10: at(p10), p90: at(p90),
  };
}

/** Wilson score interval for a binomial share, the one small-sample interval that stays inside [0, 1]. */
export function wilsonInterval(kills, trials, z = 1.96) {
  if (!(trials > 0)) return null;
  const p = kills / trials;
  const den = 1 + (z * z) / trials;
  const mid = (p + (z * z) / (2 * trials)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / den;
  return { p, lo: Math.min(p, Math.max(0, mid - half)), hi: Math.max(p, Math.min(1, mid + half)), n: trials };
}

/** Deterministic paired seeds: one named stream, independent of the blows. */
export function pairedFightSeeds(count, seed = 0) {
  const n = Math.max(0, Math.floor(num(count, 0)));
  const stream = createRng(Number.isSafeInteger(seed) ? seed : 0).stream('seeds');
  return Array.from({ length: n }, () => Math.floor(stream.float() * 4294967296));
}

/**
 * Run `trials` independent fights. Pass `seeds` to reuse a fixed list (the paired form). Every result carries the
 * pool, the seed list, the number killed and the distributions of TTK, damage, overkill and blows. `ttk` (and its
 * alias `ttkConditional`) and `killDps` are CONDITIONAL on a kill: with censored fights they are biased low relative
 * to an unconditional time-to-kill. `killProbability` is the overall share of fights that kill inside
 * `horizonSeconds`, with a Wilson interval. `outputDps`, `damageDealt`, remaining and overkill cover every trial,
 * including a censored one (its `outputDps` is over the time it actually ran, not the full horizon; a trial that
 * landed no blow has no rate and is left out of that summary, whose `n` says how many rows it has).
 */
export function simulateFights(ch, args = {}) {
  const trials = Math.max(1, Math.floor(num(args.trials, Array.isArray(args.seeds) ? args.seeds.length : 1000)));
  const seeds = Array.isArray(args.seeds) ? [...args.seeds] : pairedFightSeeds(trials, num(args.seed, 0));
  if (!seeds.length) throw new RangeError('simulateFights: at least one seed is required');
  const rows = seeds.map((seed) => simulateFight(ch, { ...args, seed }));
  if (rows.some((r) => !r)) return null;
  const kills = rows.filter((r) => r.kill);
  const pool = rows[0].health;
  const ttk = summarize(kills.map((r) => r.ttk));
  const output = summarize(rows.map((r) => r.outputDps));
  const killDps = summarize(kills.map((r) => r.killDps));
  return {
    trials: rows.length,
    seeds,
    health: pool,
    kills: kills.length,
    censored: rows.length - kills.length,
    // `ttk`/`killDps` are CONDITIONAL on a kill; `killProbability` is the overall share of fights that kill inside the
    // horizon. With censored fights, the conditional mean is biased low relative to an unconditional TTK.
    ttk,
    ttkConditional: ttk,
    killProbability: wilsonInterval(kills.length, rows.length),
    horizonSeconds: num(args.maxSeconds, 3600),
    damageMode: rows[0].damageMode,
    outputDps: output,
    killDps,
    damageDealt: summarize(rows.map((r) => r.damageDealt)),
    overkill: summarize(rows.map((r) => r.overkill)),
    remainingHealth: summarize(rows.map((r) => r.remainingHealth)),
    blows: summarize(rows.map((r) => r.blows)),
    expectedPerSwing: summarize(rows.map((r) => r.expectedPerSwing)),
    rows,
    with: (edit = {}) => simulateFights(ch, { ...args, ...edit }),
  };
}

/**
 * Several builds on the SAME seed list, the form a paired comparison needs. `entries` is `[{id, ch}]`; the result
 * carries the shared seeds and each build's `simulateFights` result.
 */
export function simulatePairedFights(entries, args = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('simulatePairedFights: at least one entry is required');
  const trials = Math.max(1, Math.floor(num(args.trials, 1000)));
  const seeds = Array.isArray(args.seeds) ? [...args.seeds] : pairedFightSeeds(trials, num(args.seed, 0));
  return { seeds, trials: seeds.length, rows: entries.map((e) => ({ id: e.id, result: simulateFights(e.ch, { ...args, seeds }) })) };
}

/** Named aliases for callers that prefer the objective vocabulary. */
export const simulateFightDistribution = simulateFights;
