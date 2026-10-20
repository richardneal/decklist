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
const API = 'https://import.decklist.app/api/import';

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
  importReply = { body: '4 Island', format: null, name: null };
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
      'Access-Control-Expose-Headers': 'X-Deck-Format, X-Deck-Name',
      ...(importReply.format ? { 'X-Deck-Format': importReply.format } : {}),
      ...(importReply.name ? { 'X-Deck-Name': encodeURIComponent(importReply.name) } : {})
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
  assert.equal(await page.innerText('.status.valid .statusmark'), 'Ready to print');
  // No 60-card or 15-card warnings for a Commander or Limited deck
  assert.deepEqual((await deck(...COMMANDER)).messages, []);
  assert.deepEqual((await deck('6 Grizzly Bears\n34 Forest')).messages, []);
  assert.deepEqual((await deck('60 Island', '15 Island')).messages, []);
});

test('a 59-card deck is still a card short', async () => {
  const { label, messages } = await deck('4 Counterspell\n55 Island', '15 Island');
  assert.equal(label, 'Auto-detect (Pauper)');
  assert.deepEqual(messages, ['Decks may not consist of less than 60 cards']);
  // Beside the status box, the deck box doesn't list its problems again
  assert.equal(await page.isVisible('#deckmain-messages'), false);
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

test('each added format shows its own status messages', async () => {
  assert.deepEqual((await deck('4 Brainstorm\n4 Swords to Plowshares\n52 Island', '15 Island', 'premodern')).messages,
    ['The following cards are not legal in Premodern:\nBrainstorm']);
  assert.deepEqual((await deck('2 Sol Ring\n58 Island', '15 Island', 'oldschool')).messages,
    ['The following cards are restricted in Old School, so a deck may hold only one copy:\nSol Ring']);
  // Sol Ring is legal in Commander, but not in Duel Commander
  assert.deepEqual((await deck(...COMMANDER, 'duel')).messages,
    ['The following cards are not legal in Duel Commander:\nSol Ring']);
  assert.deepEqual((await deck('97 Island', COMMANDER[1], 'duel')).messages,
    ['Duel Commander decks consist of exactly 100 cards, counting the commander (this one has 98)']);
  assert.deepEqual((await deck('99 Island', '1 Derevi, Empyrial Tactician', 'duel')).messages,
    ['The following cards may not be your commander in Duel Commander:\nDerevi, Empyrial Tactician']);
  assert.deepEqual((await deck('1 Counterspell\n98 Island', '1 Tatyova, Benthic Druid', 'paupercommander')).messages, []);
  assert.deepEqual((await deck(...COMMANDER, 'predh')).messages,
    ["The following cards are not legal in PreDH:\nAtraxa, Praetors' Voice"]);
  assert.deepEqual((await deck('58 Mountain', '1 Chandra, Torch of Defiance\n1 Lightning Bolt', 'oathbreaker')).messages, []);
  assert.deepEqual((await deck('58 Mountain', '1 Chandra, Torch of Defiance', 'oathbreaker')).messages, [
    'Oathbreaker decks consist of exactly 60 cards, counting the Oathbreaker and its signature spell (this one has 59)',
    'List your Oathbreaker and its signature spell in the sideboard'
  ]);
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

// Clicks Copy Permalink and returns the link it copied, checking that nothing left the page
async function copyPermalink() {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  outside.length = 0;
  await page.click('#permalink');
  await page.waitForFunction(() => document.querySelector('#permalink').textContent === 'Copied!');
  assert.deepEqual(outside, []);
  const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(link.origin, 'https://decklist.app');
  return link;
}

// The sheet and sort order radios that are checked
const radios = () => page.evaluate(() => ({
  sheet: document.querySelector('input[name=decksheetformat]:checked').id,
  sort: document.querySelector('input[name=sortorder]:checked').id
}));

test('Copy Permalink copies a link that reopens the deck, and sends it nowhere', async () => {
  await deck("1 Sol Ring\n1 +2 Mace\n1 Fire // Ice\n96 Island", "1 Atraxa, Praetors' Voice", 'commander');
  await page.fill('#deckname', 'Atraxa & Friends 100%');
  const filled = await fields();
  const label = await page.textContent('#permalink');
  const link = await copyPermalink();
  // The button puts its own label back
  await page.waitForFunction(label => document.querySelector('#permalink').textContent === label, label, { timeout: 5000 });

  // A fresh page, so nothing carries over but the link
  await page.close();
  await newPage({}, '/index.html' + link.search);
  assert.deepEqual(await fields(), filled);
});

test('a permalink keeps the sheet and sort order, and back and forward restore them', async () => {
  await page.fill('#deckmain', '4 Counterspell\n56 Island');
  await page.waitForTimeout(600);
  await page.click('label[for=decksheet-scg]');
  await page.click('label[for=sort-manavalue]');
  const link = await copyPermalink();
  assert.equal(link.search, '?deckmain=4+Counterspell%0A56+Island&decksheet=scg&decksort=manavalue');
  // Each radio is a step in the address bar's history
  assert.equal(new URL(page.url()).search, link.search);

  // Going back two steps undoes both radios at once and keeps the steps ahead
  await page.evaluate(() => history.go(-2));
  await page.waitForTimeout(200);
  assert.deepEqual(await radios(), { sheet: 'decksheet-wotc', sort: 'sort-type' });
  assert.equal(new URL(page.url()).search, '?deckmain=4+Counterspell%0A56+Island');
  await page.evaluate(() => history.go(2));
  await page.waitForTimeout(200);
  assert.deepEqual(await radios(), { sheet: 'decksheet-scg', sort: 'sort-manavalue' });

  await page.close();
  await newPage({}, '/index.html' + link.search);
  assert.deepEqual(await radios(), { sheet: 'decksheet-scg', sort: 'sort-manavalue' });
});

test('clicking the brand scrolls to the top and keeps the deck', async () => {
  await open('/index.html?deckname=Mono+Blue&deckmain=4+Counterspell%0A56+Island');
  await page.fill('#deckdesigner', 'Jace');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const url = page.url();
  await page.click('.navbar-brand');
  await page.waitForFunction(() => window.scrollY === 0);
  assert.equal(page.url(), url);
  assert.equal(await page.inputValue('#deckdesigner'), 'Jace');
  assert.equal(await page.inputValue('#deckmain'), '4 Counterspell\n56 Island');
  assert.equal(await page.getAttribute('.navbar-brand', 'href'), '/');
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
  const label = await page.textContent('#permalink');
  outside.length = 0;
  await page.click('#permalink');
  const shared = await page.waitForFunction(() => window.shared).then(handle => handle.jsonValue());
  assert.equal(shared.url, 'https://decklist.app/?deckmain=4+Counterspell%0A56+Island');
  assert.equal(await page.textContent('#permalink'), label);
  assert.deepEqual(outside, []);
});

test('Save and Load keep the format, and Clear resets it', async () => {
  await deck(...LEGACY, 'legacy');
  await page.click('#saveDeck');
  assert.equal(await page.textContent('#saveDeck'), 'Saved!');
  assert.ok(await page.$eval('#saveDeck', button => button.classList.contains('done')));
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

test('an import fills in the deck name it reports, and undo restores the last one', async () => {
  await page.fill('#deckname', 'My Brew');
  importReply = { body: '1 Sol Ring\n98 Island\nSideboard\n1 Atraxa, Praetors’ Voice', format: 'commander',
    name: 'Atraxa “Superfriends” — 100%' };
  await importDeck('https://moxfield.com/decks/y6-gAWsstnWUyIpXDf5SMQ');
  assert.equal(await page.inputValue('#deckname'), 'Atraxa “Superfriends” — 100%');
  // It reaches the address bar with the deck, so a permalink keeps it
  await page.waitForFunction(() => new URLSearchParams(location.search).get('deckname') === 'Atraxa “Superfriends” — 100%');
  await page.click('#deckimport-undo');
  assert.equal(await page.inputValue('#deckname'), 'My Brew');
  // A deck the Worker names none for (MTGTop8's, or any from a Worker that predates
  // the header) keeps the name already there
  importReply = { body: '4 Goblin Guide\n56 Mountain', format: null, name: null };
  await importDeck('https://www.mtgtop8.com/event?e=1&d=2&f=MO');
  assert.equal(await page.inputValue('#deckname'), 'My Brew');
});

test('an MTGTop8 link names its format, and a deck with none goes back to Auto-detect', async () => {
  importReply = { body: '4 Goblin Guide\n56 Mountain', format: null };
  await importDeck('https://www.mtgtop8.com/event?e=1&d=2&f=MO');
  assert.equal(await page.inputValue('#deckformat'), 'modern');
  await importDeck('https://www.mtggoldfish.com/deck/123');
  assert.equal(await page.inputValue('#deckformat'), '');
});

test('an import selects a paper variant it names, and checks the deck against it', async () => {
  await deck('');
  const messages = async () => {
    await page.waitForTimeout(600);
    return page.$$eval('.status .details > li', items => items.map(item => item.innerText.trim()));
  };
  importReply = { body: '58 Mountain\nSideboard\n1 Chandra, Torch of Defiance\n1 Lightning Bolt', format: 'oathbreaker' };
  await importDeck('https://moxfield.com/decks/y6-gAWsstnWUyIpXDf5SMQ');
  assert.equal(await page.inputValue('#deckformat'), 'oathbreaker');
  assert.deepEqual(await messages(), []);
  importReply = { body: '4 Brainstorm\n56 Island\nSideboard\n15 Island', format: null };
  await importDeck('https://www.mtgtop8.com/event?e=1&d=2&f=PREM');
  assert.equal(await page.inputValue('#deckformat'), 'premodern');
  assert.deepEqual(await messages(), ['The following cards are not legal in Premodern:\nBrainstorm']);
});

test('the preview renders a PDF', async () => {
  await deck(...COMMANDER);
  await page.waitForFunction(() => document.querySelector('#decklist')?.getAttribute('src')?.startsWith('data:application/pdf'),
    null, { timeout: 5000 });
});

test('a phone draws the preview, picks the date natively, and lists deck problems under the deck box', async () => {
  await page.close();
  await newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  assert.equal(await page.getAttribute('#eventdate', 'type'), 'date');
  await deck('4 Lightning Bolt\n4 Not A Card\n52 Mountain', '15 Mountain');
  const messages = await page.$$eval('#deckmain-messages > li', items => items.map(item => item.innerText));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Couldn't recognize the following card\(s\):\s+Not A Card$/);
  assert.ok(await page.isVisible('#deckmain-messages'));
  assert.equal(await page.isVisible('#deckside-messages'), false);
  // PDF.js draws the sheet in place of the iframe, and it isn't blank
  await page.waitForSelector('#decklistpreview canvas', { timeout: 10000 });
  assert.equal(await page.$('#decklist'), null);
  const inked = await page.$eval('#decklistpreview canvas', canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) count++;
    return count;
  });
  assert.ok(inked > 1000, 'the drawn preview has ' + inked + ' dark pixels');
  // The status comes before the download button
  assert.ok((await page.locator('.status').boundingBox()).y < (await page.locator('#download').boundingBox()).y);
});

// Types at the end of the main deck as a player would, and returns the suggestions shown.
// The deck box is focused directly: a click could land on an open list
async function typeInDeck(text) {
  await page.$eval('#deckmain', box => {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
  await page.keyboard.type(text);
  return page.$$eval('.autocomplete-suggestion', items => items.filter(item => item.offsetParent).map(item => item.textContent));
}

test('autocomplete puts the name typed, then names starting with it, first', async () => {
  assert.equal((await typeInDeck('4 island'))[0], 'Island');
  await page.fill('#deckmain', '');
  const thought = await typeInDeck('2 thoughtse');
  assert.equal(thought[0], 'Thoughtseize');
  await page.fill('#deckmain', '');
  // A word starting with the term beats the term inside a word
  const bolt = await typeInDeck('4 bolt');
  const firstInside = bolt.findIndex(name => !/(^|[^a-z0-9])bolt/i.test(name));
  assert.ok(firstInside === -1 || bolt.slice(firstInside).every(name => !/(^|[^a-z0-9])bolt/i.test(name)), bolt.join(', '));
  assert.ok(bolt.slice(0, firstInside === -1 ? bolt.length : firstInside).every(name => /(^|[^a-z0-9])bolt/i.test(name)));
});

test('picking a suggestion keeps typing in the deck box', async () => {
  await typeInDeck('4 snapcas');
  await page.click('.autocomplete-suggestion >> text=Snapcaster Mage');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'deckmain');
  await page.keyboard.type('\n2 Island');
  assert.equal(await page.inputValue('#deckmain'), '4 Snapcaster Mage\n2 Island');
});

test('Enter and Tab take the highlighted suggestion, and Enter after a full name ends the line', async () => {
  await typeInDeck('4 snapcas');
  await page.keyboard.press('Enter');
  await typeInDeck('\n1 lightning bo');
  await page.keyboard.press('ArrowDown');
  const second = await page.textContent('.autocomplete-suggestion.selected');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#deckmain'), '4 Snapcaster Mage\n1 ' + second);
  await page.fill('#deckmain', '');
  await typeInDeck('4 island');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#deckmain'), '4 island\n');
});

test('the suggestions sit at the caret, inside the visible part of the page', async () => {
  await page.close();
  await newPage({ viewport: { width: 375, height: 500 }, hasTouch: true, isMobile: true });
  await page.$eval('#deckmain', box => {
    box.value = Array.from({ length: 20 }, () => '1 Island').join('\n');
    box.scrollIntoView({ block: 'end' });
  });
  await typeInDeck('\n4 bolt');
  const { list, box, caretLine, view } = await page.evaluate(() => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const box = document.querySelector('#deckmain');
    return { list: rect(document.querySelector('.autocomplete-suggestions')), box: rect(box),
      caretLine: box.getBoundingClientRect().bottom, view: innerHeight };
  });
  // The caret is on the box's last line, so the list opens above it rather than below the box
  assert.ok(list.bottom <= caretLine, JSON.stringify({ list, box }));
  assert.ok(list.top >= 0 && list.bottom <= view, JSON.stringify({ list, view }));
  assert.ok(list.height >= 44);
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
  // An Oathbreaker deck's sideboard holds its Oathbreaker and signature spell, and keeps its order too
  await page.selectOption('#deckformat', 'oathbreaker');
  assert.deepEqual(await sideboard(), ['Jace, Multiverse Architect', 'Grizzly Bears', 'Counterspell']);
});
