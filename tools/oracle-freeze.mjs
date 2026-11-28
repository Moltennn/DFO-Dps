#!/usr/bin/env node
/*
 * tools/oracle-freeze.mjs - record (or compare) the frozen answers of the dfo-core JS oracles.
 *
 *   node tools/oracle-freeze.mjs            write rust/tests/frozen/oracle/ (answers + MANIFEST)
 *   node tools/oracle-freeze.mjs --check    run the live JS and fail if a recorded answer would differ
 *
 * The three scripts below are the differential oracles `rust/dfo-core/tests/{planner_mutants,probe,sidebar}.rs`
 * replay. While `src/`, `vendor/` and the scripts exist, `--check` re-runs them and compares byte for byte, so a JS
 * change cannot leave the Rust tests asserting an old answer. Before those trees are removed the recorded answers are
 * the evidence; the Rust tests read them through `tests/common/oracle.rs` and verify each file against this MANIFEST.
 *
 * Store format: one `<name>.txt.gz` per oracle (gzip -9 of the script's stdout, nothing added), and
 *
 *   oracle <name> <script> <gzip-sha256> <raw-sha256> <raw-bytes> <lines>
 *
 * A missing file, a digest that disagrees, a wrong size or a wrong line count fails the Rust test; it never skips.
 *
 * The book is pinned to the SYNTHETIC spellbook. `gate.mjs --real-spells` sets `DFO_REAL_SPELLS=1` for every child, and
 * the planner oracle's `book` row would then carry the player's own SPELLS.STD into a committed file: this tool deletes
 * the variable from the child environment and refuses a recording whose book row is not the synthetic one.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(root, 'rust', 'tests', 'frozen', 'oracle');
// The oracle whose `book u => …` row carries the spellbook (planner only; probe and sidebar never read one).
const BOOK_ORACLE = 'planner';
const ORACLES = [
  { name: 'planner', script: 'rust/dfo-core/tests/planner_oracle.mjs' },
  { name: 'probe', script: 'rust/dfo-core/tests/probe_oracle.mjs' },
  { name: 'sidebar', script: 'rust/dfo-core/tests/sidebar_oracle.mjs' },
];

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The synthetic book's names are `Anvil Proof <n>` (tools/rust-synth-book.mjs), so a real book announces itself the
 * moment one recorded name is not. Returns the decoded names on the `book` line, or null when there is no book row.
 */
function bookNames(raw) {
  const line = raw.toString('utf8').split('\n').find((l) => l.startsWith('book '));
  if (!line) return null;
  const names = [];
  for (const m of line.matchAll(/s((?:[0-9a-f]{4}){2,});/g)) {
    let text = '';
    for (let i = 0; i < m[1].length; i += 4) text += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    names.push(text);
  }
  return names;
}

/** The property names a book row always carries; anything else long enough to be a spell name is a name. */
const BOOK_KEYS = new Set([
  'effects', 'type', 'subType', 'durationBase', 'durationMod', 'durationPerLevel', 'chanceBase', 'chanceMod',
  'chancePerLevel', 'magnitudeBaseLow', 'magnitudeBaseHigh', 'magnitudeLevelBase', 'magnitudeLevelHigh',
  'magnitudePerLevel', 'element', 'rangeType', 'cost', 'name', 'icon', 'index',
]);

/** A recorded book row must be the synthetic one: every spell name starts `Anvil Proof`, and there is at least one. */
function syntheticBook(raw) {
  const names = bookNames(raw);
  if (!names) return `${BOOK_ORACLE}: no \`book\` row, so the spellbook in force cannot be identified`;
  const spells = names.filter((n) => !BOOK_KEYS.has(n));
  if (!spells.length) return `${BOOK_ORACLE}: the \`book\` row names no spell`;
  const foreign = spells.filter((n) => !n.startsWith('Anvil Proof'));
  if (foreign.length) {
    return `${BOOK_ORACLE}: the book is not the synthetic one: ${foreign.length} spelled name(s) such as `
      + `${JSON.stringify(foreign.slice(0, 5))}. Re-record with DFO_REAL_SPELLS unset; the committed answers may carry `
      + 'made-up spell names only.';
  }
  return null;
}

function live(oracle) {
  const env = { ...process.env };
  // `gate.mjs --real-spells` exports this for every child; a committed answer may never carry the game's own book.
  delete env.DFO_REAL_SPELLS;
  delete env.DAGGER_USER_DATA;
  const r = spawnSync('node', [join(root, oracle.script)], {
    cwd: root,
    env,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0) {
    process.stderr.write(`${oracle.name}: ${oracle.script} exited ${r.status}\n${r.stderr}\n`);
    process.exit(1);
  }
  return r.stdout;
}

const modes = process.argv.slice(2);
if (modes.length > 1 || (modes.length === 1 && modes[0] !== '--check')) {
  console.error('usage: node tools/oracle-freeze.mjs [--check]');
  process.exit(2);
}
const check = modes[0] === '--check';

mkdirSync(outDir, { recursive: true });
const lines = ['# Written by `node tools/oracle-freeze.mjs`: name, script, gzip/raw sha256, raw bytes, non-empty lines.'];
const pending = [];
let bad = 0;
for (const oracle of ORACLES) {
  const raw = live(oracle);
  const count = raw.toString('utf8').split('\n').filter(Boolean).length;
  const wrongBook = oracle.name === BOOK_ORACLE ? syntheticBook(raw) : null;
  if (wrongBook) {
    // The planner answer carries the book: never write, and never accept, a real one.
    console.log(`${wrongBook}`);
    bad++;
    continue;
  }
  if (check) {
    let stored;
    try {
      stored = gunzipSync(readFileSync(join(outDir, `${oracle.name}.txt.gz`)));
    } catch (e) {
      console.log(`${oracle.name}: cannot read the recorded answer: ${e.message}`);
      bad++;
      continue;
    }
    // A committed answer may not carry the game's book either: re-check it, not just the live output.
    const storedWrongBook = oracle.name === BOOK_ORACLE ? syntheticBook(stored) : null;
    if (storedWrongBook) {
      console.log(`recorded answer refused: ${storedWrongBook}`);
      bad++;
      continue;
    }
    const same = stored.equals(raw);
    console.log(`${oracle.name}: ${same ? 'matches' : 'DIFFERS'} (${count} cases, ${raw.length} bytes)`);
    if (!same) bad++;
    continue;
  }
  const packed = gzipSync(raw, { level: 9 });
  pending.push({ name: oracle.name, script: oracle.script, packed, raw, count });
  console.log(`recorded ${oracle.name}: ${count} cases, ${raw.length} bytes (${packed.length} gzipped)`);
}
if (!check && bad === 0) {
  // A refused run writes nothing: a half-written answer set would lose the committed planner row.
  for (const p of pending) writeFileSync(join(outDir, `${p.name}.txt.gz`), p.packed);
  for (const p of pending) {
    lines.push(`oracle ${p.name} ${p.script} ${sha(p.packed)} ${sha(p.raw)} ${p.raw.length} ${p.count}`);
  }
  writeFileSync(join(outDir, 'MANIFEST'), `${lines.join('\n')}\n`);
}
if (bad) {
  console.log(`${check ? `${bad} oracle(s) differ from the recorded answers` : `${bad} oracle(s) not recorded`}`);
  process.exit(1);
}
