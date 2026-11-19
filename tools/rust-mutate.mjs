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
 *   --timeout seconds per mutant before it counts as a hang and is killed with its whole process group (default 180)
 *   --list    print the candidate mutants and exit
 *
 * Code under `#[cfg(test)]`, comments, doc comments and string literals are never mutated. The file is restored after
 * every mutant and on any exit; the final state is compared byte for byte with the original.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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
  console.error('usage: node tools/rust-mutate.mjs <file under rust/dfo-core/src> --tests a,b [--count N] [--seed S] [--list]');
  process.exit(2);
}
const path = join(rustDir, 'dfo-core', 'src', file);
const tests = (flag('tests', '') || '').split(',').filter(Boolean);
const count = Number(flag('count', 40));
const seed = Number(flag('seed', 1));
const listOnly = args.includes('--list');

const original = readFileSync(path, 'utf8');
const backup = `/tmp/rust-mutate-${file.replace(/[^a-z0-9]/gi, '_')}.bak`;
copyFileSync(path, backup);
const restore = () => writeFileSync(path, original);
process.on('exit', restore);
// The run loop below is asynchronous on purpose: a signal handler can only run while the event loop is free, so a
// SIGTERM now restores the file and kills the live test process group at once (a synchronous loop ignored it).
let live = null;
const killLive = () => { if (live?.pid) { try { process.kill(-live.pid, 'SIGKILL'); } catch { /* already gone */ } } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killLive(); restore(); process.exit(130); });

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
const cargoArgs = ['test', '-q', ...tests.flatMap((t) => ['--test', t]), '--lib'];
// A mutant may loop forever (for example a binary-search midpoint shift). Each run has a deadline; on expiry the whole
// process group (cargo AND the test binary it started) is killed and the mutant counts as killed ("hang").
const mutantTimeoutS = Number(flag('timeout', 180));
const run = (timeoutS = 600) => new Promise((resolveRun) => {
  const child = spawn('cargo', cargoArgs, { cwd: rustDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  live = child;
  let out = '';
  let hung = false;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { hung = true; killLive(); }, timeoutS * 1000);
  child.on('close', (status) => { clearTimeout(timer); live = null; killLive(); resolveRun({ status: hung ? null : status, stdout: out, stderr: '', hung }); });
  child.on('error', () => { clearTimeout(timer); live = null; resolveRun({ status: 127, stdout: out, stderr: '', hung }); });
});

const base = await run();
if (base.status !== 0) {
  console.error(`the unmutated file does not pass (${cargoArgs.join(' ')}):\n${(base.stdout + base.stderr).slice(-1500)}`);
  process.exit(1);
}

const picked = mutants.slice(0, count);
const survivors = [];
let killed = 0;
let invalid = 0;
for (const [i, m] of picked.entries()) {
  const ls = original.split('\n');
  ls[m.line] = ls[m.line].slice(0, m.col) + m.repl + ls[m.line].slice(m.col + m.len);
  writeFileSync(path, ls.join('\n'));
  const r = await run(mutantTimeoutS);
  const out = r.stdout + r.stderr;
  let verdict;
  if (r.hung) {
    verdict = `killed (hang > ${mutantTimeoutS}s)`;
    killed++;
  } else if (r.status === 0) {
    verdict = 'SURVIVED';
    survivors.push({ ...m, text: original.split('\n')[m.line].trim() });
  } else if (/error(\[E\d+\])?:/.test(out) && /could not compile/.test(out)) {
    verdict = 'invalid (does not compile)';
    invalid++;
  } else {
    verdict = 'killed';
    killed++;
  }
  console.log(`[${i + 1}/${picked.length}] ${file}:${m.line + 1} ${m.what} -> ${verdict}`);
}
restore();
const same = readFileSync(path, 'utf8') === original;
console.log(`\n${file}: ${picked.length} mutants (of ${mutants.length} candidates): ${killed} killed, ${survivors.length} survived, ${invalid} invalid; file restored: ${same}`);
for (const sv of survivors) console.log(`  SURVIVOR ${file}:${sv.line + 1}  ${sv.what}\n      ${sv.text}`);
process.exit(same ? 0 : 3);
