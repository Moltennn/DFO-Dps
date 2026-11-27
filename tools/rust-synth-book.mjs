#!/usr/bin/env node
/*
 * tools/rust-synth-book.mjs - the synthetic spellbook every generator and test reads in place of the game's.
 *
 * The record LAYOUT is the game's (`readSpellRecord`, src/spells.js). Every name and number here is made up: nothing
 * is read from, copied from or derived from the game's file. The record INDICES the code looks up come from the
 * tables in src (`enchantData.js`), which is why they appear below.
 *
 * `DFO_REAL_SPELLS=1` is the opt-in local tier: read the launcher's own SPELLS.STD instead. Its output is never
 * committed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { arena2Dir, configPath } from '../src/save.js';
import { EFFECT_COST_TABLE, SPELL_RECORD_SIZE, readSpellsStd } from '../src/spells.js';
import { ENCHANTMENT_COSTS } from '../src/enchantData.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const realSpells = () => process.env.DFO_REAL_SPELLS === '1';

/** The strike candidates `src/enchantPlan.js` prices that deal health damage here. The planner generator requires
 *  every plan to rate exactly six, so the other six candidates must stay harmless. */
const STRIKE_CANDIDATES = [50, 53, 52, 54, 56, 33, 20, 25, 16, 7, 55, 67];

// An effect shape is [type, subType, overrides?].
const HIT = [4, 0];
const BURN = [1, 0];
const SIPHON = [11, 8];

/** Hand-assigned records: index -> { element, rangeType, effects (null = an empty slot) }. */
const ASSIGNED = {
  // the six damaging strike candidates
  53: { element: 0, rangeType: 2, effects: [HIT] },
  7: { element: 1, rangeType: 1, effects: [HIT] },
  33: { element: 4, rangeType: 1, effects: [BURN] },
  25: { element: 4, rangeType: 1, effects: [SIPHON] },
  16: { element: 4, rangeType: 2, effects: [HIT, [10, 9]] },
  67: { element: 4, rangeType: 1, effects: [BURN, [4, 1]] },
  // the reader's one patched record: (3,2) at index 10 reads back as (26,-1)
  10: { element: 4, rangeType: 0, effects: [[3, 2]] },
};

/** Damage over every element and range, then the shapes the readers branch on. */
const DAMAGE_SHAPES = [
  ...[0, 1, 2, 3, 4].flatMap((element) => [0, 1, 2, 3, 4].map((rangeType) => ({ element, rangeType, effects: [HIT] }))),
  { element: 0, rangeType: 2, effects: [BURN] },
  { element: 2, rangeType: 3, effects: [BURN] },
  { element: 3, rangeType: 4, effects: [[1, 0, { magnitudePerLevel: 0 }]] },
  { element: 1, rangeType: 1, effects: [[4, 0, { magnitudePerLevel: 0 }]] },
  { element: 4, rangeType: 1, effects: [[1, 0, { durationPerLevel: 7, fixed: true }]] },
  { element: 0, rangeType: 1, effects: [[4, 0, { fixed: true }]] },
  { element: 3, rangeType: 2, effects: [HIT, BURN] },
  { element: 2, rangeType: 1, effects: [BURN, [8, 2], HIT] },
  { element: 4, rangeType: 2, effects: [[0, -1], HIT] },
  { element: 1, rangeType: 3, effects: [null, HIT] },
];

// An effect type the cost table does not price (it costs nothing, and absorbs as Destruction), alone and beside damage.
for (const [at, shape] of [
  [0, { element: 4, rangeType: 2, effects: [[32, -1], HIT] }],
  [9, { element: 0, rangeType: 1, effects: [[32, -1]] }],
  [18, { element: 4, rangeType: 1, effects: [[32, -1], BURN] }],
]) DAMAGE_SHAPES.splice(at, 0, shape);

