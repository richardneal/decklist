const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = vm.createContext({ URL, AbortSignal, $: () => {} });
vm.runInContext(fs.readFileSync('js/decklist/deckimport.js', 'utf8'), context);
const importer = context.DeckImport;

test('recognizes Goldfish and Top8 deck URLs and extracts the correct ID', () => {
  for (const url of ['https://www.mtggoldfish.com/deck/123#paper', 'https://mtggoldfish.com/deck/download/123', 'www.mtggoldfish.com/deck/123']) {
    assert.equal(importer.downloadURL(url), 'https://www.mtggoldfish.com/deck/download/123');
  }
  for (const url of ['https://mtgtop8.com/event?e=12&d=345&f=MO', 'https://www.mtgtop8.com/event?d=345&e=12']) {
    assert.equal(importer.downloadURL(url), 'https://www.mtgtop8.com/mtgo?d=345');
  }
});
test('rejects unrelated hosts, malformed URLs, and missing deck IDs', () => {
  for (const url of ['invalid', 'https://mtggoldfish.com.evil.test/deck/123', 'https://mtgtop8.com/event?e=123', 'https://mtggoldfish.com/deck/abc', 'ftp://mtggoldfish.com/deck/123']) {
    assert.equal(importer.downloadURL(url), null);
  }
});
test('splits LF and CRLF exports, sideboard headings and SB prefixes', () => {
  for (const text of ['4 Island\n\n2 Negate', '4 Island\r\n\r\n2 Negate', '4 Island\r\nSideboard\r\n2 Negate', '4 Island\nSB: 2 Negate']) {
    const deck = importer.split(text);
    assert.equal(deck.main, '4 Island');
    assert.equal(deck.side, '2 Negate');
  }
  assert.equal(importer.split('4 Island\n').side, '');
});
test('rejects empty downloads, HTML and proxy error text', () => {
  for (const text of ['', '<html>error</html>', 'Rate limit exceeded']) assert.throws(() => importer.split(text));
});
test('fetches through the dedicated API and reports HTTP errors', async () => {
  context.fetch = async (url) => {
    assert.equal(url, importer.apiURL + '?source=mtggoldfish&id=123');
    return { ok: true, text: async () => '4 Island\n\n2 Negate' };
  };
  assert.equal((await importer.load('https://mtggoldfish.com/deck/123')).side, '2 Negate');
  context.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(importer.load('https://mtgtop8.com/event?d=123'), /HTTP 503/);
  await assert.rejects(importer.load('invalid'), /valid.*URL/);
});

test('reads the deck format the Worker reports, or an MTGTop8 link names', async () => {
  const reply = format => async () => ({ ok: true, text: async () => '4 Island',
    headers: { get: name => name === 'X-Deck-Format' ? format : null } });
  context.fetch = reply('modern');
  assert.equal((await importer.load('https://archidekt.com/decks/123')).format, 'modern');
  for (const format of ['premodern', 'oldschool', 'duel', 'paupercommander', 'predh', 'oathbreaker']) {
    context.fetch = reply(format);
    assert.equal((await importer.load('https://archidekt.com/decks/123')).format, format);
  }
  context.fetch = reply('brawl');
  assert.equal((await importer.load('https://archidekt.com/decks/123')).format, '');
  context.fetch = reply(null);
  assert.equal((await importer.load('https://www.mtgtop8.com/event?e=1&d=2&f=PAU')).format, 'pauper');
  // MTGTop8's EDH is Duel Commander, and a code missing from mtgtop8Formats reports none
  assert.equal((await importer.load('https://www.mtgtop8.com/event?e=1&d=2&f=EDH')).format, 'duel');
  assert.equal((await importer.load('https://www.mtgtop8.com/event?e=1&d=2&f=PREM')).format, 'premodern');
  assert.equal((await importer.load('https://www.mtgtop8.com/event?e=1&d=2&f=cEDH')).format, '');
  assert.equal((await importer.load('https://mtggoldfish.com/deck/123')).format, '');
});

