import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/index.mjs';

function setup(options = {}) {
  const entries = new Map();
  const calls = [];
  const env = {
    ALLOWED_ORIGINS: 'https://decklist.app,https://nealston.com',
    MOXFIELD_USER_AGENT: 'decklist-test/1.0',
    USER_AGENT: 'decklist-generic/1.0',
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
  return { calls, entries, run: (query = '?source=mtggoldfish&id=123', origin = 'https://decklist.app', method = 'GET') =>
    handle(new Request('https://import.decklist.app/api/import' + query, {
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
  const cached = await s.run(undefined, 'https://nealston.com');
  assert.equal(cached.headers.get('Access-Control-Allow-Origin'), 'https://nealston.com');
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
const MOXFIELD_JSON = JSON.stringify({ format: 'commander', boards: {
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

test('reports the format of a JSON deck, from the cache too, and exposes it to the page', async () => {
  const s = setup({ body: MOXFIELD_JSON });
  for (let i = 0; i < 2; i++) {
    const response = await s.run('?source=moxfield&id=' + MOXFIELD_ID);
    assert.equal(response.headers.get('X-Deck-Format'), 'commander');
    assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-Deck-Format');
  }
  assert.equal(s.calls.length, 1);
  // Formats the page cannot check, and the text exports, report none
  const brawl = setup({ body: JSON.stringify({ ...JSON.parse(MOXFIELD_JSON), format: 'brawl' }) });
  assert.equal((await brawl.run('?source=moxfield&id=' + MOXFIELD_ID)).headers.get('X-Deck-Format'), null);
  assert.equal((await setup().run()).headers.get('X-Deck-Format'), null);
});

test('converts Moxfield deck JSON and sends the allowlisted User-Agent', async () => {
  const s = setup({ body: MOXFIELD_JSON });
  const response = await s.run('?source=moxfield&id=' + MOXFIELD_ID);
  assert.equal(response.status, 200);
  // Commanders lead the sideboard, printings of one card merge, and a companion
  // joins the sideboard; Moxfield's own sideboard is dropped, since Commander has none,
  // as are the maybeboard and zero-quantity entries.
  assert.equal(await response.text(), [
    '4 Swamp', '4 Thoughtseize',
    'Sideboard', '1 Atraxa, Praetors\u2019 Voice', '1 Lurrus of the Dream-Den'
  ].join('\n'));
  assert.equal(s.calls[0].url, 'https://api2.moxfield.com/v3/decks/all/' + MOXFIELD_ID);
  assert.equal(s.calls[0].init.headers['User-Agent'], 'decklist-test/1.0');
  assert.equal(s.calls[0].init.headers.Accept, 'application/json');
});
test('keeps the sideboard of a Moxfield deck with no commander', async () => {
  const { commanders, ...boards } = JSON.parse(MOXFIELD_JSON).boards;
  const s = setup({ body: JSON.stringify({ format: 'modern', boards }) });
  assert.equal(await (await s.run('?source=moxfield&id=' + MOXFIELD_ID)).text(), [
    '4 Swamp', '4 Thoughtseize', 'Sideboard', '3 Negate', '1 Lurrus of the Dream-Den'
  ].join('\n'));
});
test("puts a Moxfield Oathbreaker deck's signature spell in the sideboard after its Oathbreaker", async () => {
  const s = setup({ body: JSON.stringify({ format: 'oathbreaker', boards: {
    commanders: { cards: { a: { quantity: 1, card: { name: 'Chandra, Torch of Defiance' } } } },
    signatureSpells: { cards: { b: { quantity: 1, card: { name: 'Lightning Bolt' } } } },
    mainboard: { cards: { c: { quantity: 58, card: { name: 'Mountain' } } } },
    sideboard: { cards: { d: { quantity: 3, card: { name: 'Shock' } } } }
  } }) });
  const response = await s.run('?source=moxfield&id=' + MOXFIELD_ID);
  assert.equal(await response.text(), '58 Mountain\nSideboard\n1 Chandra, Torch of Defiance\n1 Lightning Bolt');
  assert.equal(response.headers.get('X-Deck-Format'), 'oathbreaker');
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
  assert.match(await response.text(), /^4 Swamp/);

  const huge = setup({ body: JSON.stringify({ note: 'x'.repeat(3 * 1024 * 1024) }) });
  assert.equal((await huge.run('?source=moxfield&id=' + MOXFIELD_ID)).status, 502);
  assert.equal(huge.entries.size, 0);
});

const ARCHIDEKT_JSON = JSON.stringify({
  deckFormat: 3,
  categories: [
    { name: 'Commander', isPremier: true, includedInDeck: true },
    { name: 'Ramp', isPremier: false, includedInDeck: true },
    { name: 'Sideboard', isPremier: false, includedInDeck: false },
    { name: 'Maybeboard', isPremier: false, includedInDeck: false },
    { name: 'Companion', isPremier: false, includedInDeck: false }
  ],
  cards: [
    { quantity: 1, categories: ['Companion'], card: { oracleCard: { name: 'Lurrus of the Dream-Den' } } },
    { quantity: 1, categories: ['Creature'], companion: true, card: { oracleCard: { name: 'Yorion, Sky Nomad' } } },
    { quantity: 2, categories: ['Ramp'], card: { oracleCard: { name: 'Swamp' } } },
    { quantity: 2, categories: null, card: { oracleCard: { name: 'Swamp' } } },
    { quantity: 1, categories: ['Commander'], card: { oracleCard: { name: 'Atraxa, Praetors’ Voice' } } },
    { quantity: 4, categories: ['Ramp', 'Maybeboard'], card: { oracleCard: { name: 'Thoughtseize' } } },
    { quantity: 3, categories: ['Sideboard'], card: { oracleCard: { name: 'Negate' } } },
    { quantity: 9, categories: ['Maybeboard', 'Ramp'], card: { oracleCard: { name: 'Not In The Deck' } } },
    { quantity: 0, categories: [], card: { oracleCard: { name: 'Zero Copies' } } },
    { quantity: 1, categories: [] }
  ]
});

test('converts Archidekt deck JSON, placing each card by its first category', async () => {
  const s = setup({ body: ARCHIDEKT_JSON });
  const response = await s.run('?source=archidekt&id=123456');
  assert.equal(response.status, 200);
  // The commander leads the sideboard, uncategorized cards are main deck, printings
  // merge, a card whose first category is excluded (the Maybeboard) is dropped, and a
  // companion joins the sideboard by flag or by category, even an excluded one. The
  // Sideboard category is dropped, since Commander has none.
  assert.equal(await response.text(), [
    '4 Swamp', '4 Thoughtseize',
    'Sideboard', '1 Atraxa, Praetors’ Voice', '1 Lurrus of the Dream-Den', '1 Yorion, Sky Nomad'
  ].join('\n'));
  assert.equal(response.headers.get('X-Deck-Format'), 'commander');
  assert.equal(s.calls[0].url, 'https://archidekt.com/api/decks/123456/');
  assert.equal(s.calls[0].init.headers.Accept, 'application/json');
  assert.equal(s.calls[0].init.headers['User-Agent'], undefined);
});
test('keeps the Sideboard category of an Archidekt deck with no commander', async () => {
  const deck = JSON.parse(ARCHIDEKT_JSON);
  deck.deckFormat = 2;
  deck.cards = deck.cards.filter(entry => entry.categories?.[0] !== 'Commander');
  const s = setup({ body: JSON.stringify(deck) });
  assert.equal(await (await s.run('?source=archidekt&id=123456')).text(), [
    '4 Swamp', '4 Thoughtseize',
    'Sideboard', '3 Negate', '1 Lurrus of the Dream-Den', '1 Yorion, Sky Nomad'
  ].join('\n'));
});
test('rejects malformed Archidekt IDs and decks with no usable cards', async () => {
  const s = setup({ body: ARCHIDEKT_JSON });
  for (const id of ['0', 'abc', '123/extra', '1'.repeat(13), '']) {
    assert.equal((await s.run('?source=archidekt&id=' + encodeURIComponent(id))).status, 400);
  }
  assert.equal(s.calls.length, 0);
  for (const body of ['not json', '{}', '{"cards":null}', '{"cards":[]}',
    JSON.stringify({ categories: [{ name: 'Maybeboard', includedInDeck: false }],
      cards: [{ quantity: 1, categories: ['Maybeboard'], card: { oracleCard: { name: 'Island' } } }] })]) {
    const bad = setup({ body });
    assert.equal((await bad.run('?source=archidekt&id=123456')).status, 502);
    assert.equal(bad.entries.size, 0);
  }
});

const SCRYFALL_ID = '5b088ae5-153e-48a9-8a38-b59c68fb5739';
const entry = (name, count) => ({ count, card_digest: { name } });

test('converts a constructed Scryfall deck and names itself to the API', async () => {
  const s = setup({ body: JSON.stringify({ format: 'pioneer', layout: 'constructed', entries: {
    mainboard: [entry('Island', 10), entry('Island', 7), entry('Spectral Sailor', 4), { count: 1, card_digest: null }],
    sideboard: [entry('Brazen Borrower // Petty Theft', 2)],
    maybeboard: [entry('Not In The Deck', 1)]
  } }) });
  const response = await s.run('?source=scryfall&id=' + SCRYFALL_ID);
  assert.equal(response.status, 200);
  // Printings merge, a blank entry Scryfall could not match is skipped, and the
  // maybeboard is dropped.
  assert.equal(await response.text(), '17 Island\n4 Spectral Sailor\nSideboard\n2 Brazen Borrower // Petty Theft');
  assert.equal(response.headers.get('X-Deck-Format'), 'pioneer');
  assert.equal(s.calls[0].url, 'https://api.scryfall.com/decks/' + SCRYFALL_ID + '/export/json');
  assert.equal(s.calls[0].init.headers.Accept, 'application/json');
  assert.equal(s.calls[0].init.headers['User-Agent'], 'decklist-generic/1.0');
});
test('puts a Scryfall commander and cards from outside the game in the sideboard', async () => {
  const s = setup({ body: JSON.stringify({ layout: 'commander', entries: {
    nonlands: [entry('Sol Ring', 1)], lands: [entry('Plains', 30)],
    commanders: [entry('Rin and Seri, Inseparable', 1)],
    outside: [entry('Kaheera, the Orphanguard', 1)], maybeboard: [entry('Not In The Deck', 9)]
  } }) });
  assert.equal(await (await s.run('?source=scryfall&id=' + SCRYFALL_ID)).text(),
    '1 Sol Ring\n30 Plains\nSideboard\n1 Rin and Seri, Inseparable\n1 Kaheera, the Orphanguard');
});
test("puts a Scryfall Oathbreaker deck's Oathbreaker and signature spell in the sideboard", async () => {
  const s = setup({ body: JSON.stringify({ format: 'oathbreaker', entries: {
    nonlands: [entry('Shock', 1)], lands: [entry('Mountain', 57)],
    oathbreakers: [entry('Chandra, Torch of Defiance', 1), entry('Lightning Bolt', 1)]
  } }) });
  const response = await s.run('?source=scryfall&id=' + SCRYFALL_ID);
  assert.equal(await response.text(), '1 Shock\n57 Mountain\nSideboard\n1 Chandra, Torch of Defiance\n1 Lightning Bolt');
  assert.equal(response.headers.get('X-Deck-Format'), 'oathbreaker');
});
test('rejects malformed Scryfall IDs and decks with no usable cards', async () => {
  const s = setup();
  for (const id of ['abc', SCRYFALL_ID.toUpperCase(), SCRYFALL_ID + '/export', SCRYFALL_ID.slice(1)]) {
    assert.equal((await s.run('?source=scryfall&id=' + encodeURIComponent(id))).status, 400);
  }
  assert.equal(s.calls.length, 0);
  for (const body of ['not json', '{}', '{"entries":null}', '{"entries":{"mainboard":[]}}',
    JSON.stringify({ entries: { maybeboard: [entry('Island', 1)] } })]) {
    const bad = setup({ body });
    assert.equal((await bad.run('?source=scryfall&id=' + SCRYFALL_ID)).status, 502);
    assert.equal(bad.entries.size, 0);
  }
});
test('reports the paper variants by the name each source gives them', async () => {
  const reported = async (source, id, deck) =>
    (await setup({ body: JSON.stringify(deck) }).run('?source=' + source + '&id=' + id)).headers.get('X-Deck-Format');
  const moxfield = { premodern: 'premodern', oldSchool: 'oldschool', duelCommander: 'duel',
    pauperEdh: 'paupercommander', predh: 'predh', oathbreaker: 'oathbreaker',
    duelCommanderRussian: null, pennyDreadful: null };
  for (const [name, format] of Object.entries(moxfield)) {
    assert.equal(await reported('moxfield', MOXFIELD_ID, { ...JSON.parse(MOXFIELD_JSON), format: name }), format, name);
  }
  // Archidekt's 11 is 1v1 Commander, which is not Duel Commander
  const archidekt = { 12: 'duel', 14: 'oathbreaker', 17: 'paupercommander', 22: 'premodern', 23: 'predh', 11: null };
  for (const [number, format] of Object.entries(archidekt)) {
    assert.equal(await reported('archidekt', '123456', { ...JSON.parse(ARCHIDEKT_JSON), deckFormat: Number(number) }), format, number);
  }
  for (const format of ['premodern', 'oldschool', 'duel', 'paupercommander', 'predh', 'oathbreaker']) {
    assert.equal(await reported('scryfall', SCRYFALL_ID, { format, entries: { mainboard: [entry('Island', 60)] } }), format);
  }
});
