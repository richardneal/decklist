// Drives the real page in headless Chromium: the format checks as a player sees
// them, the format's place in links and saved decks, and imports against a stubbed
// import Worker. Run with `npm test --prefix tests/browser`.
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

let server, browser, origin, page, pageErrors, importReply;

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
  page = await browser.newPage();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  importReply = { body: '4 Island', format: null };
  // Stay offline: serve the import API from the test, and drop everything else
  // that isn't the page itself (web fonts)
  await page.route(url => !url.href.startsWith(origin), route => {
    if (!route.request().url().startsWith(API)) return route.abort();
    return route.fulfill({ status: 200, body: importReply.body, headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Deck-Format',
      ...(importReply.format ? { 'X-Deck-Format': importReply.format } : {})
    } });
  });
  await open('/index.html');
});

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

test('an Arena export with a companion pasted into the main deck fills both sections', async () => {
  const arena = 'About\nName Burn\n\nCompanion\n1 Jegantha, the Wellspring (IKO) 222\n\n' +
    'Deck\n4 Lightning Bolt (2X2) 117\n1 Fire // Ice (MH2) 290 *F*\n55 Mountain (ANA) 1\n\n' +
    'Sideboard\n1 Jegantha, the Wellspring (IKO) 222\n2 Blood Moon (DMR) 123\n12 Mountain (ANA) 1';
  // No unrecognized cards, and a 15-card sideboard: the companion is counted once
  assert.deepEqual(await deck(arena), { label: 'Auto-detect (Legacy)', messages: [] });
  const sections = await page.evaluate(() => {
    const parsed = Decklist.parse();
    return [parsed.main, parsed.side].map(list => list.map(card => card.q + ' ' + card.n));
  });
  assert.deepEqual(sections, [['4 Lightning Bolt', '1 Fire // Ice', '55 Mountain'],
    ['1 Jegantha, the Wellspring', '2 Blood Moon', '12 Mountain']]);
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
