/*
 * test/harness/relayFightOracle.mjs - Stage 3.4.1 whole-compositor upstream oracle.
 *
 * Drives the pinned upstream path for one ordered attack list: calculateAttackDamage (and thus lootBlow/lootStrike),
 * the seeded Flow clock, takeOwed (the relay echo), bossStrikeAt (the target's resistance) and gateBrain.applyHit.
 * It returns the per-event outcome for the local event seam and the per-event upstream claim/relay state. No local
 * result is used as an expected value.
 *
 * STAGE 3.7f adds the CWS + Continuous Damage path, composed the way the host composes it:
 *   - a Cast When Strikes row is resolved INSIDE calculateAttackDamage by the vendored
 *     `systems/enchantments.js` doItemEnchantmentPayloads, whose `enchantCtx.applySpellToTarget` calls the vendored
 *     `effects.applySpell` (`full:scenes/gate/standInSpell.js:198-217`, `combat/formulas.js:826-836`); its DIRECT damage
 *     and its first round are submitted as ONE claim BEFORE the blow's claim, at the same timestamp;
 *   - later rounds are the vendored `effects.tickActiveEffects` at `k * 5 s` from t=0 (`src/spells.js:21`), ONE claim
 *     per round carrying the live entries' tick sum (`full:scenes/gate/standInSpell.js:131-151`); a round at a blow's
 *     own timestamp comes AFTER the blow's claim (the M35/M38 ordering rule, an ASSUMPTION - upstream has no tie to
 *     read), and rounds still due after the last event are drained while an entry lives and the boss lives;
 *   - a warded blow (`now*1000 < f.shieldUntil`) sets `body.warded`, so the vendored CastWhenStrikes refuses the cast
 *     itself (`systems/enchantments.js:597`); a round always ticks and its CLAIM is left to the engine, which refuses
 *     it while shielded (`net/gate/gateBrain.js:1308`);
 *   - a blow that casts and is KILLED by the cast sends no blow claim (the host's live-foe gate, `hostEnchant.js:198-209`).
 * `cwsRolls` is a separate seeded draw function for the cast and the rounds (the local fight keeps its own `cws` stream),
 * so both sides consume the same script. Everything still goes through the one vendored `applyHit`.
 */
import { upstreamEntity } from './fixtures.mjs';
import { generator } from './prng.mjs';
import {
  _resetLootPowersForTests, _setLootPowersClockForTests, _setLootPowersRandForTests, flowStacks,
} from '../../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';
import { takeOwed } from '../../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { MAGIC_ROUND_SECONDS } from '../../src/spells.js';

/**
 * @param {object} u the upstream harness
 * @param {object} o desc, item, offItem, body (upstream-minted; body.health is advanced), level, pool, events
 *   ([{t, hand}]), seed, fresh, shieldUntil (seconds), traits (boss traits on the body for bossStrikeAt),
 *   standard (a spells Map: the CWS spellbook), cwsRolls (a seeded draw function for the cast/rounds), maxSeconds (the
 *   drain's horizon)
 */
