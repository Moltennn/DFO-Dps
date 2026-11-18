/*
 * tools/test-fast.mjs - the quick iteration pass: every test file except the heavy ones.
 *
 * `npm test` stays the gate and still runs every test/*.test.js. This is the same suite minus the files that take a
 * few seconds or more on their own, so an inner loop is seconds instead of a minute. The list lives here, in ONE
 * place; it is a list and not a name suffix because test/differential.test.js has to keep its name for
 * `npm run test:differential`.
 *
 * Keep it up to date: a new heavy file must be added here, and a renamed one removed (the check below fails loudly
 * rather than silently running it).
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEAVY = [
  'blowDifferential.test.js',
  'crossSystem.test.js',
  'cwsDifferential.test.js',
  'differential.test.js',
  'equippedBuild.test.js',
  'fight.test.js',
  'fightDifferential.test.js',
  'longBow.test.js',
  'pricing.test.js',
  'shieldOutcomes.test.js',
  'stochasticObjectives.test.js',
  'stochasticOrdering.test.js',
];

const dir = new URL('../test/', import.meta.url);
const present = readdirSync(dir).filter((name) => name.endsWith('.test.js'));
const heavy = new Set(HEAVY);
for (const name of heavy) if (!present.includes(name)) throw new Error(`test-fast.mjs: no such heavy file: test/${name}`);

const files = present.filter((name) => !heavy.has(name)).sort().map((name) => fileURLToPath(new URL(name, dir)));
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
