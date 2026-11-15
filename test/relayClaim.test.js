/*
 * test/relayClaim.test.js - Stage 3.3, the streaming relay claim engine's contract.
 *
 * These pin the game's order (gateBrain.js applyHit): a dead/invalid claim touches no clock; a shielded claim touches no
 * clock; `spendBlow` refills the token bucket and charges a token; only then does the damage bucket refill and pay
 * `min(claim, 12 x ref, bucket, health)`. The boundary cases are exact, not approximate: four tokens at t=0, a token at
 * exactly 0.25 s, a claim equal to the cap, the bucket and the health, and a claim at exactly `shieldUntil`.
 *
 * The differential file (test/relayClaimDifferential.test.js) proves the same numbers against upstream applyHit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allowanceLaw } from '../src/allowance.js';
import { createRelayClaimEngine } from '../src/relayClaim.js';

const LEVEL = 45;
const LAW = allowanceLaw(LEVEL); // ref 50, depth 750, rate 150, cap 600, 4 tokens
const SHARE = 12000;

const engine = (o = {}) => createRelayClaimEngine({ level: LEVEL, share: SHARE, ...o });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const claims = (e, list) => list.map(([t, d]) => e.claim({ t, damage: d }));

test('1. the relay constants are the game\'s and a fresh join starts full', () => {
  const e = engine();
  assert.deepEqual([LAW.depth, LAW.rate, LAW.cap, LAW.hitHz], [750, 150, 600, 4]);
  assert.equal(e.bucket, 750);
  assert.equal(e.tokens, 4);
  assert.equal(e.hp, SHARE);
  const s = e.summary();
  assert.equal(s.bucketCapacity, 750);
  assert.equal(s.tokenCapacity, 4);
  assert.equal(s.claims, 0);
});

test('2. tokens and bucket at exact boundaries: four at t=0, the fifth refused, the next at 0.25 s', () => {
  const e = engine();
  const r = claims(e, [[0, 100], [0, 100], [0, 100], [0, 100], [0, 100]]);
  assert.deepEqual(r.map((x) => x.got), [100, 100, 100, 100, 0]);
  assert.equal(r[4].reason, 'noToken');
  assert.equal(r[4].tokensBefore, 0);
  assert.equal(r[4].tokensAfter, 0);
  assert.equal(r[4].bucketBefore, 350);
  assert.equal(r[4].bucketAfter, 350, 'the bucket is not refilled when no token is spent');
  assert.equal(e.tokens, 0);
  assert.equal(e.bucket, 350);
  // 0.249 s gives 0.996 of a token: still refused; 0.25 s reaches exactly 1 and is accepted
  const before = e.claim({ t: 0.249, damage: 100 });
  assert.equal(before.reason, 'noToken');
  assert.ok(near(before.tokensAfter, 0.996));
  const at = e.claim({ t: 0.25, damage: 100 });
  assert.equal(at.accepted, true);
  assert.ok(near(at.tokensAfter, 0), 'the refill reached exactly one token');
  assert.ok(near(at.bucketBefore, 350));
  assert.ok(near(at.bucketRefilled, 350 + 0.25 * 150), 'the bucket refilled from the last accepted claim');
  assert.ok(near(at.bucketAfter, 350 + 0.25 * 150 - 100));
});

test('3. zero, negative and non-finite claims are refused before any clock is touched', () => {
  const e = engine();
  for (const d of [0, -1, NaN, Infinity, -Infinity]) {
    const r = e.claim({ t: 0, damage: d });
    assert.equal(r.reason, 'invalid');
    assert.equal(r.tokenSpent, false);
    assert.equal(r.tokensBefore, 4);
    assert.equal(r.bucketBefore, 750);
  }
  assert.equal(e.summary().invalid, 5);
  assert.equal(e.tokens, 4);
  assert.equal(e.bucket, 750);
  // and a valid claim at the same instant still has all four tokens
  assert.equal(e.claim({ t: 0, damage: 100 }).accepted, true);
  assert.equal(e.tokens, 3);
  const s = e.summary();
  assert.ok(near(s.dealt + s.clipped + s.refusedOffer, s.offered), 'offered = dealt + clipped + refused');
});

test('4. the cap, the bucket and the health clip in that order; the excess is discarded', () => {
  const e = engine();
  const a = e.claim({ t: 0, damage: 600 });
  assert.equal(a.got, 600);
  assert.equal(a.capClip, 0);
  const b = e.claim({ t: 0, damage: 601 });
  assert.equal(b.got, 150, 'the bucket has 150 left');
  assert.equal(b.capClip, 1);
  assert.equal(b.bucketClip, 450);
  const c = e.claim({ t: 0, damage: 900 });
  assert.equal(c.got, 0);
  assert.equal(c.reason, 'empty');
  assert.equal(c.bucketClip, 600);
  assert.equal(c.tokenSpent, true, 'the token is spent even when the purse is empty');
  // health clip: a custom deep bucket and a small pool
  const small = createRelayClaimEngine({ level: LEVEL, share: 100, law: { ...LAW, cap: 1000, depth: 1000 } });
  const k = small.claim({ t: 0, damage: 150 });
  assert.equal(k.got, 100);
  assert.equal(k.healthClip, 50);
  assert.equal(k.killed, true);
  assert.equal(small.hp, 0);
  assert.equal(small.claim({ t: 1, damage: 10 }).reason, 'dead');
});

test('5. an exact bucket can be emptied, then refills at 3 x ref a second', () => {
  const e = createRelayClaimEngine({ level: LEVEL, share: SHARE, law: { ...LAW, cap: 10000 } });
  const drained = e.claim({ t: 0, damage: 750 });
  assert.equal(drained.got, 750);
  assert.equal(e.bucket, 0);
  const at100 = e.claim({ t: 0.1, damage: 100 });
  assert.equal(at100.got, 15); // 0.1 s x 150/s
  assert.equal(at100.bucketClip, 85);
  assert.equal(e.bucket, 0);
  const at1 = e.claim({ t: 1, damage: 200 });
  assert.equal(at1.got, 135); // 0.9 s x 150/s
  assert.equal(e.bucket, 0);
  const at5 = e.claim({ t: 5, damage: 600 });
  assert.equal(at5.got, 600); // 4 s x 150/s, capped at the 750 depth
  assert.equal(e.bucket, 0);
});

test('6. a fixed shield refuses before the token, and a claim at exactly its end is accepted', () => {
  const e = engine({ shieldUntil: 1 });
  const before = e.claim({ t: 0.999, damage: 100 });
  assert.equal(before.reason, 'shielded');
  assert.equal(before.tokenSpent, false);
  assert.equal(e.tokens, 4);
  assert.equal(e.bucket, 750);
  const at = e.claim({ t: 1, damage: 100 });
  assert.equal(at.accepted, true);
  assert.equal(e.tokens, 3);
  // an invalid claim while shielded is invalid (the game checks damage first), and still touches no clock
  assert.equal(e.claim({ t: 1.5, damage: 0 }).reason, 'invalid');
});

test('7. a wounded-boss join starts with an empty bucket but four tokens; recovery is the refill', () => {
  const e = engine({ fresh: false });
  assert.equal(e.bucket, 0);
  assert.equal(e.tokens, 4);
  const first = e.claim({ t: 0, damage: 100 });
  assert.equal(first.reason, 'empty');
  assert.equal(first.tokenSpent, true);
  const later = e.claim({ t: 1, damage: 100 });
  assert.equal(later.got, 100);
  assert.equal(later.bucketBefore, 0, 'the stored bucket before this claim');
  assert.equal(later.bucketRefilled, 150, 'one second of refill');
  assert.equal(later.bucketAfter, 50);
});

test('8. ordering, ties and deterministic replay', () => {
  const e = engine();
  e.claim({ t: 1, damage: 10 });
  assert.throws(() => e.claim({ t: 0.5, damage: 10 }), /non-decreasing/);
  const a = engine();
  const b = engine();
  const list = [[0, 100], [0, 200], [0.25, 900], [1, 0], [1, 600], [2, 750]];
  const ra = claims(a, list);
  const rb = claims(b, list);
  assert.deepEqual(ra, rb);
  assert.deepEqual(a.summary(), b.summary());
  assert.equal(a.summary().claims, list.length);
  assert.equal('history' in a, false, 'the engine keeps no claim history');
});

test('9. a long stream is streaming: counters only, identical on replay', () => {
  const run = () => {
    const e = engine();
    for (let i = 0; i < 50000; i++) e.claim({ t: i * 0.3, damage: 100 });
    return e.summary();
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.equal(a.claims, 50000);
  assert.ok(a.accepted > 0 && a.accepted < a.claims);
  assert.ok(Number.isFinite(a.bucket) && a.bucket >= 0 && a.bucket <= 750);
  assert.ok(a.tokens >= 0 && a.tokens < 4);
});

test('10. the engine clock is the claim timestamp; refused claims do not move the purse', () => {
  const e = engine();
  for (let i = 0; i < 4; i++) assert.equal(e.claim({ t: 0, damage: 100 }).accepted, true);
  const noToken = e.claim({ t: 0.1, damage: 100 });
  assert.equal(noToken.reason, 'noToken');
  assert.equal(e.time, 0.1, 'the engine clock is the claim time');
  assert.equal(e.bucket, 350, 'a no-token claim does not refill the purse');
  assert.ok(near(e.tokens, 0.4), 'the token clock did advance');

  const shielded = engine({ shieldUntil: 1 });
  const before = shielded.claim({ t: 0.5, damage: 100 });
  assert.equal(before.reason, 'shielded');
  assert.equal(shielded.time, 0.5);
  assert.equal(shielded.tokens, 4);
  assert.equal(shielded.bucket, 750);
  const invalid = shielded.claim({ t: 0.6, damage: 0 });
  assert.equal(invalid.reason, 'invalid');
  assert.equal(shielded.time, 0.6);
  assert.equal(shielded.tokens, 4);
  assert.equal(shielded.bucket, 750);
});