test('reads the deck name the Worker reports, and none from an older Worker', async () => {
  const reply = name => async () => ({ ok: true, text: async () => '4 Island',
    headers: { get: header => header === 'X-Deck-Name' ? name : null } });
  context.fetch = reply(encodeURIComponent(' Ætherflux \u201cReservoir\u201d '));
  assert.equal((await importer.load('https://archidekt.com/decks/123')).name, 'Ætherflux \u201cReservoir\u201d');
  // A malformed encoding is no name, and doesn't fail the import
  for (const name of [null, '', '%E0%A4%A']) {
    context.fetch = reply(name);
    const deck = await importer.load('https://archidekt.com/decks/123');
    assert.equal(deck.name, '');
    assert.equal(deck.main, '4 Island');
  }
  context.fetch = async () => ({ ok: true, text: async () => '4 Island' });
  assert.equal((await importer.load('https://mtggoldfish.com/deck/123')).name, '');
});

// Runs deckimport.js against a stand-in for the page's form fields.
function importerUI() {
  const elements = new Map();
  function $(selector) {
    if (typeof selector === 'function') { selector(); return; }
    if (typeof selector !== 'string') return selector;
    const ids = selector.split(',').map(id => id.trim());
    if (ids.length > 1) return { on(event, handler) { ids.forEach(id => $(id).on(event, handler)); return this; } };
    if (!elements.has(selector)) elements.set(selector, {
      value: '', properties: {}, handlers: {}, message: '', inputs: 0,
      val(value) { if (value === undefined) return this.value; this.value = value; return this; },
      prop(key, value) { if (value === undefined) return this.properties[key]; this.properties[key] = value; return this; },
      attr(key, value) { return this.prop(key, value); },
      text(value) { this.message = value; return this; },
      on(event, handler) { this.handlers[event] = handler; return this; },
      trigger(event) { if (event === 'input') this.inputs++; return this.handlers[event]?.call(this); }
    });
    return elements.get(selector);
  }
  // report.js runs for real, its beacons kept in `beacons`
  const beacons = [];
  const ui = vm.createContext({ URL, AbortSignal, $, Blob, JSON,
    window: { addEventListener() {} },
    location: { protocol: 'https:', href: 'https://decklist.app/', origin: 'https://decklist.app' },
    navigator: { sendBeacon: (url, blob) => beacons.push(blob) } });
  vm.runInContext(fs.readFileSync('js/decklist/report.js', 'utf8'), ui);
  vm.runInContext(fs.readFileSync('js/decklist/deckimport.js', 'utf8'), ui);
  // The reports sent so far, as [event, ...codes]
  const reports = async () => (await Promise.all(beacons.map(blob => blob.text())))
    .map(text => JSON.parse(text)).map(({ e, d }) => [e, ...d]);
  return { $, ui, reports };
}

test('names only known deck sites for a link the import cannot read', () => {
  assert.equal(importer.site('https://tappedout.net/mtg-decks/secret/'), 'tappedout.net');
  assert.equal(importer.site('www.deckstats.net/decks/1'), 'deckstats.net');
  assert.equal(importer.site('https://moxfield.com/decks/public'), 'moxfield.com');
  for (const value of ['https://jace.example/deck', 'not a link', '', 'https://tappedout.net.evil.test/']) {
    assert.equal(importer.site(value), 'other');
  }
});

test('reports a failed import by source and kind, and a link it cannot read by site', async () => {
  const { $, ui, reports } = importerUI();
  $('#deckimport').val('https://mtggoldfish.com/deck/123');
  ui.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await $('#deckimport-button').trigger('click');
  ui.fetch = async () => { throw new DOMException('timed out', 'TimeoutError'); };
  await $('#deckimport-button').trigger('click');
  $('#deckimport').val('https://moxfield.com/decks/abcdefghijklmnopqrstuv');
  ui.fetch = async () => ({ ok: false, status: 502, headers: new Map(), text: async () => '' });
  await $('#deckimport-button').trigger('click');
  $('#deckimport').val('https://tappedout.net/mtg-decks/my-secret-deck/');
  await $('#deckimport-button').trigger('click');
  // The same failure is reported once
  await $('#deckimport-button').trigger('click');
  assert.deepEqual(await reports(), [['import', 'mtggoldfish', 'network'], ['import', 'mtggoldfish', 'timeout'],
    ['import', 'moxfield', 'failed'], ['badlink', 'tappedout.net']]);
});

