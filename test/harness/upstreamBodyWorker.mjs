/*
 * test/harness/upstreamBodyWorker.mjs - the oracle's own realm for foe bodies.
 *
 * Runs in a worker thread, so its module graph is a separate instance of the
 * vendored tree: nothing this project builds (src/) is loaded here, and the boot
 * below cannot leak into the realm the simulator runs in (the boot edits
 * ENEMY_BASICS in place and replaces the enemy equipment assigner).
 *
 * The realm boots as the client does at every load:
 *   scenes/shared.js:1518 installEnemyExpansion()   (full checkout; the vendored
 *   systems/enemyExpansion/dexInstall.js:183-224), reading the mods' own switches
 *   (systems/modSettings.js shipped defaults) - no argument is passed.
 * Then every body is upstream's own constructor:
 *   mint      characters/enemy/enemyEntity.js makeEnemyEntity
 *   standIn   world/gate/gateBoss.js bossStandIn
 *   loadout   combat/enemyEquipment.js equipmentVariantFor + assignEnemyStartingEquipment
 *             (the delegate the boot installed: dexInstall.js:246-247)
 * Answers are plain data (structured clone), never live objects.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';

const { SRC, PRNG } = workerData;
const load = (rel) => import(path.join(SRC, rel));

const enemyBasics = await load('characters/enemy/enemyBasics.js');
const enemyEntity = await load('characters/enemy/enemyEntity.js');
const enemyEquipment = await load('combat/enemyEquipment.js');
const gateBoss = await load('world/gate/gateBoss.js');
const dex = await load('systems/enemyExpansion/dexInstall.js');
const dexSwitches = await load('systems/enemyExpansion/dexSwitches.js');
const { generator } = await import(PRNG);

const installed = dex.installEnemyExpansion({ log: () => {} });
const CLASSIC = [...Array.from({ length: 43 }, (_, i) => i), ...Array.from({ length: 19 }, (_, i) => 128 + i)];
const boot = Object.freeze({
  loaded: installed.loaded,
  mudex: installed.mudex,
  dexLoaded: dexSwitches.dexLoaded() === true,
  mudexLoaded: dexSwitches.mudexLoaded() === true,
  // With DEX loaded, Meaner Monsters' row and the overhaul's edit stand aside (dexSwitches.js:28).
  meanerMonstersAlone: dexSwitches.meanerMonstersAlone(true),
  // The boot's combat doors that could touch a CLASSIC foe: the skeletal override (dexCombat.js
  // skeletal) and the group/language overrides, which read only the mod's own fifty (ids from 256).
  classicSkeletal: CLASSIC.filter((m) => dex.dexProperties(m)?.isSkeletal === true),
  customEnemyIds: dex.dexEnemyIds(),
});

const roller = (roll) => () => roll;

function answer(req) {
  const rows = enemyBasics.ENEMY_BASICS;
  switch (req.kind) {
    case 'mint':
      return enemyEntity.makeEnemyEntity(
        req.mobile, rows[req.mobile], req.career ?? null, req.playerLevel ?? 1,
        roller(req.roll ?? 0.5), { exactLevel: req.exactLevel === true },
      );
    case 'standIn':
      return gateBoss.bossStandIn({ mobile: req.mobile }, req.name ?? 'stand-in');
    case 'loadout': {
      const e = enemyEntity.makeEnemyEntity(req.mobile, rows[req.mobile], req.career ?? null, req.playerLevel ?? 1, roller(0.5));
      const r = generator(req.seed);
      const variant = enemyEquipment.equipmentVariantFor(e.careerIndex, e.isClass, r);
      if (variant == null) return { variant: null, armorValues: e.armorValues, pieces: [] };
      const eq = enemyEquipment.assignEnemyStartingEquipment(e, variant, req.playerLevel ?? 1, { rolls: r });
      return {
        variant,
        armorValues: eq.armorValues,
        pieces: eq.armorPieces.map((a) => ({ piece: a.piece, material: a.material, shield: a.shield === true })),
      };
    }
    default:
      throw new Error(`upstream body worker: unknown request kind ${req.kind}`);
  }
}

parentPort.on('message', ({ id, requests }) => {
  try {
    const bodies = requests.map((req) => structuredClone(answer(req)));
    parentPort.postMessage({ id, boot, bodies });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.stack ?? err) });
  }
});
