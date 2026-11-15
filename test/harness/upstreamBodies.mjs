/*
 * test/harness/upstreamBodies.mjs - foe bodies the oracle builds for itself.
 *
 * Stage 2.8 (the stage record V1): an oracle that is handed the
 * local target's level, skills or armour can only agree with it. Every body here
 * is minted by upstream's own constructor, in its own module realm (a worker
 * thread, test/harness/upstreamBodyWorker.mjs), after the boot the client runs.
 * Nothing in this file reads src/: it takes a test's INPUTS (a mobile, a career,
 * a player level, the pieces to wear) and never a local target.
 *
 *   upstreamBodies(requests)  -> { boot, bodies }   one round trip to the realm
 *   oracleEntity(body)        -> a fresh deep copy to sample against
 *   upstreamWear(u, e, pieces)-> e wearing `pieces`, placed and armoured by upstream
 *   compareBody(local, body)  -> the fields where a local target and an upstream body differ
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { SRC } from './upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let _worker = null;
let _next = 0;
const _pending = new Map();

function realm() {
  if (_worker) return _worker;
  _worker = new Worker(path.join(HERE, 'upstreamBodyWorker.mjs'), {
    workerData: { SRC, PRNG: path.join(HERE, 'prng.mjs') },
    execArgv: [], // its own realm: no loader or flag of the parent's process
  });
  _worker.unref();
  _worker.on('message', ({ id, error, boot, bodies }) => {
    const p = _pending.get(id);
    if (!p) return;
    _pending.delete(id);
    if (!_pending.size) _worker.unref(); // idle: the realm does not keep a test process alive
    if (error) p.reject(new Error(error));
    else p.resolve({ boot, bodies });
  });
  _worker.on('error', (err) => {
    for (const p of _pending.values()) p.reject(err);
    _pending.clear();
  });
  return _worker;
}

/**
 * Bodies upstream mints in the booted realm. A request is one of
 *   { kind: 'mint', mobile, career?, playerLevel?, roll?, exactLevel? }  makeEnemyEntity
 *   { kind: 'standIn', mobile }                                         bossStandIn
 *   { kind: 'loadout', mobile, career?, playerLevel?, seed }            the booted equipment roll
 */
export function upstreamBodies(requests) {
  const id = _next++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    const w = realm();
    w.ref(); // a request in flight keeps the process waiting for its answer
    w.postMessage({ id, requests });
  });
}

/** One body (and the boot it was minted under). */
export async function upstreamBody(request) {
  const { boot, bodies } = await upstreamBodies([request]);
  return { boot, body: bodies[0] };
}

/** A fresh copy, so a sampled blow can never write into a body another case reads. */
export const oracleEntity = (body) => structuredClone(body);

/**
 * Wear `pieces` ({ templateIndex, material, condition }) on an upstream entity, as upstream does it:
 * the piece minted by combat/enemyEquipment.js armorOfMaterial, its condition the test's fraction of
 * its maximum, laid in the slot the entity's own table names (full checkout scenes/hostCombat.js:286-291
 * equipEnemy: `getEquipSlot`, first piece wins), and the struck-part ArmorValues from the game's own pass
 * (combat/enemyEquipment.js:298-325 enemyArmorValues over the entity's own `armor`). The entity's own
 * table - never a slot object a local target holds.
 */
export function upstreamWear(u, entity, pieces, { armorValues = true } = {}) {
  const slots = u.equip.equipTableOf(entity);
  const worn = [];
  for (const p of pieces) {
    const item = u.enemyEquipment.armorOfMaterial(Number(p.templateIndex), Number(p.material ?? 0));
    const max = item.maxCondition ?? 0;
    const c = Math.max(0, Math.min(1, Number(p.condition ?? 1)));
    item.currentCondition = Math.max(0, Math.min(max, Math.round(max * c)));
    const slot = u.equip.getEquipSlot(entity, item);
    if (slot === u.equip.EQUIP_SLOTS.None || slots[slot]) continue;
    slots[slot] = item;
    worn.push({ piece: item.templateIndex, material: item.material, ...(u.armorMaterials.isShieldTemplate(item.templateIndex) ? { shield: true } : {}) });
  }
  if (armorValues) entity.armorValues = u.enemyEquipment.enemyArmorValues({ isClass: !!entity.isClass, armor: entity.armor ?? 0 }, worn);
  entity.spareGear = true;
  return entity;
}

const STAT_KEYS = ['strength', 'intelligence', 'willpower', 'agility', 'endurance', 'personality', 'speed', 'luck'];

/**
 * The body fields a local target must share with an upstream body, compared one by one:
 * level, every skill (upstream holds one scalar), the seven ArmorValues, minMetalToHit, affinity,
 * career index, class flag, mobile and the eight stats. `{ combatLevel: true }` compares the
 * target's combat level (a boss's content level is its own field). Returns the differing fields.
 */
export function compareBody(local, body, { combatLevel = false } = {}) {
  const out = [];
  const diff = (field, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field, local: a, upstream: b });
  };
  diff(combatLevel ? 'combatLevel' : 'level', combatLevel ? local?.combatLevel : local?.level, body?.level);
  const skills = Array.isArray(body?.skills) ? body.skills : Array.from({ length: 35 }, () => body?.skills);
  diff('skills', Array.from({ length: 35 }, (_, i) => local?.skills?.[i]), skills);
  diff('armorValues', local?.armorValues, body?.armorValues);
  diff('minMetalToHit', local?.minMetalToHit, body?.minMetalToHit);
  diff('affinity', local?.affinity ?? null, body?.affinity ?? null);
  diff('careerIndex', local?.careerIndex, body?.careerIndex);
  diff('isClass', !!local?.isClass, !!body?.isClass);
  diff('mobileType', local?.mobileType, body?.mobileType);
  diff('stats', STAT_KEYS.map((k) => local?.stats?.[k]), STAT_KEYS.map((k) => body?.stats?.[k]));
  return out;
}
