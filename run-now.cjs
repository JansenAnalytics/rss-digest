'use strict';

/**
 * run-now.cjs — run digest immediately, ignoring seen_guids (for testing)
 *
 * Usage:
 *   node run-now.cjs           # fetch and send
 *   node run-now.cjs --dry-run # fetch, print, no send
 */

const { main } = require('./digest.cjs');

const dryRun = process.argv.includes('--dry-run');

main({ ignoreSeenGuids: true, dryRun })
  .then((result) => {
    if (!dryRun) {
      console.log('Done:', JSON.stringify(result));
    }
  })
  .catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
