// Prints the page's error and outcome counts and the import API's for the last few
// days, most common first. The token comes from analyticsToken() (analytics.mjs):
//
//   node hosting/counts.mjs [days]

import { analyticsToken, query, SQL } from './analytics.mjs';

const days = Math.max(1, Math.min(90, Number(process.argv[2]) || 7));
const token = analyticsToken();
if (!token) {
  console.error('Set CLOUDFLARE_API_TOKEN to a token with Account Analytics: Read, or store it in the Keychain:\n' +
    '  security add-generic-password -a "$USER" -s decklist-counts -w');
  process.exit(1);
}

for (const [title, sql] of [['Page events', SQL.events(days)], ['Imports', SQL.imports(days)]]) {
  console.log(`\n${title}, last ${days} day${days === 1 ? '' : 's'}`);
  try {
    const rows = await query(token, sql);
    if (!rows.length) console.log('  none');
    else console.table(rows);
  } catch (error) {
    console.log('  ' + error.message);
  }
}
