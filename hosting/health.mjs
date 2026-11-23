// The daily health check (.github/workflows/health-check.yml). It imports a known public
// deck from each source that serves the import Worker to a server (Moxfield turns
// automated clients away, and Scryfall has no public deck to find), then reads the last
// day's counts (analytics.mjs) and flags what crossed a threshold. It prints a Markdown
// report, adds it to the workflow's summary, and exits 1 when anything is wrong, so
// GitHub emails about the failed run.
//
//   node hosting/health.mjs

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { analyticsToken, query, SQL } from './analytics.mjs';

const API = 'https://import.decklist.app/api/import';

// Decks from tournaments, which their sites keep
export const PROBES = [
  { source: 'mtggoldfish', id: '6837920' },
  { source: 'mtgtop8', id: '902543' },
  { source: 'archidekt', id: '7031486' }
];

// Sites that put a Cloudflare challenge in front of every request, which only a browser
// can solve, so no import from them works until they lift it. MTGGoldfish has since
// November 2026. The check still imports their test deck, to see when that changes, but
// a challenge from one of these is a note rather than a problem, since nothing on our
// side gets past it. A challenge from any other site is still a problem.
export const CHALLENGED = new Set(['mtggoldfish']);

// How much of a kind of trouble in a day is worth a look. One-off failures happen
// (a phone loses signal halfway through the 2 MB card data), so each needs a few.
export const LIMITS = {
  // An import source's failures, which must also be at least this share of its tries
  importFailures: 3, importShare: 0.2,
  // The page's own reports, per kind
  load: 3, error: 3, preview: 3, clientImport: 5
};

// Imports each probe deck through the Worker as the site would. Returns {problems,
// notes}: a problem per deck that didn't come back as a decklist, and a note for a
// CHALLENGED site's deck, whether it was turned away or came back.
export async function probe(fetcher = fetch) {
  const problems = [], notes = [];
  for (const { source, id } of PROBES) {
    try {
      const response = await fetcher(`${API}?source=${source}&id=${id}`, {
        headers: { Origin: 'https://decklist.app' }, signal: AbortSignal.timeout(25000)
      });
      const text = await response.text();
      if (CHALLENGED.has(source) && response.headers.get('X-Deck-Error') === 'challenge') {
        notes.push(`${source} still turns imports away with a bot challenge`);
      } else if (CHALLENGED.has(source) && response.ok && /^\d+x?\s+\S/m.test(text)) {
        notes.push(`${source} imports work again: take it out of CHALLENGED in hosting/health.mjs`);
      } else if (!response.ok) problems.push(`Importing the ${source} test deck ${id} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
      else if (!/^\d+x?\s+\S/m.test(text)) problems.push(`The ${source} test deck ${id} came back without a decklist.`);
    } catch (error) {
      problems.push(`Importing the ${source} test deck ${id} failed: ${error.name} ${error.message}`);
    }
  }
  return { problems, notes };
}

// Weighs a day's counts (the rows SQL.events and SQL.imports return) against LIMITS.
// Returns {problems, notes}: what needs a look, and the day in brief.
export function assess(events, imports) {
  const problems = [], notes = [];
  const count = rows => rows.reduce((total, row) => total + Number(row.count), 0);
  // Rows grouped by a key, each group's rows summed
  const tally = (rows, key) => rows.reduce((groups, row) => {
    groups.set(key(row), (groups.get(key(row)) || 0) + Number(row.count));
    return groups;
  }, new Map());

  // Imports, by source: ok and cached are successes; a bad request or a rate limit is
  // the visitor's doing, not the source's, and a CHALLENGED site's challenge is noted
  const failed = ['upstream', 'timeout', 'invalid'];
  const challenged = row => CHALLENGED.has(row.source) && row.outcome === 'upstream' && row.detail === 'challenge';
  for (const source of new Set(imports.map(row => row.source))) {
    const turnedAway = count(imports.filter(row => row.source === source && challenged(row)));
    if (turnedAway) notes.push(`${source}: ${turnedAway} imports turned away by its bot challenge`);
    const rows = imports.filter(row => row.source === source && !challenged(row));
    const failures = count(rows.filter(row => failed.includes(row.outcome)));
    const tries = failures + count(rows.filter(row => row.outcome === 'ok' || row.outcome === 'cached'));
    if (tries) notes.push(`${source}: ${tries - failures} of ${tries} imports worked`);
    if (failures >= LIMITS.importFailures && failures / tries >= LIMITS.importShare) {
      const details = [...tally(rows.filter(row => failed.includes(row.outcome)), row => row.outcome + (row.detail ? ' ' + row.detail : ''))]
        .map(([detail, n]) => `${n}× ${detail}`).join(', ');
      problems.push(`${source} imports failed ${failures} of ${tries} times (${details})`);
    }
  }

  // The page's reports
  const kinds = (name, key) => tally(events.filter(row => row.event === name), key);
  for (const [path, n] of kinds('load', row => row.code1)) {
    if (n >= LIMITS.load) problems.push(`${path} failed to load ${n} times`);
  }
  for (const [error, n] of kinds('error', row => row.code1 + ' ' + row.code2)) {
    if (n >= LIMITS.error) problems.push(`Script error ${n} times: ${error}`);
  }
  for (const [error, n] of kinds('preview', row => row.code1 + ' ' + row.code2)) {
    if (n >= LIMITS.preview) problems.push(`The phone preview failed ${n} times: ${error}`);
  }
  for (const [kind, n] of kinds('import', row => row.code1 + ' ' + row.code2)) {
    // The Worker's counts above already note a CHALLENGED site's challenges
    const [source, why] = kind.split(' ');
    if (why === 'challenge' && CHALLENGED.has(source)) continue;
    if (n >= LIMITS.clientImport) problems.push(`Imports failed in the browser ${n} times: ${kind}`);
  }

  const downloads = events.filter(row => row.event === 'download');
  if (downloads.length) {
    const total = count(downloads);
    const withErrors = count(downloads.filter(row => row.code1.endsWith(':error')));
    const unrecognized = count(downloads.filter(row => row.code3 === '3+'));
    notes.push(`${total} sheets downloaded, ${withErrors} with an error still on them, ${unrecognized} with 3 or more unrecognized cards`);
  }
  const badlinks = [...kinds('badlink', row => row.code1)].map(([site, n]) => `${site} ${n}`);
  if (badlinks.length) notes.push(`Links the importer couldn't read: ${badlinks.join(', ')}`);
  return { problems, notes };
}

export function report(problems, notes) {
  return [
    problems.length ? '## Needs a look' : '## All clear',
    ...problems.map(problem => '- ' + problem),
    '',
    '### The last day',
    ...(notes.length ? notes.map(note => '- ' + note) : ['- Nothing counted']),
    ''
  ].join('\n');
}

async function main() {
  const { problems, notes } = await probe();
  const token = analyticsToken();
  if (!token) {
    problems.push('No analytics token: set CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read).');
  } else {
    // A dataset nothing wrote to in the window is missing rather than empty
    const rows = async sql => query(token, sql).catch(error => {
      if (/unknown dataset|does not exist|not found/i.test(error.message)) return [];
      throw error;
    });
    try {
      const day = assess(await rows(SQL.events(1)), await rows(SQL.imports(1)));
      problems.push(...day.problems);
      notes.push(...day.notes);
    } catch (error) {
      problems.push('Could not read the counts: ' + error.message);
    }
  }
  const text = report(problems, notes);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exitCode = problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
