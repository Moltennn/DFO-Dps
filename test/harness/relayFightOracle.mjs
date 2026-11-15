/*
 * test/harness/relayFightOracle.mjs - Stage 3.4.1 whole-compositor upstream oracle.
 *
 * Drives the pinned upstream path for one ordered attack list: calculateAttackDamage (and thus lootBlow/lootStrike),
 * the seeded Flow clock, takeOwed (the relay echo), bossStrikeAt (the target's resistance) and gateBrain.applyHit.
 * It returns the per-event outcome for the local event seam and the per-event upstream claim/relay state. No local
 * result is used as an expected value.
 */
import { upstreamEntity } from './fixtures.mjs';
import { generator } from './prng.mjs';
import {
  _resetLootPowersForTests, _setLootPowersClockForTests, _setLootPowersRandForTests, flowStacks,
} from '../../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { takeOwed } from '../../vendor/upstream/a3eb1605/src/systems/playerDoor.js';

/**
 * @param {object} u the upstream harness
 * @param {object} o desc, item, offItem, body (upstream-minted; body.health is advanced), level, pool, events
 *   ([{t, hand}]), seed, fresh, shieldUntil (seconds), traits (boss traits on the body for bossStrikeAt)
 */
export async function upstreamRelayEvents(u, {
  desc, item, offItem = null, body, level, pool, events, seed = 1, fresh = true, shieldUntil = 0, traits = [],
}) {
  const rng = generator(seed);
  const attacker = upstreamEntity(desc);
  const slots = u.equip.equipTableOf(attacker);
  const G = u.gateBrain;
  const f = G.newFight(1, 0, 1e12, 'ruhn');
  G.joinFight(f, 'me', 'Me', level, 0, true);
  f.max = pool;
  f.hp = pool;
  f.shieldUntil = Math.max(0, Number(shieldUntil) || 0) * 1000;
  const p = f.players.me;
  if (!fresh) p.bucket = 0;
  const pose = { x: f.pos[0] + 3, z: f.pos[1] };
  body.maxHealth = pool;
  body.health = pool;
  body.bossTraits = traits;
  slots[u.equip.EQUIP_SLOTS.RightHand] = item;
  slots[u.equip.EQUIP_SLOTS.LeftHand] = offItem;

  let notes = null;
  let strikeInfo = null;
  u.formulas.registerAttackResolutionListener('relayFightOracle', (n) => { notes = n; });
  u.formulas.registerPlayerStrikeListener('relayFightOracle', (_a, _t, _d, _w, info) => { strikeInfo = info; });
  let now = 0;
  _resetLootPowersForTests();
  _setLootPowersClockForTests(() => now);
  _setLootPowersRandForTests(() => rng());
  const rows = [];
  try {
    for (const ev of events) {
      now = ev.t;
      const hand = ev.hand ?? 'main';
      const w = hand === 'off' ? offItem : item;
      if (!w) throw new Error(`upstreamRelayEvents: no ${hand} item`);
      const slot = hand === 'off' ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand;
      slots[slot] = w;
      const strike = 'StrikeLeft';
      const mods = u.playerWeapon.SWING_MODS[strike];
      const opts = {
        weapon: w, damageMod: mods.damage, toHitMod: mods.toHit, rolls: () => rng(), backstabChance: 0,
      };
      if (hand === 'off') {
        opts.toHitMod += u.handsLaw.offHandToHit(attacker.stats.agility);
        Object.assign(opts, u.handsLaw.OFF_HAND_BLOW);
      }
      const warded = now * 1000 < f.shieldUntil;
      body.warded = warded;
      body.health = Math.max(0, f.hp);
      notes = null;
      strikeInfo = null;
      const flowBefore = flowStacks(now);
      const raw = u.formulas.calculateAttackDamage(attacker, body, opts);
      const owed = takeOwed(body);
      const whole = strikeInfo ? strikeInfo.blow !== false : true;
      let sent = 0;
      let got = 0;
      let preEchoBlow = 0;
      let echoDamage = 0;
      let hostBlow = 0;
      if (!warded && raw > 0) {
        preEchoBlow = u.bossTraits.bossStrikeAt(body, raw, 'melee', w, null, false, null);
        echoDamage = owed > 0 ? u.bossTraits.bossStrikeAt(body, owed, 'melee', w, null, false, null) : 0;
        hostBlow = preEchoBlow + echoDamage;
        sent = Math.round(hostBlow);
        if (sent >= 1) got = G.applyHit(f, 'me', sent, G.HIT_KINDS.Melee, pose, now * 1000);
      }
      rows.push({
        t: ev.t, hand, warded, raw, whole,
        hit: notes ? !!notes.hit : false,
        echoHits: owed > 0 ? 1 : 0,
        flowBefore, flowAfter: flowStacks(now),
        sent, hostBlow, preEchoBlow, echoDamage, got, accepted: got > 0,
        bucket: p.bucket, tokens: p.rate, hp: f.hp, clipped: p.clipped,
        outcome: {
          hit: notes ? !!notes.hit : false, whole, formulaPositive: raw > 0,
          blow: warded ? 0 : preEchoBlow,
          echoDamage: warded ? 0 : echoDamage,
          echoMask: owed > 0 ? 1 : 0, echoHits: owed > 0 ? 1 : 0,
        },
      });
    }
  } finally {
    u.formulas.registerAttackResolutionListener('relayFightOracle', null);
    u.formulas.registerPlayerStrikeListener('relayFightOracle', null);
    _resetLootPowersForTests();
    _setLootPowersClockForTests(null);
    _setLootPowersRandForTests(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
    slots[u.equip.EQUIP_SLOTS.LeftHand] = null;
  }
  return { rows, hp: f.hp, landed: rows.reduce((s, r) => s + r.got, 0) };
}
