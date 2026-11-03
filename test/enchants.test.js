import test from 'node:test';
import assert from 'node:assert/strict';
import { theoryCharacter } from '../src/theory.js';
import { analyze, bossTarget } from '../src/model.js';
import { rebuildEnchantMods, strikeEnchantments, enchantDps, procsBeforeBreak } from '../src/enchants.js';

function weapon(over = {}) {
  const ch = theoryCharacter({});
  ch.weapon = {
    name: 'Test Sword', group: 'Weapons', templateIndex: 120, material: 9,
    maxCondition: 1000, currentCondition: 1000, equipSlot: 19,
    affixes: [{ id: 'damage', value: 35 }],
    enchantments: [{ type: 2, param: 25 }],
    ...over,
  };
  return ch;
}

test('EnhancesSkill is +15 per row, on top of the softcap', () => {
  const mods = rebuildEnchantMods([{ enchantments: [{ type: 10, param: 29 }, { type: 10, param: 29 }] }]);
  assert.equal(mods.skillMods[29], 30);
});

test('Cast When Strikes prices the spell and adds its DPS to the weapon', () => {
  const ch = weapon();
  const target = bossTarget({ level: 45, health: 12000, traits: [], group: 'daedra' });
  const strike = strikeEnchantments(ch.weapon, ch, target, { level: 45, potencyPct: 30 });
  assert.ok(strike.procDamage > 0);
  const e = enchantDps(ch.weapon, ch, target, { hit: 1, aps: 1, level: 45, potencyPct: 30 });
  assert.ok(e.dps > 0);
  const r = analyze(ch, { target, health: 12000, core: 'overhaul', rri: true, potencyPct: 30 });
  assert.ok(r.enchantDps > 0);
  assert.ok(r.totalDps > r.dps);
  assert.equal(r.procsBeforeBreak, 100);
});

test('Potent Vs is a flat +5 on the matching affinity only', () => {
  const ch = weapon({ enchantments: [{ type: 4, param: 1 }] });
  const daedra = bossTarget({ level: 45, health: 12000, group: 'daedra' });
  const undead = bossTarget({ level: 45, health: 12000, group: 'undead' });
  assert.equal(strikeEnchantments(ch.weapon, ch, daedra).flat, 5);
  assert.equal(strikeEnchantments(ch.weapon, ch, undead).flat, 0);
});

test('a weapon with no enchantments adds nothing', () => {
  const ch = weapon({ enchantments: [] });
  const r = analyze(ch, { target: bossTarget({ level: 45, health: 12000 }), health: 12000, core: 'overhaul', rri: true });
  assert.equal(r.enchantDps, 0);
  assert.equal(r.totalDps, r.dps);
});


test('a Cast When Strikes DoT is priced per tick, not as its whole duration every hit', () => {
  const ch = weapon({ enchantments: [{ type: 2, param: 33 }] }); // Wildfire
  const target = bossTarget({ level: 45, health: 12000, traits: [], group: 'daedra' });
  const strike = strikeEnchantments(ch.weapon, ch, target, { level: 45 });
  assert.equal(strike.procDamage, 0);
  assert.ok(strike.procDot > 0);
  const e = enchantDps(ch.weapon, ch, target, { hit: 1, aps: 1.4, level: 45 });
  assert.ok(e.dotDps > 0);
  assert.ok(e.dps < 100, `Wildfire DPS ${e.dps}`);
});
