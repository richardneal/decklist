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

test('button updates textareas, refreshes the preview, and preserves edits during a request', async () => {
  const elements = new Map();
  function $(selector) {
    if (typeof selector === 'function') { selector(); return; }
    if (typeof selector !== 'string') return selector;
    const ids = selector.split(',').map(id => id.trim());
    if (ids.length > 1) return { on(event, handler) { ids.forEach(id => $(id).on(event, handler)); } };
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
  const ui = vm.createContext({ URL, AbortSignal, $ });
  vm.runInContext(fs.readFileSync('js/decklist/deckimport.js', 'utf8'), ui);
  $('#deckimport').val('https://mtggoldfish.com/deck/123');
  $('#deckside').val('old sideboard');
  ui.fetch = async () => ({ ok: true, text: async () => '4 Island' });
  await $('#deckimport-button').trigger('click');
  assert.equal($('#deckmain').val(), '4 Island');
  assert.equal($('#deckside').val(), '');
  assert.equal($('#deckside').inputs, 1);
  assert.equal($('#deckimport-button').prop('disabled'), false);
  $('#deckmain').val('2 Mountain').trigger('input');
  $('#deckside').val('1 Negate');
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
