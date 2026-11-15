/*
 * dfo-dps - the whole-fight evaluation of health-dependent damage.
 *
 * Three effects in the blow read the FOE's own share of its health at the moment of the blow, and pay only on one side
 * of a threshold:
 *   axe mastery    systems/weaponMastery.js:118-126  `share < WEAPON_HALF_LINE` (0.5) -> climb x WEAPON_HALF_PER_POINT
 *   blunt mastery  the same, `share >= 0.5`
 *   venom          systems/loot/lootPowers.js:320    `share(target) < 0.5` -> the flat doubled
 *   execute        systems/loot/lootPowers.js:329    `share(target) < p.below / 100` -> pct
 * `share` is `combat/healthShare.js:24-40` - the body's `health / maxHealth` (the relay's word for a relay body). All four
 * are evaluated where they already were: axe/blunt in the weapon-blow modifiers, venom and execute in lootBlow - before
 * the martial path, the crit, the defence, the trait and the cap. So a whole fight is the SAME blow evaluated at each
 * health the foe actually passes through, and nothing about the ordering changes.
 *
 * The attacker's health is a different matter: `rage` (lootPowers.js:328-330) and Berserker's Frenzy
 * (martialPowers.js:217, :276) read the WIELDER's share. Nothing here derives that trajectory - this model does not
 * simulate damage taken (the assumptions register M5/M23) - so `attackerHealthShare` stays the caller's declaration and is
 * never varied with the foe's health.
 *
 * THE FIGHT. Between two thresholds the blow's expected damage per swing does not change (it is a function of the share
 * only through those comparisons), so the fight is a walk over segments:
 *
 *   start at the pool's health; for each segment, top down: evaluate the blow at a share strictly inside it, take
 *   `ceil(health above the segment's floor / perSwing)` blows, add their time (1 / aps each), subtract their damage.
 *
 * That is the game's own event order: each blow is struck at the share that stands when it lands, and a blow that
 * crosses a threshold crosses it. The expected damage is used per blow (hits and misses already averaged), so the walk
 * is deterministic; the last blow at the pool's bottom overshoots, as a real one does. This is a whole-fight KILL RATE:
 * `dps = health / ttk`. It is not the per-hit-capped or allowance-sustained figure - a relay body's cap and purse are a
 * separate stage - and the comparison with the fixed-health snapshot is made explicit by returning it too.
 */
import { analyze, weaponPowers } from './model.js';
import { allowanceLaw, claimStreams, simulateAllowance } from './allowance.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The foe-health shares a fight's blow can change at: 1, 0.5 (mastery and venom), every execute power's `below`, 0. */
export function healthThresholds(powers = []) {
  const set = new Set([1, 0.5, 0]);
  for (const p of powers ?? []) {
    if (p?.kind !== 'execute') continue;
    const below = num(p.below, 0);
    if (below > 0 && below < 100) set.add(below / 100);
  }
  return [...set].filter((s) => s >= 0 && s <= 1).sort((a, b) => b - a);
}

/**
 * The whole fight of one build against one body.
 *
 * @param {object} ch  the build (as `analyze` reads it)
 * @param {object} args  the `analyze` scenario; `healthShare` is supplied per segment, `attackerHealthShare` is kept as
 *   given; `health` (the pool) defaults to the target's `maxHealth`
 * @returns {null | { dps, ttk, blows, health, segments, snapshot, with }}
 *   dps       the fight's kill rate, health / ttk (expected damage per blow; the last blow overshoots)
 *   ttk       seconds (sum of the blows' 1/aps)
 *   segments  one per health segment: its bounds, the share evaluated, the per-swing damage, blows and seconds
 *   snapshot  the same build at full foe health (`healthShare: 1`), the fixed-health figure it replaces
 *   with      the same fight re-run with one scenario edit (the same `with` semantics as `analyze`)
 */
