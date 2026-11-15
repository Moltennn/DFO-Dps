/*
 * test/blowDifferential.test.js - Stage 3.1, Part E: the per-blow outcome distribution against the pinned game.
 *
 * For each scenario the oracle (test/harness/blowOracle.mjs) draws N blows from upstream's own code - the direction
 * draw, calculateAttackDamage with its resolution report, the Strikes payload, the strike listeners and the host's
 * steps - and records the JOINT key (direction, facing, backstab, critical, hit, off-hand whole, echo mask, blow, an
 * ordinary foe's echo hit). The local FIGHT tier, enumerated from `src/blowOutcomes.js`, must give every cell of that
 * joint distribution its probability:
 *   - no key upstream produces may have local probability 0;
 *   - each cell with expected count >= 20 is within |z| 4.5, and the Pearson statistic over all cells, pooled below 20,
 *     is within z 3.5 of its null (Wilson-Hilferty). Both bounds, the draw counts and the seeds are fixed in advance
 *     (test/harness/blowConfigs.mjs) and were never tuned to a result.
 * Then the marginals (hit, critical, whole, echo, each direction, the mean damage uncapped and capped).
 * The oracle is handed INPUTS only (a description, an item, a body request, the host's settings); the local side never
 * hands it a distribution, a damage value or a target field.
 *
 * Negative controls prove the comparison has teeth: the neutral swing direction the model used before Stage 2.13, and a
 * build missing its Strikes payload, are both rejected against the same upstream sample.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { weaponOf } from '../src/model.js';
import { blowOutcomes, blowFightTier, mergeToFightTier, tierMeans } from '../src/blowOutcomes.js';
import { upstream, pcaaoModules, referenceFoe } from './harness/upstream.mjs';
import { oracleEntity, upstreamBody, upstreamWear } from './harness/upstreamBodies.mjs';
import { upstreamWeapon, weapon } from './harness/fixtures.mjs';
import { CAREER, CONFIGS, CUIRASS_AND_TOWER, localItem, localSide } from './harness/blowConfigs.mjs';
import { compareCounts, jointKey, sampleCoreParts, sampleJointBlow } from './harness/blowOracle.mjs';

const MARGINAL_Z = 4.5;

/** The upstream item and body for a scenario - built from its inputs only. */
async function oracleSide(u, cfg) {
  const base = upstreamWeapon(weapon(cfg.template, { material: 9 }));
  const item = { ...base, ...(cfg.fields ?? {}), ...(cfg.fields?.enchantments ? { isIdentified: true } : {}) };
  let body;
  if (cfg.target === 'reference') body = referenceFoe(u, 30, 'tough');
  else if (cfg.target === 'relay') body = oracleEntity((await upstreamBody({ kind: 'standIn', mobile: 31 })).body);
  else {
    const { body: lord } = await upstreamBody({ kind: 'mint', mobile: 31, career: CAREER });
    body = upstreamWear(u, oracleEntity(lord), cfg.pieces ?? CUIRASS_AND_TOWER);
  }
  return { item, body };
}

const proportionZ = (observed, n, p) => {
  if (p < 1e-12) return observed === 0 ? 0 : Infinity; // a probability of 0 or 1 up to rounding is exact: any other count is a failure
  if (p > 1 - 1e-12) return observed === n ? 0 : Infinity;
  return (observed - n * p) / Math.sqrt(n * p * (1 - p));
};
const meanZ = (sum, sumSq, n, expected) => {
  const mean = sum / n;
  const se = Math.sqrt(Math.max(0, sumSq / n - mean * mean) / n);
  return se > 0 ? (expected - mean) / se : (expected === mean ? 0 : Infinity);
};

function marginalGaps(sample, tier) {
  const { agg, draws: n } = sample;
  const mass = (pred) => tier.outcomes.filter(pred).reduce((s, o) => s + o.p, 0);
  const m = tierMeans(tier);
  const gaps = {
    hit: proportionZ(agg.hit, n, mass((o) => o.hit)),
    crit: proportionZ(agg.crit, n, mass((o) => o.crit)),
    whole: proportionZ(agg.whole, n, mass((o) => o.whole)),
    echo: proportionZ(agg.echo, n, mass((o) => o.echoMask > 0)),
    meanDamage: meanZ(agg.sum, agg.sumSq, n, m.perSwing),
    meanCapped: meanZ(agg.sumCapped, agg.sumCappedSq, n, m.cappedPerSwing),
  };
  tier.directions.forEach((_, i) => { gaps[`direction ${i}`] = proportionZ(agg.dir[i], n, mass((o) => o.directionIndex === i)); });
  return gaps;
}

const describe = (r) => `chi z ${r.chiZ.toFixed(2)} (${r.cells} cells, df ${r.df}), max cell z ${r.maxZ.toFixed(2)}${r.worst ? ` at ${r.worst.key} (obs ${r.worst.observed}, exp ${r.worst.expected.toFixed(1)})` : ''}, unsupported ${r.unsupported.slice(0, 3).join('; ')}`;

