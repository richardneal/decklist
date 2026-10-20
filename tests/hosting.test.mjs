import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../hosting/index.mjs';

// The site Worker only sees paths that match no static file.
function run(path, method = 'GET') {
  return handle(new Request('https://decklist.app' + path, { method }));
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
  for (const path of ['/', '/missing.html', '/js/nothing.js', '/moxfield.com', '/evil.com/decks/1', '/httpsmoxfield.com/decks/1',
    '/notmoxfield.com/decks/1', '/ftp://moxfield.com/decks/1']) {
    assert.equal((await run(path)).status, 404, path);
  }
  assert.equal((await run('/https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv', 'POST')).status, 404);
  assert.equal((await run('/https://moxfield.com/decks/AbCdEfGhIjKlMnOpQrStUv', 'HEAD')).status, 302);
});
