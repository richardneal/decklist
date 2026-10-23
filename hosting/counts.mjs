// Prints the page's error and outcome counts (the decklist_events dataset, written by
// /api/event in index.mjs) and the import API's (decklist_imports, worker/index.mjs)
// for the last few days, most common first. Needs an API token that can read Account
// Analytics:
//
//   CLOUDFLARE_API_TOKEN=… node hosting/counts.mjs [days]

const ACCOUNT = 'f81e0f0d52bb815d2073e9e646641867';
const days = Math.max(1, Math.min(90, Number(process.argv[2]) || 7));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('Set CLOUDFLARE_API_TOKEN to a token with Account Analytics: Read.');
  process.exit(1);
}

// Analytics Engine samples busy datasets; _sample_interval weights each row back up
const QUERIES = {
  'Page events': `SELECT blob1 AS event, blob2 AS code1, blob3 AS code2, blob4 AS code3, blob5 AS browser,
    blob6 AS device, SUM(_sample_interval) AS count FROM decklist_events
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY event, code1, code2, code3, browser, device ORDER BY count DESC LIMIT 100`,
  'Imports': `SELECT blob1 AS source, blob2 AS outcome, blob3 AS detail, SUM(_sample_interval) AS count,
    quantileWeighted(0.5, double1, _sample_interval) AS median_ms FROM decklist_imports
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY source, outcome, detail ORDER BY count DESC LIMIT 100`
};

for (const [title, query] of Object.entries(QUERIES)) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: query + ' FORMAT JSON'
  });
  const text = await response.text();
  console.log(`\n${title}, last ${days} day${days === 1 ? '' : 's'}`);
  if (!response.ok) {
    // A dataset nothing has written to yet doesn't exist
    console.log('  ' + text.trim().split('\n')[0]);
    continue;
  }
  const rows = JSON.parse(text).data;
  if (!rows.length) console.log('  none');
  else console.table(rows);
}
