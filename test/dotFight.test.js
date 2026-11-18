/*
 * test/dotFight.test.js - Stage 3.6b: the Continuous Damage (1,0) lifecycle inside the ordinary fight.
 *
 * The rules pinned here (all local unless an upstream line is cited):
 *   - a fight owns its target's live effects: the caller's target object may be shared by every trial of a batch, and a
 *     second trial must fight exactly as the first did with the same seed (no entry carried over);
 *   - a DoT round is damage like any other: it lands through the same health path, is counted in `cwsDamage` and
 *     `damageDealt`, and is recorded in `cwsTrace`, so the trace's `remaining` reconciles with every drop;
 *   - the round anchor is the fight clock: rounds fall at k * MAGIC_ROUND_SECONDS (5 s) from t=0, while the cast's OWN
 *     first round lands inside the cast, at the cast's time (docs/STAGE-3-AUDIT.md A3.0-3);
 *   - at an equal timestamp the BLOW resolves first and the round after it - a labelled ASSUMPTION, not event order
 *     (docs/ASSUMPTIONS.md);
 *   - a round that kills ends the cast: no later effect of the same spell applies (src/cws.js's direct arm does the
 *     same), and `killSource` names the DoT.
 *
 * The fixtures use `dotSpell` (test/harness/fixtures.mjs): `durationBase` IS the round count (rollDuration).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { character, simCharacter, weapon, dotSpell } from './harness/fixtures.mjs';
import { referenceFoe, weaponOf } from '../src/model.js';
import { createAttackSchedule, simulateFight, simulateFights } from '../src/simulateFight.js';
import { resolveCwsCast } from '../src/cws.js';

const BASIC = () => character({
  level: 30, raceId: 1, stats: { strength: 70, agility: 60, speed: 60, luck: 50 },
  skills: 0, skillOverride: { 29: 70, 34: 40, 19: 50 },
});

/** A weapon with one Cast When Strikes row pointing at spell index 1. */
const cwsItem = (opts = {}) => {
  const it = weapon(121, { material: 9, ...opts });
  it.enchantments = [{ type: 2, param: 1 }];
  return it;
};

/** A (1,0) spell, optionally followed (or preceded) by an instant (4,0) effect of the same spell. */
const dotSpellWith = ({ magnitude = 10, rounds = 3, direct = 0, directFirst = false } = {}) => {
  const spell = dotSpell({ magnitude, rounds });
  if (direct > 0) {
    const instant = {
      type: 4, subType: 0,
      magnitudeBaseLow: direct, magnitudeBaseHigh: direct,
      magnitudeLevelBase: 0, magnitudeLevelHigh: 0, magnitudePerLevel: 1,
      durationBase: 0, durationMod: 0, durationPerLevel: 1,
      chanceBase: 0, chanceMod: 0, chancePerLevel: 1,
    };
    if (directFirst) spell.effects.unshift(instant); else spell.effects.push(instant);
  }
  return spell;
};

const foe = () => referenceFoe(30, 'tough');

/** One deterministic fight: rolls all 0.5 (magnitude 10, an 80% save -> 8 a round). */
function fightFor({
  rounds = 3, magnitude = 10, direct = 0, directFirst = false, health = 1e6, target = null, seed = 3, maxSeconds = 12,
  maxBlows = undefined, attackSpeedPct = undefined,
} = {}) {
  const item = cwsItem();
  return {
    item,
    args: {
      target: target ?? foe(), health, weapon: weaponOf(item), seed, trace: true, maxSeconds,
      ...(maxBlows !== undefined ? { maxBlows } : {}),
      ...(attackSpeedPct !== undefined ? { attackSpeedPct } : {}),
      standard: new Map([[1, dotSpellWith({ magnitude, rounds, direct, directFirst })]]),
      cwsRolls: () => 0.5,
    },
  };
}

