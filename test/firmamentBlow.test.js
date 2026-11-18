import test from 'node:test';
import assert from 'node:assert/strict';
import * as modules from 'node:module';

test('ORACLE: live Firmament blows on a held weapon carry; a warded blow does not spend the carry', async () => {
  // Just the tree data edge is stubbed in the pin. Fill it with the game's separately vendored star catalog;
  // the real pinned law, live state and blow hook still run. Keep the redirect in this test file's process.
  const tree = new URL('../vendor/firmament/firmamentTree.js', import.meta.url).href;
  const law = new URL('../vendor/upstream/a3eb1605/src/net/firmament/firmamentLaw.js', import.meta.url).href;
  function resolve(specifier, context, next) {
    const { tree, law } = urls;
    return next(context.parentURL === law && specifier === './firmamentTree.js' ? tree : specifier, context);
  }
  const urls = { tree, law };
  const hook = modules.registerHooks?.({ resolve });
  if (!hook) {
    const source = `const urls = ${JSON.stringify(urls)}; export ${resolve.toString()}`;
    modules.register(`data:text/javascript,${encodeURIComponent(source)}`);
  }

  const { setFirmamentOnline, setFirmamentTree } = await import('../vendor/upstream/a3eb1605/src/systems/firmamentLive.js');
  const { firmamentBlow } = await import('../vendor/upstream/a3eb1605/src/systems/firmamentPowers.js');
  const { createCarryState, referenceFoe, weaponBlow, weaponOf } = await import('../src/model.js');
  const { buildById, planBuild } = await import('../src/firmament.js');
  const { applyFirmament } = await import('../src/realBuild.js');
  const { character, simCharacter, upstreamEntity, weapon } = await import('./harness/fixtures.mjs');
  const desc = character({ level: 30, raceId: 1, skills: 40 });
  const item = weapon(121, { material: 9 });
  const plan = planBuild(buildById('longblade'));
  const ch = applyFirmament(simCharacter(desc, item), plan);
  const w = weaponOf(item);
  const attacker = upstreamEntity(desc);
  const body = referenceFoe(30, 'tough');
  const bases = [102, 101, 101, 101];
  const targets = [body, { ...body, warded: true }, body, body];

  // firmamentPowers.js:79-81,111-115,172-181@a3eb1605: online tree, ward gate, held-item remainder.
  setFirmamentTree(plan.tree);
  setFirmamentOnline(true);
  try {
    const held = { ...item };
    const estimateItem = { ...item };
    const theirs = bases.map((b, i) => firmamentBlow(held, b, attacker, targets[i], {}));
    const estimates = bases.map((b, i) => firmamentBlow(estimateItem, b, attacker, targets[i], { estimate: true }));
    assert.deepEqual(theirs, [132, 101, 131, 132], 'the sky pays, the ward skips, and only the last share uses the carry');
    assert.deepEqual(estimates, [132, 101, 131, 131], 'estimates on a fresh item do not accumulate a remainder');
    const opts = { firmamentDamagePct: ch.firmamentDamagePct };
    const carry = { ...opts, carryState: createCarryState() };
    assert.deepEqual(bases.map((b, i) => weaponBlow(ch, w, b, targets[i], carry)), theirs);
    assert.deepEqual(bases.map((b, i) => weaponBlow(ch, w, b, targets[i], opts)), estimates);
  } finally {
    setFirmamentOnline(false);
    setFirmamentTree(null);
    hook?.deregister();
  }
});
