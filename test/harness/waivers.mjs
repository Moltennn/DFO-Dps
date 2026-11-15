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
    title: 'Warded shields do not suppress on-hit effects per blow',
    detail:
      'Upstream every blow-path power no-ops while the target is warded (lootPowers.js:287,354; enchantments.js:597; weaponMastery.js:137). The simulator only adds the shield seconds to the kill time.',
    evidence: 'above vs src/model.js:766-769',
    fix: 'Stage 3.',
  },
  'W-PROC-BUDGET': {
    title: 'The per-hit-capped ceiling still sums procs on top of weapon DPS',
    detail:
      'C1 made every proc and DoT round its own relay claim in the allowance run (TTK, burst, sustained). The ceiling figures (totalDps, enchantDps) still add proc damage to weapon damage, cap each DoT tick apart rather than as one summed round claim, and fold Potent Vs / Low Damage Vs (+-5) into the enchant layer instead of the blow (enchantments.js:623-631). Stage 2.9 added what the blow does with it: the payload runs for a player whatever the blow did, so upstream returns the five for a swing that MISSED too (test/pricing.test.js); analyze `with({ potentVs })` models that, but an EQUIPPED Potent Vs weapon still goes through the enchant layer, which adds `hit x 5` to the capped figure - the two disagree by the miss share until that stage.',
    evidence: 'standInSpell.js:131-151, enchantments.js:623-631 vs src/enchants.js:104-141',
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
