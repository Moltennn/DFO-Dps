/*
 * test/defaultBuild.test.js - the FLIP's own contract: 0.1.14631 is the default, and `--game-build 14512` re-selects
 * the vendored cut exactly.
 *
 * Three things are proved, none of them vacuous:
 *   1. no flag == an explicit `--game-build 14631`, for EVERY command that reads the flag (`GAME_BUILD_READERS`);
 *   2. an explicit `--game-build 14512` == the bytes this repository printed BEFORE the flip. The pre-flip output is
 *      frozen into `test/fixtures/defaultFlip14512.json` (sha256 of stdout+page per case) by
 *      `node tools/capture-default-build.mjs` run on the commit before the flip;
 *   3. a direct LIBRARY call with no `gameBuild` key (`report.buildReport`, `maxprofile.maxCharacter`/`maxRun`,
 *      `enchantPlan.planEnchants`, the theory cap sheet) is the live build, and an explicit `'14512'` is the cut.
 *
 * These are LOCAL INVARIANTS (the 14631 law is `dist:` evidence cited in CHANGELOG-MECHANICS.md); the differential
 * suites in test/*.test.js remain the oracle against the live JS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport } from '../src/report.js';
import { maxCharacter, maxRun } from '../src/maxprofile.js';
import { planEnchants } from '../src/enchantPlan.js';
import { gearMasteryPoints, theoryCaps, THEORY_CAPS } from '../src/theory.js';
import { DEFAULT_GAME_BUILD, gameBuildOf } from '../src/model.js';

const bin = fileURLToPath(new URL('../bin/dfo-dps.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/defaultFlip14512.json', import.meta.url));

/** Every command that reads `--game-build` (src/cli.js `GAME_BUILD_READERS`), one cheap distinguishing case each. */
const CASES = [
  ['build', ['build', '--theory', '--json']],
  ['build-text', ['build', '--theory']],
  ['objective', ['objective', '--theory', '--json', '--target', 'tough']],
  ['rank', ['rank', '--theory', '--json']],
  ['compare', ['compare', '--theory', '--stat', 'strength=10']],
  ['scale', ['scale', '--theory', '--json', '--stat', 'strength']],
  ['tradeoff', ['tradeoff', '--theory', '--json']],
  ['theory', ['theory', '--json']],
  ['theory-text', ['theory']],
  ['imprints', ['imprints', '--json']],
  ['enchant-plan', ['enchant-plan', '--json']],
  ['weapons', ['weapons', '--json']],
  ['skills', ['skills', '--json']],
  ['report', ['report', '--theory']],
  ['graph', ['graph', '--theory', '--series', 'stat:strength', '--from', '0', '--to', '20', '--step', '10']],
  ['loadout', ['loadout', '--json', '--uncapped']],
  ['real-dps', ['real-dps', '--json', '--uncapped']],
];

/** The cases whose PRE-FLIP bytes were captured (the two sampled/loadout commands are too slow to freeze twice; they
 *  are still covered by test 1, and their scenario plumbing is shared with the commands below). */
const FROZEN = new Set([
  'build', 'build-text', 'objective', 'rank', 'compare', 'scale', 'tradeoff', 'theory', 'theory-text',
  'imprints', 'enchant-plan', 'weapons', 'skills', 'report', 'graph',
]);

const PAGE_COMMANDS = new Set(['report', 'graph', 'weapons', 'skills', 'imprints', 'enchant-plan', 'loadout', 'real-dps']);

/** A private root per run: the page writer is create-only and every command defaults to its own page name. */
function capture(name, args, build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dfo-flip-'));
  const page = PAGE_COMMANDS.has(name) ? path.join(root, `${name}.html`) : null;
  const full = [...args, ...(build ? ['--game-build', build] : []), ...(page ? ['--out', page] : [])];
  const r = spawnSync(process.execPath, [bin, ...full], {
    encoding: 'utf8',
    env: { ...process.env, DAGGER_USER_DATA: root, HOME: root },
    timeout: 1800000,
  });
  const bytes = page && r.status === 0 ? fs.readFileSync(page, 'utf8') : '';
  // Every page-writing command echoes its own `--out` on stdout; that path is per-run, so it is normalised away and
  // the page bytes are compared instead.
  const stdout = page ? r.stdout.split(page).join('<OUT>') : r.stdout;
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.status, 0, `${name}${build ? ` @${build}` : ''}: ${r.stderr}`);
  return { stdout, page: bytes };
}

