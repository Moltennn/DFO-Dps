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
 * See README.md for what is modelled and what is independently checked.
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
    title: 'The stateless estimates and explicit floor streams omit the held item’s fraction',
    detail:
      'lootPowers.js:176-181 keeps the fractional share on the held item, per channel; so do weaponMastery.js:148-150, martialPowers.js:232-235 and firmamentPowers.js:111-115 (ceil for a loss, never below 1 at :181). The plain card, its deterministic consumers and the explicit sampled `carry: false` stream do not have a live remainder. This differs from the held-item stream, not from upstream’s fresh-item estimate: `info.estimate` reads any existing carry but never writes it. Ordinary and relay sampled fights now carry by default, resetting to zero per fight (M43). Pricing uses the exact long-run percentage share instead, not live per-blow carry: its remaining rounding bias is about 0.25% on the card fixture (19.4051 vs 19.4536); the theory `damagePct` floor can also differ when evaluated on the mean (M41).',
    evidence: 'test/pricing.test.js §5 pins the 25% slayer card gap (+2.2% on the 250,000-blow held stream); carriedPerSwing is within 0.5%. test/wardSuppression.test.js and test/gearLines.test.js pin the fresh-item estimate against upstream. test/lootCarry.test.js §5 pins explicit carry:false against the held ordinary oracle (1.5–2.7% low, z > 3), §6 preserves the original floor trace, and §7 pins the relay floor gap (z = 6.90). The implicit default passes both held-item fight differentials.',
    fix: 'Retain the stateless card and deterministic estimates as such, and keep explicit carry:false for floor comparisons and historical seeded replay. Use the default sampled fights for live carry or the carried mean for pricing.',
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
