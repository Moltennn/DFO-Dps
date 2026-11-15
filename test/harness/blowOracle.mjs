/*
 * test/harness/blowOracle.mjs - the JOINT outcome distribution of one blow, sampled from the pinned game (Stage 3.1).
 *
 * `sampleJointBlow` runs upstream's own blow N times and records, per draw, the same joint key the local fight tier
 * carries: direction, facing, backstab, critical, hit, off-hand whole, echo mask, the blow and an ordinary foe's echo.
 * Nothing here reads src/: the oracle is handed INPUTS (a character description, an item, a body upstream minted, the
 * host's settings) and every field of the key is read from upstream:
 *
 *   direction      the click draw's own expression (combat/playerWeapon.js:1032) over CLICK_ATTACK_DIRECTIONS and
 *                  DIRECTION_TO_STRIKE; the strike's damage / to-hit are SWING_MODS (a bow is forced to StrikeDown, :1113)
 *   critical, hit, backstab    the resolution upstream REPORTS (registerAttackResolutionListener: formulas.js:632 `notes`)
 *   whole          the off-hand `rolls() < blowWeight` draw (formulas.js:830) is the last `rolls()` call of the blow: the
 *                  wrapper records it and compares it with handsLaw's own OFF_HAND_BLOW
 *   blow           calculateAttackDamage's answer (the core, the Strikes payload, the strike listeners), then the host's
 *                  steps: a shaft's pull (bowFastDamage), the boss trait (bossStrike), and an owed echo (takeOwed)
 *   echo           lootStrike's own `_rand` draws, recorded through _setLootPowersRandForTests
 *   facing         the host's input: a back-facing foe is the test's own Bernoulli(uptime), and then the host hands
 *                  `backstabChance` (the wielder's Backstabbing, read from the description) to the formula
 * A back-facing foe, a bow and a hand are scenario inputs, exactly as in `analyze`.
 */
import { generator } from './prng.mjs';
import { upstreamEntity } from './fixtures.mjs';
import { takeOwed, setPlayerDoor } from '../../vendor/upstream/a3eb1605/src/systems/playerDoor.js';
import { _resetLootPowersForTests, _setLootPowersRandForTests } from '../../vendor/upstream/a3eb1605/src/systems/loot/lootPowers.js';

export const jointKey = (o) => [
  o.directionIndex, o.facing ? 1 : 0, o.backstab ? 1 : 0, o.crit ? 1 : 0, o.hit ? 1 : 0, o.whole ? 1 : 0,
  o.echoMask, o.blow, o.echoDamage,
].join('|');

/**
 * @param {object} u  the oracle (test/harness/upstream.mjs)
 * @param {object} o
 *   desc, item (the upstream item, fresh fields), body (an upstream-minted body), hand: 'main'|'off', seed, draws,

 *   traits, cap (the relay's one-blow cap, applied to the claim for the capped mean), uptime (the share of swings with the foe's back to the player), bow (forced StrikeDown + the pull),
 *   echoPower (id of the power on the item, if any), echoCalls (listener invocations per blow: 2 = two echo powers),
 *   door (true: an ordinary foe the host holds - the echo is its own hit)
 */
export function sampleJointBlow(u, {
  desc, item, body, hand = 'main', seed, draws, traits = [], cap = 0, uptime = 0, bow = false, gun = false, echoPower = null, echoCalls = 1, door = false,
}) {
  const rng = generator(seed);
  const attacker = upstreamEntity(desc);
  const slots = u.equip.equipTableOf(attacker);
  const slot = hand === 'off' ? u.equip.EQUIP_SLOTS.LeftHand : u.equip.EQUIP_SLOTS.RightHand;
  const chance = echoPower ? u.lootRarity.powerOf(echoPower).chance : 0;
  const pull = bow ? u.bowBloom.bowKindOf(item).pull : 1;
  const weight = u.handsLaw.OFF_HAND_BLOW.blowWeight;
  const backSkill = desc.skills[19];

  let last = 0;
  const wrapped = () => { last = rng(); return last; };
  let randLog = [];
  _resetLootPowersForTests();
  _setLootPowersRandForTests(() => { const r = rng(); randLog.push(r); return r; });
  let notes = null;
  u.formulas.registerAttackResolutionListener('blowOracle', (n) => { notes = n; });
  let own = 0;
  if (door) setPlayerDoor({ foes: () => [{ entity: body, dead: false }], feet: () => [0, 0, 0], hurtFoe: (_f, n) => { own += n; }, castOnPlayer: () => {} });

  const counts = new Map();
  const agg = { n: draws, hit: 0, crit: 0, whole: 0, echo: 0, dir: new Array(6).fill(0), sum: 0, sumSq: 0, sumCapped: 0, sumCappedSq: 0 };
  const worn = () => JSON.stringify(Object.values(body.equip?.slots ?? {}).filter(Boolean).map((i) => i.currentCondition));
  const wornBefore = worn();
  const skillsBefore = JSON.stringify(attacker.skills);
  try {
    for (let i = 0; i < draws; i++) {
      const forced = bow ? 'StrikeDown' : gun ? 'StrikeLeft' : null;
      const directionIndex = forced ? 0 : Math.floor(rng() * u.playerWeapon.CLICK_ATTACK_DIRECTIONS.length);
      const strike = forced ?? u.anims.DIRECTION_TO_STRIKE[u.playerWeapon.CLICK_ATTACK_DIRECTIONS[directionIndex]];
      const mods = u.playerWeapon.SWING_MODS[strike];
      const facing = uptime > 0 ? rng() < uptime : false;
      const w = item ? { ...item } : null;
      slots[slot] = w;
      const opts = {
        weapon: w, rolls: wrapped, damageMod: mods.damage, toHitMod: mods.toHit, backstabChance: facing ? backSkill : 0,
      };
      if (hand === 'off') {
        opts.toHitMod += u.handsLaw.offHandToHit(attacker.stats.agility);
        Object.assign(opts, u.handsLaw.OFF_HAND_BLOW);
      }
      randLog = [];
      own = 0;
      notes = null;
      const raw = u.formulas.calculateAttackDamage(attacker, body, opts);
      for (let k = 1; k < echoCalls; k++) if (raw > 0) u.lootPowers.lootStrike(attacker, body, raw, w, { blow: true });
      const whole = hand === 'off' ? last < weight : true;
      let echoMask = 0;
      for (let k = 0; k < randLog.length; k++) if (randLog[k] * 100 < chance) echoMask |= 1 << k;
      const owed = takeOwed(body);
      const shot = bow && raw > 0 ? u.bowBloom.bowFastDamage({ pull, fast: 0 }, raw) : raw;
      const struck = (d, kind) => (traits.length && d > 0 ? u.bossTraits.bossStrike({ bossTraits: traits }, d, { kind, weapon: w }).damage : d);
      const blow = struck(shot, bow ? 'arrow' : 'melee') + (owed > 0 ? struck(owed, 'melee') : 0);
      const outcome = {
        directionIndex, facing, backstab: !!notes.backstab, crit: !!notes.critical, hit: !!notes.hit, whole,
        echoMask, blow, echoDamage: own,
      };
      const k = jointKey(outcome);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (outcome.hit) agg.hit++;
      if (outcome.crit) agg.crit++;
      if (outcome.whole) agg.whole++;
      if (echoMask) agg.echo++;
      agg.dir[directionIndex]++;
      const total = blow + own;
      const capped = (cap > 0 ? Math.min(blow, cap) : blow) + own;
      agg.sum += total; agg.sumSq += total * total; agg.sumCapped += capped; agg.sumCappedSq += capped * capped;
    }
  } finally {
    u.formulas.registerAttackResolutionListener('blowOracle', null);
    _resetLootPowersForTests();
    setPlayerDoor(null);
    slots[slot] = null;
  }
  return { counts, agg, draws, drift: { body: worn() !== wornBefore, skills: JSON.stringify(attacker.skills) !== skillsBefore } };
}

