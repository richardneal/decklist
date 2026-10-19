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
test('finds flip and prepare cards by their front face', () => {
  const lines = ['1 Akki Lavarunner', '1 Erayo, Soratami Ascendant',
    '1 Emeritus of Woe', '1 Adventurous Eater', '1 Demonic Tutor'];
  const deck = decklist.parse(lines.join('\n'), '');
  assert.deepEqual([...deck.unrecognized], []);
  const summary = Array.from(deck.main, ({ n, c, t, m }) => ({ n, c, t, m }));
  assert.deepEqual(summary, [
    { n: 'Akki Lavarunner', c: 'D', t: '2', m: 4 },
    { n: 'Erayo, Soratami Ascendant', c: 'B', t: '2', m: 2 },
    { n: 'Emeritus of Woe', c: 'C', t: '2', m: 4 },
    { n: 'Adventurous Eater', c: 'C', t: '2', m: 3 },
    { n: 'Demonic Tutor', c: 'C', t: '3', m: 2 },
  ]);
});
test('finds front-face-keyed cards written with both halves', () => {
  for (const [line, name] of [
    ['1 Akki Lavarunner // Tok-Tok, Volcano Born', 'Akki Lavarunner'],
    ['1 Emeritus of Woe // Demonic Tutor', 'Emeritus of Woe'],
    ['1 Bonecrusher Giant / Stomp', 'Bonecrusher Giant'],
    ['1 Delver of Secrets // Insectile Aberration', 'Delver of Secrets'],
  ]) {
    const deck = decklist.parse(line, '');
    assert.equal(deck.main[0].n, name, line);
    assert.equal(deck.unrecognized.length, 0, line);
  }
});
test('drops doubled reversible-card names', () => {
  const deck = decklist.parse('1 Forest // Forest\n1 Bloomvine Regent', '');
  assert.deepEqual(Array.from(deck.main, card => card.n), ['Forest', 'Bloomvine Regent']);
  assert.equal(decklist.searchIndex().has('forest forest'), false);
});
test('finds the tournament card when a playtest card shares its name', () => {
  const deck = decklist.parse('1 Pick Your Poison', '');
  const { n, c, t, m } = deck.main[0];
  assert.deepEqual({ n, c, t, m }, { n: 'Pick Your Poison', c: 'E', t: '3', m: 1 });
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
