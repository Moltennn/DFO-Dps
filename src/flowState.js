/*
 * dfo-dps - the Flow stack clock (Stage 3.4).
 *
 * Source: systems/loot/lootPowers.js (a3eb1605) `_s.flow`/`_s.flowUntil` and `flowStacks` (:187-188, :274). Flow is
 * GLOBAL state, not per hand: a stack is read at the blow (`lootBlow` :316-318) and a whole landed blow refreshes the
 * stack (`lootStrike` :383-387): `flow = min(max, flowStacks(now)+1)`, `flowUntil = now + seconds`. `flowStacks` is
 * strict: a stack at exactly `flowUntil` is gone. There is no RNG and no damage here; the percentage is applied by the
 * existing `lootBlow` arm through `blowOutcomes`' `flowStacks` argument.
 */
export function createFlowState({ max = 5, seconds = 6, stacks = 0, until = 0 } = {}) {
  const cap = Math.max(0, Math.floor(Number(max) || 0));
  const duration = Math.max(0, Number(seconds) || 0);
  let held = Math.max(0, Math.min(cap, Math.floor(Number(stacks) || 0)));
  let expires = Number(until) || 0;

  /** The stacks a blow at `t` reads: `t < flowUntil`, never `<=`. */
  const stacksAt = (t) => (Number(t) < expires ? held : 0);

  /**
   * One strike listener's Flow arm. `whole` is `info.blow !== false`; `eligible` is the listener gate (damage > 0 and
   * the target not warded). A non-whole or ineligible blow neither builds nor refreshes.
   * @returns {{before:number, after:number, until:number, built:boolean}}
   */
  const hit = (t, { whole = true, eligible = true } = {}) => {
    const before = stacksAt(t);
    if (!eligible || !whole) return { before, after: before, until: expires, built: false };
    held = Math.min(cap, before + 1);
    expires = Number(t) + duration;
    return { before, after: held, until: expires, built: true };
  };

  const state = (t) => ({ stacks: stacksAt(t), held, until: expires, max: cap, seconds: duration });
  return {
    stacksAt,
    hit,
    state,
    get max() { return cap; },
    get seconds() { return duration; },
    get held() { return held; },
    get until() { return expires; },
  };
}
