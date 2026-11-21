// Focused differential for `dfo_core::probe`, against the REAL `src/probe.js`.
//
// Run by `rust/dfo-core/tests/probe.rs`. Every fixture is SYNTHETIC (built here, never a real capture): a capture-shaped
// document is printed as one value-codec token, the JS module's own answer as another, and the Rust test replays the
// input and compares the whole result bit for bit.
//
// Line schema: `<kind> <input-token> <opts-token?> => <expected-token>`
//   summary     the capture document                => summarizeProbe(document)
//   fight       a samples array                     => fightSummary(samples, opts)
//   split       a samples array (opts: [gap, min])  => splitFights(samples, {gapMs, minSeconds})
//   charttop    a chart                             => chartTop(chart)
//   charttotals a chart                             => chartTotals(chart)
//   constants   a level                             => probeConstants(level)
//   refusal     a non-capture document              => both refuse (the Rust side compares its message only)
import { bossContent, chartTop, chartTotals, fightSummary, gateOutcome, probeConstants, splitFights, summarizeProbe } from '../../../src/probe.js';
import { encodeValue } from '../../../tools/rust-codec.mjs';

/**
 * A synthetic capture like `test/probe.test.js` builds: 10 Hz samples whose boss bar drains linearly, with optional
 * no-damage window, split halves and gate state.
 */
function capture({ seconds = 30, gap = [0, 0], content = 'breach', halves = false, gate = null, name = 'The Warden' } = {}) {
  const samples = [];
  const n = seconds * 10;
  let hp = 100;
  for (let i = 0; i <= n; i++) {
    const t = i * 100;
    const inGap = gap[1] > 0 && t >= gap[0] * 1000 && t < (gap[0] + gap[1]) * 1000;
    if (!inGap) hp = Math.max(0, 100 - (i / n) * 100);
    const sample = {
      t,
      wall: 1_700_000_000_000 + t,
      boss: {
        content,
        name,
        sub: 'level 45',
        hp,
        warded: false,
        wrath: false,
        tags: [],
        halves: halves && i / n > 0.5 ? [{ name: 'Gold', hp, state: '' }, { name: 'Silver', hp, state: '' }] : [],
      },
    };
    if (gate) sample.gate = { ...gate };
    samples.push(sample);
  }
  return { version: 1, build: 'test', level: 45, players: 1, startedAt: 0, endedAt: n * 100, samples, events: [], chart: null };
}

const lines = [];
const push = (kind, input, opts, expected) => {
  lines.push(`${kind} ${encodeValue(input)} ${encodeValue(opts)} => ${encodeValue(expected)}`);
};

// ── summarizeProbe: the cases `test/probe.test.js` pins, plus the chart and the odd reads ─────────────────────────
push('summary', capture(), undefined, summarizeProbe(capture()));
push('summary', capture({ gap: [12, 5] }), undefined, summarizeProbe(capture({ gap: [12, 5] })));

{
  const a = capture({ seconds: 15 });
  const b = capture({ seconds: 15 });
  for (const s of b.samples) { s.t += 60_000; s.wall += 60_000; }
  const joined = { ...a, samples: [...a.samples, ...b.samples] };
  push('summary', joined, undefined, summarizeProbe(joined));
}

push('summary', capture({ halves: true }), undefined, summarizeProbe(capture({ halves: true })));
push('summary', capture({ name: 'Valkynaz Ruhn' }), undefined, summarizeProbe(capture({ name: 'Valkynaz Ruhn' })));
push('summary', capture({ name: 'Sky-ketch Warden' }), undefined, summarizeProbe(capture({ name: 'Sky-ketch Warden' })));
push('summary', capture({ name: 'Abyss Remnant' }), undefined, summarizeProbe(capture({ name: 'Abyss Remnant' })));

// A slow weapon cadence: one hit every second, none of it immunity.
{
  const samples = [];
  let hp = 100;
  for (let i = 0; i <= 300; i++) {
    const t = i * 100;
    if (i > 0 && i % 10 === 0) hp = Math.max(0, hp - 100 / 30);
    samples.push({ t, boss: { content: 'breach', name: 'The Warden', sub: '', hp, tags: [], halves: [] } });
  }
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined, summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}

// The chart's per-player levels add their own share.
{
  const data = capture();
  data.levels = [45, 45];
  data.players = 2;
  push('summary', data, undefined, summarizeProbe(data));
}
// The top-10 chart fills the remaining players at the median level.
{
  const data = capture();
  data.players = 49;
  data.levels = Array.from({ length: 10 }, () => 31);
  push('summary', data, undefined, summarizeProbe(data));
}
// The gate's own maximum, and its landed total.
{
  const data = capture({ seconds: 30 });
  for (const s of data.samples) s.gate = { max: 423360, fighters: 49, phase: 1 };
  data.players = 49;
  data.levels = Array.from({ length: 10 }, () => 31);
  push('summary', data, undefined, summarizeProbe(data));
}
{
  const data = capture({ seconds: 30 });
  for (const s of data.samples) s.gate = { max: 45300, hp: 1183, fighters: 6, phase: 3 };
  data.players = 6;
  data.levels = Array.from({ length: 6 }, () => 31);
  push('summary', data, undefined, summarizeProbe(data));
}
// A chart that says fallen overrides stale gate hp and makes the damage the whole pool.
{
  const data = capture({ seconds: 30 });
  data.players = 6;
  data.levels = Array.from({ length: 6 }, () => 31);
  for (const s of data.samples) s.gate = { max: 45300, hp: 1183, fighters: 6, phase: 3 };
  data.chart = { sub: 'Valkynaz Ruhn has fallen - 6 challengers', rows: [] };
  push('summary', data, undefined, summarizeProbe(data));
}
// A mid-fight join reports since-join damage and keeps the whole kill total.
{
  const data = capture({ seconds: 30 });
  data.players = 6;
  data.levels = Array.from({ length: 6 }, () => 31);
  for (const s of data.samples) s.gate = { max: 45300, hp: 0, fighters: 6, phase: 3 };
  data.samples[0].gate = { max: 27300, hp: 18535, fighters: 3, phase: 1 };
  data.outcome = 'kill';
  push('summary', data, undefined, summarizeProbe(data));
}
// The player snapshot names the weapon and imprint.
{
  const data = capture();
  data.playerEnd = { weapon: { name: 'Broadsword', imprint: 'warp-edge' }, offWeapon: { name: 'Broadsword' } };
  push('summary', data, undefined, summarizeProbe(data));
}
{
  const data = capture();
  data.playerStart = { weapon: { name: 'Dagger' }, offWeapon: { name: 'Sabre', imprint: 'echo' } };
  push('summary', data, undefined, summarizeProbe(data));
}
// A boss heal is added to the landed total, and a stale gate max stays out of the split.
{
  const data = capture({ seconds: 30 });
  data.players = 6;
  data.levels = Array.from({ length: 6 }, () => 31);
  for (const s of data.samples) s.gate = { max: 100000, hp: 40000, fighters: 6, phase: 3 };
  data.samples[40].gate = { max: 100000, hp: 42825, fighters: 6, phase: 3 };
  data.outcome = 'kill';
  push('summary', data, undefined, summarizeProbe(data));
}
// Levels out of range are dropped; a capture with no samples, no chart and no players still reads.
{
  const data = capture();
  data.levels = [0, 61, -3, 45, 44];
  push('summary', data, undefined, summarizeProbe(data));
}
push('summary', { version: 1, level: 45 }, undefined, summarizeProbe({ version: 1, level: 45 }));
push('summary', { version: 1, level: 45, players: 0, levels: [31, 31], samples: capture({ seconds: 5 }).samples }, undefined,
  summarizeProbe({ version: 1, level: 45, players: 0, levels: [31, 31], samples: capture({ seconds: 5 }).samples }));
