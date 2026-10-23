// Reads the error and outcome counts in Analytics Engine: decklist_events (the page's
// reports, /api/event in index.mjs) and decklist_imports (worker/index.mjs). Shared by
// counts.mjs and health.mjs.

import { execFileSync } from 'node:child_process';

const ACCOUNT = 'f81e0f0d52bb815d2073e9e646641867';

// An API token that can read Account Analytics: CLOUDFLARE_ANALYTICS_TOKEN or
// CLOUDFLARE_API_TOKEN, or on a Mac the login Keychain's decklist-counts item, stored
// once with (security prompts for the token, so it stays out of shell history):
//
//   security add-generic-password -a "$USER" -s decklist-counts -w
export function analyticsToken() {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (token) return token;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'decklist-counts', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return '';
  }
}

// Runs a query and returns its rows, or throws with the API's message. A dataset
// nothing has written to yet doesn't exist, which reads as an error too.
export async function query(token, sql) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: sql + ' FORMAT JSON'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.trim().split('\n')[0]);
  return JSON.parse(text).data;
}

// Analytics Engine samples busy datasets; _sample_interval weights each row back up
export const SQL = {
  events: days => `SELECT blob1 AS event, blob2 AS code1, blob3 AS code2, blob4 AS code3, blob5 AS browser,
    blob6 AS device, SUM(_sample_interval) AS count FROM decklist_events
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY event, code1, code2, code3, browser, device ORDER BY count DESC LIMIT 1000`,
  imports: days => `SELECT blob1 AS source, blob2 AS outcome, blob3 AS detail, SUM(_sample_interval) AS count,
    quantileWeighted(0.5, double1, _sample_interval) AS median_ms FROM decklist_imports
    WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    GROUP BY source, outcome, detail ORDER BY count DESC LIMIT 1000`
};
