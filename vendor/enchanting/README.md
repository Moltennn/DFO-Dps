# Enchanting data (vendored)

`itemTemplates.json` is the game's ItemTemplates table, copied from the same
`daggerfall-js-source` snapshot as the Firmament files. `src/enchantData.js`
carries the matching `ENCHANTMENT_COSTS` table and picker rules from
`systems/enchantmentCatalogue.js`; both are verbatim data, not a model guess.

`src/enchantPlan.js` reads `enchantmentPoints` from it and adds the stated
5,000 soul-gem channel when `dfo-dps enchant-plan --soul-gem` is used.
