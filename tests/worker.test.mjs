import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/index.mjs';

function setup(options = {}) {
  const entries = new Map();
  const calls = [];
  const env = {
    ALLOWED_ORIGINS: 'https://nealston.com,https://richardneal.github.io',
    MOXFIELD_USER_AGENT: 'decklist-test/1.0',
    IMPORT_LIMITER: { limit: async () => ({ success: !options.limited }) }
  };
  const ctx = { waitUntil: promise => promise };
  const services = {
    cache: {
      match: async key => entries.get(key.url)?.clone(),
      put: async (key, value) => { entries.set(key.url, value.clone()); }
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.throws) throw new Error('Network failure');
      return new Response(options.body ?? '4 Island\n\n2 Negate', { status: options.status || 200 });
    }
  };
  return { calls, entries, run: (query = '?source=mtggoldfish&id=123', origin = 'https://nealston.com', method = 'GET') =>
    handle(new Request('https://deck-import.nealston.com/api/import' + query, {
      method, headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1' }
    }), env, ctx, services) };
}

test('fetches only fixed export endpoints and caches validated text', async () => {
  const s = setup();
  const first = await s.run();
  assert.equal(first.status, 200);
  assert.equal(await first.text(), '4 Island\n\n2 Negate');
  assert.equal(s.calls[0].url, 'https://www.mtggoldfish.com/deck/download/123');
  assert.equal(s.calls[0].init.redirect, 'manual');
  const cached = await s.run(undefined, 'https://richardneal.github.io');
  assert.equal(cached.headers.get('Access-Control-Allow-Origin'), 'https://richardneal.github.io');
  assert.equal(s.calls.length, 1);
  await s.run('?source=mtgtop8&id=456');
  assert.equal(s.calls[1].url, 'https://www.mtgtop8.com/mtgo?d=456');
});
test('rejects arbitrary targets, invalid IDs, origins, and methods before fetching', async () => {
  const s = setup();
  for (const query of ['?source=evil&id=123', '?source=mtgtop8&id=0', '?source=mtggoldfish&id=../123', '?url=https://example.com']) {
    assert.equal((await s.run(query)).status, 400);
  }
  const denied = await s.run(undefined, 'https://evil.example');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await s.run(undefined, undefined, 'POST')).status, 405);
  assert.equal((await s.run(undefined, undefined, 'OPTIONS')).status, 204);
  assert.equal(s.calls.length, 0);
});
test('rate limits imports without contacting the source', async () => {
  const s = setup({ limited: true });
  const response = await s.run();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(s.calls.length, 0);
});
test('does not cache source errors, HTML, oversized exports or network failures', async () => {
  for (const options of [{ status: 403 }, { body: '<html>challenge</html>' }, { body: '' },
    { body: '4 ' + 'a'.repeat(65536) }, { throws: true }]) {
    const s = setup(options);
    assert.equal((await s.run()).status, 502);
    assert.equal(s.entries.size, 0);
  }
});

const MOXFIELD_ID = 'psDQiUrXLkSfMEyEc3oDTw';
const MOXFIELD_JSON = JSON.stringify({ boards: {
  commanders: { cards: { a: { quantity: 1, card: { name: 'Atraxa, Praetors\u2019 Voice' } } } },
  mainboard: { cards: {
    b: { quantity: 2, card: { name: 'Swamp' } },
    c: { quantity: 2, card: { name: 'Swamp' } },
    d: { quantity: 4, card: { name: 'Thoughtseize' } },
    e: { quantity: 0, card: { name: 'Zero Copies' } },
    f: { quantity: 1 }
  } },
  sideboard: { cards: { g: { quantity: 3, card: { name: 'Negate' } } } },
  companions: { cards: { h: { quantity: 1, card: { name: 'Lurrus of the Dream-Den' } } } },
  maybeboard: { cards: { i: { quantity: 9, card: { name: 'Not In The Deck' } } } }
} });

test('converts Moxfield deck JSON and sends the allowlisted User-Agent', async () => {
  const s = setup({ body: MOXFIELD_JSON });
  const response = await s.run('?source=moxfield&id=' + MOXFIELD_ID);
  assert.equal(response.status, 200);
  // Commanders lead the main deck, printings of one card merge, and a companion
  // joins the sideboard; the maybeboard and zero-quantity entries are dropped.
  assert.equal(await response.text(), [
    '1 Atraxa, Praetors\u2019 Voice', '4 Swamp', '4 Thoughtseize',
    'Sideboard', '3 Negate', '1 Lurrus of the Dream-Den'
  ].join('\n'));
  assert.equal(s.calls[0].url, 'https://api2.moxfield.com/v3/decks/all/' + MOXFIELD_ID);
  assert.equal(s.calls[0].init.headers['User-Agent'], 'decklist-test/1.0');
  assert.equal(s.calls[0].init.headers.Accept, 'application/json');
});
test('omits the User-Agent for the text sources and when none is configured', async () => {
  const s = setup();
  await s.run();
  assert.equal(s.calls[0].init.headers['User-Agent'], undefined);
  assert.equal(s.calls[0].init.headers.Accept, 'text/plain');
});
test('rejects Moxfield route names and oversized IDs before fetching', async () => {
  const s = setup({ body: MOXFIELD_JSON });
  for (const id of ['public', 'short', '', 'a'.repeat(33), MOXFIELD_ID + '/primer']) {
    assert.equal((await s.run('?source=moxfield&id=' + encodeURIComponent(id))).status, 400);
  }
  assert.equal(s.calls.length, 0);
});
test('does not cache Moxfield responses that carry no usable deck', async () => {
  for (const body of ['not json', '{}', '{"boards":null}', '{"boards":{"mainboard":{"cards":{}}}}',
    JSON.stringify({ boards: { maybeboard: { cards: { a: { quantity: 1, card: { name: 'Island' } } } } } })]) {
    const s = setup({ body });
    assert.equal((await s.run('?source=moxfield&id=' + MOXFIELD_ID)).status, 502);
    assert.equal(s.entries.size, 0);
  }
});

test('accepts Moxfield JSON larger than the text-export cap, but not unbounded', async () => {
  // A real 60-card deck's JSON is about 140 KB: well past the 64 KB text cap.
  const padded = JSON.stringify({ note: 'x'.repeat(200 * 1024), ...JSON.parse(MOXFIELD_JSON) });
  assert.ok(padded.length > 64 * 1024);
  const big = setup({ body: padded });
  const response = await big.run('?source=moxfield&id=' + MOXFIELD_ID);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^1 Atraxa/);

  const huge = setup({ body: JSON.stringify({ note: 'x'.repeat(3 * 1024 * 1024) }) });
  assert.equal((await huge.run('?source=moxfield&id=' + MOXFIELD_ID)).status, 502);
  assert.equal(huge.entries.size, 0);
});