test('DoT fight: a round after the spell has already killed bills nothing', () => {
  // The (4,0) is FIRST and kills; the (1,0) follows it. A dead round still takes its draws (the direct arm rolls every
  // effect, applied or not), but it bills nothing and must not claim the kill.
  const { item, args } = fightFor({ rounds: 3, magnitude: 1000, direct: 1000, directFirst: true, health: 10, seed: 7 });
  const run = simulateFight(simCharacter(BASIC(), item), args);
  const row = run.cwsTrace[0];
  assert.ok(row, 'the first blow cast');
  assert.equal(row.effects[0].type, 4, 'the direct effect is first');
  assert.equal(row.dotDamage, 0, 'a round on a dead foe bills nothing');
  assert.equal(row.kill, true);
  assert.equal(run.killSource, 'cws', 'the direct damage killed, not the DoT');
  assert.equal(run.overkill, 790, 'the dead round does not inflate the overkill');
  assert.equal(run.damageDealt, (run.health - run.remainingHealth) + run.overkill, 'dealt = the hp drop plus overkill');

  // The draws the dead round takes: 3 for the killing (4,0) (magnitude twice, save once) and 3 for the (1,0) round.
  let draws = 0;
  const rolls = () => { draws += 1; return 0.5; };
  let hp = 10;
  const out = resolveCwsCast({
    spell: dotSpellWith({ magnitude: 1000, rounds: 3, direct: 1000, directFirst: true }),
    caster: { entity: { level: 30 } }, casterLevel: 30, target: foe(), rolls,
    hurt: (n) => { hp = Math.max(0, hp - n); return hp > 0; },
  });
  assert.equal(out.damage, 800, 'the direct effect billed');
  assert.equal(out.dotDamage, 0, 'and the dead round did not');
  assert.equal(draws, 6, '3 for the killing effect, 3 for the dead round');
});

test('DoT fight: rounds that fall after the last blow are billed', () => {
  // One blow (the blow budget ends the fight at t0); the DoT's next two rounds fall at 5 s and 10 s, inside the horizon.
  const { item, args } = fightFor({ rounds: 3, health: 1e6, maxSeconds: 12, seed: 3, maxBlows: 1 });
  const run = simulateFight(simCharacter(BASIC(), item), args);
  assert.equal(run.blows, 1, 'one blow');
  assert.equal(run.endReason, 'blowBudget');
  const roundTimes = run.cwsTrace.filter((e) => e.round).map((e) => e.t);
  assert.deepEqual(roundTimes, [5, 10], 'the rounds after the last blow still fall on the clock');
  assert.equal(run.dotDamage, 24, 'the cast round and both drained rounds');
  assert.equal(run.remainingHealth, run.health - run.damageDealt, 'the drained rounds are in the health');
});

test('DoT fight: the health segments carry the round damage too', () => {
  const { args } = fightFor({ rounds: 3, health: 5000, seed: 5 });
  const run = simulateFight(simCharacter(BASIC(), cwsItem()), args);
  assert.ok(run.cwsTrace.some((e) => e.round), 'a round billed');
  assert.equal(run.segments.reduce((a, s) => a + s.damage, 0), run.damageDealt, 'the segments add up to dealt');
  assert.equal(run.segments.reduce((a, s) => a + s.cwsDamage, 0), run.cwsDamage);
});

test('DoT fight: a second trial with the same seed fights the same fight (no effects carried over)', () => {
  const { args } = fightFor({ rounds: 3, seed: 11 });
  const ch = simCharacter(BASIC(), cwsItem());
  const first = simulateFight(ch, args);
  const second = simulateFight(ch, args);
  assert.deepEqual(second.cwsTrace, first.cwsTrace, 'the second trial casts what the first cast');
  assert.deepEqual(second.trace.map((r) => r.remaining), first.trace.map((r) => r.remaining),
    'the second trial loses the same health on the same blows');
  assert.equal(second.cwsDamage, first.cwsDamage);

  // The batch form: two identical seeds must produce the same fight.
  const batch = simulateFights(ch, { ...args, seeds: [11, 11] });
  assert.deepEqual(batch.rows[1].cwsTrace, batch.rows[0].cwsTrace, 'seed 11 twice is one fight, not two');
  assert.deepEqual(batch.rows[1].trace.map((r) => r.remaining), batch.rows[0].trace.map((r) => r.remaining));
  assert.deepEqual(args.target.activeEffects, [], 'the fight does not leave its effects on the caller\'s target');
});

test('DoT fight: every round is accounted in cwsDamage and the traces reconcile with the health drops', () => {
  const { args } = fightFor({ rounds: 3, health: 5000, seed: 5 });
  const run = simulateFight(simCharacter(BASIC(), cwsItem()), args);

  const rounds = run.cwsTrace.filter((e) => e.round);
  assert.ok(rounds.length > 0, 'a DoT round landed inside the fight');
  assert.ok(rounds.every((e) => e.damage === 8), 'each round is the 8 the seed gives');
  assert.equal(run.cwsDamage, run.cwsTrace.reduce((a, e) => a + e.damage, 0),
    'cwsDamage is every cast and every round the cwsTrace reports');

  // Replay the health: a blow row bills its cast, its echo and its melee blow; a round row bills its own round. At an
  // equal time the blow comes first.
  const events = [
    ...run.trace.map((r) => ({ t: r.t, order: 0, dmg: r.cwsDamage + r.echoApplied + r.damage, remaining: r.remaining })),
    ...rounds.map((r) => ({ t: r.t, order: 1, dmg: r.damage, remaining: r.remaining })),
  ].sort((x, y) => x.t - y.t || x.order - y.order);
  let hp = run.health;
  let drops = 0;
  for (const e of events) {
    const before = hp;
    hp = Math.max(0, hp - e.dmg);
    drops += before - hp;
    assert.equal(e.remaining, hp, `remaining after the event at ${e.t}`);
  }
  assert.equal(drops, run.health - run.remainingHealth, 'the drops are the health that went missing');
  assert.equal(run.damageDealt, run.cwsDamage + run.echoDamage + run.meleeDamage);
});