// The chart rows the page reads, through summarizeProbe.
{
  const data = capture({ seconds: 20 });
  data.chart = {
    sub: 'Valkynaz Ruhn has fallen - 2 challengers',
    text: 'png',
    rows: [
      { cls: 'wb-dmg-row wb-dmg-head', text: '#' },
      { cls: 'wb-dmg-row', text: '1A' },
      { cls: 'wb-dmg-rank', text: '1' },
      { cls: 'wb-dmg-name', text: 'A' },
      { cls: 'wb-dmg-lv', text: 'Lv 31' },
      { cls: 'wb-dmg-damage wb-dmg-num', text: '10,000' },
      { cls: 'wb-dmg-share', text: '50%' },
      { cls: 'wb-dmg-blows', text: '120' },
      { cls: 'wb-dmg-best', text: '516' },
      { cls: 'wb-dmg-cx', text: '0' },
      { cls: 'wb-dmg-falls', text: '1' },
      { cls: 'wb-dmg-heal', text: '200' },
    ],
  };
  push('summary', data, undefined, summarizeProbe(data));
}

// A 0.4 s cadence with one 0.9 s quiet stretch: the immunity floor (2.5x the median gap, 1.0 s) must stay above 0.9 s,
// so the stretch is not immunity. (A 2.0x floor, 0.8 s, would count it - a mutant this case kills.)
{
  const samples = [];
  let hp = 100;
  let next = 0;
  for (let i = 0; i <= 300; i++) {
    if (i === next) {
      hp = Math.max(0, hp - 100 / 60);
      next = i < 80 ? i + 4 : i === 80 ? 90 : i + 4;
    }
    samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp, tags: [], halves: [] } });
  }
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}

// ── fightSummary: the options the summary fixes, read directly ───────────────────────────────────────────────────────
{
  const samples = capture({ seconds: 20 }).samples;
  for (const opts of [
    {},
    { content: 'skyketch', level: 31, players: 3, levels: [31, 32] },
    { content: 'abyss', levels: [10, 20, 30], gate: { max: 50000, hp: 20000, fighters: 3, phase: 2 } },
    { gate: null, chartKill: true, outcome: 'ended' },
    { gate: { max: 0, hp: 0, fell: true } },
    { content: 'breach', playerEnd: { weapon: null, offWeapon: { imprint: 'echo' } } },
    { levels: [31, 61, 0, 45], players: 5 },
    // The destructured defaults apply to `undefined`, not to a caller's explicit null/string.
    { content: null, level: '45', players: 1, levels: [] },
    { content: 'skyketch', level: null },
    // `fightSummary` filters levels with `Number.isFinite` (no coercion), unlike `summarizeProbe`.
    { levels: ['31', 31, 32.5, NaN, 60, 61], players: 3 },
  ]) {
    push('fight', samples, opts, fightSummary(samples, opts));
  }
}