export function synthSpellsStd() {
  let state = 0x5eedb00c;
  const int = (lo, hi) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return lo + Math.floor((state / 2 ** 32) * (hi - lo + 1));
  };
  const referenced = ['CastWhenUsed', 'CastWhenHeld', 'CastWhenStrikes']
    .flatMap((type) => ENCHANTMENT_COSTS[type].spells.map(([id]) => id));
  // Filler up to 99 leaves some gaps, so a lookup of a missing index stays a real case.
  const filler = Array.from({ length: 99 }, (_, i) => i + 1).filter((i) => i % 11 !== 10);
  const indices = [...new Set([...referenced, ...filler, 10])].sort((a, b) => a - b);

  // Every priced effect that is not health damage, dealt round-robin to the records without an assigned shape.
  const utility = Object.keys(EFFECT_COST_TABLE)
    .map((k) => k.split(',').map(Number))
    .filter(([t, s]) => !['4,0', '1,0', '11,8'].includes(`${t},${s}`))
    .map(([t, s]) => [t, s === 255 ? -1 : s]);
  const shapes = [...DAMAGE_SHAPES];
  let next = 0;
  const take = () => utility[next++ % utility.length];
  const free = indices.filter((i) => !ASSIGNED[i] && !STRIKE_CANDIDATES.includes(i));
  const plan = new Map();
  // Damage takes every other free record, so item enchantments of every kind reach both sorts.
  for (const [n, index] of free.entries()) {
    if (n % 2 === 0 && shapes.length) plan.set(index, shapes.shift());
  }
  if (shapes.length) throw new Error(`rust-synth-book: ${shapes.length} damage shapes have no record`);
  const rest = indices.filter((i) => !ASSIGNED[i] && !plan.has(i));
  // Pack what the one-effect records cannot hold into the first records as second and third effects.
  let spare = Math.max(0, utility.length - rest.length);
  for (const [n, index] of rest.entries()) {
    const effects = [take()];
    while (spare > 0 && effects.length < (n === 0 ? 3 : 2)) { effects.push(take()); spare--; }
    plan.set(index, { element: n % 9 === 0 ? n % 4 : 4, rangeType: [0, 0, 1, 0, 2, 1, 3, 4][n % 8], effects });
  }
  for (const [index, shape] of Object.entries(ASSIGNED)) plan.set(Number(index), shape);

  const record = (index, { element, rangeType, effects }, name) => {
    const b = Buffer.alloc(SPELL_RECORD_SIZE);
    const slots = [0, 1, 2].map((i) => effects[i] ?? null);
    for (const [i, slot] of slots.entries()) {
      const [type, subType, fixed = {}] = slot ?? [-1, -1];
      b.writeInt8(type, 2 * i);
      b.writeInt8(subType, 2 * i + 1);
      if (!slot) continue;
      const low = int(2, 13);
      const rise = int(1, 8);
      const duration = [int(1, 7), int(0, 9), fixed.durationPerLevel ?? int(1, 4)];
      const chance = [int(5, 55), int(1, 18), int(1, 6)];
      const magnitude = [low, fixed.fixed ? low : low + int(3, 31), rise, fixed.fixed ? rise : rise + int(1, 7),
        fixed.magnitudePerLevel ?? int(1, 3)];
      b.set(duration, 14 + 3 * i);
      b.set(chance, 23 + 3 * i);
      b.set(magnitude, 32 + 5 * i);
    }
    b.writeUInt8(element, 6);
    b.writeUInt8(rangeType, 7);
    // Both sides of the one-byte boundary, with unequal bytes so a swapped byte order shows.
    b.writeUInt16LE(index % 3 ? 263 + index * 17 : 11 + index, 8);
    b.write(name, 47, 24, 'latin1');
    b.writeUInt8(index % 40, 72);
    b.writeUInt8(index, 73);
    return b;
  };
  const records = indices.map((i) => record(i, plan.get(i), `Anvil Proof ${i}`));
  // A repeated index (the first record wins), a name at full length, and an empty record the reader drops.
  records.push(record(58, { element: 4, rangeType: 1, effects: [HIT] }, 'Anvil Proof Repeat Index'));
  records.push(record(0, { element: 4, rangeType: 0, effects: [] }, 'Anvil Proof Blank'));
  return Buffer.concat(records);
}

/** Point this process and its children at the spellbook in force: the synthetic one, written under `.cache/` with a
 *  launcher config naming it, so the implicit `standardSpells()` reads it too. No-op in the real tier. */
export function useSpellbook() {
  if (realSpells()) return;
  const home = join(root, '.cache', 'synth-game');
  const arena = join(home, 'ARENA2');
  mkdirSync(arena, { recursive: true });
  // Rename into place: parallel generator processes write the same bytes.
  const put = (path, bytes) => {
    writeFileSync(`${path}.${process.pid}`, bytes);
    renameSync(`${path}.${process.pid}`, path);
  };
  put(join(arena, 'SPELLS.STD'), synthSpellsStd());
  put(join(home, 'config.json'), JSON.stringify({ arena2Path: arena }));
  process.env.DAGGER_USER_DATA = home;
}

/** The bytes and parsed records of the spellbook in force; fails loudly without one. */
export function readSpellBook(who) {
  useSpellbook();
  const dir = arena2Dir();
  if (!dir) throw new Error(`${who}: no ARENA2 in ${configPath()}; SPELLS.STD is required with DFO_REAL_SPELLS=1`);
  const path = resolve(dir, 'SPELLS.STD');
  const bytes = readFileSync(path);
  const records = readSpellsStd(bytes);
  if (!records.length) throw new Error(`${who}: empty ${path}`);
  return { path, bytes, records };
}