export function fight(ch, args = {}) {
  // `with({ imprint })` is the same shorthand `analyze` takes: the power rides the item for the walk and its thresholds
  const scenario = { ...args };
  if (scenario.imprint) {
    scenario.imprints = [...(scenario.imprints ?? []), scenario.imprint];
    delete scenario.imprint;
  }
  const target = scenario.target ?? null;
  const health = num(scenario.health, num(target?.maxHealth, 0));
  if (!(health > 0)) return null;
  // the powers the blow will carry, so an execute's threshold is in the walk (the item's and the what-ifs')
  const w = scenario.weapon === undefined ? null : scenario.weapon;
  const probe = analyze(ch, { ...scenario, healthShare: 1, health });
  const powers = weaponPowers(probe.weapon ?? w, scenario);
  const bounds = healthThresholds(powers);
  let hp = health;
  let t = 0;
  let blows = 0;
  let dealt = 0;
  const segments = [];
  for (let i = 0; i < bounds.length - 1 && hp > 0; i++) {
    const hi = bounds[i];
    const lo = bounds[i + 1];
    const floorHealth = lo * health;
    const above = Math.max(0, hp - floorHealth);
    if (!(above > 0)) continue;
    const share = (hi + lo) / 2; // strictly inside: every `<`/`>=` reads the segment's side
    const r = analyze(ch, { ...scenario, healthShare: share, health });
    const perSwing = r.perSwing;
    if (!(perSwing > 0)) return null; // this build cannot empty the pool
    const aps = num(r.cadence?.aps, 0);
    if (!(aps > 0)) return null;
    const n = Math.ceil(above / perSwing - 1e-9);
    const seconds = n / aps;
    t += seconds;
    hp -= n * perSwing;
    dealt += n * perSwing;
    blows += n;
    segments.push({ hi, lo, share, perSwing, aps, blows: n, seconds });
  }
  if (!(t > 0) || hp > 0) return null;
  const out = {
    // killDps is the fight's kill RATE - health / ttk. It is not output DPS: the last blow overshoots, so the damage
    // actually dealt is `dealt`, and `outputDps` (dealt / ttk) is the larger figure. `expectedPerSwing` is dealt / blows.
    killDps: health / t,
    dps: health / t, // the name the 2.12a callers use; same number
    outputDps: t > 0 ? dealt / t : 0,
    expectedPerSwing: blows > 0 ? dealt / blows : 0,
    overkill: dealt - health,
    ttk: t,
    blows,
    health,
    segments,
    snapshot: probe,
    with: (edit = {}) => fight(ch, { ...args, ...edit }),
  };
  return out;
}

/** The same fight, named for the metric: the health-weighted kill rate over the whole pool. */
export const fightDps = (ch, args = {}) => fight(ch, args);

/**
 * The whole fight against a body the RELAY runs - the allowance applied to every claim (net/gate/gateBrain.js
 * joinFight :1213 / applyHit :1298 / spendBlow :3411, the law `allowance.js` implements):
 *
 *   join       bucket = BUCKET_DEPTH_X x ref (empty for a wounded join), GATE_HIT_HZ_MAX tokens, share = the pool
 *   applyHit   refused while shielded (no token spent), a token spent, then got = min(claim, HIT_CAP_X x ref, bucket, hp)
 *   refill     BUCKET_RATE_X x ref a second, up to the depth
 *
 * The claim is the health-dependent one, read through `perClaimAt`: the blow evaluated at the share of the pool that
 * stands when the claim is made (the game reads the relay's word for a relay body's share, so the share falls through a
 * boss fight exactly as it does against an ordinary foe). The law itself is `simulateAllowance` - no second copy.
 *
 * What the result separates:
 *   uncappedDps  what the blows would deal with neither the per-hit cap nor the relay (the snapshot's `dps`)
 *   ceilingDps   after the per-hit cap, before the relay: the highest rate the relay would ever see from this build
 *   acceptedDps  what the relay took (the realised rate, clipped claims included as lost)
 *   saturated    the bucket ran dry (the relay, not the build, set the pace)
 *   marginDps    ceilingDps - the refill: how far the build stands above saturation
 * Two builds that saturate share an `acceptedDps` (the refill) and a kill time; `ceilingDps` and `marginDps` are what
 * tells them apart. The per-hit cap, the bucket and the token hand are the target's own (gateTarget/encounterTarget).
 *
 * Procs and Cast When Strikes are NOT claims here (the proc budget is a later stage): the fight is the weapon's.
 */
