/*
 * test/relayClaimDifferential.test.js - Stage 3.3: every claim against the vendored relay.
 *
 * The oracle (`test/harness/relay.mjs` `relayStream`) calls the vendored `gateBrain.applyHit`/`spendBlow` once per
 * claim and reads the player's bucket, token count, dealt and clipped totals and the fight's health. It never uses the
 * local engine. The local engine must equal the game after EVERY claim, refused ones included, including the bucket
 * and token clocks the game leaves stale on a refused claim.
 *
 * The schedules cover four tokens at one instant, the exact 0.25 s refill, the per-claim cap, the bucket capacity,
 * an exact-health kill, a fixed shield's strict boundary, a wounded-boss join, zero/negative/NaN claims and a 1,000
 * claim seeded stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allowanceLaw } from '../src/allowance.js';
import { createRelayClaimEngine } from '../src/relayClaim.js';
import { relayStream } from './harness/relay.mjs';
import { generator } from './harness/prng.mjs';

const LEVEL = 45;
const SHARE = 12000;
const near = (a, b, eps = 1e-7) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

async function compare(label, claims, { share = SHARE, fresh = true, shieldUntil = 0 } = {}) {
  const e = createRelayClaimEngine({ level: LEVEL, share, fresh, shieldUntil });
  const local = claims.map((c) => e.claim(c));
  const up = await relayStream({ level: LEVEL, claims: claims.map((c) => ({ t: c.t, d: c.damage ?? c.d })), fresh, shieldUntil, share });
  assert.equal(up.rows.length, local.length, `${label}: rows`);
  for (let i = 0; i < local.length; i++) {
    const a = local[i];
    const b = up.rows[i];
    const at = `${label} claim ${i} (t ${b.t}, d ${b.claim})`;
    assert.ok(near(a.got, b.got), `${at}: got ${a.got} vs ${b.got}`);
    assert.ok(near(a.bucketAfter, b.bucketAfter), `${at}: bucket ${a.bucketAfter} vs ${b.bucketAfter}`);
    assert.ok(near(a.tokensAfter, b.tokensAfter), `${at}: tokens ${a.tokensAfter} vs ${b.tokensAfter}`);
    assert.ok(near(a.hpAfter, b.hpAfter), `${at}: hp ${a.hpAfter} vs ${b.hpAfter}`);
    assert.ok(near(a.clippedAfter, b.clippedAfter), `${at}: clipped ${a.clippedAfter} vs ${b.clippedAfter}`);
    assert.ok(near(a.dealtAfter, b.dealtAfter), `${at}: dealt ${a.dealtAfter} vs ${b.dealtAfter}`);
  }
  assert.equal(e.killed, up.killedAt !== null, `${label}: kill flag`);
  assert.ok(near(e.killedAt ?? 0, up.killedAt ?? 0), `${label}: killedAt ${e.killedAt} vs ${up.killedAt}`);
  assert.ok(near(e.hp, up.hp), `${label}: final hp ${e.hp} vs ${up.hp}`);
  return { e, up };
}

test('1. tokens and the damage purse at their exact boundaries', async () => {
  await compare('boundaries', [
    { t: 0, damage: 100 }, { t: 0, damage: 100 }, { t: 0, damage: 100 }, { t: 0, damage: 100 },
    { t: 0, damage: 100 }, { t: 0.249, damage: 100 }, { t: 0.25, damage: 100 }, { t: 0.25, damage: 900 },
    { t: 0.5, damage: 600 }, { t: 0.5, damage: 601 }, { t: 0.75, damage: 750 },
  ]);
});

test('2. cap, bucket and health clipping in the game order', async () => {
  await compare('clip', [
    { t: 0, damage: 600 }, { t: 0, damage: 601 }, { t: 0, damage: 900 }, { t: 1, damage: 600 },
    { t: 2, damage: 600 }, { t: 10, damage: 600 }, { t: 20, damage: 900 },
  ]);
  // exact-health kill: 600 + 450 on a 1,050 pool; the rest is clipped, not dealt
  const { e } = await compare('kill', [
    { t: 0, damage: 600 }, { t: 0, damage: 450 }, { t: 1, damage: 600 }, { t: 2, damage: 600 },
  ], { share: 1050 });
  assert.equal(e.hp, 0);
  assert.ok(e.killedAt !== null && e.summary().dealt <= 1050 + 1e-9);
});

test('3. a fixed shield: before it is refused without a token, at it is accepted', async () => {
  await compare('shield', [
    { t: 0.999, damage: 100 }, { t: 1, damage: 100 }, { t: 1.001, damage: 100 }, { t: 5, damage: 900 },
  ], { shieldUntil: 1 });
});

test('4. a wounded-boss join starts with an empty bucket and four tokens', async () => {
  await compare('fresh=false', [
    { t: 0, damage: 100 }, { t: 0, damage: 100 }, { t: 1, damage: 100 }, { t: 2, damage: 750 },
    { t: 10, damage: 600 },
  ], { fresh: false });
});

test('5. zero, negative and non-finite claims touch no clock in the game either', async () => {
  await compare('invalid', [
    { t: 0, damage: 0 }, { t: 0, damage: -5 }, { t: 0, damage: NaN }, { t: 0, damage: 100 },
    { t: 0.25, damage: 0 }, { t: 0.25, damage: 100 },
  ]);
});

test('6. a long seeded stream agrees claim for claim', async () => {
  const rng = generator(0x3301);
  const claims = [];
  let t = 0;
  for (let i = 0; i < 1000; i++) {
    t += 0.02 + rng() * 0.3;
    claims.push({ t, damage: Math.floor(rng() * 900) });
  }
  const { e } = await compare('seeded', claims);
  assert.equal(e.summary().claims, 1000);
  assert.ok(e.summary().accepted > 0 && e.summary().refused > 0);
});
