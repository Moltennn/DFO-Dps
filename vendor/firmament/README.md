# Firmament tree data (vendored)

These two files are the game's own Firmament definition, copied verbatim from
the `daggerfall-js-source` snapshot used for the live-formula work:

- `firmamentTree.js` - the 518 stars, their positions, kinds, sectors and stats.
- `firmamentLaw.js` - the purses, channel caps and the `treeStats`/`blowPct` reads.

They are not modified. `src/firmament.js` imports them to plan star
allocations; `dfo-dps firmament` is the command.
