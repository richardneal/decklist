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
test('finds meld cards by their own name', () => {
  const deck = decklist.parse('1 The Mightstone and Weakstone\n1 Urza, Lord Protector', '');
  assert.equal(deck.unrecognized.length, 0);
  const summary = Array.from(deck.main, ({ n, c, t, m }) => ({ n, c, t, m }));
  assert.deepEqual(summary, [
    { n: 'The Mightstone and Weakstone', c: 'G', t: '5', m: 5 },
    { n: 'Urza, Lord Protector', c: 'F', t: '2', m: 3 },
  ]);
});
test('finds the tournament card when a playtest card shares its name', () => {
  const deck = decklist.parse('1 Pick Your Poison', '');
  const { n, c, t, m } = deck.main[0];
  assert.deepEqual({ n, c, t, m }, { n: 'Pick Your Poison', c: 'E', t: '3', m: 1 });
});
