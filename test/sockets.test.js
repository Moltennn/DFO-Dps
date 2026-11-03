import test from 'node:test';
import assert from 'node:assert/strict';
import { theoryCharacter, theoryFists } from '../src/theory.js';
import { analyze, referenceFoe, weaponOf } from '../src/model.js';
import { perfectSockets, socketAffixes, socketCount } from '../src/sockets.js';

test('socket counts follow the weapon size', () => {
  assert.equal(socketCount(116), 1); // Shortsword
  assert.equal(socketCount(120), 2); // Longsword
  assert.equal(socketCount(123), 3); // Dai-katana
  assert.equal(socketCount(563), 2); // Hand Wraps
});

test('perfect diamond sockets are +12% damage each', () => {
  const ch = theoryCharacter({ damagePct: 40, sockets: perfectSockets(123) });
  const w = weaponOf(ch.weapon);
  assert.equal(w.damagePct, 40 + 36);
  assert.equal(socketAffixes(ch.weapon).length, 3);
  assert.equal(socketAffixes(ch.weapon)[0].value, 12);
});

test('Hand Wraps carry damage and sockets onto the fist blow', () => {
  const bare = theoryFists({ gearH2H: 510, gearCrit: 540 });
  const wrapped = theoryFists({ gearH2H: 510, gearCrit: 540, wraps: true });
  const target = referenceFoe(45, 'tough');
  const a = analyze(bare, { target, core: 'overhaul', rri: true });
  const b = analyze(wrapped, { target, core: 'overhaul', rri: true });
  assert.ok(wrapped.wraps);
  assert.ok(b.totalDps > a.totalDps);
  assert.ok(b.damage.avg > a.damage.avg);
});

test('dual wield adds the off hand at x0.8 and -5 hit', () => {
  const ch = theoryCharacter({ blade: 121, gearLB: 240, gearCS: 540, damagePct: 40, sockets: perfectSockets(121) });
  ch.offWeapon = { ...ch.weapon, equipSlot: 21 };
  const target = referenceFoe(45, 'tough');
  const single = analyze(ch, { target, core: 'overhaul', rri: true });
  const dual = analyze(ch, { target, core: 'overhaul', rri: true, dual: true });
  assert.ok(dual.dual);
  assert.ok(dual.dps > single.dps);
  assert.ok(dual.dps < single.dps * 2);
});
