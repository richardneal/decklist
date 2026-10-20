import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handle, countDeck, preview } from '../hosting/index.mjs';

// The front page, as the assets binding serves it
const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const env = {
  ASSETS: {
    fetch: request => new Response(request.method === 'HEAD' ? null : page, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(page.length), ETag: '"page"' }
    })
  }
};

// The site Worker sees the front page, and paths that match no static file.
function run(path, method = 'GET') {
  return handle(new Request('https://decklist.nealston.com' + path, { method }), env);
}

// The preview tags a page was served with
function tags(html) {
  return Object.fromEntries([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[a-z:]+)" content="([^"]*)">/g)]
    .map(([, name, content]) => [name, content]));
}

function permalink(params) {
  return '/?' + Object.entries(params).map(([key, value]) => key + '=' + encodeURIComponent(value).replace(/%20/g, '+')).join('&');
}

async function imported(path) {
  const response = await run(path);
  assert.equal(response.status, 302, path);
  const location = response.headers.get('Location');
  assert.match(location, /^\/\?deckimport=/);
  return new URL(location, 'https://decklist.nealston.com').searchParams.get('deckimport');
}

test('a deck link after the site address redirects to deckimport', async () => {
  assert.equal(await imported('/https://www.mtggoldfish.com/deck/6837920'), 'https://www.mtggoldfish.com/deck/6837920');
  assert.equal(await imported('/https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv'), 'https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(await imported('/http://archidekt.com/decks/123/atraxa'), 'http://archidekt.com/decks/123/atraxa');
  assert.equal(await imported('/https://scryfall.com/@jace/decks/0b5a2f43-6f1d-4c0a-9c36-0b1a4c0f1e2d'),
    'https://scryfall.com/@jace/decks/0b5a2f43-6f1d-4c0a-9c36-0b1a4c0f1e2d');
});

test("an MTGTop8 link keeps its query, which the redirect encodes", async () => {
  const response = await run('/https://www.mtgtop8.com/event?e=1&d=2&f=MO');
  assert.equal(response.headers.get('Location'), '/?deckimport=' + encodeURIComponent('https://www.mtgtop8.com/event?e=1&d=2&f=MO'));
});

test('the scheme is optional for the deck sites, and a merged // is restored', async () => {
  assert.equal(await imported('/moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv'), 'https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(await imported('/www.mtgtop8.com/event?e=1&d=2'), 'https://www.mtgtop8.com/event?e=1&d=2');
  assert.equal(await imported('/Archidekt.com/decks/123'), 'https://Archidekt.com/decks/123');
  assert.equal(await imported('/https:/moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv'), 'https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(await imported('/HTTPS:moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv'), 'HTTPS://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv');
});

test('an already encoded link is decoded once', async () => {
  assert.equal(await imported('/' + encodeURIComponent('https://www.mtgtop8.com/event?e=1&d=2&f=MO')),
    'https://www.mtgtop8.com/event?e=1&d=2&f=MO');
  assert.equal((await run('/https%3A%E0%A4%A')).status, 404);
});

test("another site's link still reaches the page, which explains what it supports", async () => {
  assert.equal(await imported('/https://tappedout.net/mtg-decks/burn/'), 'https://tappedout.net/mtg-decks/burn/');
});

test('other missing paths and methods are 404s', async () => {
  for (const path of ['/missing.html', '/js/nothing.js', '/moxfield.com', '/evil.com/decks/1', '/httpsmoxfield.com/decks/1',
    '/notmoxfield.com/decks/1', '/ftp://moxfield.com/decks/1']) {
    assert.equal((await run(path)).status, 404, path);
  }
  assert.equal((await run('/https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv', 'POST')).status, 404);
  assert.equal((await run('/https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv', 'HEAD')).status, 302);
});

test('the front page without a deck keeps its own preview', async () => {
  for (const path of ['/', '/?firstname=Jace', '/?deckimport=' + encodeURIComponent('https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv')]) {
    const response = await run(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('ETag'), '"page"', path);
    assert.equal(await response.text(), page, path);
  }
});

test("a deck permalink's preview names the deck, its format and its cards", async () => {
  const response = await run(permalink({
    firstname: 'Jace', lastname: 'Beleren', event: 'FNM at The Store', deckname: 'Murktide', deckformat: 'modern',
    deckmain: '4 Ragavan, Nimble Pilferer\n4 Murktide Regent\n4 Lightning Bolt\n48 Island',
    deckside: '2 Blood Moon\n13 Spell Pierce'
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('ETag'), null);
  assert.equal(response.headers.get('Content-Length'), null);
  const html = await response.text();
  const meta = tags(html);
  assert.equal(meta['og:title'], 'Murktide');
  assert.equal(meta['twitter:title'], 'Murktide');
  assert.equal(meta['og:description'],
    'Modern · 60 cards + 15 sideboard. 4 Ragavan, Nimble Pilferer · 4 Murktide Regent · 4 Lightning Bolt · 48 Island');
  assert.equal(meta['twitter:description'], meta['og:description']);
  assert.equal(meta['og:image'], 'https://decklist.nealston.com/images/og-image.png');
  // The player and the event stay out of the preview
  assert.doesNotMatch(html, /Jace|Beleren|The Store/);
});

test('a HEAD request for a permalink has no body', async () => {
  const response = await run(permalink({ deckname: 'Burn' }), 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('the preview escapes what the link holds', async () => {
  const html = await (await run(permalink({ deckname: '"><script>alert(1)</script>', deckmain: '4 <b>Bolt</b> & "Co"' }))).text();
  assert.doesNotMatch(html, /<script>alert|<b>Bolt/);
  const meta = tags(html);
  assert.equal(meta['og:title'], '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(meta['og:description'], '4 cards. 4 &lt;b&gt;Bolt&lt;/b&gt; &amp; &quot;Co&quot;');
});

test('a Commander deck counts and names its commander', () => {
  const main = Array.from({ length: 99 }, (_, i) => '1 Card ' + i).join('\n');
  assert.deepEqual(preview(new URLSearchParams({ deckformat: 'commander', deckmain: main, deckside: "1 Atraxa, Praetors' Voice" })), {
    title: 'Commander decklist',
    description: "Commander · 100 cards · Atraxa, Praetors' Voice. 1 Card 0 · 1 Card 1 · 1 Card 2 · 1 Card 3 · 1 Card 4 · 1 Card 5 · 1 Card 6 · 1 Card 7 · …"
  });
});

test('an unknown format is left out, and a long name is clipped', () => {
  const { title, description } = preview(new URLSearchParams({ deckname: 'x'.repeat(150), deckformat: 'toString', deckmain: '60 Island' }));
  assert.equal(title.length, 100);
  assert.match(title, /…$/);
  assert.equal(description, '60 cards. 60 Island');
});

test('a pasted export is counted as the page parses it', () => {
  // An Arena export: About block, headers, printings, a companion and a blank line
  assert.deepEqual(countDeck(
    'About\nName Lurrus Burn\n\nCompanion\n1 Lurrus of the Dream-Den (IKO) 226\n\nDeck\n4 Lightning Bolt (2X2) 117 *F*\n56 Mountain\n\nSideboard\n14 Smash to Smithereens\n\nMaybeboard\n3 Shock'
  ), {
    main: 60, side: 15,
    cards: [{ q: 4, n: 'Lightning Bolt' }, { q: 56, n: 'Mountain' }],
    leaders: ['Lurrus of the Dream-Den', 'Smash to Smithereens']
  });
  // A blank line after the main deck starts the sideboard, as do SB: lines; comments and 4x count
  const deck = countDeck('// Burn\n4x Lightning Bolt\nSB: 2 Blood Moon\nGoblin Guide\n\n3 Skullcrack', '1 Pyroblast');
  assert.equal(deck.main, 5);
  assert.equal(deck.side, 6);
});
