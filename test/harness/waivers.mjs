/*
 * test/harness/waivers.mjs - the known discrepancies the audit established.
 *
 * A waiver is not a pass. It is a precise, testable statement that this
 * project and the pinned game disagree here, with the audit's evidence. Every
 * waived differential case asserts the disagreement still exists: when a fix
 * lands, the test fails and the entry must be removed (and the fix recorded in
 * CHANGELOG-MECHANICS.md). Nothing in this file may be used to excuse a new
 * divergence.
 *
 * See the assumptions register for what is modelled and the verification notes for
 * what is independently checked.
 */

export const WAIVERS = Object.freeze({
  'W-PROC-BUDGET': {
    title: 'The explicit card ceiling sums Cast When Strikes damage before the shared relay budget',
    detail:
      'The relay fight (simulateRelayFight) bills each submitted Cast When Strikes proc and eligible Continuous Damage round as its own claim against both per-hit and shared relay limits; turned ticks do not submit. The explicit card ceiling (ceilingTotalDps and ceilingTotalTtk/totalTtkCapOnly) still adds the expected proc component (enchantDps) to the per-hit-capped weapon rate. It caps direct procs individually and caps the summed DoT round once (src/enchants.js:137-172), but the sum never pays the shared blow tokens or purse and does not model discrete submissions. It can still predict a much earlier kill. The default allowance totals now select the existing expected-value run, with no kill-time fallback. The run itself schedules mean instant procs at the landed-blow cadence and a separate repeating DoT round (src/allowance.js:97-115), not the sampled cast with its first tick plus later eligible rounds. Potent Vs / Low Damage Vs still ride the weapon blow (src/model.js strikesNet).',
    evidence: 'test/procBudget.test.js keeps its explicit ceiling < claim TTK waiver pin and replays the expected-value schedule through vendored gateBrain.applyHit (710.09 ceiling DPS vs 150 paid DPS). standInSpell.js:131-151,198-236 and gateBrain.js:1298-1335@a3eb1605 show the real submission and billing; test/relayDotDifferential.test.js and test/standInSpellDifferential.test.js cover the sampled path.',
    fix: 'Keep the pre-allowance ceiling diagnostic distinct from the budgeted estimate. For actual per-event proc and DoT billing use the seeded relay fight; the card does not reproduce that lifecycle.',
  },
  'W-LOOT-CARRY': {
    title: 'The DEFAULT fight streams and the plain card estimate floor each blow; the game carries the fraction',
    detail:
      'lootPowers.js:176-181 shareOf takes floor(damage x pct / 100 + carry) and keeps the remainder on the held item, per channel - the same shape in the weapon masteries (weaponMastery.js:148-150), the martial path (martialPowers.js:232-235) and the Firmament (firmamentPowers.js:111-115, whole = floor for a price and ceil for a loss, remainder unclamped, the blow never below 1 at :181). A held item\'s long-run mean of a percentage line is therefore its EXACT share. PRICING uses that mean: `analyze` runs the one card a second time with `carried: true` (src/model.js), where the four per-cent channels - mastery, the loot step\'s slayer/power share, the martial path and the Firmament - take the exact share (`carriedPct` / `carriedFirmament`) instead of `applyPct`\'s per-blow floor, while the non-carried floors stay: the weapon damage affix and the theory damagePct (lootRarity.js:2474-2478 trunc) and the elemental/venom flat (Math.floor, lootPowers.js:294,:320). The result is `carriedPerSwing` / `carriedCappedPerSwing` / `carriedDps` / `carriedCappedDps`, and imprint/enchant pricing reads it (src/imprints.js powerDps and rankFamily, src/enchantPlan.js, src/realBuild.js). The SEEDED FIGHT STREAMS also carry now, behind the opt-in scenario flag `carry: true` on simulateFight/simulateFights/simulateRelayFight(s): a per-fight carry state (a Map per channel and held item, reset at the fight\'s start - ASSUMPTION M43) is consulted per drawn blow, so the percentage channels are re-resolved with the live remainder in upstream\'s stage order (mastery, the loot step\'s one summed share, elemental flat, martial, the theory damagePct floor, the Firmament) and the non-percentage stages stay integral and unchanged; proved against the vendored held-item stream by test/lootCarry.test.js 1-3 and 5. What REMAINS divergent: the DEFAULT fight-stream path (`carry` off, the shipped callers) and the plain card (`perSwing`/`dps`/`cappedDps`/`totalDps`) still floor every blow - the card is also upstream\'s own Stats-page estimate (`info.estimate` reads the carry and never writes it). On the 25% slayer line at level 30 the card reads 19.03 against the held item\'s 19.45 (+2.2%); the floor fight stream is 1.5% low on that build (2.7% mastery, 2.3% martial, 2.3% Firmament 30%), with mean TTK 1.7-2.5% high. A carried pricing figure carries a BIAS of about 0.25% low on that fixture (19.4051 against 19.4536; z -3.88 at the test seed): the mean-based pass skips the integer stages\' per-blow unityRound (the crit\'s and the hide\'s), so `carriedDps` shifts from `dps` even for an item with no percentage line at all, while a delta largely cancels it because both sides drop the same rounding. A second, smaller residual is the theory `damagePct` channel, still floored on the MEAN (floor-of-mean vs the game\'s mean-of-floors, up to a point per blow when that what-if channel is used). The waiver PIN now covers both halves: test/pricing.test.js section 5 compares the card figure with the held stream, and test/lootCarry.test.js 5 pins the DEFAULT (`carry: false`) fight-stream mean against the same held-item oracle (1.5-2.7% low, z > 3), while the `carry: true` stream is within 1% TTK and |z| < 3.5 of it.',
    evidence: 'test/pricing.test.js section 5: `carriedPerSwing` within 0.5% of a 250,000-blow held-item stream while the card figure still fails the same comparison (+2.2%, the waiver pin); src/model.js carriedPct/carriedFirmament and analyze\'s carried pass; test/imprints.test.js \'the carried metric keeps the card\'s imprint order on every family fixture\' (no metric-driven reorder on the six max-profile fixtures); the card\'s own estimate path stays pinned by test/wardSuppression.test.js and test/gearLines.test.js (weaponBlow == lootBlow(...,{estimate:true})). The FIGHT half: test/lootCarry.test.js 1-3 (sequence-level equality with lootBlow/weaponMasteryBlow/martialBlow on ONE reused item; slayer + bane = one 75% share; mastery then loot = two independent remainders; misses do not advance; the Firmament mean is the exact share), 5 (seeded simulateFights mean damage/blow and TTK with carry:true against the held-item fightOracle, |z| < 3.5 and TTK within 1%), 6 (the default path is bit-identical to a pre-change recorded fight literal), 7 (relay fights accept the flag); its `expectKnownDiscrepancy` call pins that carry:false still floors (1.5-2.7% below the held oracle). The relay stream is wired and smoke-tested only, not differentially sampled.',
    fix: 'The DEFAULT: the shipped callers (objectives, CLI, benchmark reports) still run with carry off, deliberately. Flipping them is a separate decision with a measured effect (mean TTK 1.7-2.5% shorter on the shipped fixtures, ASSUMPTION M43); it is NOT done here. The plain card stays floor-by-design (upstream\'s own estimate path). Pricing already uses the mean (docs/ASSUMPTIONS.md M41).',
  },
});

export const waiverIds = () => Object.keys(WAIVERS);

/**
 * Assert a discrepancy the audit already recorded is STILL present. Reaching a
 * state where it is gone fails the test on purpose, so a fix must remove the
 * waiver rather than leave a stale claim behind.
 */
export function expectKnownDiscrepancy(assert, id, condition, observed) {
  const w = WAIVERS[id];
  if (!w) throw new Error(`unknown waiver ${id}`);
  assert.ok(
    condition,
    `waiver ${id} ("${w.title}") is stale: the discrepancy no longer reproduces (observed ${JSON.stringify(observed)}). ` +
      `Remove the waiver from test/harness/waivers.mjs and record the fix in CHANGELOG-MECHANICS.md.`,
  );
}
