/*
 * test/harness/relayEventSeam.mjs - the explicit test brand for the pre-sampled event path.
 *
 * `simulateRelayFight` refuses `events` unless this brand is present, so an ordinary scenario cannot accidentally
 * bypass the sampler/tier. Only the whole-compositor differential builds this object.
 */
export const relayEventArgs = (events) => ({ events, __relayEventsTest: true });
