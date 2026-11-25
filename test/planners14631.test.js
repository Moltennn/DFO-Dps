/*
 * test/plannners14631.test.js - the shipped build reaches the PLANNERS (`--game-build` on every command that prices a
 * weapon number through a scenario it builds itself: imprints, weapons, skills, enchant-plan, gear-plan, loadout,
 * real-dps, and the theory/weapons frontier they share).
 *
 * `src/maxprofile.js`, `src/imprints.js`, `src/enchantPlan.js` and `src/realBuild.js` forge their own scenario instead
 * of taking `scenarioOf`, so before this step `--game-build` was refused by name on their commands: a 0.1.14631 picker
 * could price a card but not a loadout. Every case below is a LOCAL INVARIANT (the 14631 law is cited from `dist:` in
 * CHANGELOG-MECHANICS.md, weak evidence) plus a CLI wiring check; the numbers are not oracle-checked against the game.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { legalGear } from '../src/maxprofile.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { rankFamily } from '../src/imprints.js';
import { planEnchants } from '../src/enchantPlan.js';
import { realTemplate, realWeaponLoadouts } from '../src/realBuild.js';

const bin = fileURLToPath(new URL('../bin/dfo-dps.js', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

const json = (args) => {
  const r = cli(...args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

test('the planner modules price the shipped build a caller names', () => {
  // A max-profile card: the gear percent vs the flat add, straight from `maxRun`'s scenario.
  const ch = maxCharacter(118, {});
  const cut = maxRun(ch);
  const drift = maxRun(ch, { gameBuild: '14631' });
  assert.notEqual(cut.damage.parts.mastery, drift.damage.parts.mastery, 'the mastery percent moves');
  assert.equal(cut.damage.parts.gearAdd, undefined);
  assert.ok(drift.damage.parts.gearAdd.lo > 0);
  assert.notEqual(cut.cappedDps, drift.cappedDps, 'and the carried number with it');

  // The legal frontier: the 14631 law makes weapon-skill points worth far more than Critical Strike (a flat add per
  // point vs a percent), so the point that maximises DPS MOVES. That is the planner assumption the ticket warned
  // about: the search is still right (it re-prices every point), but anything that cached or hard-coded the 14512
  // winner would serve the wrong split. Measured on 118: 250/370/25% -> 350/252/38%.
  const planCut = legalGear(118, {});
  const planDrift = legalGear(118, { gameBuild: '14631' });
  assert.notDeepEqual(
    { lb: planCut.lb, cs: planCut.cs, dmg: planCut.dmg },
    { lb: planDrift.lb, cs: planDrift.cs, dmg: planDrift.dmg },
    'the 14631 law re-picks the legal frontier winner',
  );
  assert.notEqual(planCut.dps, planDrift.dps, 'and its price');
  // Both are legal allocations, so the rules that bind them did not move.
  assert.deepEqual(planCut.violations, []);
  assert.deepEqual(planDrift.violations, []);
  // The cache must key on the build: asking again in the other order returns each build's own winner.
  assert.equal(legalGear(118, { gameBuild: '14631' }).lb, planDrift.lb);
  assert.equal(legalGear(118).lb, planCut.lb);

  // The imprint ranking and the enchant plan both ride the same card. The ranked base moves, and so does the delta
  // each power buys - under 14631 the larger blows hit the Breach's per-hit cap, so the percentage powers' gains
  // collapse and the ORDER re-sorts. Nothing is hard-coded: the rows are sorted by the price they were measured at.
  const family = { key: 'LongBlade', name: 'Long Blade', templates: [118, 119, 120, 121, 122, 123] };
  const rankCut = rankFamily(family, {});
  const rankDrift = rankFamily(family, { gameBuild: '14631' });
  assert.notEqual(rankCut.base.cappedDps, rankDrift.base.cappedDps, 'the ranked base moves');
  assert.notDeepEqual(
    rankCut.rows.map((r) => r.delta),
    rankDrift.rows.map((r) => r.delta),
    'the measured gain of each power moves with the law',
  );
  assert.notDeepEqual(rankCut.rows.map((r) => r.id), rankDrift.rows.map((r) => r.id), 'and so does the order');
  // Every row is still sorted by its own measured delta, so the ranking is a price, never a fit assumption.
  const desc = (rows) => rows.every((r, i) => i === 0 || rows[i - 1].delta >= r.delta);
  assert.ok(desc(rankCut.rows) && desc(rankDrift.rows), 'sorted by the price at its own build');

  const enchCut = planEnchants({ weapon: 118, gameBuild: '14512' });
  const enchDrift = planEnchants({ weapon: 118, gameBuild: '14631' });
  assert.notEqual(enchCut.carriedBaseDps, enchDrift.carriedBaseDps, 'the enchant baseline moves');

  // The real-loadout chain, and one row of it.
  const rowCut = realTemplate(118, family, {});
  const rowDrift = realTemplate(118, family, { gameBuild: '14631' });
  assert.notEqual(rowCut.totalDps, rowDrift.totalDps, 'the loadout total moves');
});

test('every planner command accepts --game-build and the default stays 14512', () => {
  for (const args of [['imprints', '--json'], ['enchant-plan', '--json']]) {
    const plain = cli(...args);
    const cut = cli(...args, '--game-build', '14512');
    const drift = cli(...args, '--game-build', '14631');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(cut.status, 0, cut.stderr);
    assert.equal(drift.status, 0, drift.stderr);
    assert.equal(plain.stdout, cut.stdout, `${args[0]}: no --game-build is 14512`);
    assert.notEqual(plain.stdout, drift.stdout, `${args[0]}: 14631 moves the plan`);
  }
  // The loadout chain is the slow one; pin that it accepts the flag and that its build tier moves.
  const uncapped = json(['loadout', '--json', '--uncapped', '--game-build', '14631']);
  const pinned = json(['loadout', '--json', '--uncapped', '--game-build', '14512']);
  const plain = json(['loadout', '--json', '--uncapped']);
  assert.deepEqual(plain, pinned, 'no --game-build is 14512');
  assert.notDeepEqual(plain, uncapped, '14631 moves the loadout rows');
});

test('a refused command still refuses, and a command that is not a planner is unchanged', () => {
  for (const cmd of ['saves', 'doctor', 'firmament', 'probe', 'spell', 'spells']) {
    const r = cli(cmd, '--theory', '--game-build', '14631');
    assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--game-build is not read by ${cmd}`));
  }
});
