#!/usr/bin/env node
/*
 * tools/js-isolation-check.mjs - prove the Rust suite does not read the JavaScript trees or spawn Node.
 *
 *   node tools/js-isolation-check.mjs [--keep] [extra cargo test args]
 *
 * Builds a mirror of the repository under /tmp/opencode/js-isolation: `rust/` without `target/`, the generated
 * `vectors/` (the tests default to the frozen sample) and every `.mjs`, plus `package.json`, and then replaces `src/`,
 * `bin/`, `test/` and `vendor/` with plain FILES of those names. `tools/` is left out entirely, so the JavaScript tooling
 * cannot be a hidden input either. Any open under one of the four names is ENOTDIR, so a test that still read the
 * JavaScript would fail rather than quietly pass. PATH is a directory of symlinks to every executable except Node's, so
 * a `node` spawn is ENOENT.
 *
 * Prints the test totals and exits 1 unless every test passed. `--keep` leaves the mirror for inspection. Cargo is a
 * separate process, so a caller whose allowlist permits only `node tools/gate.mjs *` uses the gate step instead
 * (`node tools/gate.mjs isolated`), which runs this script.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = join('/tmp/opencode', 'js-isolation');
const mirror = join(base, 'repo');
const bin = join(base, 'bin');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
// `--tests a,b` is this script's spelling (the gate's); cargo wants one `--test a` per target.
const rest = [];
let only = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep') continue;
  if (args[i] === '--tests') {
    only = (args[i + 1] ?? '').split(',').filter(Boolean);
    i++;
    continue;
  }
  rest.push(args[i]);
}
const cargoArgs = ['--workspace', '--no-fail-fast', ...only.flatMap((t) => ['--test', t]), ...rest];

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function copyTree(from, to, skip = new Set(), skipFile = () => false) {
  const meta = lstatSync(from);
  if (meta.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) {
      if (skip.has(name)) continue;
      copyTree(join(from, name), join(to, name), skip, skipFile);
    }
  } else if (meta.isFile() && !skipFile(basename(from))) {
    copyFile(from, to);
  }
}

if (existsSync(base)) rmSync(base, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
// `target/` is 1 GB of build output and `vectors/` is the 3.6 GB opt-in set; the default tier is the frozen sample.
// `tools/` is left out entirely (with every `.mjs` elsewhere): the suite must not need the JavaScript tooling either, and
// a test that path-referenced an `.mjs` would then fail with ENOENT rather than find it.
copyTree(join(root, 'rust'), join(mirror, 'rust'), new Set(['target', 'vectors']), (name) => name.endsWith('.mjs'));
copyFile(join(root, 'package.json'), join(mirror, 'package.json'));

// The four trees become files: no path below them can resolve, so a reader fails loudly.
for (const name of ['src', 'bin', 'test', 'vendor']) {
  writeFileSync(join(mirror, name), `replaced by tools/js-isolation-check.mjs: ${name}/ must not be read\n`);
}

// Every executable on PATH except Node's, so `Command::new("node")` is ENOENT while `sh`, `head` and the toolchain work.
const shadowed = /^(node|nodejs|npm|npx|corepack|yarn|pnpm)/;
for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', join(homedir(), '.cargo', 'bin'), join(homedir(), '.rustup')]) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (shadowed.test(name)) continue;
    try {
      symlinkSync(join(dir, name), join(bin, name));
    } catch {
      // Two PATH directories with one name: the first wins, which is what PATH order means anyway.
    }
  }
}

const env = { ...process.env, PATH: bin };
for (const name of Object.keys(env)) {
  if (/^(DFO_|DAGGER_)/.test(name) || name === 'PLANNERS_SLOW') delete env[name];
}

const probe = spawnSync(join(bin, 'sh'), ['-c', 'command -v node || true'], { env, encoding: 'utf8' });
if (probe.stdout.trim()) {
  console.error(`js-isolation: \`node\` is still reachable at ${probe.stdout.trim()}; nothing was proven`);
  process.exit(1);
}
console.log('js-isolation: src/ bin/ test/ vendor/ are files, no tools/ and no .mjs, and `node` is not on PATH');

const started = Date.now();
const r = spawnSync(join(bin, 'cargo'), ['test', ...cargoArgs], {
  cwd: join(mirror, 'rust'),
  env,
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});
const out = `${r.stdout}\n${r.stderr}`;
let passed = 0;
let failed = 0;
for (const m of out.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)) {
  passed += Number(m[1]);
  failed += Number(m[2]);
}
console.log(`js-isolation: ${passed} passed, ${failed} failed (${((Date.now() - started) / 1000).toFixed(0)}s)`);
if (r.status !== 0 || failed > 0) {
  console.log(out.split('\n').filter((l) => /panicked at|^error|test result: FAILED/.test(l)).slice(0, 40).join('\n'));
}
if (keep) console.log(`js-isolation: mirror kept at ${mirror}`);
else rmSync(base, { recursive: true, force: true });
process.exit(r.status === 0 && failed === 0 && passed > 0 ? 0 : 1);
