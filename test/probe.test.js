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
