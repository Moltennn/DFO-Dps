/*
 * test/harness/spellbook.mjs - tests that need a spellbook.
 *
 * Importing this points `standardSpells()` at the synthetic book (tools/rust-synth-book.mjs), so these tests run on any
 * machine and never read the game's file. `DFO_REAL_SPELLS=1` is the opt-in local tier: the launcher's own SPELLS.STD,
 * with the tests reported as SKIPPED where it does not exist.
 */
import { standardSpells } from '../../src/spells.js';
import { realSpells, useSpellbook } from '../../tools/rust-synth-book.mjs';

useSpellbook();

export const NEEDS_SPELLBOOK = !realSpells() || standardSpells().size > 0
  ? {}
  : { skip: "DFO_REAL_SPELLS=1 needs the game's SPELLS.STD (set arena2Path in the launcher config)" };
