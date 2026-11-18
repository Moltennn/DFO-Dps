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
  'W-WARD': {
    title: 'The `warded` boss trait and its ward pool do not suppress per-blow powers',
    detail:
      'Stage 3.6c gated the six per-blow ward paths (lootPowers.js:287,354; enchantments.js:597,674; artifactEffects.js:247; weaponMastery.js:141; martialPowers.js:136; firmamentPowers.js:173) on ONE local test - `target.warded` (src/model.js `weaponBlow` :675-687 and `afterShare` :817-829) - and that gate fires only when a CALLER sets the flag (the host\'s copy of the Warden\'s/court\'s word). The card\'s own `warded` TRAIT is a different thing: it adds the boss ward\'s health pool to the kill time (src/model.js:1451, `WARD_SHARE`) and never sets `target.warded`, so a trait-warded target still carries its slayer lines, elemental flat, mastery, martial path, Firmament and echo (src/model.js:1451 vs :675-687). Two smaller openings stay with it: Continuous Damage rounds are not ward-gated on either side (the vendored `runEffectRound` has no ward test, effects.js:720-731; docs/ASSUMPTIONS.md M36), and the Firmament gate is checked only against the vendored stub of the sky law (vendor/upstream/a3eb1605/STUBS.md:47), never a live oracle call.',
    evidence: 'test/wardSuppression.test.js "OPEN GAP (W-WARD)": a target with traits ["warded"] prices the ward pool (card.ward > 0) and still takes the slayer+elemental blow (130 through weaponBlow), where target.warded takes 100; the six gate tests A-D and the Potent Vs / CWS guards are the part now closed',
    fix: 'A later stage: the host copies the trait/boss ward onto the body as `target.warded` per blow (the card has no such per-blow state), and `runEffectRound` reads it. The Firmament needs the live sky law to become a real oracle.',
  },
  'W-PROC-BUDGET': {
    title: 'The per-hit-capped ceiling still sums procs on top of weapon DPS',
    detail:
      'C1 made every proc and DoT round its own relay claim in the allowance run (TTK, burst, sustained). The ceiling figures (totalDps, enchantDps) still add proc damage to weapon damage, cap each DoT tick apart rather than as one summed round claim, and fold Potent Vs / Low Damage Vs (+-5) into the enchant layer instead of the blow (enchantments.js:623-631). Stage 2.9 modelled what the blow does with Potent Vs, and Stage 2.11a moved the EQUIPPED rows onto that same channel (src/model.js strikesNet), so an item and `with({ potentVs })` are one calculation and the enchant layer no longer adds `hit x 5`. What remains of this waiver is the Cast When Strikes procs and DoT rounds: summed on top of the weapon figure, each capped apart, and not a differential stage.',
    evidence: 'standInSpell.js:131-151 vs src/enchants.js (procs and DoTs only since Stage 2.11a)',
    fix: 'Stage 4 (procs).',
  },
  'W-LOOT-CARRY': {
    title: 'A percentage line floors each blow; the game carries the fraction between blows',
    detail:
      'lootPowers.js:176-181 shareOf takes floor(damage x pct / 100 + carry) and keeps the remainder per held item (the same shape in the weapon masteries, the martial and Firmament blow channels), so the long-run mean of a percentage line is its exact share. The model floors each blow with no carry (src/model.js applyPct), which matches the combat card and a fresh item but is below the held item by about half a point per blow: a 25% slayer line on a level-30 katana, 19.03 against 19.41 sampled (+2.0%). This is not new in Stage 2.9 - slayer, mastery, martial and Firmament lines carry it already - but the what-if percentages pricing now enters (analyze `with`) share it, so imprint and enchant deltas of a percentage power are low by that rounding.',
    evidence: 'test/pricing.test.js section 5 (250,000 blows of one held item); lootPowers.js:176-181; model.js applyPct',
    fix: 'A later stage: the blow as a distribution over the carried remainder (a state the card does not have).',
  },
  'W-DEX-LOADOUT': {
    title: 'A class foe\'s rolled kit is the stock delegate\'s, not Enemy Expansion\'s',
    detail:
      'The client boots Daggerfall Enemy Expansion (scenes/shared.js:1518), and its install replaces the enemy-equipment delegate (systems/enemyExpansion/dexInstall.js:246-247 setEnemyEquipmentAssigner(createDexEquipmentAssigner)), which assignEnemyStartingEquipment consults first (combat/enemyEquipment.js:346). For a class foe the booted roll gives a different kit on the same dice (128 at level 45, seeds 0x52-0x54: the stock roll wears 1-5 pieces, the booted one none or a cuirass); monsters are unchanged. gearEnemy rolls the stock delegate. Found by the Stage 2.8 oracle, which rolls in a booted realm; before it, the oracle rolled the same unbooted delegate as the simulator.',
    evidence: 'test/differential.test.js "the game\'s own enemy loadout"; tools/vendor-parity.mjs "booted class loadout" (vendored = full checkout)',
    fix: 'A later equipment stage: gearEnemy rolls through the booted delegate (systems/enemyExpansion/dexEquipment.js).',
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