// ── splitFights: name change, restart, refill, share growth, gap and minSeconds ────────────────────────────────────
{
  const samples = capture({ seconds: 20 }).samples;
  push('split', samples, [5000, 1], splitFights(samples));
}
{
  // A phase bar jump or a boss heal does not split one gate fight.
  const samples = [];
  for (let i = 0; i <= 200; i++) {
    const bar = i < 100 ? 100 - i * 0.4 : 60 - (i - 100) * 0.6;
    const gateHp = 100000 - i * 400;
    samples.push({
      t: i * 100,
      boss: { content: 'breach', name: 'Valkynaz Ruhn', sub: '', hp: i === 100 ? bar + 8 : bar, halves: [], tags: [] },
      gate: { hp: i === 120 ? gateHp + 2825 : gateHp, max: 100000, fighters: 40, phase: 2 },
    });
  }
  push('split', samples, [5000, 1], splitFights(samples));
}
{
  // A boss that refills, a rename and a restart, all in one run.
  const samples = capture({ seconds: 40 }).samples;
  for (const s of samples) s.t += 0;
  for (let i = 150; i < 200; i++) samples[i].boss.hp = 100;
  for (let i = 200; i < 250; i++) samples[i].boss.hp = 0;
  for (let i = 250; i <= 300; i++) samples[i].boss.hp = 100;
  for (let i = 100; i < 150; i++) samples[i].boss.name = 'Another Warden';
  push('split', samples, [5000, 1], splitFights(samples));
}
{
  // More fighters join and the gate grows: a refill is not a split then.
  const samples = capture({ seconds: 20 }).samples;
  for (const s of samples) s.gate = { max: 100000, hp: 90000, fighters: 3, phase: 1 };
  for (let i = 100; i < samples.length; i++) samples[i].gate = { max: 100000, hp: 98000, fighters: 4, phase: 1 };
  push('split', samples, [5000, 1], splitFights(samples));
}
{
  // A gap splits, but the default minimum keeps a one-sample tail out.
  const samples = capture({ seconds: 10 }).samples;
  for (const s of samples) if (s.t > 5000) s.t += 20000;
  push('split', samples, [5000, 1], splitFights(samples));
  push('split', samples, [5000, 100], splitFights(samples, { gapMs: 5000, minSeconds: 100 }));
}
// ── The `splitFights` boundary conditions, one per source comparison ────────────────────────────────────────────────
{
  // A refill while more fighters join and the shared max stays: `shareGrow` suppresses the split; equal fighters is not
  // a share-grow, and a gate that drops its max is not one either.
  const grownFighters = capture({ seconds: 20 }).samples;
  for (const s of grownFighters) s.gate = { max: 100000, hp: 90000, fighters: 3, phase: 1 };
  for (let i = 100; i < grownFighters.length; i++) grownFighters[i].gate = { max: 100000, hp: 98000, fighters: 4, phase: 1 };
  push('split', grownFighters, [5000, 1], splitFights(grownFighters));

  const equalFighters = capture({ seconds: 20 }).samples;
  for (const s of equalFighters) s.gate = { max: 100000, hp: 90000, fighters: 3, phase: 1 };
  for (let i = 100; i < equalFighters.length; i++) equalFighters[i].gate = { max: 100000, hp: 98000, fighters: 3, phase: 1 };
  push('split', equalFighters, [5000, 1], splitFights(equalFighters));

  const shrunkMax = capture({ seconds: 20 }).samples;
  for (const s of shrunkMax) s.gate = { max: 100000, hp: 90000, fighters: 3, phase: 1 };
  for (let i = 100; i < shrunkMax.length; i++) shrunkMax[i].gate = { max: 90000, hp: 98000, fighters: 4, phase: 1 };
  push('split', shrunkMax, [5000, 1], splitFights(shrunkMax));

  // A gate that appears mid-fight (there is no previous gate, so no share to grow) is a refill.
  const gateAppears = capture({ seconds: 20 }).samples;
  for (let i = 100; i < gateAppears.length; i++) gateAppears[i].gate = { max: 100, hp: 96, fighters: 4, phase: 1 };
  push('split', gateAppears, [5000, 1], splitFights(gateAppears));
}
{
  // A pure refill with nothing else: the last `||` disjunct alone must split.
  const samples = capture({ seconds: 20 }).samples;
  for (let i = 100; i < 140; i++) samples[i].boss.hp = 100;
  push('split', samples, [5000, 1], splitFights(samples));
  // A restart exactly AT the 0.01 floor (`<=`), isolated from the refill path: `splitHp` reads the GATE's hp first, so
  // the gate is the one at 0.01. More fighters join with an unchanged max on the SAME pair, so `shareGrow` suppresses
  // the refill and only the restart can split - `< 0.01` would miss it; every other pair keeps 3 fighters.
  const restart = capture({ seconds: 20 }).samples;
  for (const s of restart) s.gate = { max: 100000, hp: 90000, fighters: 3, phase: 1 };
  restart[60].gate = { max: 100000, hp: 0.01, fighters: 3, phase: 1 };
  restart[61].gate = { max: 100000, hp: 96000, fighters: 4, phase: 1 };
  for (let i = 62; i < restart.length; i++) restart[i].gate = { max: 100000, hp: 96000, fighters: 4, phase: 1 };
  for (let i = 0; i < 60; i++) restart[i].boss.hp = 100;
  restart[60].boss.hp = 0.01;
  for (let i = 61; i < 100; i++) restart[i].boss.hp = 100;
  for (let i = 100; i < restart.length; i++) restart[i].boss.hp = 90 - (i - 100) * 0.1;
  push('split', restart, [5000, 1], splitFights(restart));
}

// `summarizeProbe`'s player fallback: `players: 0` with NO levels is 1 (`|| levels.length || 1`). A `2` fallback
// would report two players and price a maxHp for two.
{
  const data = capture({ seconds: 10 });
  data.players = 0;
  push('summary', data, undefined, summarizeProbe(data));
  data.players = -1; // truthy and finite, so the capture's own negative count stands (never the fallback)
  push('summary', data, undefined, summarizeProbe(data));
  // An explicit `{players: 0}` option reaches the same fallback (`pl` stays 0, which the last branch turns into 1).
  push('summary', data, { players: 0 }, summarizeProbe(data, { players: 0 }));
}
{
  // A fight that lasts EXACTLY one second over three samples: `/1000 >= minSeconds` keeps it at the boundary.
  const samples = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 500, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
  ];
  push('split', samples, [5000, 1], splitFights(samples));
  push('split', samples, [5000, 1.001], splitFights(samples, { gapMs: 5000, minSeconds: 1.001 }));
}
// A fight with a missing bar read: `hpOf` is null, which `hpOf(a) - hpOf(b)` coerces to 0 (never a made-up 1).
{
  const samples = capture({ seconds: 10 }).samples;
  samples[50].boss.hp = null;
  samples[51].boss.hp = undefined;
  push('fight', samples, {}, fightSummary(samples, {}));
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
// ── `fightSummary` numbers at the source's boundaries ───────────────────────────────────────────────────────────────
{
  const samples = capture({ seconds: 20 }).samples;
  // Gate fighters between 0 and 1 (JS keeps the fraction; the count is `players`).
  let withGate = samples.map((s) => ({ ...s, gate: { max: 1000, hp: 900, fighters: 0.5, phase: 1 } }));
  push('fight', withGate, { content: 'breach', level: 45, players: 3 }, fightSummary(withGate, { content: 'breach', level: 45, players: 3 }));
  // Stale gate hp ABOVE max: the landed total clamps to 0, never 1.
  withGate = samples.map((s) => ({ ...s, gate: { max: 1000, hp: 1100, fighters: 1, phase: 1 } }));
  push('fight', withGate, { content: 'breach', outcome: 'ended' }, fightSummary(withGate, { content: 'breach', outcome: 'ended' }));
  // Gate hp exactly at 0.5: not a kill (`<= 0` is false), so the fight ended.
  withGate = samples.map((s) => ({ ...s, gate: { max: 1000, hp: 0.5, fighters: 1, phase: 1 } }));
  push('fight', withGate, { content: 'breach' }, fightSummary(withGate, { content: 'breach' }));
  push('summary', { version: 1, level: 45, players: 1, samples: withGate }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples: withGate }));
  // A bar read at 95% (not mid-fight) and a tiny pre-join difference below 1 (max(0, diff) keeps the fraction).
  const join = samples.map((s) => ({ ...s, gate: { max: 10, hp: 9.4, fighters: 1, phase: 1 } }));
  push('fight', join, { content: 'breach', outcome: 'kill' }, fightSummary(join, { content: 'breach', outcome: 'kill' }));
  // Exactly 95% full is NOT a mid-fight join (`< 0.95`, not `<=`).
  const atFloor = samples.map((s) => ({ ...s, gate: { max: 1000, hp: 950, fighters: 1, phase: 1 } }));
  push('fight', atFloor, { content: 'breach', outcome: 'kill' }, fightSummary(atFloor, { content: 'breach', outcome: 'kill' }));
  // A first gate ABOVE its max is not mid-fight either: 1.2x max is still above the 0.95 bar (`* 0.95`, not `* 1.95`).
  const overMax = samples.map((s) => ({ ...s, gate: { max: 1000, hp: 1200, fighters: 1, phase: 1 } }));
  push('fight', overMax, { content: 'breach', outcome: 'kill' }, fightSummary(overMax, { content: 'breach', outcome: 'kill' }));
  // A boss "heal" of exactly zero adds exactly zero (`>` vs `>=`), and so does a DROP of 2825 (`>` vs `>=` must not
  // read a negative as a heal); a real heal still adds its size.
  const equal = samples.map((s) => ({ ...s, gate: { max: 1000, hp: 700, fighters: 1, phase: 1 } }));
  push('fight', equal, { content: 'breach', outcome: 'ended' }, fightSummary(equal, { content: 'breach', outcome: 'ended' }));
  const drop = equal.map((s) => ({ ...s, gate: { max: 1000, hp: 700, fighters: 1, phase: 1 } }));
  drop[40].gate = { max: 1000, hp: 700 - 2825, fighters: 1, phase: 1 };
  push('fight', drop, { content: 'breach', outcome: 'ended' }, fightSummary(drop, { content: 'breach', outcome: 'ended' }));
}

