#!/usr/bin/env node
/*
 * tools/rust-mutate.mjs - a small mutation gate for the Rust port.
 *
 * A vector test that always passes proves nothing until a wrong implementation fails it. This applies ONE mutation at a
 * time to a Rust source file (a numeric literal +1, a comparison flipped, `&&`<->`||`, `+`<->`-`), runs the integration
 * tests that should cover it, and reports every mutant the tests did NOT catch. A surviving mutant is either a gap in
 * the vectors (add a probe) or an equivalent mutant (no observable change): read each one.
 *
 *   node tools/rust-mutate.mjs <file under rust/dfo-core/src> --tests a,b [--count 40] [--seed 1] [--list]
 *
 *   --tests   integration test names (rust/dfo-core/tests/<name>.rs) that cover the file; lib unit tests always run
 *   --count   how many mutants to try (default 40), drawn with a seeded shuffle so a run is reproducible
 *   --seed    shuffle seed (default 1)
 *   --lines   only mutate these 1-based lines, as `a-b,c,d-e`: a scoped sweep of one change's code, with no shuffle
 *             (the whole selected set runs and `--count` is ignored)
 *   --jobs    parallel workers (default: as many as cores/2 allows, at most 8, reduced until each worker's cap is >= 1 GiB)
 *   --timeout seconds per mutant before it counts as a hang and is killed with its whole process group (default 180)
 *   --max-mem per-worker memory cap, e.g. 2G, 512M or 300 (MiB). Default: half of RAM split equally between the workers.
 *             Every cargo run (build and test binary) is capped; a mutant that hits the cap is killed and reported as
 *             `killed (memory cap ...)`. Only that one run dies: the cap is a separate cgroup, not the session's.
 *   --full    read the full generated vectors (`rust/tests/vectors/`) instead of the committed frozen sample: the
 *             comparison tier that proves the sample catches what the whole set catches.
 *   --no-mem-cap  run with no memory cap at all. Without it the gate refuses to run when no cap mechanism works.
 *   --list    print the candidate mutants and exit
 *
 * Memory cap (tools/mem-cap.mjs): a transient systemd scope (MemoryMax, MemorySwapMax=0) when the user manager can make
 * one, else `prlimit --data`. The mechanism is chosen by a probe that reads the limit back, and the choice is printed.
 *
 * Code under `#[cfg(test)]`, comments, doc comments and string literals are never mutated. Mutants run in PRIVATE COPIES of
 * the crate (see the run section), so the real source tree is never written and there is nothing to restore.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, cpus, totalmem } from 'node:os';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtMiB, parseSize, planMemory, probeMechanism, wrap } from './mem-cap.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rustDir = join(root, 'rust');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
/** Flags that take no value, so the word after them is not theirs. */
const BOOLEAN_FLAGS = new Set(['--list', '--no-mem-cap', '--full']);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BOOLEAN_FLAGS.has(args[i - 1])));
if (!file) {
  console.error('usage: node tools/rust-mutate.mjs <file under rust/dfo-core/src> --tests a,b [--count N] [--seed S] [--lines a-b,c] [--jobs J] [--timeout S] [--max-mem SIZE] [--no-mem-cap] [--list]');
  process.exit(2);
}
const path = join(rustDir, 'dfo-core', 'src', file);
const tests = (flag('tests', '') || '').split(',').filter(Boolean);
const count = Number(flag('count', 40));
const seed = Number(flag('seed', 1));
const listOnly = args.includes('--list');
/** `--lines a-b,c,d-e`: 1-based line ranges; only mutants inside them are candidates. */
const lineRanges = (flag('lines', '') || '')
  .split(',')
  .filter(Boolean)
  .map((r) => r.split('-').map(Number))
  .map(([a, b]) => [a, b ?? a]);
const scoped = (n) => lineRanges.some(([a, b]) => n + 1 >= a && n + 1 <= b);

const original = readFileSync(path, 'utf8');

