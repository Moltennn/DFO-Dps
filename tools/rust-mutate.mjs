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
 *   --jobs    parallel workers (default min(8, cores/2)); each owns a private copy of the crate under ~/.cache/dfo-mut/wN
 *   --timeout seconds per mutant before it counts as a hang and is killed with its whole process group (default 180)
 *   --list    print the candidate mutants and exit
 *
 * Code under `#[cfg(test)]`, comments, doc comments and string literals are never mutated. Mutants run in PRIVATE COPIES of
 * the crate (see the run section), so the real source tree is never written and there is nothing to restore.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, cpus } from 'node:os';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rustDir = join(root, 'rust');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const file = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!file) {
  console.error('usage: node tools/rust-mutate.mjs <file under rust/dfo-core/src> --tests a,b [--count N] [--seed S] [--jobs J] [--timeout S] [--list]');
  process.exit(2);
}
const path = join(rustDir, 'dfo-core', 'src', file);
const tests = (flag('tests', '') || '').split(',').filter(Boolean);
const count = Number(flag('count', 40));
const seed = Number(flag('seed', 1));
const listOnly = args.includes('--list');

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

// seeded shuffle (mulberry32)
let s = seed >>> 0;
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
for (let i = mutants.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [mutants[i], mutants[j]] = [mutants[j], mutants[i]];
}

if (listOnly) {
  console.log(`${mutants.length} candidate mutants in ${file}`);
  process.exit(0);
}

// ---- run ---------------------------------------------------------------------------------------------------------
// Parallel pool. Each worker owns a private COPY of the crate (own source, own target dir; the generated vectors are
// symlinked), so mutants run side by side and the real source tree is never touched: a killed run leaves nothing to
// restore. Tests are built with opt-level 2 (about 3x faster than debug for these numeric vector loops).
const jobs = Math.max(1, Number(flag('jobs', Math.min(8, Math.floor(cpus().length / 2)))));
const mutantTimeoutS = Number(flag('timeout', 180));
const workRoot = join(homedir(), '.cache', 'dfo-mut');
const cargoArgs = ['test', '-q', ...tests.flatMap((t) => ['--test', t]), '--lib'];
const cargoEnv = { ...process.env, CARGO_PROFILE_DEV_OPT_LEVEL: '2', CARGO_PROFILE_DEV_DEBUG: '0' };

const live = new Set();
const killGroup = (child) => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } };
const killAll = () => { for (const c of live) killGroup(c); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
process.on('exit', killAll);

function prepare(w) {
  const dir = join(workRoot, `w${w}`);
  mkdirSync(join(dir, 'dfo-core'), { recursive: true });
  for (const f of ['Cargo.toml', 'Cargo.lock']) cpSync(join(rustDir, f), join(dir, f));
  cpSync(join(rustDir, 'dfo-core', 'Cargo.toml'), join(dir, 'dfo-core', 'Cargo.toml'));
  for (const d of ['src', 'tests']) {
    rmSync(join(dir, 'dfo-core', d), { recursive: true, force: true });
    cpSync(join(rustDir, 'dfo-core', d), join(dir, 'dfo-core', d), { recursive: true });
  }
  mkdirSync(join(dir, 'tests'), { recursive: true });
  const link = join(dir, 'tests', 'vectors');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(join(rustDir, 'tests', 'vectors'), link);
  return dir;
}

function run(dir, timeoutS) {
  return new Promise((resolveRun) => {
    const child = spawn('cargo', cargoArgs, { cwd: dir, env: { ...cargoEnv, CARGO_TARGET_DIR: join(dir, 'target') }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child);
    let out = '';
    let hung = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { hung = true; killGroup(child); }, timeoutS * 1000);
    const done = (status) => { clearTimeout(timer); live.delete(child); killGroup(child); resolveRun({ status: hung ? null : status, out, hung }); };
    child.on('close', done);
    child.on('error', () => done(127));
  });
}

const dirs = Array.from({ length: jobs }, (_, w) => prepare(w));
const rel = join('dfo-core', 'src', file);

const base = await run(dirs[0], 900);
if (base.status !== 0) {
  console.error(`the unmutated file does not pass (${cargoArgs.join(' ')}):\n${base.out.slice(-1500)}`);
  process.exit(1);
}

const picked = mutants.slice(0, count);
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
const same = readFileSync(path, 'utf8') === original; // the real file is never written; this stays true
console.log(`\n${file}: ${picked.length} mutants (of ${mutants.length} candidates): ${killed} killed, ${survivors.length} survived, ${invalid} invalid; file restored: ${same}  [${jobs} workers]`);
for (const sv of survivors.sort((a, b) => a.line - b.line)) console.log(`  SURVIVOR ${file}:${sv.line + 1}  ${sv.what}\n      ${sv.text}`);
process.exit(same ? 0 : 3);
