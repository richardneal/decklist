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

let server, browser, origin, page, pageErrors, importReply, outside, events;

before(async () => {
  server = createServer(async (request, response) => {
    // The page's error and outcome reports (report.js), kept with the headers the site
    // Worker reads
    if (request.method === 'POST' && request.url === '/api/event') {
      let body = '';
      for await (const chunk of request) body += chunk;
      events.push({ ...JSON.parse(body), origin: request.headers.origin });
      return response.writeHead(204).end();
    }
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
  events = [];
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
    return route.fulfill({ status: importReply.status || 200, body: importReply.body, headers: {
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
// the Auto-detect option's text with the deck messages from the status box, and the
// cards with a problem as their rows under the deck boxes name them. The player and
// event fields are filled, so their warnings stay out of the way.
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
    messages: await page.$$eval('.status .details > li', items => items.map(item => item.innerText.trim())),
    rows: await page.$$eval('.deckcheck li[data-problems]', items => items.map(item =>
      item.querySelector('.deckcheck-name').textContent + ': ' +
      [...item.querySelectorAll('.deckcheck-reason')].map(reason => reason.textContent).join('; ')))
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
  assert.deepEqual(messages, ['Decks may not consist of fewer than 60 cards (this one has 59)']);
  // Beside the status box, the deck box doesn't list its problems again
  assert.equal(await page.isVisible('#deckmain-messages'), false);
});

test('an Arena export with a companion pasted into the main deck fills both sections', async () => {
  const arena = 'About\nName Burn\n\nCompanion\n1 Jegantha, the Wellspring (IKO) 222\n\n' +
    'Deck\n4 Lightning Bolt (2X2) 117\n1 Fire // Ice (MH2) 290 *F*\n55 Mountain (ANA) 1\n\n' +
    'Sideboard\n1 Jegantha, the Wellspring (IKO) 222\n2 Blood Moon (DMR) 123\n12 Mountain (ANA) 1';
  // No unrecognized cards, and a 15-card sideboard: the companion is counted once
  assert.deepEqual(await deck(arena), { label: 'Auto-detect (Legacy)', messages: [], rows: [] });
  const sections = await page.evaluate(() => {
    const parsed = Decklist.parse();
    return [parsed.main, parsed.side].map(list => list.map(card => card.q + ' ' + card.n));
  });
  assert.deepEqual(sections, [['4 Lightning Bolt', '1 Fire // Ice', '55 Mountain'],
    ['1 Jegantha, the Wellspring', '2 Blood Moon', '12 Mountain']]);
});

test('a chosen format lists its banned and restricted cards', async () => {
  let checked = await deck(...LEGACY, 'modern');
  assert.deepEqual(checked.messages, ['2 cards not legal in Modern']);
  assert.deepEqual(checked.rows, ['Brainstorm: Not legal in Modern', 'Force of Will: Not legal in Modern']);
  checked = await deck(...LEGACY, 'vintage');
  assert.deepEqual(checked.messages, ['1 card restricted in Vintage with more than one copy']);
  assert.deepEqual(checked.rows, ['Brainstorm: Restricted in Vintage, so a deck may hold only one copy']);
});

test('each card over its copy limit shows its count and limit', async () => {
  let checked = await deck('8 Seven Dwarves\n52 Mountain', '15 Mountain', 'modern');
  assert.deepEqual(checked.messages, ['1 card over its copy limit']);
  assert.deepEqual(checked.rows, ['Seven Dwarves: Over its copy limit (8 copies; limit 7)']);
  assert.deepEqual((await deck('7 Seven Dwarves\n53 Mountain', '15 Mountain', 'modern')).messages, []);
  checked = await deck('5 Lightning Bolt\n55 Mountain', '15 Mountain');
  assert.deepEqual(checked.messages, ['1 card over its copy limit']);
  assert.deepEqual(checked.rows, ['Lightning Bolt: Over its copy limit (5 copies; limit 4)']);
});

test('a Commander deck is held to 100 singleton cards legal in Commander', async () => {
  const checked = await deck('2 Sol Ring\n1 Dockside Extortionist\n96 Island', COMMANDER[1]);
  assert.deepEqual(checked.messages, ['1 card over its copy limit', '1 card not legal in Commander']);
  assert.deepEqual(checked.rows,
    ['Sol Ring: Over its copy limit (2 copies; limit 1)', 'Dockside Extortionist: Not legal in Commander']);
  assert.deepEqual((await deck('1 Sol Ring\n97 Island', COMMANDER[1], 'commander')).messages,
    ['Commander decks consist of exactly 100 cards, counting the commander (this one has 99)']);
  assert.deepEqual((await deck("1 Atraxa, Praetors' Voice\n1 Sol Ring\n98 Island", '')).messages,
    ['List your commander in the sideboard']);
});

test('each added format shows its own status messages', async () => {
  assert.deepEqual(await deck('4 Brainstorm\n4 Swords to Plowshares\n52 Island', '15 Island', 'premodern'),
    { label: 'Auto-detect', messages: ['1 card not legal in Premodern'], rows: ['Brainstorm: Not legal in Premodern'] });
  assert.deepEqual((await deck('2 Sol Ring\n58 Island', '15 Island', 'oldschool')).rows,
    ['Sol Ring: Restricted in Old School, so a deck may hold only one copy']);
  // Sol Ring is legal in Commander, but not in Duel Commander
  assert.deepEqual((await deck(...COMMANDER, 'duel')).rows, ['Sol Ring: Not legal in Duel Commander']);
  assert.deepEqual((await deck('97 Island', COMMANDER[1], 'duel')).messages,
    ['Duel Commander decks consist of exactly 100 cards, counting the commander (this one has 98)']);
  assert.deepEqual(await deck('99 Island', '1 Derevi, Empyrial Tactician', 'duel'), { label: 'Auto-detect',
    messages: ['1 card may not be your commander in Duel Commander'],
    rows: ['Derevi, Empyrial Tactician: May not be your commander in Duel Commander'] });
  assert.deepEqual((await deck('1 Counterspell\n98 Island', '1 Tatyova, Benthic Druid', 'paupercommander')).messages, []);
  assert.deepEqual((await deck(...COMMANDER, 'predh')).rows, ["Atraxa, Praetors' Voice: Not legal in PreDH"]);
  assert.deepEqual((await deck('58 Mountain', '1 Chandra, Torch of Defiance\n1 Lightning Bolt', 'oathbreaker')).messages, []);
  assert.deepEqual((await deck('58 Mountain', '1 Chandra, Torch of Defiance', 'oathbreaker')).messages, [
    'Oathbreaker decks consist of exactly 60 cards, counting the Oathbreaker and its signature spell (this one has 59)',
    'List your Oathbreaker and its signature spell in the sideboard'
  ]);
});

test('a Limited deck has no copy or sideboard limits', async () => {
  assert.deepEqual((await deck('6 Grizzly Bears\n34 Forest', '30 Lightning Bolt', 'limited')).messages, []);
  assert.deepEqual((await deck('6 Grizzly Bears\n33 Forest', '', 'limited')).messages,
    ['Decks may not consist of fewer than 40 cards (this one has 39)']);
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

// The sort order picked
const sortOrder = () => page.inputValue('#decksort');

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

test('a permalink keeps the sort order, and back and forward restore it', async () => {
  await page.fill('#deckmain', '4 Counterspell\n56 Island');
  await page.waitForTimeout(600);
  await page.selectOption('#decksort', 'manavalue');
  await page.selectOption('#decksort', 'color');
  const link = await copyPermalink();
  assert.equal(link.search, '?deckmain=4+Counterspell%0A56+Island&decksort=color');
  // Each pick is a step in the address bar's history
  assert.equal(new URL(page.url()).search, link.search);

  // Going back two steps undoes both picks at once and keeps the steps ahead
  await page.evaluate(() => history.go(-2));
  await page.waitForTimeout(200);
  assert.equal(await sortOrder(), 'type');
  assert.equal(new URL(page.url()).search, '?deckmain=4+Counterspell%0A56+Island');
  await page.evaluate(() => history.go(2));
  await page.waitForTimeout(200);
  assert.equal(await sortOrder(), 'color');

  await page.close();
  await newPage({}, '/index.html' + link.search);
  assert.equal(await sortOrder(), 'color');
});

test('an old link naming the SCG sheet opens the WotC sheet', async () => {
  await page.close();
  await newPage({}, '/index.html?deckmain=4+Counterspell%0A56+Island&decksheet=scg');
  assert.equal(await page.inputValue('#deckmain'), '4 Counterspell\n56 Island');
  assert.equal(await page.locator('input[name=decksheetformat]').count(), 0);
});

test('the preview sidebar stays in view as the form scrolls', async () => {
  // The sidebar's top and bottom in the window once the page has scrolled to y
  const at = async y => {
    await page.evaluate(y => window.scrollTo(0, y), y);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page.evaluate(() => {
      const { top, bottom } = document.querySelector('.right').getBoundingClientRect();
      return { top: Math.round(top), bottom: Math.round(bottom), window: window.innerHeight };
    });
  };
  await page.close();
  await newPage({ viewport: { width: 1280, height: 1100 } }, '/index.html?deckmain=4+Counterspell%0A56+Island');
  assert.equal((await at(300)).top, 16);

  // One taller than the window shows its bottom scrolling down, then its top scrolling up
  await page.setViewportSize({ width: 1280, height: 700 });
  await at(0);
  let box = await at(600);
  assert.ok(box.top < 0);
  assert.equal(box.bottom, box.window - 16);
  box = await at(100);
  assert.equal(box.top, 16);

  // Below the form, in one column, it stays where the page puts it, and a width that
  // brings it back beside the form keeps it in view again
  await page.setViewportSize({ width: 375, height: 812 });
  for (let y = 0; y <= 2000; y += 200) await at(y);
  assert.equal(await page.evaluate(() => document.querySelector('.right').style.top), '');
  const covered = await page.evaluate(() => ['#lastname', '#event', '#eventlocation'].filter(id => {
    const field = document.querySelector(id);
    field.scrollIntoView({ block: 'center' });
    const { x, y } = field.getBoundingClientRect();
    return document.elementFromPoint(x + 10, y + 10) !== field;
  }));
  assert.deepEqual(covered, []);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await at(800);
  assert.notEqual(await page.evaluate(() => document.querySelector('.right').style.top), '');
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
  // So does the navbar's own Decklist link
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('.navbar-links a[aria-current="page"]');
  await page.waitForFunction(() => window.scrollY === 0);
  assert.equal(page.url(), url);
  assert.equal(await page.inputValue('#deckdesigner'), 'Jace');
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

test('Save and Load keep the sort order, and Clear resets it', async () => {
  await page.fill('#deckmain', '4 Counterspell\n56 Island');
  await page.selectOption('#decksort', 'manavalue');
  await page.click('#saveDeck');
  await page.click('#clearDeck');
  assert.equal(await sortOrder(), 'type');
  await page.click('#loadDeck');
  assert.equal(await sortOrder(), 'manavalue');

  // A deck saved when the sort order was a row of radios names the radio
  await page.evaluate(() => localStorage.setItem('savedDeck', JSON.stringify({ deckmain: '4 Counterspell', sortorder: 'sort-color' })));
  await page.click('#loadDeck');
  assert.equal(await sortOrder(), 'color');
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
  assert.deepEqual(await messages(), ['1 card not legal in Premodern']);
});

test('the preview renders a PDF', async () => {
  await deck(...COMMANDER);
  await page.waitForFunction(() => document.querySelector('#decklist')?.getAttribute('src')?.startsWith('data:application/pdf'),
    null, { timeout: 5000 });
});

test('the preview opens the sheet fitted in its frame, so a scroll over it moves the page', async () => {
  await deck('4 Lightning Bolt\n56 Mountain');
  await page.waitForFunction(() => document.querySelector('#decklist')?.getAttribute('src')?.startsWith('data:application/pdf'),
    null, { timeout: 5000 });
  assert.ok((await page.getAttribute('#decklist', 'src')).endsWith('#view=Fit&zoom=page-fit'));
});

test('a phone draws the preview, picks the date natively, and lists deck problems under the deck box', async () => {
  await page.close();
  await newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  assert.equal(await page.getAttribute('#eventdate', 'type'), 'date');
  await deck('4 Lightning Bolt\n4 Not A Card\n51 Mountain', '15 Mountain');
  const messages = await page.$$eval('#deckmain-messages > li', items => items.map(item => item.innerText));
  assert.deepEqual(messages, ['Decks may not consist of fewer than 60 cards (this one has 59)']);
  assert.ok(await page.isVisible('#deckmain-messages'));
  // A problem with a named card is on that card's own row instead, just below
  assert.deepEqual(await marked('deckmain'), ['warning 4 Not A Card: Couldn\'t recognize this card']);
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

// The deck box filled to past its height, so the caret's line is its last, with `room`
// pixels of the window left below it
async function fillDeckAbove(room) {
  await page.$eval('#deckmain', (box, room) => {
    box.value = Array.from({ length: 20 }, () => '1 Island').join('\n');
    box.scrollIntoView({ block: 'end' });
    scrollBy(0, box.getBoundingClientRect().bottom - (innerHeight - room));
  }, room);
}

function measureList() {
  return page.evaluate(() => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const box = document.querySelector('#deckmain');
    return { list: rect(document.querySelector('.autocomplete-suggestions')), box: rect(box),
      caretLine: box.getBoundingClientRect().bottom, view: innerHeight };
  });
}

test('the suggestions open under the line when a few rows fit there, not over the lines before', async () => {
  // Room for most of a full list, but not all of it
  await fillDeckAbove(190);
  await typeInDeck('\n4 bolt');
  const { list, box, view } = await measureList();
  const padding = await page.$eval('#deckmain', box => parseFloat(getComputedStyle(box).paddingBottom));
  assert.ok(list.top >= box.bottom - padding, JSON.stringify({ list, box }));
  assert.ok(list.bottom <= view, JSON.stringify({ list, view }));
  // Narrowed, it stays below
  assert.equal((await typeInDeck('w')).length, 2);
  const narrowed = await measureList();
  assert.ok(narrowed.list.top >= narrowed.box.bottom - padding, JSON.stringify(narrowed));
});

test('the suggestions sit at the caret, inside the visible part of the page', async () => {
  await page.close();
  await newPage({ viewport: { width: 375, height: 500 }, hasTouch: true, isMobile: true });
  // Room below the box for a short list but not a few rows of a full one
  await fillDeckAbove(110);
  await typeInDeck('\n4 bolt');
  const { list, box, caretLine, view } = await measureList();
  // The caret is on the box's last line, so the list opens above it rather than below the box
  assert.ok(list.bottom <= caretLine, JSON.stringify({ list, box }));
  assert.ok(list.top >= 0 && list.bottom <= view, JSON.stringify({ list, view }));
  assert.ok(list.height >= 44);
  // Narrowed to a list short enough to fit below, it stays above
  assert.equal((await typeInDeck('w')).length, 2);
  const narrowed = await measureList();
  assert.ok(narrowed.list.bottom <= narrowed.caretLine, JSON.stringify(narrowed));
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

test('the Text file tab loads an uploaded deck file, and undo restores the last deck', async () => {
  await page.fill('#deckmain', '4 Island');
  await page.selectOption('#deckformat', 'modern');
  assert.equal(await page.isVisible('#deckfile-button'), false);
  await page.click('#import-tab-file');
  assert.equal(await page.isVisible('#deckimport'), false);
  assert.equal(await page.getAttribute('#import-tab-file', 'aria-selected'), 'true');
  await page.setInputFiles('#deckfile', { name: 'burn.dek', mimeType: 'application/octet-stream', buffer: Buffer.from(
    '<?xml version="1.0"?><Deck><Cards Quantity="4" Sideboard="false" Name="Lightning Bolt"/>' +
    '<Cards Quantity="56" Sideboard="false" Name="Mountain"/><Cards Quantity="2" Sideboard="true" Name="Abrade"/></Deck>') });
  await page.waitForSelector('#deckimport-status[data-state="success"]');
  assert.equal(await page.inputValue('#deckmain'), '4 Lightning Bolt\n56 Mountain');
  assert.equal(await page.inputValue('#deckside'), '2 Abrade');
  // A file names no format, so the one chosen stays
  assert.equal(await page.inputValue('#deckformat'), 'modern');
  assert.match(await page.textContent('#deckimport-status'), /Loaded burn\.dek: 60 main-deck cards and 2 sideboard cards/);
  await page.click('#deckimport-undo');
  assert.equal(await page.inputValue('#deckmain'), '4 Island');

  // An Arena export goes into the main deck box whole, and a file with no deck changes nothing
  await page.setInputFiles('#deckfile', { name: 'arena.txt', mimeType: 'text/plain',
    buffer: Buffer.from('About\nName Mono Red\n\nDeck\n4 Lightning Bolt\n56 Mountain\n\nSideboard\n2 Abrade\n') });
  await page.waitForSelector('#deckimport-status[data-state="success"]');
  assert.equal(await page.inputValue('#deckname'), 'Mono Red');
  assert.equal(await page.inputValue('#deckside'), '');
  await page.setInputFiles('#deckfile', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember to sleeve up') });
  await page.waitForSelector('#deckimport-status[data-state="error"]');
  assert.match(await page.inputValue('#deckmain'), /^About/);

  // The arrow keys move between the tabs
  await page.focus('#import-tab-file');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.isVisible('#deckimport'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'import-tab-link');
});

// The rows under a textarea that the player sees, as "quantity name: reason; reason"
function marked(list) {
  return page.$$eval('#' + list + '-check li', items => items.filter(item => item.offsetParent).map(item => {
    const reasons = [...item.querySelectorAll('.deckcheck-reason')].map(reason => reason.textContent);
    const row = (item.querySelector('.deckcheck-q').textContent + ' ' + item.querySelector('.deckcheck-name').textContent).trim();
    return item.className + ' ' + row + (reasons.length ? ': ' + reasons.join('; ') : '');
  }));
}

test('each card with a problem is marked on its own row under its textarea', async () => {
  await deck('5 Lightning Bolt\n4 Brainstorm\n1 Notacard\n50 Mountain', '15 Mountain', 'modern');
  assert.deepEqual(await marked('deckmain'), [
    'error 5 Lightning Bolt: Over its copy limit (5 copies; limit 4)',
    'error 4 Brainstorm: Not legal in Modern',
    'warning 1 Notacard: Couldn\'t recognize this card'
  ]);
  assert.equal(await page.textContent('#deckmain-check .deckcheck-toggle'), 'Show all 60 cards');
  // The sideboard has no problems, so it lists nothing until asked
  assert.deepEqual(await marked('deckside'), []);
  assert.equal(await page.textContent('#deckside-check .deckcheck-toggle'), 'No problems found. Show all 15 cards');
  // The status box keeps its messages
  assert.ok((await deck('4 Brainstorm\n56 Island', '15 Island', 'modern')).messages
    .includes('1 card not legal in Modern'));

  await deck('2 Brainstorm\n58 Island', '15 Island', 'vintage');
  assert.deepEqual(await marked('deckmain'),
    ['error 2 Brainstorm: Restricted in Vintage, so a deck may hold only one copy']);

  await deck('99 Island', '1 Derevi, Empyrial Tactician', 'duel');
  assert.deepEqual(await marked('deckside'),
    ['error 1 Derevi, Empyrial Tactician: May not be your commander in Duel Commander']);
  assert.deepEqual(await marked('deckmain'), []);

  // A card is listed under the textarea it came from, its name shown as typed
  await deck('60 Island', '14 Island\n<b>x', 'constructed');
  assert.deepEqual(await marked('deckside'), ['warning 1 <b>x: Couldn\'t recognize this card']);

  // A problem with the whole sideboard names no card, but it isn't "no problems" either
  await deck('60 Island', '7 Island', 'modern');
  assert.deepEqual(await marked('deckside'), []);
  assert.equal(await page.textContent('#deckside-check .deckcheck-toggle'), 'Show all 7 cards');
});

test('the status box puts errors first and the blank fields on one line, last', async () => {
  await page.fill('#deckmain', '5 Lightning Bolt\n4 Brainstorm\n1 Notacard\n50 Mountain');
  await page.fill('#deckside', '7 Mountain');
  await page.selectOption('#deckformat', 'modern');
  await page.fill('#lastname', 'Beleren');
  await page.waitForTimeout(600);
  const items = await page.$$eval('.status .details > li', items => items.map(item => item.className + ' ' + item.innerText.trim()));
  assert.deepEqual(items, [
    'error 1 card over its copy limit',
    'error 1 card not legal in Modern',
    'warning Couldn\'t recognize 1 card',
    'warning Most sideboards consist of exactly 15 cards (this one has 7)',
    'warning Missing first name, event name, event date and event location'
  ]);
  // A count of cards leads to the first of them, on its row under the deck box
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.click('.status .details label[data-problem="illegal"]');
  await page.waitForFunction(() => {
    const { top, bottom } = document.querySelector('.deckcheck li.flash').getBoundingClientRect();
    return top >= 0 && bottom <= window.innerHeight;
  });
  assert.equal(await page.textContent('.deckcheck li.flash .deckcheck-name'), 'Brainstorm');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'deckmain');
  // Each blank field's name still leads to its field
  await page.click('.status .details label[for="event"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'event');
  await page.fill('#firstname', 'Jace');
  await page.fill('#event', 'Test Open');
  await page.fill('#eventdate', '2099-01-01');
  await page.waitForTimeout(600);
  assert.equal(await page.$eval('.status .details > li:last-child', item => item.innerText.trim()), 'Missing event location');
});

test('the import box keeps its height when the tab changes', async () => {
  const height = () => page.$eval('.deck-import', box => box.offsetHeight);
  const before = await height();
  await page.click('#import-tab-file');
  assert.equal(await height(), before);
  assert.equal(await page.isVisible('#deckimport'), false);
  assert.equal(await page.isVisible('#deckfile-button'), true);
});

test('the deck name and designer examples show only while both fields are empty', async () => {
  const shown = () => page.evaluate(() => ['#deckname', '#deckdesigner'].map(id =>
    getComputedStyle(document.querySelector(id), '::placeholder').color !== 'rgba(0, 0, 0, 0)'));
  assert.deepEqual(await shown(), [true, true]);
  // A filled field shows its value, and the other field's example is hidden
  await page.fill('#deckname', 'Burn');
  assert.equal((await shown())[1], false);
  await page.fill('#deckname', '');
  assert.deepEqual(await shown(), [true, true]);
  await page.fill('#deckdesigner', 'Patrick Chapin');
  assert.equal((await shown())[0], false);
});

test('the full list shows each card as it was matched, and hides again', async () => {
  await deck('4 fire ice\n1 Lightning Bolt\n1 Lightning Bolt\n50 Mountain', '15 Mountain', 'legacy');
  // 56 cards is a deck problem, so not "No problems found", but no card has one
  assert.equal(await page.textContent('#deckmain-check .deckcheck-toggle'), 'Show all 56 cards');
  assert.deepEqual(await marked('deckmain'), []);
  await page.click('#deckmain-check .deckcheck-toggle');
  assert.deepEqual(await marked('deckmain'), ['ok 4 Fire // Ice', 'ok 2 Lightning Bolt', 'ok 50 Mountain']);
  assert.equal(await page.getAttribute('#deckmain-check .deckcheck-toggle', 'aria-expanded'), 'true');
  assert.equal(await page.textContent('#deckmain-check .deckcheck-toggle'), 'Hide the list');
  // It stays open as the deck changes
  await page.fill('#deckmain', '5 Mountain');
  await page.press('#deckmain', 'Escape');  // close the autocomplete over the toggle
  await page.waitForTimeout(600);
  assert.deepEqual(await marked('deckmain'), ['ok 5 Mountain']);
  await page.click('#deckmain-check .deckcheck-toggle');
  assert.deepEqual(await marked('deckmain'), []);
  // An empty textarea lists nothing at all
  await deck('', '');
  assert.equal(await page.isHidden('#deckmain-check'), true);
});

// The reports sent so far, once the given number have arrived
async function reports(count) {
  await page.waitForFunction(count => performance.getEntriesByType('resource')
    .filter(entry => entry.name.endsWith('/api/event')).length >= count, count, { timeout: 5000 });
  await page.waitForTimeout(100);
  return events.map(({ e, d }) => [e, ...d]);
}

test('a download reports its format, problems and unrecognized cards, and nothing from the form', async () => {
  await deck('4 Lightning Bolt\n4 Notacard Atall\n50 Mountain', '', 'modern');
  await page.fill('#deckname', 'Secret Burn');
  await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  assert.deepEqual(await reports(1), [['download', 'modern:error', 'toosmall,unrecognized', '1-2']]);
  assert.equal(events[0].origin, origin);
  assert.doesNotMatch(JSON.stringify(events), /Jace|Beleren|Test Open|Minneapolis|Secret|Bolt|Notacard|Mountain/);
});

test('a failed import reports its source and kind, and a link it cannot read only its site', async () => {
  importReply = { status: 502, body: 'The deck source returned HTTP 403.' };
  await page.fill('#deckimport', 'https://moxfield.com/decks/abcdefghijklmnopqrstuv');
  await page.click('#deckimport-button');
  await page.waitForSelector('#deckimport-status[data-state="error"]');
  await page.fill('#deckimport', 'https://tappedout.net/mtg-decks/my-secret-deck/');
  await page.click('#deckimport-button');
  await page.fill('#deckimport', 'https://example.com/jace/deck');
  await page.click('#deckimport-button');
  assert.deepEqual(await reports(3), [['import', 'moxfield', 'failed'], ['badlink', 'tappedout.net'], ['badlink', 'other']]);
});

test('nothing is reported while the browser sends Global Privacy Control', async () => {
  await page.close();
  page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true }));
  await page.route(url => !url.href.startsWith(origin), route => route.abort());
  await open('/index.html');
  await deck('4 Lightning Bolt\n56 Mountain', '', 'modern');
  await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  await page.waitForTimeout(500);
  assert.deepEqual(events, []);
});