// `hp0`'s fallback: `fightSummary` only calls it on the first/last sample (guarded by `hp_of(...).is_some()`) and in
// the two loops, where a missing read must read 0. A made-up 1 moves the step and the immunity sum, so this pins it.
{
  // A hole in the middle: the first/last reads are present, so `barLost` still sums; the step loop reads the hole as 0.
  const samples = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 200, boss: { content: 'breach', name: 'The Warden', sub: '' } },
    { t: 300, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
    { t: 400, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 70 } },
  ];
  // Directly, because `splitFights` drops a hole before `summarizeProbe` can see it: `maxStepPct` still reports it.
  push('fight', samples, {}, fightSummary(samples, {}));
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
// ── `hp0`'s fallback through the step loop (the only place a missing read is not guarded) ──────────────────────────
{
  // A 0.5% read, then a missing one, then 0.9 s quiet: the real difference is +0.5 (a hit, so it ends the quiet run);
  // a made-up 1 for the missing read turns it into -0.5 (quiet), which changes the immunity figure.
  const samples = [];
  for (let i = 0; i < 9; i++) samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 10 } });
  samples.push({ t: 900, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0.5 } });
  samples.push({ t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '' } });
  for (let i = 11; i <= 20; i++) samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0.5 } });
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
// ── The immunity step boundaries ─────────────────────────────────────────────────────────────────────────────────
{
  // A 0.1 s tick that loses exactly 0.05: `dh > 0.05` is false at the exact f64 0.05, so the tick stays quiet and
  // does not record a step (a `>=` would record a 1.05 s step and move the median gap). The 0.25 values are exact.
  const hpAt = (i) => (i === 0 ? 10 : i === 10 ? 9.9 : i === 110 ? 0.05 : i >= 110 ? 0 : 9.9);
  const samples = [];
  for (let i = 0; i <= 130; i++) {
    samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: hpAt(i) } });
  }
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // A trailing quiet window EXACTLY at the 1.25 s floor: `quiet > immunityFloor` is false, so it adds nothing; a `>=`
  // would add the 0.75 s remainder. Ticks are 0.5/0.25 s so the sums are exact.
  const samples = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 500, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
    { t: 1500, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 70 } },
    { t: 2000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 60 } },
    { t: 2500, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 60 } },
    { t: 3000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 60 } },
    { t: 3250, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 60 } },
  ];
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // A trailing quiet window ABOVE the floor: `Math.max(0, quiet - gap)` keeps the measured remainder, never a 1.
  const samples = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 1100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
  ];
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // Six hits at 0.1/0.2/0.3/0.4/0.5/0.6 s, then a 0.9 s quiet tail: the median step is the LOWER middle value
  // (`len / 2` -> 0.4; a `len / 3` mutant reads 0.3), and the 0.9 s tail sits between the two floors.
  const hp = [100, 90, 80, 70, 60, 50, 40];
  const ts = [0, 100, 300, 600, 1000, 1500, 2100];
  const samples = hp.map((h, i) => ({ t: ts[i], boss: { content: 'breach', name: 'The Warden', sub: '', hp: h } }));
  for (let i = 1; i <= 9; i++) samples.push({ t: 2100 + i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 40 } });
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // A 0.2 s cadence (median 0.2, so the 0.5 s floor is the constant) with three quiet windows: 0.8 s (counted), 0.5 s
  // (exactly at the floor: `>` is false, `>=` would count it) and 0.6 s (contributes 0.4, never a made-up 1).
  const samples = [];
  let hp = 100;
  const quiet = (i) => (i >= 100 && i < 108) || (i >= 200 && i < 205) || (i >= 300 && i < 306);
  for (let i = 0; i <= 600; i++) {
    if (i > 0 && i % 2 === 0 && !quiet(i) && !quiet(i - 1)) hp = Math.max(0, hp - 0.4);
    samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp } });
  }
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
// ── Warded halves: a zero-hp half never counts (`>` vs `>=`), any positive hp does ─────────────────────────────────
for (const halfHp of [0, 0.5, 1]) {
  const samples = capture({ seconds: 10 }).samples;
  for (const s of samples) s.boss.halves = [{ name: 'Gold', hp: halfHp, state: 'Warded' }];
  push('fight', samples, { content: 'abyss' }, fightSummary(samples, { content: 'abyss' }));
}
// ── summarizeProbe's player fallback and the chart's level floor ───────────────────────────────────────────────────
{
  // `players` 0 and no levels: the fallback is 1, not 2 (the JS `|| levels.length || 1`).
  const data = capture({ seconds: 10 });
  data.players = 0;
  push('summary', data, undefined, summarizeProbe(data));
}
{
  // A chart level of 0 reads null (`Number(...) || null`), not 0.
  const chart = {
    table: [
      { name: 'A', level: 'Lv 0', damage: 10, share: '1%', blows: 1, best: 2 },
      { name: 'B', level: 'Lv 31', damage: 10, share: '1%', blows: 1, best: 2 },
    ],
  };
  push('charttop', chart, undefined, chartTop(chart));
}