test('button updates textareas, refreshes the preview, and preserves edits during a request', async () => {
  const { $, ui } = importerUI();
  $('#deckimport').val('https://mtggoldfish.com/deck/123');
  $('#deckside').val('old sideboard');
  $('#deckformat').val('legacy');
  ui.fetch = async () => ({ ok: true, text: async () => '4 Island' });
  await $('#deckimport-button').trigger('click');
  assert.equal($('#deckmain').val(), '4 Island');
  // An import with no format of its own goes back to Auto-detect
  assert.equal($('#deckformat').val(), '');
  assert.equal($('#deckside').val(), '');
  assert.equal($('#deckside').inputs, 1);
  assert.equal($('#deckimport-button').prop('disabled'), false);
  $('#deckmain').val('2 Mountain').trigger('input');
  $('#deckside').val('1 Negate');
  $('#deckformat').val('vintage');
  await ui.DeckImport.importFromParameters({ deckimport: 'https://mtggoldfish.com/deck/123' });
  assert.match($('#deckimport-status').message, /Imported from MTGGoldfish: 4 main-deck cards and 0 sideboard cards/);
  assert.equal($('#deckside').inputs, 2);
  for (const params of [{}, { deckimport: '' },
    { deckimport: 'https://mtggoldfish.com/deck/123', deckmain: '2 Mountain' },
    { deckimport: 'https://mtggoldfish.com/deck/123', deckside: '' }]) {
    await ui.DeckImport.importFromParameters(params);
    assert.equal($('#deckside').inputs, 2);
  }
  assert.equal($('#deckimport-undo').prop('hidden'), false);
  await $('#deckimport-undo').trigger('click');
  assert.equal($('#deckmain').val(), '2 Mountain');
  assert.equal($('#deckside').val(), '1 Negate');
  assert.equal($('#deckformat').val(), 'vintage');
  assert.equal($('#deckimport-undo').prop('hidden'), true);
  await ui.DeckImport.importFromParameters({ deckimport: 'https://unrelated.example/deck/1' });
  assert.match($('#deckimport-status').message, /valid.*URL/);
  $('#deckimport').val('https://mtggoldfish.com/deck/123');
  let finish;
  ui.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = $('#deckimport-button').trigger('click');
  $('#deckmain').val('2 Mountain').trigger('input');
  finish({ ok: true, text: async () => '4 Island' });
  await pending;
  assert.equal($('#deckmain').val(), '2 Mountain');
  assert.match($('#deckimport-status').message, /cancelled/);
  ui.fetch = async () => { throw new Error('Network unavailable'); };
  await $('#deckimport-button').trigger('click');
  assert.equal($('#deckmain').val(), '2 Mountain');
  assert.match($('#deckimport-status').message, /Network unavailable/);
  assert.equal($('#deckimport-button').prop('disabled'), false);
});

const MOXFIELD_ID = 'psDQiUrXLkSfMEyEc3oDTw';

test('an import fills in the deck name, and undo restores the last one', async () => {
  const { $, ui } = importerUI();
  const named = name => async () => ({ ok: true, text: async () => '4 Island',
    headers: { get: header => header === 'X-Deck-Name' ? (name && encodeURIComponent(name)) : null } });
  $('#deckimport').val('https://moxfield.com/decks/' + MOXFIELD_ID);
  $('#deckname').val('My Brew');
  ui.fetch = named('Mono Blue \u201cTempo\u201d');
  await $('#deckimport-button').trigger('click');
  assert.equal($('#deckname').val(), 'Mono Blue \u201cTempo\u201d');
  await $('#deckimport-undo').trigger('click');
  assert.equal($('#deckname').val(), 'My Brew');
  // A deck with no name, from an older Worker or MTGTop8, leaves the field as it is,
  // and undo leaves it too
  ui.fetch = named(null);
  await $('#deckimport-button').trigger('click');
  assert.equal($('#deckname').val(), 'My Brew');
  await $('#deckimport-undo').trigger('click');
  assert.equal($('#deckname').val(), 'My Brew');
  // A name typed while the deck is on its way wins, and one typed after the import
  // survives its undo
  let finish;
  ui.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = $('#deckimport-button').trigger('click');
  $('#deckname').val('Typed While Waiting');
  await named('Source Name')().then(finish);
  await pending;
  assert.equal($('#deckmain').val(), '4 Island');
  assert.equal($('#deckname').val(), 'Typed While Waiting');
  ui.fetch = named('Source Name');
  await $('#deckimport-button').trigger('click');
  assert.equal($('#deckname').val(), 'Source Name');
  $('#deckname').val('Renamed');
  await $('#deckimport-undo').trigger('click');
  assert.equal($('#deckname').val(), 'Renamed');
  assert.equal($('#deckimport-undo').prop('hidden'), true);
});