export async function upstreamRelayEvents(u, {
  desc, item, offItem = null, body, level, pool, events, seed = 1, fresh = true, shieldUntil = 0, traits = [],
  standard = null, cwsRolls = null, maxSeconds = 1e9,
}) {
  const rng = generator(seed);
  const castRolls = cwsRolls ?? (() => 0.5);
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
  /** Every claim the oracle submits, in order: `{t, kind, claim, got, bucket, tokens, hp, clipped}` (cumulative clipped). */
  const claims = [];
  const submit = (t, kind, damage) => {
    const claim = Math.round(damage);
    if (!(claim >= 1)) return 0;
    const got = G.applyHit(f, 'me', claim, G.HIT_KINDS.Melee, pose, t * 1000);
    claims.push({ t, kind, claim, got, bucket: p.bucket, tokens: p.rate, hp: f.hp, clipped: p.clipped });
    return got;
  };
  const liveEntry = () => (body.activeEffects ?? []).some((a) => a?.kind === 'continuousDamage' && (a.roundsRemaining ?? 0) > 0);
  // The vendored magic round: every live entry's tick sums into ONE claim (`standInSpell.js:131-151`).
  const roundClaim = (t) => {
    let total = 0;
    u.effects.tickActiveEffects(body, { hurt: (n) => { total += n; } }, castRolls);
    if (total > 0) submit(t, 'dot', total);
  };
  let nextRoundT = MAGIC_ROUND_SECONDS;
  // The round clock advances with the FIGHT's clock, not the entry's life: an anchor that passes with no live entry is
  // simply skipped (the local fight does the same, so a cast that lands late cannot burst the anchors it missed). The
  // final drain stops as soon as no entry is left.
  const flushRounds = (at, inclusive, stopWhenIdle = false) => {
    while (f.hp > 0 && (inclusive ? nextRoundT <= at + 1e-12 : nextRoundT < at - 1e-12)) {
      if (liveEntry()) roundClaim(nextRoundT);
      else if (stopWhenIdle) return;
      nextRoundT += MAGIC_ROUND_SECONDS;
    }
  };
  // The CWS enchantCtx: the host's landing. The cast's direct damage and its first round are one claim, before the blow's.
  const enchantCtx = standard ? {
    spellsByIndex: () => standard,
    applySpellToTarget: (record, caster) => {
      if (!(f.hp > 0)) return undefined;
      let total = 0;
      const out = u.effects.applySpell(record, level, body, { hurt: (n) => { total += n; } }, castRolls, { entity: caster });
      submit(now, 'proc', total);
      return out;
    },
  } : undefined;
  try {
    for (const ev of events) {
      now = ev.t;
      // Rounds strictly before this attack; the round at an equal timestamp comes after the blow (M35/M38).
      flushRounds(now, false);
      const hand = ev.hand ?? 'main';
      const w = hand === 'off' ? offItem : item;
      if (!w) throw new Error(`upstreamRelayEvents: no ${hand} item`);
      const slot = hand === 'off' ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand;
      slots[slot] = w;
      const strike = 'StrikeLeft';
      const mods = u.playerWeapon.SWING_MODS[strike];
      const opts = {
        weapon: w, damageMod: mods.damage, toHitMod: mods.toHit, rolls: () => rng(), backstabChance: 0,
        ...(enchantCtx ? { enchantCtx } : {}),
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
      if (!warded && raw > 0 && f.hp > 0) { // the host's live-foe gate: a cast kill sends no blow claim
        preEchoBlow = u.bossTraits.bossStrikeAt(body, raw, 'melee', w, null, false, null);
        echoDamage = owed > 0 ? u.bossTraits.bossStrikeAt(body, owed, 'melee', w, null, false, null) : 0;
        hostBlow = preEchoBlow + echoDamage;
        sent = Math.round(hostBlow);
        if (sent >= 1) got = submit(now, 'blow', hostBlow);
      }
      rows.push({
        t: ev.t, hand, warded, raw, whole, strikesPositive: raw > 0,
        hit: notes ? !!notes.hit : false,
        echoHits: owed > 0 ? 1 : 0,
        flowBefore, flowAfter: flowStacks(now),
        sent, hostBlow, preEchoBlow, echoDamage, got, accepted: got > 0,
        bucket: p.bucket, tokens: p.rate, hp: f.hp, clipped: p.clipped,
        outcome: {
          hit: notes ? !!notes.hit : false, whole, formulaPositive: raw > 0, strikesPositive: raw > 0,
          blow: warded ? 0 : preEchoBlow,
          echoDamage: warded ? 0 : echoDamage,
          echoMask: owed > 0 ? 1 : 0, echoHits: owed > 0 ? 1 : 0,
        },
      });
      // Rounds at this attack's own timestamp, after the blow.
      flushRounds(now, true);
    }
    // The drain: rounds still due inside the horizon, while an entry lives and the boss lives.
    flushRounds(maxSeconds, true, true);
  } finally {
    u.formulas.registerAttackResolutionListener('relayFightOracle', null);
    u.formulas.registerPlayerStrikeListener('relayFightOracle', null);
    _resetLootPowersForTests();
    _setLootPowersClockForTests(null);
    _setLootPowersRandForTests(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
    slots[u.equip.EQUIP_SLOTS.LeftHand] = null;
  }
  return { rows, claims, hp: f.hp, landed: claims.reduce((s, r) => s + r.got, 0) };
}
