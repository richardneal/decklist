const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const context = vm.createContext({ $: () => ({ val: () => '' }) });
vm.runInContext(fs.readFileSync('js/cards/decklist-cards-min.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('js/decklist/decklist.js', 'utf8'), context);
const decklist = context.Decklist;

test('finds split cards typed without slashes', () => {
  for (const line of ['1 Fire // Ice', '1 Fire/Ice', '1 fire / ice', '1 Fire Ice', '1 FIRE  ICE']) {
    const deck = decklist.parse(line, '');
    assert.equal(deck.main[0].n, 'Fire // Ice', line);
    assert.equal(deck.unrecognized.length, 0, line);
  }
});
test('still reports names that match no card', () => {
  const deck = decklist.parse('1 Fire Iceberg', '');
  assert.deepEqual([...deck.unrecognized], ['Fire Iceberg']);
});
test('search keys ignore case, accents and slashes', () => {
  assert.equal(decklist.searchKey('Fire // Ice'), 'fire ice');
  assert.equal(decklist.searchKey('Fire Ice'), 'fire ice');
  assert.equal(decklist.searchKey('Lim-Dûl the Necromancer'), 'lim-dul the necromancer');
  assert.ok(decklist.searchIndex().get('fire ice'));
});
test('finds double-faced and adventure cards spelled out in full', () => {
  const deck = decklist.parse('1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki\n' +
    '1 Delver of Secrets // Insectile Aberration\n1 brazen borrower / petty theft', '');
  assert.deepEqual([...deck.main.map(card => card.n)],
    ['Fable of the Mirror-Breaker', 'Delver of Secrets', 'Brazen Borrower']);
  assert.equal(deck.unrecognized.length, 0);
  // Split cards are stored under both halves, so they still match in full.
  assert.equal(decklist.parse('1 Fire // Ice', '').main[0].n, 'Fire // Ice');
});