test('recognizes Moxfield deck URLs, including a trailing primer segment', () => {
  for (const url of ['https://moxfield.com/decks/' + MOXFIELD_ID,
    'https://www.moxfield.com/decks/' + MOXFIELD_ID + '/',
    'https://www.moxfield.com/decks/' + MOXFIELD_ID + '/primer',
    'moxfield.com/decks/' + MOXFIELD_ID]) {
    assert.equal(importer.downloadURL(url), 'https://api2.moxfield.com/v3/decks/all/' + MOXFIELD_ID);
  }
  // Spread into this realm: the importer runs in a vm, so its prototype differs.
  assert.deepEqual({ ...importer.parse('https://moxfield.com/decks/' + MOXFIELD_ID) }, {
    source: 'moxfield', label: 'Moxfield', id: MOXFIELD_ID,
    url: 'https://api2.moxfield.com/v3/decks/all/' + MOXFIELD_ID
  });
});
test('rejects Moxfield routes and lookalike hosts that carry no deck ID', () => {
  for (const url of ['https://moxfield.com/decks/public', 'https://moxfield.com/decks/public?q=eyJ9',
    'https://moxfield.com/decks/', 'https://moxfield.com/', 'https://moxfield.com/users/someone',
    'https://moxfield.com/decks/' + MOXFIELD_ID + '/primer/extra',
    'https://moxfield.com.evil.test/decks/' + MOXFIELD_ID,
    'https://moxfield.com:8443/decks/' + MOXFIELD_ID]) {
    assert.equal(importer.downloadURL(url), null);
  }
});
test('asks the API for the Moxfield source and deck ID', async () => {
  context.fetch = async (url) => {
    assert.equal(url, importer.apiURL + '?source=moxfield&id=' + MOXFIELD_ID);
    return { ok: true, text: async () => '4 Island\nSideboard\n2 Negate' };
  };
  const deck = await importer.load('https://moxfield.com/decks/' + MOXFIELD_ID);
  assert.equal(deck.main, '4 Island');
  assert.equal(deck.side, '2 Negate');
});

test('recognizes Archidekt deck URLs, with or without the name slug', () => {
  for (const url of ['https://archidekt.com/decks/123456', 'https://archidekt.com/decks/123456/',
    'https://www.archidekt.com/decks/123456/my_deck_name', 'https://archidekt.com/decks/123456/my_deck_name#top',
    'archidekt.com/decks/123456/my_deck_name']) {
    assert.equal(importer.downloadURL(url), 'https://archidekt.com/api/decks/123456/');
  }
  assert.deepEqual({ ...importer.parse('https://archidekt.com/decks/123456/my_deck_name') }, {
    source: 'archidekt', label: 'Archidekt', id: '123456', url: 'https://archidekt.com/api/decks/123456/'
  });
});
test('rejects Archidekt pages and lookalike hosts that carry no deck ID', () => {
  for (const url of ['https://archidekt.com/', 'https://archidekt.com/decks/', 'https://archidekt.com/decks/abc',
    'https://archidekt.com/decks/0', 'https://archidekt.com/decks/123456/my_deck_name/extra',
    'https://archidekt.com/search/decks', 'https://archidekt.com/u/someone',
    'https://archidekt.com.evil.test/decks/123456', 'https://archidekt.com:8443/decks/123456']) {
    assert.equal(importer.downloadURL(url), null);
  }
});
test('asks the API for the Archidekt source and deck ID', async () => {
  context.fetch = async (url) => {
    assert.equal(url, importer.apiURL + '?source=archidekt&id=123456');
    return { ok: true, text: async () => '4 Island\nSideboard\n2 Negate' };
  };
  const deck = await importer.load('https://archidekt.com/decks/123456/my_deck_name');
  assert.equal(deck.main, '4 Island');
  assert.equal(deck.side, '2 Negate');
});

const SCRYFALL_ID = '5b088ae5-153e-48a9-8a38-b59c68fb5739';

