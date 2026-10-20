// Drives the real page in headless Chromium: the format checks as a player sees
// them, the format's place in links and saved decks, the shared permalink, and
// imports against a stubbed import Worker. Run with `npm test --prefix tests/browser`.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const API = 'https://deck-import.nealston.com/api/import';

let server, browser, origin, page, pageErrors, importReply, outside;

before(async () => {
  server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    try {
      const body = await readFile(join(ROOT, path === '/' ? 'index.html' : path));
      response.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
    } catch (_) {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

beforeEach(async () => {
  pageErrors = [];
  importReply = { body: '4 Island', format: null };
  await newPage();
});

// Opens the generator in a fresh page made with the given browser context options.
// The page stays offline: the import API is served from the test, and everything
// else that isn't the page itself (web fonts) is dropped. Every outside request is
// logged in `outside`
async function newPage(options = {}, path = '/index.html') {
  page = await browser.newPage(options);
  outside = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route(url => !url.href.startsWith(origin), route => {
    outside.push(route.request().url());
    if (!route.request().url().startsWith(API)) return route.abort();
    return route.fulfill({ status: 200, body: importReply.body, headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Deck-Format',
      ...(importReply.format ? { 'X-Deck-Format': importReply.format } : {})
    } });
  });
  await open(path);
}

afterEach(async () => {
  await page.close();
  assert.deepEqual(pageErrors, []);
});

async function open(path) {
  await page.goto(origin + path);
  await page.waitForFunction(() => typeof cards !== 'undefined');
}

// Fills the deck and format, waits out the 400ms validation debounce, and returns
// the Auto-detect option's text with the deck messages from the status box. The
// player and event fields are filled, so their warnings stay out of the way.
async function deck(main, side = '', format = '') {
  await page.fill('#firstname', 'Jace');
  await page.fill('#lastname', 'Beleren');
  await page.fill('#event', 'Test Open');
  await page.fill('#eventdate', '2099-01-01');
  await page.fill('#eventlocation', 'Minneapolis');
  await page.fill('#deckmain', main);
  await page.fill('#deckside', side);
  await page.selectOption('#deckformat', format);
  await page.waitForTimeout(600);
  return {
    label: await page.$eval('#deckformat option[value=""]', option => option.textContent),
    messages: await page.$$eval('.status .details > li', items => items.map(item => item.innerText.trim()))
  };
}

const LEGACY = ['4 Brainstorm\n4 Force of Will\n52 Island', '15 Island'];
const COMMANDER = ['1 Sol Ring\n98 Island', "1 Atraxa, Praetors' Voice"];

test('auto-detect names the format it picked', async () => {
  assert.equal((await deck('')).label, 'Auto-detect');
  assert.equal((await deck(...LEGACY)).label, 'Auto-detect (Legacy)');
  assert.equal((await deck(...COMMANDER)).label, 'Auto-detect (Commander)');
  assert.equal((await deck('6 Grizzly Bears\n34 Forest')).label, 'Auto-detect (Limited)');
  assert.equal((await deck('4 Counterspell\n56 Island', '15 Island')).label, 'Auto-detect (Pauper)');
  // Choosing a format puts the plain label back
  assert.equal((await deck(...LEGACY, 'modern')).label, 'Auto-detect');
});

test('a deck auto-detect reads correctly has no deck messages', async () => {
  assert.deepEqual((await deck(...LEGACY)).messages, []);
  // No 60-card or 15-card warnings for a Commander or Limited deck
  assert.deepEqual((await deck(...COMMANDER)).messages, []);
  assert.deepEqual((await deck('6 Grizzly Bears\n34 Forest')).messages, []);
  assert.deepEqual((await deck('60 Island', '15 Island')).messages, []);
});

test('a 59-card deck is still a card short', async () => {
  const { label, messages } = await deck('4 Counterspell\n55 Island', '15 Island');
  assert.equal(label, 'Auto-detect (Pauper)');
  assert.deepEqual(messages, ['Decks may not consist of less than 60 cards']);
});

test('a chosen format lists its banned and restricted cards', async () => {
  assert.deepEqual((await deck(...LEGACY, 'modern')).messages,
    ['The following cards are not legal in Modern:\nBrainstorm\nForce of Will']);
  assert.deepEqual((await deck(...LEGACY, 'vintage')).messages,
    ['The following cards are restricted in Vintage, so a deck may hold only one copy:\nBrainstorm']);
});

test('each card over its copy limit shows its count and limit', async () => {
  assert.deepEqual((await deck('8 Seven Dwarves\n52 Mountain', '15 Mountain', 'modern')).messages,
    ['The following cards are over their copy limit:\nSeven Dwarves (8 copies; limit 7)']);
  assert.deepEqual((await deck('7 Seven Dwarves\n53 Mountain', '15 Mountain', 'modern')).messages, []);
  assert.deepEqual((await deck('5 Lightning Bolt\n55 Mountain', '15 Mountain')).messages,
    ['The following cards are over their copy limit:\nLightning Bolt (5 copies; limit 4)']);
});

test('a Commander deck is held to 100 singleton cards legal in Commander', async () => {
  assert.deepEqual((await deck('2 Sol Ring\n1 Dockside Extortionist\n96 Island', COMMANDER[1])).messages, [
    'The following cards are over their copy limit:\nSol Ring (2 copies; limit 1)',
    'The following cards are not legal in Commander:\nDockside Extortionist'
  ]);
  assert.deepEqual((await deck('1 Sol Ring\n97 Island', COMMANDER[1], 'commander')).messages,
    ['Commander decks consist of exactly 100 cards, counting the commander (this one has 99)']);
  assert.deepEqual((await deck("1 Atraxa, Praetors' Voice\n1 Sol Ring\n98 Island", '')).messages,
    ['List your commander in the sideboard']);
});

test('a Limited deck has no copy or sideboard limits', async () => {
  assert.deepEqual((await deck('6 Grizzly Bears\n34 Forest', '30 Lightning Bolt', 'limited')).messages, []);
  assert.deepEqual((await deck('6 Grizzly Bears\n33 Forest', '', 'limited')).messages,
    ['Decks may not consist of less than 40 cards']);
});

test('the format rides in the URL and falls back to Auto-detect when unknown', async () => {
  await deck(...LEGACY, 'modern');
  assert.equal(new URL(page.url()).searchParams.get('deckformat'), 'modern');
  await open('/index.html?deckformat=pauper&deckmain=4%20Counterspell%0A56%20Island');
  assert.equal(await page.inputValue('#deckformat'), 'pauper');
  await open('/index.html?deckformat=bogus&deckmain=4%20Counterspell%0A56%20Island');
  assert.equal(await page.inputValue('#deckformat'), '');
});

// The fields a permalink carries, as the page holds them
const fields = () => page.$$eval('#firstname, #lastname, #event, #eventdate, #eventlocation, #deckname, #deckdesigner, #deckformat, #deckmain, #deckside',
  inputs => Object.fromEntries(inputs.map(input => [input.id, input.value])));

test('Copy Permalink copies a link that reopens the deck, and sends it nowhere', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await deck("1 Sol Ring\n1 +2 Mace\n1 Fire // Ice\n96 Island", "1 Atraxa, Praetors' Voice", 'commander');
  await page.fill('#deckname', 'Atraxa & Friends 100%');
  const filled = await fields();
  const label = await page.inputValue('#permalink');
  outside.length = 0;
  await page.click('#permalink');
  await page.waitForFunction(() => document.querySelector('#permalink').value === 'Copied!');
  assert.deepEqual(outside, []);

  const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(link.origin, 'https://decklist.nealston.com');
  // The button puts its own label back
  await page.waitForFunction(label => document.querySelector('#permalink').value === label, label, { timeout: 5000 });

  // A fresh page, so nothing carries over but the link
  await page.close();
  await newPage({}, '/index.html' + link.search);
  assert.deepEqual(await fields(), filled);
});

test('links with %20 for spaces still open', async () => {
  await open('/index.html?deckname=Mono%20Blue&deckmain=4%20Counterspell%0A56%20Island');
  assert.equal(await page.inputValue('#deckname'), 'Mono Blue');
  assert.equal(await page.inputValue('#deckmain'), '4 Counterspell\n56 Island');
});

test('on a phone, Copy Permalink opens the share sheet with the same link', async () => {
  await page.close();
  await newPage({ hasTouch: true, isMobile: true });
  await page.evaluate(() => {
    navigator.share = async data => { window.shared = data; };
    navigator.clipboard.writeText = async () => { throw new Error('the clipboard was used'); };
  });
  await page.fill('#deckmain', '4 Counterspell\n56 Island');
  const label = await page.inputValue('#permalink');
  outside.length = 0;
  await page.click('#permalink');
  const shared = await page.waitForFunction(() => window.shared).then(handle => handle.jsonValue());
  assert.equal(shared.url, 'https://decklist.nealston.com/?deckmain=4+Counterspell%0A56+Island');
  assert.equal(await page.inputValue('#permalink'), label);
  assert.deepEqual(outside, []);
});

test('Save and Load keep the format, and Clear resets it', async () => {
  await deck(...LEGACY, 'legacy');
  await page.click('#saveDeck');
  await page.click('#clearDeck');
  assert.equal(await page.inputValue('#deckformat'), '');
  await page.click('#loadDeck');
  assert.equal(await page.inputValue('#deckformat'), 'legacy');
});

async function importDeck(link) {
  await page.fill('#deckimport', link);
  await page.click('#deckimport-button');
  await page.waitForSelector('#deckimport-status[data-state="success"]');
}

test('an import sets the format it reports, and undo restores the last one', async () => {
  await page.selectOption('#deckformat', 'legacy');
  importReply = { body: '1 Sol Ring\n98 Island\nSideboard\n1 Atraxa, Praetors’ Voice', format: 'commander' };
  await importDeck('https://archidekt.com/decks/123/atraxa');
  assert.equal(await page.inputValue('#deckformat'), 'commander');
  assert.equal(await page.inputValue('#deckside'), '1 Atraxa, Praetors’ Voice');
  await page.click('#deckimport-undo');
  assert.equal(await page.inputValue('#deckformat'), 'legacy');
});

test('an MTGTop8 link names its format, and a deck with none goes back to Auto-detect', async () => {
  importReply = { body: '4 Goblin Guide\n56 Mountain', format: null };
  await importDeck('https://www.mtgtop8.com/event?e=1&d=2&f=MO');
  assert.equal(await page.inputValue('#deckformat'), 'modern');
  await importDeck('https://www.mtggoldfish.com/deck/123');
  assert.equal(await page.inputValue('#deckformat'), '');
});

test('the preview renders a PDF', async () => {
  await deck(...COMMANDER);
  await page.waitForFunction(() => document.querySelector('#decklist')?.getAttribute('src')?.startsWith('data:application/pdf'),
    null, { timeout: 5000 });
});

test("a Commander deck's sideboard keeps the commander first on the sheet", async () => {
  importReply = { body: '1 Sol Ring\n96 Island\nSideboard\n1 Jace, Multiverse Architect\n1 Grizzly Bears\n1 Counterspell',
    format: 'commander' };
  await importDeck('https://moxfield.com/decks/y6-gAWsstnWUyIpXDf5SMQ');
  const sideboard = () => page.evaluate(() => sortSideboard(Decklist.parse()).map(card => card.n));
  assert.deepEqual(await sideboard(), ['Jace, Multiverse Architect', 'Grizzly Bears', 'Counterspell']);
  // Any other format sorts the sideboard as it does the main deck, by type by default
  await page.selectOption('#deckformat', 'constructed');
  assert.deepEqual(await sideboard(), ['Grizzly Bears', 'Counterspell', 'Jace, Multiverse Architect']);
});