// ── The last of the source comparisons: every `>=`/`<=`/`||` a capture can reach ───────────────────────────────────
{
  // `splitHp` is the gate's hp when the gate HAS one: a gate with hp 0 is a restart (`gate.truthy()`, not `&&`-flipped),
  // and `splitHp(sample) > 95` is strict (95 itself is not a restart).
  const viaGate = capture({ seconds: 20 }).samples;
  for (const s of viaGate) s.gate = { max: 100, hp: 50, fighters: 40, phase: 1 };
  viaGate[60].gate = { max: 100, hp: 0, fighters: 40, phase: 1 };
  viaGate[61].gate = { max: 100, hp: 96, fighters: 40, phase: 1 };
  for (let i = 62; i < viaGate.length; i++) viaGate[i].gate = { max: 100, hp: 96, fighters: 40, phase: 1 };
  push('split', viaGate, [5000, 1], splitFights(viaGate));
}
{
  // `splitFights` and the fight's own minimum: 4 samples spanning 1.05 s stays; a 3-sample fight spanning 0.9 s leaves.
  const long = capture({ seconds: 2 }).samples.slice(0, 5);
  push('split', long, [5000, 1], splitFights(long, { gapMs: 5000, minSeconds: 1 }));
  const shortFight = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 450, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 900, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
  ];
  push('split', shortFight, [5000, 1], splitFights(shortFight, { gapMs: 5000, minSeconds: 1 }));
  // 1e-9 seconds clamps: `seconds` of a two-sample capture at the same stamp is the floor, never 0 (a NaN dps).
  const same = [
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
  ];
  push('fight', same, { content: 'breach' }, fightSummary(same, { content: 'breach' }));
  push('split', same, [0, 0], splitFights(same, { gapMs: 0, minSeconds: 0 }));
}
{
  // The kill branch refill guard: a 96% gate is kill-ready; a gate hp of exactly 0.01 is NOT (`<= 0.01` vs `< 0.01`).
  const data = capture({ seconds: 10 });
  for (const s of data.samples) s.gate = { max: 100, hp: 96, fighters: 1, phase: 1 };
  push('summary', data, undefined, summarizeProbe(data));
  const floor = capture({ seconds: 10 });
  for (const s of floor.samples) s.gate = { max: 100, hp: 0.01, fighters: 1, phase: 1 };
  push('summary', floor, undefined, summarizeProbe(floor));
  // A gate hp of 5 also ends the fight (the `<= 0` guard is false), and damage is max - hp.
  const ended = capture({ seconds: 10 });
  for (const s of ended.samples) s.gate = { max: 100, hp: 5, fighters: 1, phase: 1 };
  push('summary', ended, undefined, summarizeProbe(ended));
  push('fight', ended.samples, { content: 'breach', gate: ended.samples[0].gate }, fightSummary(ended.samples, { content: 'breach', gate: ended.samples[0].gate }));
}
{
  // `maxHp` with a gate max of exactly 1 (kept, not dropped by a strict `>`), and no gate fighters read (< 1).
  const data = capture({ seconds: 10 });
  for (const s of data.samples) s.gate = { max: 1, hp: 0.5, fighters: 0.5, phase: 1 };
  push('summary', data, undefined, summarizeProbe(data));
  push('fight', data.samples, { content: 'breach' }, fightSummary(data.samples, { content: 'breach' }));
}
{
  // A level band at its EDGES: 1 and 60 are kept, 0 and 61 dropped, and 60.5 (above 60) dropped.
  const data = capture({ seconds: 10 });
  data.levels = [1, 60, 0, 61, 60.5];
  push('summary', data, undefined, summarizeProbe(data));
  // A capture with a missing level falls back to 45; `level: 0` is falsy and takes the same fallback.
  for (const level of [undefined, 0, 30]) push('summary', { version: 1, level, players: 1, samples: capture({ seconds: 5 }).samples }, undefined,
    summarizeProbe({ version: 1, level, players: 1, samples: capture({ seconds: 5 }).samples }));
}
{
  // `chartKill` from either phrase, and from neither: the "fallen -" arm alone (no "has fallen").
  for (const chart of [null, { sub: 'x' }, { sub: 'a has fallen' }, { title: 'fallen - 3' }, { text: 'HAS FALLEN' }]) {
    const data = capture({ seconds: 10 });
    data.chart = chart;
    data.outcome = 'ended';
    push('summary', data, undefined, summarizeProbe(data));
  }
}
{
  // The tenth chart row: `nums` fallback positions 4/5/6 (a `6 -> 7` would read a seventh slot).
  const chart = {
    table: [
      { name: 'A', damage: 10, best: 2, nums: [0, 0, 0, 0, 11, 22, 33] },
      { name: 'B', damage: 10, best: 2, crystals: 0, falls: 0, healed: 0, nums: [0, 0, 0, 0, 44, 55, 66] },
    ],
  };
  push('charttop', chart, undefined, chartTop(chart));
  // `chartTop` needs a damage OR a best; a table with only `damage` set qualifies, one with neither falls back.
  push('charttop', { table: [{ name: 'A', damage: 5 }] }, undefined, chartTop({ table: [{ name: 'A', damage: 5 }] }));
  push('charttop', { table: [{ name: 'A', best: 0 }] }, undefined, chartTop({ table: [{ name: 'A', best: 0 }] }));
  push('charttop', { table: [{ name: 'A', damage: null, best: null }], rows: [{ cls: 'wb-dmg-row' }, { cls: 'wb-dmg-name', text: 'R' }] }, undefined,
    chartTop({ table: [{ name: 'A', damage: null, best: null }], rows: [{ cls: 'wb-dmg-row' }, { cls: 'wb-dmg-name', text: 'R' }] }));
}
{
  // `first`/`fight[0]` is the fight's own first sample: a leading sample with no bar is dropped by `splitFights`, so the
  // fight's content and `seconds` come from the first SAMPLE, and a `0` index (`0 -> 1`) would read the wrong one.
  const samples = [
    { t: -1000, boss: { content: 'breach', name: 'Ghost', sub: '', hp: null } },
    ...capture({ seconds: 5, name: 'The Warden' }).samples,
  ];
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // `splitFights` is called with 5000 ms and 1 s from `summarizeProbe`: a 5000 ms gap is NOT a split (`>`, not `>=`),
  // a 5000.1 ms gap is.
  const atGap = (gapMs) => [
    ...capture({ seconds: 5 }).samples.map((s) => ({ ...s })),
    ...capture({ seconds: 5 }).samples.map((s) => ({ ...s, t: s.t + 5000 + gapMs })),
  ];
  push('summary', { version: 1, level: 45, players: 1, samples: atGap(0) }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples: atGap(0) }));
  push('summary', { version: 1, level: 45, players: 1, samples: atGap(1) }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples: atGap(1) }));
  push('summary', { version: 1, level: 45, players: 1, samples: atGap(5000) }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples: atGap(5000) }));
}
{
  // The median default step of an empty step list: 0.1 (`0.1 -> 1.1` would move the floor).
  const flat = capture({ seconds: 5 }).samples;
  for (const s of flat) s.boss.hp = 100;
  push('summary', { version: 1, level: 45, players: 1, samples: flat }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples: flat }));
  push('fight', flat, { content: 'breach' }, fightSummary(flat, { content: 'breach' }));
}
{
  // A step exactly at 0.05 (`<= 0.05` quiet, a `<` mutant would count it) after a hit, then resume: the quiet run's
  // end is read by both loops.
  const samples = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 10 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 9.95 } },
    { t: 900, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 9.95 } },
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 9.9 } },
  ];
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // `1 - 0.95` (not `1 - 1.95`) and a share above the clamp: a 2 s fight with no hits has a full quiet share, clamped.
  const samples = [];
  for (let i = 0; i <= 20; i++) samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 50 } });
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
  // A single quiet step of dt 100 s (`gapS` far past `seconds`) is still clamped to 0.95.
  const long = [{ t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 50 } },
    { t: 100_000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 50 } }];
  push('fight', long, { content: 'breach' }, fightSummary(long, { content: 'breach' }));
}

