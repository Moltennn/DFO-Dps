/*
 * test/harness/fightOracle.mjs - one seeded upstream fight for the Stage 3.2 differential.
 *
 * The event list (`{t, hand}` hits) is a test input, generated from the schedule under test only for the damage/health
 * comparison; the attack-timing test checks that schedule against upstream's own hit-frame/FLURRY constants. Every
 * damage event is upstream's `calculateAttackDamage` (its formula, payload, strike listeners), with the target body
 * minted upstream. No local outcome, damage or distribution is handed in.
 *
 * Echo: `lootStrike` runs inside the formula; an ordinary foe's repeat is paid through the player door, exactly as the
 * host's `hurtFoe` does. A body with `relayHealth` is out of scope here (Stage 3.3 owns the relay).
 */
import { upstreamEntity, upstreamWeapon } from './fixtures.mjs';
import { generator } from './prng.mjs';
import { setPlayerDoor, takeOwed } from '../../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import {
  _resetLootPowersForTests, _setLootPowersRandForTests,
} from '../../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

/**
 * @param {object} u the oracle
 * @param {object} o desc, item, offItem, body (upstream-minted), events [{t,hand}], seed, uptime, traits
 * @returns {{ttk:number|null, damageDealt:number, blows:number, remainingHealth:number, overkill:number, trace:Array}}
 */
export function upstreamFight(u, { desc, item, offItem = null, body, events, seed, uptime = 0, traits = [] }) {
  const rng = generator(seed);
  const attacker = upstreamEntity(desc);
  const slots = u.equip.equipTableOf(attacker);
  const slotFor = (hand) => (hand === 'off' ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand);
  const backSkill = desc.skills[19];
  let own = 0;
  _resetLootPowersForTests();
  _setLootPowersRandForTests(() => rng());
  setPlayerDoor({
    foes: () => [{ entity: body, dead: false }],
    feet: () => [0, 0, 0],
    hurtFoe: (_f, n) => { own += n; },
    castOnPlayer: () => {},
  });
  const initial = body.health;
  let hp = initial;
  let dealt = 0;
  let ttk = null;
  let t = 0;
  const trace = [];
  try {
    for (const ev of events) {
      if (!(hp > 0) || ev.t > 3600) break;
      const directionIndex = Math.floor(rng() * u.playerWeapon.CLICK_ATTACK_DIRECTIONS.length);
      const strike = u.anims.DIRECTION_TO_STRIKE[u.playerWeapon.CLICK_ATTACK_DIRECTIONS[directionIndex]];
      const mods = u.playerWeapon.SWING_MODS[strike];
      const facing = uptime > 0 ? rng() < uptime : false;
      // Stage 3.2 excludes equipment wear: every event gets a fresh item, as the Stage 3.1 oracle does.
      const w = ev.hand === 'off' ? (offItem ? { ...offItem } : null) : (item ? { ...item } : null);
      const slot = slotFor(ev.hand);
      slots[slot] = w;
      const opts = {
        weapon: w, damageMod: mods.damage, toHitMod: mods.toHit,
        backstabChance: facing ? backSkill : 0, rolls: rng,
      };
      if (ev.hand === 'off') {
        opts.toHitMod += u.handsLaw.offHandToHit(attacker.stats.agility);
        Object.assign(opts, u.handsLaw.OFF_HAND_BLOW);
      }
      own = 0;
      body.health = Math.max(0, hp); // the share the formula reads is the pool that stands at this hit
      const raw = u.formulas.calculateAttackDamage(attacker, body, opts);
      const owed = takeOwed(body); // relay-only; zero for an ordinary body
      const struck = (d, kind) => (traits.length && d > 0
        ? u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind, weapon: w }).damage : d);
      const damage = struck(raw, w?.group === 'Weapons' && w?.templateIndex === 129 ? 'arrow' : 'melee')
        + (owed > 0 ? struck(owed, 'melee') : 0) + own;
      t = ev.t;
      hp -= damage;
      dealt += damage;
      trace.push({ t, hand: ev.hand, damage, hit: damage > 0, remaining: Math.max(0, hp) });
      if (hp <= 0) { ttk = t; break; }
    }
  } finally {
    _resetLootPowersForTests();
    setPlayerDoor(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
    slots[u.equip.EQUIP_SLOTS.LeftHand] = null;
  }
  return {
    ttk,
    damageDealt: dealt,
    blows: trace.length,
    remainingHealth: Math.max(0, hp),
    overkill: Math.max(0, dealt - initial),
    trace,
  };
}

/** Upstream item fields for a local fixture item (a fresh object per event). */
export const oracleItem = (item) => (item ? {
  ...upstreamWeapon(item),
  ...(item.rarity ? { rarity: item.rarity } : {}),
  ...(item.legendary ? { legendary: item.legendary } : {}),
  ...(item.imprint ? { imprint: item.imprint } : {}),
  ...(item.enchantments ? { enchantments: item.enchantments.map((e) => ({ ...e })), isIdentified: true } : {}),
} : null);
