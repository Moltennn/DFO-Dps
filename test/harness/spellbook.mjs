/*
 * test/harness/spellbook.mjs - tests that need the game's standard spells.
 *
 * `standardSpells()` (src/spells.js) reads SPELLS.STD from the Daggerfall install named by the launcher config
 * (`arena2Path`). That file is the game's own data and is not part of this repository, so on a machine without the game
 * every Cast When Strikes price, spell card and sampled CWS fight is simply absent. A test that asserts one of those
 * takes `NEEDS_SPELLBOOK` as its options: it runs where the file exists and is reported as SKIPPED, with this reason,
 * where it does not - never as a confusing failure, and never silently passing.
 */
import { standardSpells } from '../../src/spells.js';

export const HAS_SPELLBOOK = standardSpells().size > 0;

export const NEEDS_SPELLBOOK = HAS_SPELLBOOK
  ? {}
  : { skip: "needs the game's SPELLS.STD (set arena2Path in the launcher config); it is not part of this repository" };