// ── Focused probes for the remaining split/kill/step comparisons ───────────────────────────────────────────────────
{
  // `splitHp` reads the gate's hp when the gate HAS one: a gate with no hp must fall back to the boss bar. The bar
  // restarts, so this is a split; a `&&`-flipped guard would read the gate's NaN and miss it.
  const samples = capture({ seconds: 20 }).samples;
  for (const s of samples) s.gate = { max: 100, fighters: 2, phase: 1 };
  for (let i = 100; i < 140; i++) samples[i].boss.hp = 0;
  for (let i = 140; i < samples.length; i++) samples[i].boss.hp = 100;
  push('split', samples, [5000, 1], splitFights(samples));
}
{
  // The restart band from both sides: prev 0.5 (not <= 0.01; a `<= 1.01` mutant splits) and prev 0.01 with the
  // refill B below 95.5 (a `> 96` mutant misses it). More fighters join, so `shareGrow` suppresses the refill.
  const above = capture({ seconds: 20 }).samples;
  for (const s of above) s.gate = { max: 100, hp: 0.5, fighters: 3, phase: 1 };
  for (let i = 100; i < above.length; i++) above[i].gate = { max: 100, hp: 96, fighters: 4, phase: 1 };
  push('split', above, [5000, 1], splitFights(above));
  const below = capture({ seconds: 20 }).samples;
  for (const s of below) s.gate = { max: 100, hp: 0.01, fighters: 3, phase: 1 };
  for (let i = 100; i < below.length; i++) below[i].gate = { max: 100, hp: 95.5, fighters: 4, phase: 1 };
  push('split', below, [5000, 1], splitFights(below));
}
{
  // `split_max` defaults when the gate has no max: 100 (not 101). A refill of exactly +5.02 clears `p + 5` but not
  // `p + 5.05`, and `>=` at exactly +5 clears neither/nor.
  const defaultMax = capture({ seconds: 20 }).samples;
  for (const s of defaultMax) s.gate = { hp: 90000, fighters: 2, phase: 1 };
  for (let i = 100; i < defaultMax.length; i++) defaultMax[i].gate = { hp: 90005.02, fighters: 2, phase: 1 };
  push('split', defaultMax, [5000, 1], splitFights(defaultMax));
  const exact = capture({ seconds: 20 }).samples;
  for (const s of exact) s.gate = { max: 100, hp: 90000, fighters: 2, phase: 1 };
  for (let i = 100; i < exact.length; i++) exact[i].gate = { max: 100, hp: 90005, fighters: 2, phase: 1 };
  push('split', exact, [5000, 1], splitFights(exact));
}
{
  // A 2-sample fight lasting a full second: `len > 2` drops it (a `>=` keeps it).
  const two = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
  ];
  push('split', two, [5000, 1], splitFights(two));
  // The duration is `last - first`, not `last + first`: 0.5 s here (2.5 s if added), so minSeconds 1 drops it.
  const uneven = [
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 1200, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 1500, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
  ];
  push('split', uneven, [5000, 1], splitFights(uneven));
}
{
  // A gate with `fighters: 0` reports null fighters (a `>= 0` mutant reports 0), and the fight's first sample (not the
  // second) sets `seconds`: t 0/100/1000 is 1.0 s, the second sample would make it 0.9 s.
  const data = capture({ seconds: 10 });
  for (const s of data.samples) s.gate = { max: 100, hp: 50, fighters: 0, phase: 1 };
  push('summary', data, undefined, summarizeProbe(data));
  const uneven = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 100 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 80 } },
  ];
  push('fight', uneven, { content: 'breach' }, fightSummary(uneven, { content: 'breach' }));
}
{
  // The kill branch, each arm alone: `fell` with a live bar, hp exactly 0, and a no-gate bar at exactly 0.01.
  const fell = capture({ seconds: 10 });
  for (const s of fell.samples) s.gate = { max: 100, hp: 50, fighters: 1, phase: 1, fell: true };
  push('summary', fell, undefined, summarizeProbe(fell));
  const zero = capture({ seconds: 10 });
  for (const s of zero.samples) s.gate = { max: 100, hp: 0, fighters: 1, phase: 1 };
  push('summary', zero, undefined, summarizeProbe(zero));
  const atFloor = capture({ seconds: 10 });
  for (let i = 0; i < atFloor.samples.length; i++) atFloor.samples[i].boss.hp = i === atFloor.samples.length - 1 ? 0.01 : 50;
  push('summary', atFloor, undefined, summarizeProbe(atFloor));
}
{
  // The first gate's max of 0 with a negative hp: `> 0` reads no gate (not mid-fight); `>= 0` reads one and the
  // negative bar is a join.
  const data = capture({ seconds: 10 });
  for (let i = 0; i < data.samples.length; i++) {
    data.samples[i].gate = i === 0 ? { max: 0, hp: -5, fighters: 1, phase: 1 } : { max: 0, hp: 0, fighters: 1, phase: 1 };
  }
  push('summary', data, undefined, summarizeProbe(data));
}
{
  // A 0.05 loss exactly: `<= 0.05` is quiet (a `< 0.05` mutant counts a hit), then a trailing quiet tail.
  const samples = [{ t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0.05 } },
    { t: 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0 } },
    { t: 200, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0 } }];
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // A trailing quiet window of exactly 0.5 s at a 0.125 s cadence: the floor is 0.5, so `> 0.5` adds nothing and a
  // `>=` mutant adds 0.375. Binary fractions keep every sum exact.
  const samples = [];
  let hp = 100;
  for (let i = 0; i <= 20; i++) {
    if (i < 12 && i > 0) hp = Math.max(0, hp - 1);
    samples.push({ t: i * 125, boss: { content: 'breach', name: 'The Warden', sub: '', hp } });
  }
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}

