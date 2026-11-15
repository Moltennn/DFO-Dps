/*
 * test/harness/relay.mjs - drive the game's own relay law (net/gate/gateBrain.js
 * joinFight / applyHit) with a schedule of damage claims.
 *
 * This is the oracle for the per-player damage allowance. It calls the vendored
 * upstream functions; nothing here re-implements the law. The only thing the
 * harness adds is the phase ward: stepBrain raises it when health falls through
 * a phase line (gateBrain.js:1706-1708), and stepBrain is the whole boss AI, so
 * the harness sets `shieldUntil` itself at the same moment and for the same
 * span the simulator is told about. Both sides then share one stated rule.
 */
import { upstream } from './upstream.mjs';

/** Every claim a set of fixed-interval streams makes up to `horizonS`, in time order (ties: stream order). */
export function expandStreams(streams, horizonS) {
  const out = [];
  streams.forEach((s, index) => {
    for (let t = s.start ?? s.interval, k = 0; t <= horizonS + 1e-12; k++, t = (s.start ?? s.interval) + k * s.interval) {
      out.push({ t, d: s.perClaim, index });
    }
  });
  out.sort((a, b) => a.t - b.t || a.index - b.index);
  return out;
}

/**
 * Run claims through the game's relay for one player.
 * @param {{level:number, claims:Array<{t:number,d:number}>, fresh?:boolean, phases?:Array<{at:number,shieldS:number}>}} o
 * @returns {{landed:number, accepted:number, refused:number, killedAt:number|null, share:number, hp:number}}
 */
export async function relayRun({ level, claims, fresh = true, phases = [] }) {
  const u = await upstream();
  const G = u.gateBrain;
  const f = G.newFight(1, 0, 1e12, 'ruhn');
  if (!fresh) {
    // A wounded boss: someone else's share already stands in it, at 50% health, so a newcomer's bucket starts empty
    // (gateBrain.js:1228-1240 `fresh = frac >= 1`).
    G.joinFight(f, 'other', 'Other', level, 0, true);
    f.hp = f.max * 0.5;
  }
  G.joinFight(f, 'me', 'Me', level, 0, true);
  const share = f.players.me.share;
  const pose = { x: f.pos[0] + 3, z: f.pos[1] };
  const order = [...phases].sort((a, b) => b.at - a.at);
  let phaseAt = 0;
  let landed = 0;
  let accepted = 0;
  let refused = 0;
  let killedAt = null;
  for (const c of claims) {
    const ms = c.t * 1000;
    const before = f.hp;
    const got = G.applyHit(f, 'me', c.d, G.HIT_KINDS.Melee, pose, ms);
    if (got > 0) {
      accepted += 1;
      landed += got;
    } else refused += 1;
    // the ward: set exactly as stepBrain would on crossing a phase line
    while (fresh && phaseAt < order.length && f.hp <= f.max * order[phaseAt].at) {
      f.shieldUntil = Math.max(f.shieldUntil, ms + order[phaseAt].shieldS * 1000);
      phaseAt += 1;
    }
    if (f.fell && killedAt === null) killedAt = c.t;
    if (f.fell || before <= 0) break;
  }
  return { landed, accepted, refused, killedAt, share, hp: f.hp };
}

/**
 * The same relay law, one claim at a time: every result is read from the vendored player/fight state after `applyHit`.
 * The local engine must equal `got`, `bucket`, `rate`, `hp` and `clipped` after every claim, including the refused ones.
 *
 * @param {{level:number, claims:Array<{t:number,d:number}>, fresh?:boolean, shieldUntil?:number}} o
 *   `claims` in seconds, `shieldUntil` in seconds. `fresh:false` joins a boss already at half health (empty bucket).
 * @returns {{rows:Array, landed:number, accepted:number, refused:number, killedAt:number|null, hp:number, share:number}}
 */
export async function relayStream({ level, claims, fresh = true, shieldUntil = 0, share = null }) {
  const u = await upstream();
  const G = u.gateBrain;
  const f = G.newFight(1, 0, 1e12, 'ruhn');
  if (!fresh) {
    G.joinFight(f, 'other', 'Other', level, 0, true);
    f.hp = f.max * 0.5;
  }
  G.joinFight(f, 'me', 'Me', level, 0, true);
  f.shieldUntil = Math.max(0, Number(shieldUntil) || 0) * 1000;
  if (share != null) {
    // a test pool: one player's whole share, as the local engine's `share` input
    f.max = share;
    f.hp = share;
  }
  const p = f.players.me;
  const initialShare = f.hp;
  const pose = { x: f.pos[0] + 3, z: f.pos[1] };
  const rows = [];
  let landed = 0;
  let accepted = 0;
  let refused = 0;
  let killedAt = null;
  for (const c of claims) {
    const before = { bucket: p.bucket, rate: p.rate, hp: f.hp, clipped: p.clipped };
    const got = G.applyHit(f, 'me', c.d, G.HIT_KINDS.Melee, pose, c.t * 1000);
    rows.push({
      t: c.t,
      claim: c.d,
      got,
      bucketBefore: before.bucket,
      bucketAfter: p.bucket,
      tokensBefore: before.rate,
      tokensAfter: p.rate,
      hpAfter: f.hp,
      clippedAfter: p.clipped,
      dealtAfter: p.dealt,
    });
    if (got > 0) { accepted += 1; landed += got; } else refused += 1;
    if (f.fell && killedAt === null) killedAt = c.t;
  }
  return { rows, landed, accepted, refused, killedAt, hp: f.hp, share: initialShare };
}