const SAMPLES = new Map();

for (const cfg of CONFIGS) {
  test(`${cfg.id}: the joint blow distribution, upstream ${cfg.draws} draws`, async () => {
    const u = await upstream();
    const { item, body } = await oracleSide(u, cfg);
    const sample = sampleJointBlow(u, {
      desc: cfg.desc, item, body, hand: cfg.hand ?? 'main', seed: cfg.seed, draws: cfg.draws, traits: cfg.traits ?? [],
      cap: cfg.cap ?? 0, uptime: cfg.uptime ?? 0, bow: !!cfg.bow, echoPower: cfg.echoPower ?? null, echoCalls: cfg.echoCalls ?? 1,
      door: !!cfg.door,
    });
    assert.deepEqual(sample.drift, { body: false, skills: false }, 'sampling wore nothing and trained nothing');

    const { ch, args, hand } = localSide(cfg);
    const full = blowOutcomes(ch, { ...args, hand });
    const tier = mergeToFightTier(full);
    SAMPLES.set(cfg.id, { sample, ch, args, hand, cfg, item });

    const expected = new Map(tier.outcomes.map((o) => [jointKey(o), o.p]));
    const r = compareCounts(sample.counts, sample.draws, expected);
    assert.ok(r.cells >= 8, `${cfg.id}: cells compared (${r.cells})`);
    assert.ok(r.ok, `${cfg.id}: joint distribution - ${describe(r)}`);

    for (const [name, z] of Object.entries(marginalGaps(sample, tier))) {
      assert.ok(Math.abs(z) <= MARGINAL_Z, `${cfg.id}: marginal ${name} z ${z.toFixed(2)}`);
    }
    // the capped mean differs from the uncapped one exactly where the cap binds, on both sides
    const m = tierMeans(tier);
    assert.equal(cfg.cap > 0 && cfg.template !== 130 ? m.cappedPerSwing < m.perSwing : true, true);
  });
}

test('negative controls: the comparison rejects the pre-Stage-2.13 neutral direction and a missing Strikes payload', async () => {
  const entry = SAMPLES.get(CONFIGS[1].id);
  assert.ok(entry, 'the strong-gate scenario ran first');
  const { sample, ch, args, hand, item } = entry;
  const run = (a) => {
    const tier = blowFightTier(ch, { ...a, hand });
    return compareCounts(sample.counts, sample.draws, new Map(tier.outcomes.map((o) => [jointKey(o), o.p])));
  };
  assert.ok(run(args).ok, 'the real distribution passes');
  const neutral = run({ ...args, swing: 'StrikeLeft' });
  assert.equal(neutral.ok, false, `neutral direction rejected (${describe(neutral)})`);
  const bare = localItem({ ...CONFIGS[1], fields: { rarity: 'rare', imprint: 'warp-edge' } });
  const noPayload = run({ ...args, weapon: weaponOf(bare) });
  assert.equal(noPayload.ok, false, `a build without its Strikes payload rejected (${describe(noPayload)})`);
  const noBack = run({ ...args, backstabUptime: 0 });
  assert.equal(noBack.ok, false, 'a missing back-facing share rejected');
  void item;
});

for (const idx of [0, 8, 9]) {
  const cfg = CONFIGS[idx];
  test(`${cfg.id}: body part x critical x hit x blow against upstream's core (the part is not in the fight tier)`, async () => {
    const u = await upstream();
    const modules = pcaaoModules(u);
    const { item, body } = await oracleSide(u, cfg);
    const sample = sampleCoreParts(u, modules, { desc: cfg.desc, item, body, seed: cfg.seed + 0x100, draws: cfg.draws });
    const { ch, args } = localSide(cfg);
    const full = blowOutcomes(ch, args);
    const by = new Map();
    for (const o of full.outcomes) {
      const k = [o.directionIndex, o.part, o.crit ? 1 : 0, o.hit ? 1 : 0, o.blow].join('|');
      by.set(k, (by.get(k) ?? 0) + o.p);
    }
    const r = compareCounts(sample.counts, sample.draws, by);
    assert.ok(r.cells >= 20, `cells compared (${r.cells})`);
    assert.ok(r.ok, `${cfg.id}: ${describe(r)}`);
    // the part marginal on its own: seven weights, hit and not
    const partCounts = new Array(7).fill(0);
    for (const [k, c] of sample.counts) partCounts[Number(k.split('|')[1])] += c;
    for (let p = 0; p < 7; p++) {
      const pp = full.outcomes.filter((o) => o.part === p).reduce((s, o) => s + o.p, 0);
      const z = proportionZ(partCounts[p], sample.draws, pp);
      assert.ok(Math.abs(z) <= MARGINAL_Z, `${cfg.id}: part ${p} z ${z.toFixed(2)}`);
    }
  });
}