test('recognizes Scryfall deck URLs and lowercases the deck ID', () => {
  for (const url of ['https://scryfall.com/@nyuu/decks/' + SCRYFALL_ID,
    'https://scryfall.com/@nyuu/decks/' + SCRYFALL_ID + '/?as=list&with=usd',
    'https://www.scryfall.com/@nyuu/decks/' + SCRYFALL_ID.toUpperCase(),
    'scryfall.com/@nyuu/decks/' + SCRYFALL_ID]) {
    assert.equal(importer.downloadURL(url), 'https://api.scryfall.com/decks/' + SCRYFALL_ID + '/export/json');
  }
  assert.equal(importer.parse('https://scryfall.com/@nyuu/decks/' + SCRYFALL_ID.toUpperCase()).id, SCRYFALL_ID);
});
test('rejects Scryfall pages that carry no deck ID', () => {
  for (const url of ['https://scryfall.com/', 'https://scryfall.com/decks', 'https://scryfall.com/@nyuu/decks',
    'https://scryfall.com/@nyuu/decks/' + SCRYFALL_ID + '/edit', 'https://scryfall.com/decks/' + SCRYFALL_ID,
    'https://scryfall.com/@nyuu/decks/not-a-uuid', 'https://scryfall.com/card/slp/2/ragavan-nimble-pilferer',
    'https://api.scryfall.com/decks/' + SCRYFALL_ID, 'https://scryfall.com.evil.test/@nyuu/decks/' + SCRYFALL_ID]) {
    assert.equal(importer.downloadURL(url), null);
  }
});
test('asks the API for the Scryfall source and deck ID', async () => {
  context.fetch = async (url) => {
    assert.equal(url, importer.apiURL + '?source=scryfall&id=' + SCRYFALL_ID);
    return { ok: true, text: async () => '4 Island\nSideboard\n2 Negate' };
  };
  assert.equal((await importer.load('https://scryfall.com/@nyuu/decks/' + SCRYFALL_ID)).side, '2 Negate');
});

test('reads a plain text deck file into the two deck boxes', () => {
  const deck = importer.fromFile('﻿4 Lightning Bolt\r\n56 Mountain\r\n\r\n2 Smash to Smithereens\r\n');
  assert.equal(deck.main, '4 Lightning Bolt\n56 Mountain');
  assert.equal(deck.side, '2 Smash to Smithereens');
  assert.equal(deck.name, '');
  assert.equal(deck.format, undefined);
});
test('keeps a deck file with headers whole for the parser, with its Arena name', () => {
  const text = 'About\nName Mono Red\n\nDeck\n4 Lightning Bolt (M10) 146\n\nSideboard\n2 Abrade';
  const deck = importer.fromFile(text);
  assert.equal(deck.main, text);
  assert.equal(deck.side, null);
  assert.equal(deck.name, 'Mono Red');
});
test('reads MTGO .dek files, merging printings', () => {
  const deck = importer.fromFile(`<?xml version="1.0" encoding="utf-8"?>
<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <NetDeckID>0</NetDeckID>
  <Cards CatID="1" Quantity="2" Sideboard="false" Name="Lightning Bolt" Annotation="0" />
  <Cards CatID="2" Quantity="2" Sideboard="false" Name="Lightning Bolt" Annotation="0" />
  <Cards CatID="3" Quantity="56" Sideboard="false" Name="Mountain" />
  <Cards Name="Kiki-Jiki, Mirror Breaker" Quantity="1" Sideboard="true" CatID="4" />
  <Cards CatID="5" Quantity="2" Sideboard="true" Name="Fire &amp; Ice" />
</Deck>`);
  assert.equal(deck.main, '4 Lightning Bolt\n56 Mountain');
  assert.equal(deck.side, '1 Kiki-Jiki, Mirror Breaker\n2 Fire & Ice');
});
test('reads Cockatrice .cod files and their deck name, dropping tokens', () => {
  const deck = importer.fromFile(`<?xml version="1.0" encoding="UTF-8"?>
<cockatrice_deck version="1">
  <deckname>Burn &amp; Turn</deckname>
  <comments></comments>
  <zone name="main">
    <card number="4" name="Lightning Bolt"/>
    <card number="56" name="Mountain"/>
  </zone>
  <zone name="side">
    <card number="2" name="Smash to Smithereens"/>
  </zone>
  <zone name="tokens">
    <card number="1" name="Goblin"/>
  </zone>
</cockatrice_deck>`);
  assert.equal(deck.main, '4 Lightning Bolt\n56 Mountain');
  assert.equal(deck.side, '2 Smash to Smithereens');
  assert.equal(deck.name, 'Burn & Turn');
});
test('rejects deck files that hold no decklist', () => {
  for (const text of ['', 'just some notes', '<html><body>4 Island</body></html>', 'PK\u0003\u0004\u0000', '<?xml version="1.0"?><Deck></Deck>']) {
    assert.throws(() => importer.fromFile(text), /decklist/);
  }
});
