#!/usr/bin/env node
import { main } from '../src/cli.js';
import { UsageError } from '../src/usageError.js';

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