test('DoT fight: rounds fall on the 5 s fight clock, and the cast bills its own round at its own time', () => {
  const { item, args } = fightFor({ rounds: 3, health: 1e6, maxSeconds: 12, seed: 3 });
  const ch = simCharacter(BASIC(), item);
  const schedule = createAttackSchedule(ch, { target: foe(), health: args.health, weapon: args.weapon });
  const firstHit = schedule.next().t;
  const run = simulateFight(ch, args);

  const casts = run.cwsTrace.filter((e) => !e.round);
  assert.ok(casts.length > 0, 'the fight cast');
  assert.equal(casts[0].t, firstHit, 'the first cast is the first blow');
  assert.equal(casts[0].dotDamage, 8, 'the cast bills its own round, at the cast time');

  // durationBase 3 = three rounds: the cast's own, then the next two k*5 anchors. The fight is 12 s long.
  const roundTimes = run.cwsTrace.filter((e) => e.round).map((e) => e.t);
  assert.deepEqual(roundTimes, [5, 10], 'rounds fall on the clock anchors, not on a cast-relative offset');

  // durationBase 1 = one round, the cast's own: nothing is left for a boundary.
  const one = fightFor({ rounds: 1, health: 1e6, maxSeconds: 12, seed: 3 });
  const short = simulateFight(simCharacter(BASIC(), one.item), one.args);
  assert.equal(short.cwsTrace[0].dotDamage, 8);
  assert.deepEqual(short.cwsTrace.filter((e) => e.round).map((e) => e.t), [], 'a one-round DoT never reaches an anchor');
});

test('DoT fight: a round that kills ends the cast, applies no later effect, and names the DoT', () => {
  const { item, args } = fightFor({ rounds: 3, magnitude: 1000, direct: 1000, health: 10, seed: 7 });
  const run = simulateFight(simCharacter(BASIC(), item), args);
  const row = run.cwsTrace[0];
  assert.ok(row, 'the first blow cast');
  assert.equal(row.dotDamage, 800, 'the round is 1000 rolled, 80% kept');
  assert.equal(row.kill, true, 'the round killed');
  assert.equal(row.damage, 800, 'the later (4,0) effect did not land');
  assert.equal(row.effects[1].type, 4);
  assert.equal(row.effects[1].applied, false, 'no later effect of the same spell applies after the killing round');
  assert.equal(run.kill, true);
  assert.equal(run.killSource, 'dot', 'the kill belongs to the DoT round');
  assert.equal(run.remainingHealth, 0);
});

test('DoT fight: at an equal timestamp the blow resolves before the round', () => {
  // The explicit attack-speed input (`cadence`'s own `attackSpeedPct`) puts a blow exactly on the 5 s anchor: a
  // 0.15625 s tick, so blows land at 0.3125 + k * 0.78125 and one lands on 5 s. Nothing else about the fight is tuned.
  const { item, args } = fightFor({ rounds: 3, health: 1e6, maxSeconds: 12, seed: 2, attackSpeedPct: 17.159183673469394 });
  const run = simulateFight(simCharacter(BASIC(), item), args);
  const blowAt5 = run.trace.find((r) => Math.abs(r.t - 5) < 1e-9);
  assert.ok(blowAt5, `the fixture has a blow at exactly 5 s; blows at ${run.trace.map((r) => r.t).join(', ')}`);
  const roundAt5 = run.cwsTrace.filter((e) => e.round && Math.abs(e.t - 5) < 1e-9);
  assert.equal(roundAt5.length, 1, 'exactly one round on the 5 s anchor');
  assert.equal(roundAt5[0].damage, 8);
  assert.equal(roundAt5[0].remaining, blowAt5.remaining - 8,
    'the round is billed after the blow, on the health the blow left');
  // The two events share the timestamp; the blow is the first of them, and the round lands after it.
  const order = [
    { t: blowAt5.t, kind: 'blow' },
    { t: roundAt5[0].t, kind: 'round' },
  ].sort((x, y) => x.t - y.t || (x.kind === 'blow' ? -1 : 1));
  assert.deepEqual(order.map((e) => e.kind), ['blow', 'round']);
  assert.ok(blowAt5.remaining > roundAt5[0].remaining, 'the blow has not seen the round\'s damage');
});
