import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFights, summarizeProbe } from '../src/probe.js';

function capture({ seconds = 60, gap = [0, 0], content = 'breach', halves = false } = {}) {
  const samples = [];
  const n = seconds * 10;
  let hp = 100;
  for (let i = 0; i <= n; i++) {
    const t = i * 100;
    const inGap = gap[1] > 0 && t >= gap[0] * 1000 && t < (gap[0] + gap[1]) * 1000;
    if (!inGap) hp = Math.max(0, 100 - (i / n) * 100);
    samples.push({
      t,
      wall: 1_700_000_000_000 + t,
      boss: {
        content,
        name: 'The Warden',
        sub: 'level 45',
        hp,
        warded: false,
        wrath: false,
        tags: [],
        halves: halves && i / n > 0.5 ? [{ name: 'Gold', hp, state: '' }, { name: 'Silver', hp, state: '' }] : [],
      },
    });
  }
  return { version: 1, build: 'test', level: 45, players: 1, startedAt: 0, endedAt: n * 100, samples, events: [], chart: null };
}

test('a clean 60 s capture reads 200 DPS, 1,000 burst and no immunity', () => {
  const s = summarizeProbe(capture());
  assert.equal(s.fights.length, 1);
  const f = s.fights[0];
  assert.equal(f.maxHp, 12000);
  assert.ok(Math.abs(f.damage - 12000) < 1, `damage ${f.damage}`);
  assert.ok(Math.abs(f.dps - 200) < 3, `dps ${f.dps}`);
  assert.ok(Math.abs(f.burst5 - 1000) < 30, `burst ${f.burst5}`);
  assert.ok(f.immunityShare < 0.02);
});

test('a five-second no-damage gap is read as immunity', () => {
  const f = summarizeProbe(capture({ gap: [25, 5] })).fights[0];
  assert.ok(f.immunityS > 4 && f.immunityS < 6, `gap ${f.immunityS}`);
  assert.ok(f.immunityShare > 0.07 && f.immunityShare < 0.11, `share ${f.immunityShare}`);
});

test('two pulls split into two fights', () => {
  const a = capture({ seconds: 20 });
  const b = capture({ seconds: 20 });
  const shift = 60_000;
  for (const s of b.samples) { s.t += shift; s.wall += shift; }
  const joined = { ...a, samples: [...a.samples, ...b.samples] };
  const s = summarizeProbe(joined);
  assert.equal(s.fights.length, 2);
});

test('the split halves are carried through', () => {
  const f = summarizeProbe(capture({ halves: true })).fights[0];
  assert.ok(f.halves.length > 0);
  assert.equal(f.halves[0].halves.length, 2);
});

test('a non-probe JSON is refused', () => {
  assert.throws(() => summarizeProbe({ version: 2 }), /Combat Probe/);
});

test('a slow weapon cadence is not mistaken for immunity', () => {
  const samples = [];
  let hp = 100;
  for (let i = 0; i <= 600; i++) {
    const t = i * 100;
    if (i > 0 && i % 10 === 0) hp = Math.max(0, hp - 100 / 60);
    samples.push({ t, boss: { content: 'breach', name: 'The Warden', sub: '', hp, tags: [], halves: [] } });
  }
  const f = summarizeProbe({ version: 1, level: 45, players: 1, samples }).fights[0];
  assert.ok(f.immunityS < 0.5, `gap ${f.immunityS}`);
});

test('per-player levels from the chart add their own share', () => {
  const data = capture();
  data.levels = [45, 45];
  data.players = 2;
  const f = summarizeProbe(data).fights[0];
  assert.equal(f.players, 2);
  assert.equal(f.maxHp, 24000);
  assert.ok(Math.abs(f.damage - 24000) < 1, `damage ${f.damage}`);
});

test('a top-10 chart fills the remaining players at the median level', () => {
  const data = capture();
  data.players = 49;
  data.levels = Array.from({ length: 10 }, () => 31);
  const f = summarizeProbe(data).fights[0];
  assert.equal(f.players, 49);
  assert.equal(f.levels.length, 10);
  assert.equal(f.levelFill, 31);
  assert.equal(f.maxHpEstimated, true);
  assert.equal(f.maxHp, 240 * 36 * 49);
});

test('the gate state makes the boss HP exact', () => {
  const data = capture({ seconds: 60 });
  for (const s of data.samples) s.gate = { max: 423360, fighters: 49, phase: 1 };
  data.players = 49;
  data.levels = Array.from({ length: 10 }, () => 31);
  const f = summarizeProbe(data).fights[0];
  assert.equal(f.maxHp, 423360);
  assert.equal(f.maxHpEstimated, false);
  assert.equal(f.players, 49);
});

test('the gate state also gives the exact landed total', () => {
  const data = capture({ seconds: 86 });
  for (const s of data.samples) s.gate = { max: 45300, hp: 1183, fighters: 6, phase: 3 };
  data.players = 6;
  data.levels = Array.from({ length: 6 }, () => 31);
  const f = summarizeProbe(data).fights[0];
  assert.equal(f.maxHp, 45300);
  assert.equal(f.damage, 44117);
  assert.equal(f.maxHpEstimated, false);
  assert.equal(f.outcome, 'ended');
});

test('a chart that says fallen overrides stale gate hp and makes the damage the whole pool', () => {
  const data = capture({ seconds: 86 });
  data.players = 6;
  data.levels = Array.from({ length: 6 }, () => 31);
  for (const s of data.samples) s.gate = { max: 45300, hp: 1183, fighters: 6, phase: 3 };
  data.chart = { sub: 'Valkynaz Ruhn has fallen - 6 challengers', rows: [] };
  const f = summarizeProbe(data).fights[0];
  assert.equal(f.damage, 45300);
  assert.equal(f.outcome, 'kill');
  assert.equal(f.maxHpEstimated, false);
});

test('the flat chart rows give best and blows', () => {
  const data = capture({ seconds: 60 });
  data.chart = {
    sub: 'Valkynaz Ruhn has fallen - 2 challengers',
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
  const top = summarizeProbe(data).fights[0].chartTop;
  assert.equal(top[0].name, 'A');
  assert.equal(top[0].best, 516);
  assert.equal(top[0].blows, 120);
  assert.equal(top[0].falls, 1);
  assert.equal(top[0].healed, 200);
});
