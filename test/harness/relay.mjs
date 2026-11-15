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