// ── The remaining exact boundaries, one per survivor ───────────────────────────────────────────────────────────────
{
  // Restart band: prev 0.01, current EXACTLY 95.0, more fighters join (so the refill is suppressed): `> 95` is false,
  // a `>=` mutant splits.
  const samples = capture({ seconds: 10 }).samples;
  for (let i = 0; i < samples.length; i++) {
    samples[i].gate = i < 50 ? { max: 100, hp: 0.01, fighters: 3, phase: 1 } : { max: 100, hp: 95, fighters: 4, phase: 1 };
  }
  push('split', samples, [5000, 1], splitFights(samples));
}
{
  // `kill` at gate hp 0 with NO gate max, over a bar that stops at half: the kill flag sets hpLost 100, a `< 0` mutant
  // falls through to the bar loss (50) - the outcome string is "kill" either way, so only hpLost shows it.
  const data = capture({ seconds: 10 });
  for (let i = 0; i < data.samples.length; i++) {
    data.samples[i].gate = { hp: 0, fighters: 1, phase: 1 };
    data.samples[i].boss.hp = Math.max(50, 100 - i);
  }
  push('summary', data, undefined, summarizeProbe(data));
  push('fight', data.samples, { content: 'breach' }, fightSummary(data.samples, { content: 'breach' }));
  // A no-gate bar at exactly 0.01 last reads a kill (`<= 0.01`); a `<` mutant reads 'ended'.
  const floor = capture({ seconds: 10 });
  for (let i = 0; i < floor.samples.length; i++) floor.samples[i].boss.hp = i === floor.samples.length - 1 ? 0.01 : 40;
  push('summary', floor, undefined, summarizeProbe(floor));
}
{
  // `barLost` needs BOTH ends read: with a missing first bar it is null (damage null), a `||` mutant makes it a zero.
  const samples = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: '' } },
    { t: 1000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 90 } },
    { t: 2000, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 70 } },
  ];
  push('fight', samples, { content: 'breach' }, fightSummary(samples, { content: 'breach' }));
  // `fight[0]` (not `fight[1]`): the first sample's t sets `seconds` and its name sets the label.
  const offset = [
    { t: 0, boss: { name: 'Ghost', sub: '' } },
    { t: 1000, boss: { content: 'breach', name: 'Real', sub: '', hp: 90 } },
    { t: 2000, boss: { content: 'breach', name: 'Real', sub: '', hp: 70 } },
  ];
  push('fight', offset, { content: 'breach' }, fightSummary(offset, { content: 'breach' }));
}
{
  // Ten ticks that each lose EXACTLY 0.05: `<= 0.05` makes them all quiet, a `<` mutant counts each as a hit and the
  // whole 3 s is not immunity at all.
  const samples = [{ t: 0, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0.05 } }];
  for (let i = 1; i <= 30; i++) samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp: 0 } });
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // Median step 0.1 -> floor 0.5, then a quiet stretch of EXACTLY 0.5 s followed by a hit: `quiet > floor` is false at
  // equality (a `>=` mutant adds the 0.4 s remainder).
  const samples = [];
  let hp = 100;
  for (let i = 0; i <= 8; i++) { samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp } }); hp -= 1; }
  for (let i = 9; i <= 13; i++) samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp } });
  for (let i = 14; i <= 20; i++) { samples.push({ t: i * 100, boss: { content: 'breach', name: 'The Warden', sub: '', hp } }); hp -= 1; }
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // `levels` is the player fallback only when the capture has no `players`: an out-of-range finite level (0) and the
  // EDGE 60 must be dropped/kept, and a `||` filter keeps finite 0 (`&&`/`||`, `60`/`61`).
  const data = capture({ seconds: 10 });
  data.players = undefined;
  data.levels = [1, 60, 0, 61, 60.5];
  push('summary', data, undefined, summarizeProbe(data));
}
{
  // `chartKill` arms, over a bar that never reaches 0: only the chart phrase can make this a kill (`||` vs `&&`).
  const samples = capture({ seconds: 10 }).samples.map((s, i) => ({ ...s, boss: { ...s.boss, hp: 100 - i * 0.1 } }));
  for (const chart of [{ sub: 'a has fallen' }, { title: 'fallen - 3' }, { sub: 'has fallen - 3' }]) {
    const data = { version: 1, level: 45, players: 1, samples, chart };
    push('summary', data, undefined, summarizeProbe(data));
  }
}
{
  // `summarizeProbe` passes a 5000 ms gap: samples 5000.5 ms apart split (a `5001` mutant does not). Nothing else may
  // split them - one name, a steady bar (never 0.01, never a +5% refill), and no gate - so this isolates the gap, and
  // both halves last the 1 s minimum.
  const run = (start, hp) => Array.from({ length: 21 }, (_, i) => ({
    t: start + i * 100,
    boss: { content: 'breach', name: 'The Warden', sub: '', hp: hp - i * 0.1 },
  }));
  const samples = [...run(0, 100), ...run(5000.5 + 2000, 90)];
  push('summary', { version: 1, level: 45, players: 1, samples }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples }));
}
{
  // `fight[0]` (not `fight[1]`): `seconds` reads `samples.first()` (unaffected), but `name`/`sub`/`content` read
  // `fight[0].boss`. A `0 -> 1` mutant must not be able to hide: the first sample's `sub` differs from the rest, and a
  // same-name run is one fight (only a name change splits).
  const labeled = [
    { t: 0, boss: { content: 'breach', name: 'The Warden', sub: 'phase one', hp: 100 } },
    { t: 2000, boss: { content: 'breach', name: 'The Warden', sub: 'phase two', hp: 90 } },
    { t: 4000, boss: { content: 'breach', name: 'The Warden', sub: 'phase two', hp: 80 } },
  ];
  // `summarizeProbe` replaces `content` from the name, so only a name that does NOT resolve lets `boss.get("content")`
  // show the index. Same name (no split), three samples, `content: 'auto'`: [0] says 'abyss', [1] 'breach'.
  const unnamed = [
    { t: 0, boss: { content: 'abyss', name: 'Unknown one', sub: 'a', hp: 100 } },
    { t: 1000, boss: { content: 'breach', name: 'Unknown one', sub: 'a', hp: 90 } },
    { t: 2000, boss: { content: 'breach', name: 'Unknown one', sub: 'a', hp: 80 } },
  ];
  push('summary', { version: 1, level: 45, players: 1, content: 'auto', samples: unnamed }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, content: 'auto', samples: unnamed }));
  push('summary', { version: 1, level: 45, players: 1, samples: labeled }, undefined,
    summarizeProbe({ version: 1, level: 45, players: 1, samples: labeled }));
  push('fight', labeled, { content: 'breach' }, fightSummary(labeled, { content: 'breach' }));
}

