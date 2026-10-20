import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync, crc32 } from 'node:zlib';
import { handle, countDeck, preview, imageDeck } from '../hosting/index.mjs';

// The assets binding: the front page, one other file, and a 404 for anything else
const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const env = {
  ASSETS: {
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/docs') return new Response('docs', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path !== '/') return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : page, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(page.length), ETag: '"page"' }
      });
    }
  }
};

function run(path, method = 'GET', host = 'decklist.app') {
  return handle(new Request('https://' + host + path, { method }), env);
}

test('www.decklist.app redirects to decklist.app, keeping the path and query', async () => {
  for (const path of ['/', '/docs', '/?deckmain=4+Lightning+Bolt&deckformat=modern']) {
    const response = await run(path, 'GET', 'www.decklist.app');
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get('Location'), 'https://decklist.app' + path);
  }
});

test('a static file is served as the assets binding returns it', async () => {
  const response = await run('/docs');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'docs');
});

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
  return new URL(location, 'https://decklist.app').searchParams.get('deckimport');
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
  // The image's query carries only what it draws, escaped for the attribute
  const image = new URL(meta['og:image'].replace(/&amp;/g, '&'));
  assert.equal(image.origin + image.pathname, 'https://decklist.app/preview.png');
  assert.deepEqual(Object.fromEntries(image.searchParams), {
    v: '1', name: 'Murktide', format: 'modern', main: '60', side: '15',
    cards: '4 Ragavan, Nimble Pilferer\n4 Murktide Regent\n4 Lightning Bolt\n48 Island'
  });
  assert.equal(meta['twitter:image'], meta['og:image']);
  assert.equal(meta['og:image:alt'], 'Decklist for Murktide');
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
  const { title, description, image } = preview(new URLSearchParams({ deckformat: 'commander', deckmain: main, deckside: "1 Atraxa, Praetors' Voice" }));
  assert.equal(title, 'Commander decklist');
  assert.equal(description, "Commander · 100 cards · Atraxa, Praetors' Voice. 1 Card 0 · 1 Card 1 · 1 Card 2 · 1 Card 3 · 1 Card 4 · 1 Card 5 · 1 Card 6 · 1 Card 7 · …");
  // The image lists the first 15 cards and says how many more there are
  const drawn = imageDeck(new URL(image, 'https://decklist.app').searchParams);
  assert.equal(drawn.summary, 'Commander · 100 cards');
  assert.deepEqual(drawn.leaders, ["Atraxa, Praetors' Voice"]);
  assert.equal(drawn.cards.length, 15);
  assert.equal(drawn.more, 84);
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

// The data of a PNG's chunk of a type, checking its CRC
function chunkData(png, type) {
  const view = new DataView(png.buffer, png.byteOffset);
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    if (String.fromCharCode(...png.subarray(at + 4, at + 8)) === type) {
      assert.equal(view.getUint32(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)) >>> 0, type + ' CRC');
      return png.subarray(at + 8, at + 8 + length);
    }
    at += 12 + length;
  }
  assert.fail('no ' + type + ' chunk');
}

// A PNG's width and height, from its IHDR chunk
function size(png) {
  const view = new DataView(png.buffer, png.byteOffset);
  return [view.getUint32(16), view.getUint32(20)];
}

test("a deck's preview image is a 1200×630 PNG", async () => {
  const { image } = preview(new URLSearchParams({ deckname: 'Mono-Red Burn', deckformat: 'modern', deckmain: '4 Lightning Bolt\n56 Mountain', deckside: '15 Smash to Smithereens' }));
  const response = await run(image);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  const png = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(size(png), [1200, 630]);
  // Node's zlib inflates the IDAT, checking the deflate stream and its Adler-32
  assert.equal(inflateSync(chunkData(png, 'IDAT')).length, (1200 + 1) * 630);
  assert.equal(chunkData(png, 'PLTE').length % 3, 0);
  assert.equal((await run(image, 'HEAD')).headers.get('Content-Type'), 'image/png');
});

test("an image's query is taken on no trust", async () => {
  const drawn = imageDeck(new URLSearchParams({
    name: 'x'.repeat(500), format: '__proto__', main: '-5', side: '123456',
    leaders: 'a\nb\nc\nd', cards: Array.from({ length: 40 }, () => '99999 Too many\n4 Bolt').join('\n')
  }));
  assert.equal(drawn.name.length, 150);
  assert.equal(drawn.format, '');
  assert.equal(drawn.summary, '0 cards + 9999 sideboard');
  assert.deepEqual(drawn.leaders, ['a', 'b', 'c']);
  assert.ok(drawn.cards.every(card => card.n === 'Bolt' && card.q === 4));
  assert.equal(drawn.more, 0);
  // Any text draws, in characters the font lacks too
  const png = new Uint8Array(await (await run('/preview.png?name=' + encodeURIComponent('Æther 日本 <b>') + '&cards=' + encodeURIComponent('4 Lim-Dûl\nnot a card'))).arrayBuffer());
  assert.deepEqual(size(png), [1200, 630]);
});