const digest = (r) => createHash('sha256').update(r.stdout).update('\0').update(r.page).digest('hex');

test('no --game-build is an explicit 14631 run, for every command that reads the flag', () => {
  for (const [name, args] of CASES) {
    const plain = capture(name, args, null);
    const live = capture(name, args, '14631');
    assert.equal(plain.stdout, live.stdout, `${name}: stdout differs`);
    assert.equal(plain.page, live.page, `${name}: page differs`);
  }
});

test('an explicit 14512 reproduces the pre-flip output byte for byte', () => {
  assert.ok(fs.existsSync(fixture), `the pre-flip capture is committed (${fixture})`);
  const want = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.equal(want.version, 'pre-flip default (0.1.14512)');
  const byName = new Map(want.cases.map((c) => [c.name, c]));
  for (const [name, args] of CASES) {
    if (!FROZEN.has(name)) continue;
    const frozen = byName.get(name);
    assert.ok(frozen, `${name}: the fixture covers this case`);
    const cut = capture(name, args, '14512');
    assert.equal(digest(cut), frozen.sha256, `${name}: 14512 is the pre-flip output`);
    assert.equal(cut.stdout.length + cut.page.length, frozen.bytes, `${name}: byte count`);
  }
  // every frozen case is also a case list above, and every case list entry is checked by test 1
  for (const name of byName.keys()) assert.ok(CASES.some(([n]) => n === name), `${name}: fixture case is in CASES`);
});

test('the two builds really differ on a weapon card and on the theory sheet, so the checks are not vacuous', () => {
  for (const name of ['build', 'theory', 'report']) {
    const [, args] = CASES.find(([n]) => n === name);
    assert.notEqual(capture(name, args, null).stdout + capture(name, args, null).page,
      capture(name, args, '14512').stdout + capture(name, args, '14512').page, `${name}: the builds must differ`);
  }
});

test('a direct library call with no key is the live build; only an explicit 14512 is the cut', () => {
  // The normalisers themselves.
  assert.equal(DEFAULT_GAME_BUILD, '14631');
  assert.equal(gameBuildOf(undefined), '14631');
  assert.equal(gameBuildOf('14631'), '14631');
  assert.equal(gameBuildOf('14512'), '14512');
  assert.equal(gameBuildOf('14513'), '14631', 'an unknown string is the live build (the CLI refuses it)');

  // The cap sheet: the live sheet drops the percent, the cut sheet is the frozen table.
  assert.deepEqual(theoryCaps(), theoryCaps('14631'));
  assert.deepEqual(theoryCaps('14512'), THEORY_CAPS);
  assert.equal(gearMasteryPoints(), null);
  assert.equal(gearMasteryPoints('14512'), 728);

  // The max profile: no key (live) vs the cut, on the same character.
  const live = maxRun(maxCharacter(118));
  const cut = maxRun(maxCharacter(118, { gameBuild: '14512' }), { gameBuild: '14512' });
  assert.equal(live.damage.parts.mastery, 40, 'the live mastery is the climb alone');
  assert.equal(cut.damage.parts.mastery, 150, 'the cut keeps the 0.44% gear percent');
  assert.ok(live.damage.parts.gearAdd.lo > 0, 'the live card carries the flat add');
  assert.equal(cut.damage.parts.gearAdd, undefined, 'and the cut has no such field');

  // The enchant plan: its own default parameter is the live build.
  assert.notEqual(planEnchants({ weapon: 118 }).carriedBaseDps, planEnchants({ weapon: 118, gameBuild: '14512' }).carriedBaseDps);

  // The report renderer: `buildReport`'s destructured default is the live build (a direct caller, no CLI flags).
  const ch = maxCharacter(118);
  const base = { target: { level: 45, isBoss: false, maxHealth: 0, career: {}, stats: {}, health: 0 }, core: 'overhaul' };
  const plainPage = buildReport(ch, base);
  const livePage = buildReport(ch, { ...base, gameBuild: '14631' });
  const cutPage = buildReport(ch, { ...base, gameBuild: '14512' });
  assert.equal(plainPage, livePage, 'no gameBuild on a direct call is the live build');
  assert.notEqual(plainPage, cutPage, 'and 14512 is the cut');
  assert.match(livePage, /Gear add \(flat\)/);
  assert.doesNotMatch(cutPage, /Gear add \(flat\)/);
});
