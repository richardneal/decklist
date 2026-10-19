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

// Arrays made inside the vm don't deep-equal ours, so copy them out
const deckOf = (main, side = '') => decklist.parse(main, side);
const errors = (deck, format) => {
  const result = decklist.check(deck, format);
  return [...result.deckmain, ...result.deckside].map(problem => problem.error || problem.warning);
};

test('detects a Commander deck by its shape, with the commander in the sideboard', () => {
  const deck = deckOf('1 Sol Ring\n1 Arcane Signet\n97 Island', "1 Atraxa, Praetors' Voice");
  assert.equal(decklist.detectFormat(deck), 'commander');
  assert.deepEqual(errors(deck, 'commander'), []);
  // Before the commander moved to the sideboard, imports put it in the main deck
  const unmoved = deckOf("1 Atraxa, Praetors' Voice\n1 Sol Ring\n1 Arcane Signet\n97 Island");
  assert.equal(decklist.detectFormat(unmoved), 'commander');
  assert.deepEqual(errors(unmoved, 'commander'), ['nocommander']);
});
test('holds a Commander deck to 100 singleton cards legal in Commander', () => {
  assert.deepEqual(errors(deckOf('1 Sol Ring\n97 Island', "1 Atraxa, Praetors' Voice"), 'commander'), ['commandertoosmall']);
  // A companion may sit beside the commander, beyond the 100
  assert.deepEqual(errors(deckOf('1 Sol Ring\n98 Island', "1 Atraxa, Praetors' Voice\n1 Lurrus of the Dream-Den"), 'commander'), []);
  assert.deepEqual(errors(deckOf('1 Sol Ring\n99 Island', "1 Atraxa, Praetors' Voice"), 'commander'), ['commandertoolarge']);
  const deck = deckOf('2 Sol Ring\n1 Dockside Extortionist\n7 Seven Dwarves\n89 Island', "1 Atraxa, Praetors' Voice");
  const problems = decklist.check(deck, 'commander').deckmain;
  assert.deepEqual([...problems].map(problem => problem.error), ['quantity', 'illegal']);
  assert.deepEqual([...problems[0].data.cards], ['Sol Ring']);
  assert.deepEqual([...problems[1].data.cards], ['Dockside Extortionist']);
});
test('detects the narrowest constructed format a deck is legal in', () => {
  assert.equal(decklist.detectFormat(deckOf('4 Llanowar Elves\n56 Forest')), 'standard');
  assert.equal(decklist.detectFormat(deckOf('4 Counterspell\n56 Island')), 'pauper');
  assert.equal(decklist.detectFormat(deckOf('4 Goblin Guide\n4 Lightning Bolt\n52 Mountain')), 'modern');
  assert.equal(decklist.detectFormat(deckOf('4 Brainstorm\n4 Force of Will\n52 Island')), 'legacy');
  assert.equal(decklist.detectFormat(deckOf('1 Black Lotus\n1 Brainstorm\n58 Island')), 'vintage');
  assert.equal(decklist.detectFormat(deckOf('4 Black Lotus\n56 Island')), 'constructed');
  // A 59-card deck is still constructed, so it is told it is a card short
  assert.equal(decklist.detectFormat(deckOf('4 Counterspell\n55 Island')), 'pauper');
  assert.equal(decklist.detectFormat(deckOf('')), 'constructed');
});
test('reports cards a chosen format bans or restricts', () => {
  const deck = deckOf('4 Brainstorm\n4 Force of Will\n4 Goblin Guide\n48 Island', '15 Island');
  assert.deepEqual(errors(deck, 'legacy'), []);
  const vintage = decklist.check(deck, 'vintage').deckmain;
  assert.deepEqual([...vintage].map(problem => problem.error), ['restricted']);
  assert.deepEqual([...vintage[0].data.cards], ['Brainstorm']);
  const modern = decklist.check(deck, 'modern').deckmain;
  assert.deepEqual([...modern].map(problem => problem.error), ['illegal']);
  assert.deepEqual([...modern[0].data.cards], ['Brainstorm', 'Force of Will']);
  // Other constructed checks only sizes and copies
  assert.deepEqual(errors(deckOf('5 Brainstorm\n55 Island', '15 Island'), 'constructed'), ['quantity']);
});
test('honors the copy limits cards set for themselves', () => {
  assert.deepEqual(errors(deckOf('7 Seven Dwarves\n53 Mountain', '15 Mountain'), 'modern'), []);
  const problems = decklist.check(deckOf('8 Seven Dwarves\n52 Mountain', '15 Mountain'), 'modern').deckmain;
  assert.deepEqual([...problems[0].data.cards], ['Seven Dwarves (up to 7)']);
});
test('detects a Limited deck by its size', () => {
  assert.equal(decklist.detectFormat(deckOf('6 Grizzly Bears\n34 Forest', '30 Lightning Bolt')), 'limited');
  assert.equal(decklist.detectFormat(deckOf('6 Grizzly Bears\n39 Forest')), 'limited');
  // Past 45 it reads as constructed again
  assert.equal(decklist.detectFormat(deckOf('6 Grizzly Bears\n40 Forest')), 'pauper');
});
test('checks Limited decks for size alone', () => {
  assert.deepEqual(errors(deckOf('6 Grizzly Bears\n17 Forest\n17 Mountain', '30 Lightning Bolt'), 'limited'), []);
  assert.deepEqual(errors(deckOf('6 Grizzly Bears\n33 Forest'), 'limited'), ['toosmall']);
  // Constructed would also hold the Bears to 4 copies
  assert.deepEqual(errors(deckOf('6 Grizzly Bears\n33 Forest'), 'constructed'), ['toosmall', 'quantity', 'toosmall']);
});