export function fightRelay(ch, args = {}) {
  const scenario = { ...args };
  if (scenario.imprint) {
    scenario.imprints = [...(scenario.imprints ?? []), scenario.imprint];
    delete scenario.imprint;
  }
  const target = scenario.target ?? null;
  const spec = target?.allowance ?? null;
  if (!spec) return null; // not a body the relay runs
  const health = num(scenario.health, num(target?.maxHealth, 0));
  const pool = health / Math.max(1, num(spec.players, 1));
  if (!(pool > 0)) return null;
  const probe = analyze(ch, { ...scenario, healthShare: 1, health });
  const cap = num(probe.cap, 0);
  const hit = num(probe.hit?.hit, 0);
  const aps = num(probe.cadence?.aps, 0);
  if (!(cap > 0) || !(hit > 0) || !(aps > 0)) return null;
  const bounds = healthThresholds(weaponPowers(probe.weapon ?? scenario.weapon, scenario));
  const cache = new Map();
  const segmentAt = (share) => {
    let i = bounds.length - 2;
    for (let k = 0; k < bounds.length - 1; k++) if (share > bounds[k + 1]) { i = k; break; }
    if (!cache.has(i)) {
      const mid = (bounds[i] + bounds[i + 1]) / 2;
      const r = analyze(ch, { ...scenario, healthShare: mid, health });
      cache.set(i, { hi: bounds[i], lo: bounds[i + 1], share: mid, perSwing: r.perSwing, cappedPerSwing: r.cappedPerSwing, aps: num(r.cadence?.aps, 0) });
    }
    return cache.get(i);
  };
  const streams = claimStreams({ cappedPerSwing: probe.cappedPerSwing, hit, aps, procs: [], cap, withProcs: false });
  if (!streams.length) return null;
  let uncapped = 0;
  const perClaimAt = (_s, hp) => {
    const seg = segmentAt(Math.max(1e-9, Math.min(1, hp / pool)));
    uncapped += seg.perSwing / hit;
    return seg.cappedPerSwing / hit;
  };
  const law = allowanceLaw(spec.level);
  const run = simulateAllowance({
    share: pool, law, streams,
    phases: spec.phases ?? [], openingS: spec.openingS ?? 0, immunityShare: spec.immunityShare ?? null,
    perClaimAt,
  });
  if (!run || !run.killed) return null;
  const seconds = num(run.fightSeconds, 0);
  const ceilingDps = seconds > 0 ? run.offered / seconds : 0;
  return {
    ttk: run.ttk,
    fightSeconds: seconds,
    killDps: pool / run.ttk,
    pool,
    cap,
    refillDps: law.rate,
    bucketDepth: law.depth,
    tokensPerSecond: law.hitHz,
    uncappedDps: seconds > 0 ? uncapped / seconds : 0,
    ceilingDps,
    acceptedDps: seconds > 0 ? run.landed / seconds : 0,
    saturated: run.dryAt !== null,
    marginDps: ceilingDps - law.rate,
    clippedShare: run.offered > 0 ? run.clipped / run.offered : 0,
    burst5Dps: run.burst5 / 5,
    claimsOffered: run.claimsOffered,
    claimsAccepted: run.claimsAccepted,
    claimsRefused: run.claimsRefused,
    shieldedSeconds: run.shieldedSeconds,
    segments: [...cache.values()].sort((a, b) => b.hi - a.hi),
    run,
    snapshot: probe,
    with: (edit = {}) => fightRelay(ch, { ...args, ...edit }),
  };
}