/**
 * The upstream core alone, with the struck body part handed back: { part, crit, hit, direction } -> blow, for the
 * body-part dimension (calculateAttackDamage does not expose the part). Valid where nothing but the core shapes the blow
 * (no payload, no trait, no pull, no echo), so the core's answer is the blow.
 */
export function sampleCoreParts(u, modules, { desc, item, body, seed, draws, hand = 'main' }) {
  const rng = generator(seed);
  const counts = new Map();
  for (let i = 0; i < draws; i++) {
    const directionIndex = Math.floor(rng() * u.playerWeapon.CLICK_ATTACK_DIRECTIONS.length);
    const strike = u.anims.DIRECTION_TO_STRIKE[u.playerWeapon.CLICK_ATTACK_DIRECTIONS[directionIndex]];
    const mods = u.playerWeapon.SWING_MODS[strike];
    const notes = {};
    let part = -1;
    const opts = {
      weapon: { ...item }, rolls: rng, modules, backstabChance: 0, notes, damageMod: mods.damage, toHitMod: mods.toHit,
      onStruck: (p) => { part = p; },
    };
    if (hand === 'off') {
      opts.toHitMod += u.handsLaw.offHandToHit(desc.stats.agility);
      opts.blowShare = u.handsLaw.offHandDamage;
    }
    const blow = u.pcaao.pcaaoAttackDamage(upstreamEntity(desc), body, opts);
    const k = [directionIndex, part, notes.critical ? 1 : 0, notes.hit ? 1 : 0, blow].join('|');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return { counts, draws };
}

/**
 * Compare observed counts with a distribution `expected` (Map key -> probability). Decided in advance, never tuned:
 *   - a key observed that the distribution gives probability 0 is a failure outright (the support differs);
 *   - cells with expected count >= MIN_EXPECTED are tested one by one, |z| <= CELL_Z (Bonferroni-sized for thousands of
 *     cells at the 1e-3 level); every smaller cell is pooled into one residual cell;
 *   - the Pearson statistic over those cells is tested with the Wilson-Hilferty normal transform, z <= CHI_Z.
 */
export const MIN_EXPECTED = 20;
export const CELL_Z = 4.5;
export const CHI_Z = 3.5;

export function compareCounts(counts, draws, expected) {
  const unsupported = [];
  for (const k of counts.keys()) if (!(expected.get(k) > 0)) unsupported.push(k);
  let chi = 0;
  let cells = 0;
  let maxZ = 0;
  let worst = null;
  let poolE = 0;
  let poolO = 0;
  for (const [k, p] of expected) {
    const o = counts.get(k) ?? 0;
    const e = draws * p;
    if (e >= MIN_EXPECTED) {
      const z = (o - e) / Math.sqrt(e * (1 - p));
      if (Math.abs(z) > Math.abs(maxZ)) { maxZ = z; worst = { key: k, observed: o, expected: e }; }
      chi += ((o - e) ** 2) / e;
      cells++;
    } else {
      poolE += e;
      poolO += o;
    }
  }
  if (poolE >= MIN_EXPECTED) { chi += ((poolO - poolE) ** 2) / poolE; cells++; }
  const df = Math.max(1, cells - 1);
  const chiZ = (Math.cbrt(chi / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return { ok: unsupported.length === 0 && Math.abs(maxZ) <= CELL_Z && chiZ <= CHI_Z, unsupported, cells, chi, df, chiZ, maxZ, worst, poolE, poolO };
}
