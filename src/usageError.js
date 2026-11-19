/**
 * A command-line usage error: the caller's input is wrong, not the program.
 * The bin prints only the message and exits 2; anything else keeps its stack and exit 1.
 */
export class UsageError extends Error {
  name = 'UsageError';
}

// Input guards the libraries throw on purpose but as their own error type.
const USAGE_PATTERNS = [
  /^evaluateObjective\("[^"]*"\): (the target is a relay body|the target is not a relay body|a positive target health is required|the build cannot empty the pool|the relay fight does not terminate)/,
  /^(uncapped|cap) shortlist: choose /,
];

/** True for an error the CLI should report as bad input (exit 2), not as a crash (exit 1). */
export function isUsageFailure(e) {
  return e instanceof UsageError
    || e instanceof RangeError // the trial, seed, health and shortlist range guards
    || (typeof e?.message === 'string' && USAGE_PATTERNS.some((re) => re.test(e.message)));
}
