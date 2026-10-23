import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, probe, report, PROBES } from '../hosting/health.mjs';

// Rows as the SQL API returns them, with counts as strings
const event = (event, code1 = '', code2 = '', code3 = '', count = 1) =>
  ({ event, code1, code2, code3, browser: 'chrome', device: 'desktop', count: String(count) });
const imported = (source, outcome, count, detail = '') => ({ source, outcome, detail, count: String(count), median_ms: 100 });

test('a quiet day with working imports is all clear, and says how it went', () => {
  const { problems, notes } = assess(
    [event('download', 'modern:ok', '', '0', 8), event('download', 'legacy:error', 'banned', '3+', 2), event('badlink', 'tappedout.net', '', '', 3)],
    [imported('moxfield', 'ok', 9), imported('moxfield', 'cached', 1), imported('moxfield', 'limited', 4), imported('mtggoldfish', 'badrequest', 6)]);
  assert.deepEqual(problems, []);
  assert.deepEqual(notes, ['moxfield: 10 of 10 imports worked',
    '10 sheets downloaded, 2 with an error still on them, 2 with 3 or more unrecognized cards',
    "Links the importer couldn't read: tappedout.net 3"]);
});

test('a source failing often enough is flagged with its failures', () => {
  const { problems } = assess([], [imported('moxfield', 'upstream', 3, '403'), imported('moxfield', 'timeout', 1), imported('moxfield', 'ok', 6),
    imported('archidekt', 'invalid', 2, 'Archidekt did not return deck data.'), imported('archidekt', 'ok', 1),
    imported('mtggoldfish', 'upstream', 3, '500'), imported('mtggoldfish', 'ok', 30)]);
  // Archidekt has too few failures to count, and MTGGoldfish too small a share
  assert.deepEqual(problems, ['moxfield imports failed 4 of 10 times (3× upstream 403, 1× timeout)']);
});

test("the page's load failures, script errors, preview failures and failed imports are flagged past their limits", () => {
  const { problems } = assess([
    event('load', '/js/cards/decklist-cards-min.js', '', '', 3), event('load', '/js/jsPDF/jspdf-1.5.3.min.js', '', '', 2),
    event('error', '/js/decklist/main.js:10:5', 'TypeError: x is undefined', '', 2), event('error', '/js/decklist/main.js:10:5', 'TypeError: x is undefined', '', 1),
    event('preview', 'UnknownErrorException', 'Worker was destroyed', '', 1),
    event('import', 'scryfall', 'network', '', 5)
  ], []);
  assert.deepEqual(problems, ['/js/cards/decklist-cards-min.js failed to load 3 times',
    'Script error 3 times: /js/decklist/main.js:10:5 TypeError: x is undefined',
    'Imports failed in the browser 5 times: scryfall network']);
});

test('each probe deck is imported through the Worker as the site would, and a failure is reported', async () => {
  const calls = [];
  const problems = await probe(async (url, init) => {
    calls.push([url, init.headers.Origin]);
    if (url.includes('mtgtop8')) return new Response('The deck source returned HTTP 503.', { status: 502 });
    if (url.includes('archidekt')) return new Response('<html></html>');
    return new Response('4 Island\n\n2 Negate');
  });
  assert.equal(calls.length, PROBES.length);
  assert.ok(calls.every(([url, origin]) => url.startsWith('https://import.decklist.app/api/import?source=') && origin === 'https://decklist.app'));
  assert.deepEqual(problems, ['Importing the mtgtop8 test deck 902543 failed with HTTP 502: The deck source returned HTTP 503.',
    'The archidekt test deck 7031486 came back without a decklist.']);
});

test('the report leads with what needs a look', () => {
  assert.equal(report(['x failed'], ['y']), '## Needs a look\n- x failed\n\n### The last day\n- y\n');
  assert.equal(report([], []), '## All clear\n\n### The last day\n- Nothing counted\n');
});