// ── chartTop / chartTotals / probeConstants / bossContent through the module ────────────────────────────────────────
const flatChart = {
  sub: 'Valkynaz Ruhn has fallen - 2 challengers',
  text: 'png',
  rows: [
    { cls: 'wb-dmg-row wb-dmg-head', text: '#' },
    { cls: 'wb-dmg-row', text: '1A' },
    { cls: 'wb-dmg-rank', text: '1' },
    { cls: 'wb-dmg-name', text: 'A' },
    { cls: 'wb-dmg-lv', text: 'Lv 31' },
    { cls: 'wb-dmg-damage wb-dmg-num', text: '10,000' },
    { cls: 'wb-dmg-share', text: '50%' },
    { cls: 'wb-dmg-blows', text: '120' },
    { cls: 'wb-dmg-best', text: '516' },
    { cls: 'wb-dmg-cx', text: '0' },
    { cls: 'wb-dmg-falls', text: '1' },
    { cls: 'wb-dmg-heal', text: '200' },
    { cls: 'wb-dmg-row', text: '2B' },
    { cls: 'wb-dmg-name', text: 'B' },
    { cls: 'wb-dmg-lv', text: 'Lv 9' },
    { cls: 'wb-dmg-damage', text: '2 500.5' },
    { cls: 'wb-dmg-blows', text: '-' },
    { cls: 'wb-dmg-best', text: '1.5k' },
  ],
};
push('charttop', flatChart, undefined, chartTop(flatChart));
push('charttotals', flatChart, undefined, chartTotals(flatChart));
push('charttop', { rows: [] }, undefined, chartTop({ rows: [] }));
push('charttop', null, undefined, chartTop(null));
push('charttop', { table: [] }, undefined, chartTop({ table: [] }));
push('charttop', { table: [{ name: 'A', best: '516', damage: 12000, nums: [1, 2, 3, 4, 5, 6] }] }, undefined,
  chartTop({ table: [{ name: 'A', best: '516', damage: 12000, nums: [1, 2, 3, 4, 5, 6] }] }));
push('charttop', {
  table: [
    { name: 'A', level: 'Lv 31', damage: 1234, share: '10%', blows: 20, best: 500 },
    { name: '', damage: 1 },
    { level: 9, damage: 'x' },
  ],
}, undefined, chartTop({
  table: [
    { name: 'A', level: 'Lv 31', damage: 1234, share: '10%', blows: 20, best: 500 },
    { name: '', damage: 1 },
    { level: 9, damage: 'x' },
  ],
}));
// A table without damage/best falls back to the rows.
push('charttop', { table: [{ name: 'ignored' }], rows: flatChart.rows }, undefined,
  chartTop({ table: [{ name: 'ignored' }], rows: flatChart.rows }));
push('charttotals', null, undefined, chartTotals(null));
push('charttotals', { rows: [{ cls: 'wb-dmg-name', text: 'A' }, { cls: 'wb-dmg-rank', text: '1' }] }, undefined,
  chartTotals({ rows: [{ cls: 'wb-dmg-name', text: 'A' }, { cls: 'wb-dmg-rank', text: '1' }] }));
push('charttotals', {}, undefined, chartTotals({}));
push('charttotals', { rows: [], text: 'chart.png' }, undefined, chartTotals({ rows: [], text: 'chart.png' }));
push('charttop', { rows: 'not an array' }, undefined, chartTop({ rows: 'not an array' }));

// ── bossContent and gateOutcome, the two public readers the summary calls ──────────────────────────────────────────
for (const name of ['', 'The Warden', 'Sky-ketch Warden', 'Abyss Remnant', 'Valkynaz Ruhn', null, 31, 0])
  for (const sub of ['', 'tonal steersman', 'level 45', null])
    push('content', [name, sub], undefined, bossContent(name, sub));
for (const gate of [null, undefined, {}, { fell: true }, { hp: 0 }, { hp: 1 }, { fell: false, hp: 40 }])
  for (const samples of [[], [{ boss: { hp: 0 } }], [{ boss: { hp: 40 } }, { boss: { hp: 0.01 } }], [{ boss: { hp: 40 } }]])
    push('outcome', { gate, samples }, undefined, gateOutcome(gate, samples));

for (const level of [1, 31, 45, 60, 0, 61, 45.7, null, '45', 'x', undefined]) {
  push('constants', level, undefined, probeConstants(level));
}

// `bossContent` and the summary's content choice over the whole name table.
for (const name of ['The Warden', 'Sky-ketch', 'Tonal Steersman', 'Abyss Remnant', 'Brass Clock', 'Valkynaz Ruhn',
  'Burning Champion', 'Rime Warden', 'Dagon', 'The Court', 'unknown foe']) {
  for (const sub of ['', 'level 45']) {
    const data = capture({ seconds: 5, name, content: 'ignored' });
    for (const s of data.samples) s.boss.sub = sub;
    push('summary', data, undefined, summarizeProbe(data));
  }
}
for (const name of ['Sky-ketch', 'Brass', 'Court champion', 'plain']) {
  const data = { version: 1, level: 45, players: 1, content: 'abyss', samples: capture({ seconds: 5, name, content: 'x' }).samples };
  push('summary', data, undefined, summarizeProbe(data));
  const auto = { ...data, content: 'auto' };
  push('summary', auto, undefined, summarizeProbe(auto));
}

// ── A fractional player count: `Array(count - known.length)` throws in the JS, so this is NOT a differential ───────
// The port applies its documented truncation instead; the cases prove the JS throw, which is what makes the port's
// answer a documented assumption rather than a port bug. They are deliberately absent from the `summary` family.
{
  const data = capture({ seconds: 10 });
  data.players = 2.5;
  data.levels = [45];
  let threw = false;
  try { summarizeProbe(data); } catch { threw = true; }
  if (!threw) throw new Error('fractional players: expected the JS RangeError this port documents');
}

// ── A refusal is not a capture: the JS `Error`'s own message ──────────────────────────────────────────────────────
const message = (fn) => {
  try { fn(); } catch (e) { return e.message; }
  throw new Error('expected a refusal');
};
push('refusal', { version: 2 }, undefined, message(() => summarizeProbe({ version: 2 })));
push('refusal', { version: '1' }, undefined, message(() => summarizeProbe({ version: '1' })));
push('refusal', null, undefined, message(() => summarizeProbe(null)));

// ── Number coercion: `isNum` reads a numeric STRING, and a non-numeric one drops the sample ────────────────────────
// Timestamps stay numbers: the JS `first.t + 5000` in the burst window CONCATENATES a string `t`, which is a
// whole-capture shape no probe build writes. `hp` and the levels are the coercion this exercises.
{
  const samples = capture({ seconds: 10 }).samples;
  for (const [i, s] of samples.entries()) {
    if (i % 7 === 0) s.boss.hp = String(s.boss.hp);
  }
  samples[5].boss.hp = 'abc';
  const data = { version: 1, level: '45', players: '2', samples };
  push('summary', data, undefined, summarizeProbe(data));
  push('split', samples, [5000, 1], splitFights(samples));
}

console.log(lines.join('\n'));
