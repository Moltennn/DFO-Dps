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
import { _resetWeaponMasteryForTests } from '../../vendor/upstream/a3eb1605/src/systems/weaponMastery.js';
import { _resetMartialPowersForTests } from '../../vendor/upstream/a3eb1605/src/systems/martialPowers.js';
import { _resetFirmamentPowersForTests } from '../../vendor/upstream/a3eb1605/src/systems/firmamentPowers.js';

/**
 * @param {object} u the oracle
 * @param {object} o desc, item, offItem, body (upstream-minted), events [{t,hand}], seed, uptime, traits
 * @param {object} [o.reuseItem] keep ONE item object for the whole fight, as a held item is: the percentage channels'
 *   remainders (W-LOOT-CARRY) then carry between blows. The default (false) spreads a fresh clone per event - upstream's
 *   estimate path, which floors every blow.
 * @param {object} [o.attacker] a prepared upstream attacker (online flags / mastered skills) instead of `upstreamEntity(desc)`
 * @returns {{ttk:number|null, damageDealt:number, cwsDamage:number, echoDamage:number, meleeDamage:number,
 *   killSource:'cws'|'echo'|'melee'|null, blows:number, remainingHealth:number, overkill:number, trace:Array}}
 */
export function upstreamFight(u, { desc, item, offItem = null, body, events, seed, uptime = 0, traits = [], cws = null, reuseItem = false, attacker: attackerOverride = null, unaware = false }) {
  const rng = generator(seed);
  const attacker = attackerOverride ?? upstreamEntity(desc);
  const slots = u.equip.equipTableOf(attacker);
  const slotFor = (hand) => (hand === 'off' ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand);
  const backSkill = desc.skills[19];
  const initial = body.health;
  const foe = { entity: body, dead: false };
  let hp = initial;
  let dead = false;
  let own = 0;
  let cwsDealt = 0;
  let killSource = null;
  let totalCws = 0;
  let totalEcho = 0;
  let totalMelee = 0;
  _resetLootPowersForTests();
  _resetWeaponMasteryForTests();
  _resetMartialPowersForTests();
  _resetFirmamentPowersForTests();
  _setLootPowersRandForTests(() => rng());
  setPlayerDoor({
    foes: () => [foe],
    feet: () => [0, 0, 0],
    hurtFoe: (f, n) => {
      if (f.dead || !(hp > 0)) return;
      own += n;
      hp = Math.max(0, hp - n);
      body.health = hp;
      if (hp <= 0) { f.dead = true; dead = true; if (!killSource) killSource = 'echo'; }
    },
    castOnPlayer: () => {},
  });
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
      // Stage 3.2 excludes equipment wear: every event gets a fresh item, as the Stage 3.1 oracle does. `reuseItem`
      // keeps ONE item for the whole fight instead - a held item, whose percentage remainders carry (W-LOOT-CARRY).
      const w = ev.hand === 'off'
        ? (reuseItem ? offItem : (offItem ? { ...offItem } : null))
        : (reuseItem ? item : (item ? { ...item } : null));
      const slot = slotFor(ev.hand);
      slots[slot] = w;
      const opts = {
        weapon: w, damageMod: mods.damage, toHitMod: mods.toHit,
        backstabChance: facing ? backSkill : 0, rolls: rng,
        ...(unaware ? { unaware: true } : {}),
      };
      if (ev.hand === 'off') {
        opts.toHitMod += u.handsLaw.offHandToHit(attacker.stats.agility);
        Object.assign(opts, u.handsLaw.OFF_HAND_BLOW);
      }
      // The ordinary host's CWS landing (hostEnchant.js:198-225, without the spareGear branch): the cast is inside the
      // formula, before the strike listener. It is null when this scenario has no CWS item. This is the ISOLATED host
      // branch: the full host files are full-only and not imported, and hostMagic.applySpellToFoe's blowTaken/feud
      // ledger and damageFoe's boss/shield/party arms are omitted; the fight-level test uses a plain ordinary target.
      const enchantCtx = cws ? {
        spellsByIndex: () => cws,
        applySpellToTarget: (record, att) => {
          if (dead || !(hp > 0)) return;
          u.effects.applySpell(record, att.level ?? 1, body, {
            hurt: (n) => {
              if (dead || !(hp > 0)) return;
              cwsDealt += n;
              hp = Math.max(0, hp - n);
              body.health = hp;
              if (hp <= 0) { dead = true; foe.dead = true; if (!killSource) killSource = 'cws'; }
            },
          }, rng, { entity: att });
        },
      } : undefined;
      if (enchantCtx) opts.enchantCtx = enchantCtx;
      own = 0;
      cwsDealt = 0;
      dead = false;
      foe.dead = false;
      body.health = Math.max(0, hp); // the share the formula reads is the pool that stands at this hit
      const raw = u.formulas.calculateAttackDamage(attacker, body, opts);
      // A held item keeps its IDENTITY for the whole fight (the percentage remainders), but this oracle excludes ordinary
      // wear (Stage 3.2): restore its condition so 300 held blows do not break the very item the carry rides.
      if (reuseItem && w && Number.isFinite(w.currentCondition) && Number.isFinite(w.maxCondition)) w.currentCondition = w.maxCondition;
      const owed = takeOwed(body); // relay-only; zero for an ordinary body
      const struck = (d, kind) => (traits.length && d > 0
        ? u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind, weapon: w }).damage : d);
      // The strike listener's echo is its own ordinary-foe hit (`door.hurtFoe`) inside the formula, before the host
      // applies the melee blow. The door below already subtracted it from `hp`; if it (or CWS) killed, `damageFoe`
      // sees `foe.dead` and drops the melee.
      const echo = own;
      const melee = hp > 0
        ? struck(raw, w?.group === 'Weapons' && w?.templateIndex === 129 ? 'arrow' : 'melee')
          + (owed > 0 ? struck(owed, 'melee') : 0)
        : 0;
      const damage = cwsDealt + echo + melee;
      t = ev.t;
      hp = Math.max(0, hp - melee);
      if (hp <= 0) { dead = true; foe.dead = true; if (!killSource) killSource = 'melee'; }
      dealt += damage;
      totalCws += cwsDealt;
      totalEcho += echo;
      totalMelee += melee;
      trace.push({ t, hand: ev.hand, damage, hit: damage > 0, remaining: hp, cws: cwsDealt, echo, melee });
      if (hp <= 0) { ttk = t; break; }
    }
  } finally {
    _resetLootPowersForTests();
    _resetWeaponMasteryForTests();
    _resetMartialPowersForTests();
    _resetFirmamentPowersForTests();
    setPlayerDoor(null);
    slots[u.equip.EQUIP_SLOTS.RightHand] = null;
    slots[u.equip.EQUIP_SLOTS.LeftHand] = null;
  }
  return {
    ttk,
    damageDealt: dealt,
    cwsDamage: totalCws,
    echoDamage: totalEcho,
    meleeDamage: totalMelee,
    killSource: hp <= 0 ? (killSource ?? 'melee') : null,
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
  // The potency lines the vendored loot law sums over the worn piece (lootPowers.js:136-137,747-758).
  ...(item.affixes ? { affixes: item.affixes.map((a) => ({ ...a })) } : {}),
  ...(item.enchantments ? { enchantments: item.enchantments.map((e) => ({ ...e })), isIdentified: true } : {}),
} : null);
