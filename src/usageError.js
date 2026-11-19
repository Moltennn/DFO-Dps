/**
 * A command-line usage error: the caller's input is wrong, not the program.
 * The bin prints only the message and exits 2; anything else keeps its stack and exit 1.
 */
export class UsageError extends Error {
  name = 'UsageError';
}
