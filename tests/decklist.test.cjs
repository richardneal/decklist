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
const names = list => Array.from(list, card => card.q + ' ' + card.n);
const sections = (main, side = '') => {
  const deck = decklist.parse(main, side);
  return { main: names(deck.main), side: names(deck.side),
    unrecognized: [...deck.unrecognized], unparseable: [...deck.unparseable] };
};
const ARENA = `About
Name Mono Red Burn

Companion
1 Lurrus of the Dream-Den (IKO) 226

Deck
4 Lightning Bolt (2X2) 117
1 Fire // Ice (MH2) 290 *F*
20 Mountain (ANA) 1

Sideboard
1 Lurrus of the Dream-Den (IKO) 226
2 Blood Moon (DMR) 123`;

test('reads an Arena export by its headers, without its printings', () => {
  assert.deepEqual(sections(ARENA), {
    main: ['4 Lightning Bolt', '1 Fire // Ice', '20 Mountain'],
    // The companion is listed twice, under Companion and in the sideboard, and counted once
    side: ['1 Lurrus of the Dream-Den', '2 Blood Moon'],
    unrecognized: [], unparseable: [],
  });
});
test('puts commanders first in the sideboard, then a companion', () => {
  const commander = "Companion\n1 Lurrus of the Dream-Den\n\nCommander\n1 Atraxa, Praetors' Voice (2X2) 190\n\n" +
    'Deck\n1 Sol Ring (CMR) 472 *F*\n97 Island\n\nSideboard\n1 Pyroblast';
  assert.deepEqual(sections(commander).side, ["1 Atraxa, Praetors' Voice", '1 Lurrus of the Dream-Den', '1 Pyroblast']);
  // A commander in the main input leads cards typed in the sideboard input too
  assert.deepEqual(sections("Commanders:\n1 Atraxa, Praetors' Voice\nDeck:\n1 Sol Ring", '1 Pyroblast').side,
    ["1 Atraxa, Praetors' Voice", '1 Pyroblast']);
  assert.equal(decklist.detectFormat(decklist.parse(commander, '')), 'commander');
});
test('matches headers in any case, with a colon or a count', () => {
  for (const [main, side] of [['Main', 'Sideboard'], ['MAINBOARD:', 'SIDE BOARD:'], ['Maindeck', 'SB:'],
    ['main deck (4)', 'sideboard (2)'], ['Deck', 'Sideboard - 2 cards']]) {
    assert.deepEqual(sections(`${main}\n4 Brainstorm\n\n${side}\n2 Blood Moon`),
      { main: ['4 Brainstorm'], side: ['2 Blood Moon'], unrecognized: [], unparseable: [] }, main);
  }
  // Headers work in the sideboard input too
  assert.deepEqual(sections('4 Brainstorm', 'Sideboard\n2 Blood Moon').side, ['2 Blood Moon']);
});
test('skips an About block up to the next blank line', () => {
  const deck = sections('About\nName Name Dropping\n\nDeck\n4 Brainstorm');
  assert.deepEqual(deck, { main: ['4 Brainstorm'], side: [], unrecognized: [], unparseable: [] });
  // A header ends it too, and Name means nothing outside it
  assert.deepEqual(sections('About\nName Burn\nDeck\n4 Brainstorm\n1 Name Dropping').main, ['4 Brainstorm', '1 Name Dropping']);
});
test('strips printings and foil markers before looking cards up', () => {
  assert.deepEqual(sections('4 Lightning Bolt (2X2) 117\n1 Sol Ring (CMR) 472 *F*\n1 Arcane Signet (plst) CMR-297 *E*\n' +
    '1 Counterspell (MH2)\n1 Brainstorm *F*\n1 Made Up Card (ABC) 12 *F*'), {
    main: ['4 Lightning Bolt', '1 Sol Ring', '1 Arcane Signet', '1 Counterspell', '1 Brainstorm', '1 Made Up Card'],
    side: [], unrecognized: ['Made Up Card'], unparseable: [],
  });
  // Unless the parenthesis is the card's own
  assert.deepEqual(sections('1 Hazmat Suit (Used)\n1 Imaginary Friends (Plane)\n1 Imaginary Friends (UNF) 12').main,
    ['1 Hazmat Suit (Used)', '1 Imaginary Friends (Plane)', '1 Imaginary Friends']);
});
test('sends SB: lines to the sideboard from either input', () => {
  assert.deepEqual(sections('4 Brainstorm\nSB: 2 Blood Moon\nSB:  1 [M10] Duress\n56 Island', 'SB: 1 Pyroblast'), {
    main: ['4 Brainstorm', '56 Island'], side: ['2 Blood Moon', '1 Duress', '1 Pyroblast'], unrecognized: [], unparseable: [],
  });
});
test('a blank line after main deck cards still starts the sideboard, unless a header follows', () => {
  assert.deepEqual(sections('4 Brainstorm\n56 Island\n\n2 Blood Moon\n13 Mountain'),
    { main: ['4 Brainstorm', '56 Island'], side: ['2 Blood Moon', '13 Mountain'], unrecognized: [], unparseable: [] });
  assert.deepEqual(sections('Deck\r\n4 Brainstorm\r\n\r\n\r\n2 Blood Moon\r\n').side, ['2 Blood Moon']);
  // Before the companion, there are no main deck cards yet for the blank line to end
  assert.deepEqual(sections('Companion\n1 Lurrus of the Dream-Den\n\nDeck\n4 Brainstorm').main, ['4 Brainstorm']);
  assert.deepEqual(sections('Deck\n4 Brainstorm\n\nDeck\n56 Island').main, ['4 Brainstorm', '56 Island']);
  // The sideboard input has no main deck to end
  assert.deepEqual(sections('', '2 Blood Moon\n\n1 Duress').side, ['2 Blood Moon', '1 Duress']);
});

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
  assert.deepEqual([...problems[0].data.cards], ['Sol Ring (2 copies; limit 1)']);
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
  assert.deepEqual([...problems[0].data.cards], ['Seven Dwarves (8 copies; limit 7)']);
  const bolts = decklist.check(deckOf('5 Lightning Bolt\n55 Mountain', '15 Mountain'), 'modern').deckmain;
  assert.deepEqual([...bolts[0].data.cards], ['Lightning Bolt (5 copies; limit 4)']);
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