// ---- candidates -------------------------------------------------------------------------------------------------
const lines = original.split('\n');
const testStart = lines.findIndex((l) => /^#\[cfg\(test\)\]/.test(l));
const limit = testStart < 0 ? lines.length : testStart;

/** Blank out string literals and trailing comments so no mutation lands in them. */
function code(line) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === '"') inStr = false;
      out += ' ';
      continue;
    }
    if (c === '"') { inStr = true; out += ' '; continue; }
    if (c === '/' && line[i + 1] === '/') { out += ' '.repeat(line.length - i); break; }
    out += c;
  }
  return out;
}

const mutants = [];
for (let n = 0; n < limit; n++) {
  const raw = lines[n];
  if (/^\s*(\/\/|#\[|#!)/.test(raw)) continue;
  if (lineRanges.length && !scoped(n)) continue;
  const c = code(raw);
  const add = (col, len, repl, what) => mutants.push({ line: n, col, len, repl, what });
  for (const m of c.matchAll(/(?<![\w.])(\d+\.\d+|\d+)(?![\w.])/g)) {
    const v = m[1];
    if (v.includes('.')) add(m.index, v.length, String(Number(v) + 1) + (Number.isInteger(Number(v) + 1) ? '.0' : ''), `${v} -> ${Number(v) + 1}`);
    else add(m.index, v.length, String(Number(v) + 1), `${v} -> ${Number(v) + 1}`);
  }
  for (const [re, repl] of [[/ >= /g, ' > '], [/ <= /g, ' < '], [/ == /g, ' != '], [/ != /g, ' == '], [/ && /g, ' || '], [/ \|\| /g, ' && ']]) {
    for (const m of c.matchAll(re)) add(m.index, m[0].length, repl, `'${m[0].trim()}' -> '${repl.trim()}'`);
  }
  for (const m of c.matchAll(/ > (?!=)/g)) add(m.index, m[0].length, ' >= ', "'>' -> '>='");
  for (const m of c.matchAll(/ < (?!=)/g)) add(m.index, m[0].length, ' <= ', "'<' -> '<='");
  for (const m of c.matchAll(/ \+ /g)) add(m.index, m[0].length, ' - ', "'+' -> '-'");
  for (const m of c.matchAll(/ - (?=[\w(])/g)) add(m.index, m[0].length, ' + ', "'-' -> '+'");
}

// seeded shuffle (mulberry32); a `--lines` scope runs every selected mutant, in file order
let s = seed >>> 0;
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
if (!lineRanges.length) {
  for (let i = mutants.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [mutants[i], mutants[j]] = [mutants[j], mutants[i]];
  }
}

if (listOnly) {
  console.log(`${mutants.length} candidate mutants in ${file}`);
  process.exit(0);
}

// ---- run ---------------------------------------------------------------------------------------------------------
// Parallel pool. Each worker owns a private COPY of the crate (own source, own target dir; the generated vectors are
// symlinked), so mutants run side by side and the real source tree is never touched: a killed run leaves nothing to
// restore. Tests are built with opt-level 2 (about 3x faster than debug for these numeric vector loops).
/** True when the sweep reads the opt-in full generated set instead of the committed frozen sample. */
const full = args.includes('--full');
// The tier comes from --full alone: an inherited DFO_VECTORS_DIR / DFO_FROZEN_DIR would decide it silently.
for (const v of ['DFO_VECTORS_DIR', 'DFO_FROZEN_DIR', 'DFO_FROZEN_OUT']) delete process.env[v];
if (full) {
  // The committed sample is the default tier; `--full` compares against every generated case (`rust/tests/vectors`).
  process.env.DFO_VECTORS_DIR = join(rustDir, 'tests', 'vectors');
}
console.log(`vectors: ${full ? `full generated set (${join('rust', 'tests', 'vectors')})` : 'committed frozen sample (rust/tests/frozen)'}`);
const mutantTimeoutS = Number(flag('timeout', 180));
const workRoot = join(homedir(), '.cache', 'dfo-mut');
const cargoArgs = ['test', '-q', ...tests.flatMap((t) => ['--test', t]), '--lib'];
const cargoEnv = { ...process.env, CARGO_PROFILE_DEV_OPT_LEVEL: '2', CARGO_PROFILE_DEV_DEBUG: '0' };

// Memory: every cargo run below is capped. The workers together stay within half of RAM (planMemory), and a refusal
// comes before any work when no mechanism can cap, unless --no-mem-cap says so.
const noMemCap = args.includes('--no-mem-cap');
let mem;
let mech;
try {
  mem = planMemory({
    totalBytes: totalmem(),
    cores: cpus().length,
    jobsOpt: args.includes('--jobs') ? Number(flag('jobs')) : undefined,
    maxMemOpt: flag('max-mem', undefined) === undefined ? undefined : parseSize(flag('max-mem')),
    noCap: noMemCap,
  });
  mech = noMemCap ? 'none' : probeMechanism(mem.capBytes);
} catch (e) {
  console.error(`rust-mutate: ${e.message}`);
  process.exit(2);
}
if (mech === 'none' && !noMemCap) {
  console.error('rust-mutate: no memory cap mechanism works here (neither a systemd user scope with MemoryMax nor prlimit --data).\n' +
    'Refusing to run uncapped: a runaway mutant can take the session down. Pass --no-mem-cap to run anyway.');
  process.exit(2);
}
const jobs = mem.jobs;
const capText = mech === 'none' ? 'UNCAPPED (--no-mem-cap)' : `${mech} cap ${fmtMiB(mem.capBytes)} per worker`;
console.log(`memory: ${capText}; ${jobs} worker(s); budget ${fmtMiB(mem.budget)} (half of RAM)`);
/** True when a run died at the memory cap: SIGKILL from the scope's OOM killer (cargo reports the signal), or a Rust
 *  allocation failure under prlimit. A hang is never a cap death. */
const hitCap = (r) => mech !== 'none' && !r.hung && r.status !== 0 &&
  (r.signal === 'SIGKILL' || /signal: 9, SIGKILL|memory allocation of \d+ bytes failed|cannot allocate memory/.test(r.out));

const live = new Set();
const killGroup = (child) => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } };
const killAll = () => { for (const c of live) killGroup(c); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
process.on('exit', killAll);

function prepare(w) {
  // Mirror the repository's depth below the scratch root: a test resolving `../tests/frozen` from
  // `rust/dfo-core/tests/...` needs the same two levels.
  const base = join(workRoot, `w${w}`);
  const dir = join(base, 'rust');
  mkdirSync(join(dir, 'dfo-core'), { recursive: true });
  cpSync(join(rustDir, 'Cargo.lock'), join(dir, 'Cargo.lock'));
  // The worker builds ONLY dfo-core: copy the workspace manifest but keep the relative profiles, comments and resolver
  // (a copied `members = ["dfo-core", "dfo-cli"]` makes cargo fail on the dfo-cli path this worker does not own).
  const workspace = readFileSync(join(rustDir, 'Cargo.toml'), 'utf8')
    .replace(/^members\s*=\s*\[[^\]]*\]$/m, 'members = ["dfo-core"]');
  if (!/^members\s*=\s*\["dfo-core"\]$/m.test(workspace)) throw new Error('rust-mutate: could not narrow the workspace to dfo-core');
  writeFileSync(join(dir, 'Cargo.toml'), workspace);
  cpSync(join(rustDir, 'dfo-core', 'Cargo.toml'), join(dir, 'dfo-core', 'Cargo.toml'));
  for (const d of ['src', 'tests']) {
    rmSync(join(dir, 'dfo-core', d), { recursive: true, force: true });
    cpSync(join(rustDir, 'dfo-core', d), join(dir, 'dfo-core', d), { recursive: true });
  }
  mkdirSync(join(dir, 'tests'), { recursive: true });
  const link = join(dir, 'tests', 'vectors');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(join(rustDir, 'tests', 'vectors'), link);
  // The committed sample the tests read by default (DFO_VECTORS_DIR unset), with its MANIFEST.
  const frozen = join(dir, 'tests', 'frozen');
  rmSync(frozen, { recursive: true, force: true });
  symlinkSync(join(rustDir, 'tests', 'frozen'), frozen);
  // The frozen answers are read from the links above (the dfo-core oracle answers and the CLI snapshots live under
  // `rust/tests/frozen` and `rust/dfo-cli/tests`), so no JavaScript tree is needed here at all.
  return dir;
}

function run(dir, timeoutS) {
  return new Promise((resolveRun) => {
    // The whole cargo run (rustc and the test binary) goes under the cap, so a runaway build or test dies alone.
    const w = wrap(mech, mem.capBytes, 'cargo', cargoArgs);
    const child = spawn(w.cmd, w.args, { cwd: dir, env: { ...cargoEnv, CARGO_TARGET_DIR: join(dir, 'target') }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child);
    let out = '';
    let hung = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { hung = true; killGroup(child); }, timeoutS * 1000);
    const done = (status, signal) => { clearTimeout(timer); live.delete(child); killGroup(child); resolveRun({ status: hung ? null : status, signal, out, hung }); };
    child.on('close', done);
    child.on('error', () => done(127, null));
  });
}

const dirs = Array.from({ length: jobs }, (_, w) => prepare(w));
const rel = join('dfo-core', 'src', file);

const base = await run(dirs[0], 900);
if (base.status !== 0) {
  const why = hitCap(base) ? ` It hit the memory cap (${fmtMiB(mem.capBytes)} per worker): raise --max-mem, or lower --jobs.` : '';
  console.error(`the unmutated file does not pass (${cargoArgs.join(' ')}).${why}\n${base.out.slice(-1500)}`);
  process.exit(1);
}

const picked = lineRanges.length ? mutants : mutants.slice(0, count);
const verdicts = new Array(picked.length);
let next = 0;
let finished = 0;
async function worker(w) {
  const dir = dirs[w];
  for (;;) {
    const i = next++;
    if (i >= picked.length) return;
    const m = picked[i];
    const ls = original.split('\n');
    ls[m.line] = ls[m.line].slice(0, m.col) + m.repl + ls[m.line].slice(m.col + m.len);
    writeFileSync(join(dir, rel), ls.join('\n'));
    const r = await run(dir, mutantTimeoutS);
    let verdict;
    if (r.hung) verdict = `killed (hang > ${mutantTimeoutS}s)`;
    else if (hitCap(r)) verdict = `killed (memory cap ${fmtMiB(mem.capBytes)})`;
    else if (r.status === 0) verdict = 'SURVIVED';
    else if (/error(\[E\d+\])?:/.test(r.out) && /could not compile/.test(r.out)) verdict = 'invalid (does not compile)';
    else verdict = 'killed';
    verdicts[i] = verdict;
    finished += 1;
    console.log(`[${finished}/${picked.length}] ${file}:${m.line + 1} ${m.what} -> ${verdict}`);
  }
}
await Promise.all(dirs.map((_, w) => worker(w)));

const survivors = picked.filter((_, i) => verdicts[i] === 'SURVIVED').map((m) => ({ ...m, text: original.split('\n')[m.line].trim() }));
const killed = verdicts.filter((v) => v.startsWith('killed')).length;
const invalid = verdicts.filter((v) => v.startsWith('invalid')).length;
const capKills = verdicts.filter((v) => v.includes('memory cap')).length;
const same = readFileSync(path, 'utf8') === original; // the real file is never written; this stays true
console.log(`\n${file}: ${picked.length} mutants (of ${mutants.length} candidates): ${killed} killed (${capKills} at the memory cap), ${survivors.length} survived, ${invalid} invalid; file restored: ${same}  [${jobs} workers, ${capText}]`);
for (const sv of survivors.sort((a, b) => a.line - b.line)) console.log(`  SURVIVOR ${file}:${sv.line + 1}  ${sv.what}\n      ${sv.text}`);
process.exit(same ? 0 : 3);
