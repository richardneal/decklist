const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
// sort() and section() read the checked sort order even when one is passed
const context = vm.createContext({ $: () => ({ prop: () => 'sort-manavalue' }) });
vm.runInContext(fs.readFileSync('js/decklist/decklist.js', 'utf8'), context);
const decklist = context.Decklist;

const deck = () => [
  { n: 'Forest', t: '1', m: 0, q: 4 },
  { n: 'Unknown Card', q: 1 },
  { n: 'Lightning Bolt', t: '4', m: 1, q: 4 },
  { n: 'Ornithopter', t: '2', m: 0, q: 4 },
  { n: 'Dryad Arbor', t: '1', m: 0, q: 1 },
  { n: 'Memnite', t: '2', m: 0, q: 4 },
];

test('sorts 0-mana spells first, then lands, then unrecognized cards', () => {
  assert.deepEqual(decklist.sort(deck(), 'manavalue').map(card => card.n),
    ['Memnite', 'Ornithopter', 'Lightning Bolt', 'Dryad Arbor', 'Forest', 'Unknown Card']);
});

test('sections lands apart from 0-mana spells', () => {
  const sectioned = decklist.section(decklist.sort(deck(), 'manavalue'), 'manavalue');
  assert.deepEqual(sectioned.map(card => card.n),
    ['Memnite', 'Ornithopter', '', 'Lightning Bolt', '', 'Dryad Arbor', 'Forest', '', 'Unknown Card']);
});

test('still sections by color and type', () => {
  const cards = [{ n: 'A', c: 'A', t: '2' }, { n: 'B', c: 'A', t: '4' }, { n: 'C', c: 'Z', t: '4' }];
  assert.deepEqual(decklist.section(cards.slice(), 'color').map(card => card.n), ['A', 'B', '', 'C']);
  assert.deepEqual(decklist.section(cards.slice(), 'type').map(card => card.n), ['A', '', 'B', 'C']);
});
