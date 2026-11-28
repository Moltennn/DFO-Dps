# Waivers: the known divergences from the pinned game

A waiver is not a pass. It is a precise, testable statement that this project and the pinned game disagree here, with
the audit's evidence. Every waived differential case asserts the disagreement still exists: when a fix lands, the test
fails and the entry must be removed (and the fix recorded in `CHANGELOG-MECHANICS.md`). Nothing in this file may be used
to excuse a new divergence.

This file is the Rust-side home of the waiver text that lived in `test/harness/waivers.mjs` while the JavaScript was
present. `rust/dfo-core/tests/ported_waivers.rs` reads it and fails if an id, its title or a quoted piece of its evidence
goes missing, so removing a waiver is noticed. The detail and evidence below are carried over from that file as it stood
at the revision that still had it (2026-11-28, stage C), with the house punctuation (`'` for `’`) and the `->` arrows
normalised; nothing else is edited. The tests are the ported pins in `ported_waivers.rs`.

The `test/*.test.js` names inside the detail and evidence below are HISTORICAL: they cite the JavaScript suite at that
revision, not files this branch ships. They are kept because the evidence a waiver rests on must stay auditable, and
because a reader looking for the original pin needs to know which file it was.

## W-PROC-BUDGET

**Title.** The explicit card ceiling sums Cast When Strikes damage before the shared relay budget

**Detail.** The relay fight (simulateRelayFight) bills each submitted Cast When Strikes proc and eligible Continuous
Damage round as its own claim against both per-hit and shared relay limits; turned ticks do not submit. The explicit
card ceiling (ceilingTotalDps and ceilingTotalTtk/totalTtkCapOnly) still adds the expected proc component (enchantDps) to
the per-hit-capped weapon rate. It caps direct procs individually and caps the summed DoT round once
(src/enchants.js:137-172), but the sum never pays the shared blow tokens or purse and does not model discrete
submissions. It can still predict a much earlier kill. The default allowance totals now select the existing
expected-value run, with no kill-time fallback. The run itself schedules mean instant procs at the landed-blow cadence
and a separate repeating DoT round (src/allowance.js:97-115), not the sampled cast with its first tick plus later
eligible rounds. Potent Vs / Low Damage Vs still ride the weapon blow (src/model.js strikesNet).

**Evidence.** test/procBudget.test.js keeps its explicit ceiling < claim TTK waiver pin and replays the expected-value
schedule through vendored gateBrain.applyHit (710.09 ceiling DPS vs 150 paid DPS). standInSpell.js:131-151,198-236 and
gateBrain.js:1298-1335@a3eb1605 show the real submission and billing; test/relayDotDifferential.test.js and
test/standInSpellDifferential.test.js cover the sampled path.

**Fix.** Keep the pre-allowance ceiling diagnostic distinct from the budgeted estimate. For actual per-event proc and
DoT billing use the seeded relay fight; the card does not reproduce that lifecycle.

## W-LOOT-CARRY

**Title.** The stateless estimates and explicit floor streams omit the held item's fraction

**Detail.** lootPowers.js:176-181 keeps the fractional share on the held item, per channel; so do
weaponMastery.js:148-150, martialPowers.js:232-235 and firmamentPowers.js:111-115 (ceil for a loss, never below 1 at
:181). The plain card, its deterministic consumers and the explicit sampled `carry: false` stream do not have a live
remainder. This differs from the held-item stream, not from upstream's fresh-item estimate: `info.estimate` reads any
existing carry but never writes it. Ordinary and relay sampled fights now carry by default, resetting to zero per fight
(M43). Pricing uses the exact long-run percentage share instead, not live per-blow carry: its remaining rounding bias is
about 0.25% on the card fixture (19.4051 vs 19.4536); the theory `damagePct` floor can also differ when evaluated on
the mean (M41).

**Evidence.** test/pricing.test.js §5 pins the 25% slayer card gap (+2.2% on the 250,000-blow held stream);
carriedPerSwing is within 0.5%. test/wardSuppression.test.js and test/gearLines.test.js pin the fresh-item estimate
against upstream. test/lootCarry.test.js §5 pins explicit carry:false against the held ordinary oracle (1.5-2.7% low,
z > 3), §6 preserves the original floor trace, and §7 asserts the relay floor gap through expectKnownDiscrepancy
(z > 3.5; z was 6.90 when recorded). The implicit default passes both held-item fight differentials.

**Fix.** Retain the stateless card and deterministic estimates as such, and keep explicit carry:false for floor
comparisons and historical seeded replay. Use the default sampled fights for live carry or the carried mean for
pricing.

## The JS-side rule the text came from

`WAIVERS` is frozen and `waiverIds()` lists its keys; `expectKnownDiscrepancy(assert, id, condition, observed)` throws
`unknown waiver <id>` for an id not declared, and otherwise asserts the condition with the waiver's title in the failure
message, ending `Remove the waiver from test/harness/waivers.mjs and record the fix in CHANGELOG-MECHANICS.md.` (that
file is gone; this document is its home now). What the ported pins reproduce of that contract: the two ids are declared
in this file and checked, and each pin fails when its discrepancy disappears, so a stale waiver cannot survive.
