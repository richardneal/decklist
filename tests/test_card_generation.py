import json
from pathlib import Path
import subprocess
import tempfile
import unittest

GENERATOR = Path(__file__).resolve().parents[1] / 'js/cards/parsecards.py'

def card(name, printings=('MH3',), types=('Creature',), colors=('W',)):
    return [{'name': name, 'printings': list(printings), 'layout': 'normal',
             'types': list(types), 'colors': list(colors), 'legalities': {}}]

def generate(data):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'AtomicCards.json').write_text(json.dumps({'data': data}))
        (root / 'SetList.json').write_text(json.dumps({'data': [
            {'code': 'MH3', 'isOnlineOnly': False}, {'code': 'YMID', 'isOnlineOnly': True}
        ]}))
        subprocess.run(['python3', str(GENERATOR)], cwd=root, check=True)
        return json.loads((root / 'decklist-cards.js').read_text()[6:])

class CardGenerationTests(unittest.TestCase):
    def test_excludes_digital_cards_and_preserves_paper_cards(self):
        result = generate({
            'A-Guide of Souls': card('A-Guide of Souls', ['MH3']),
            'Guide of Souls': card('Guide of Souls', ['MH3']),
            'Inquisitor Captain': card('Inquisitor Captain', ['YMID']),
            'Paper and digital': card('Paper and digital', ['YMID', 'MH3']),
            'Unknown printing': card('Unknown printing', ['FUTURE']),
            'No printing data': card('No printing data', []),
        })
        self.assertNotIn('a-guide of souls', result)
        self.assertNotIn('inquisitor captain', result)
        self.assertIn('guide of souls', result)
        self.assertIn('paper and digital', result)
        self.assertIn('unknown printing', result)
        self.assertIn('no printing data', result)

    def test_colorless_artifacts_get_the_artifact_color(self):
        # MTGJSON lists colors on every card, as [] for colorless ones
        result = generate({
            'Sol Ring': card('Sol Ring', types=['Artifact'], colors=[]),
            'Ornithopter': card('Ornithopter', types=['Artifact', 'Creature'], colors=[]),
            'Etched Champion': card('Etched Champion', types=['Artifact', 'Creature'], colors=['W']),
            'Eldrazi Devastator': card('Eldrazi Devastator', colors=[]),
            'Darksteel Citadel': card('Darksteel Citadel', types=['Artifact', 'Land'], colors=[]),
        })
        self.assertEqual(result['sol ring']['c'], 'G')
        self.assertEqual(result['ornithopter']['c'], 'G')
        self.assertEqual(result['etched champion']['c'], 'A')
        self.assertEqual(result['eldrazi devastator']['c'], 'X')
        self.assertEqual(result['darksteel citadel']['c'], 'Z')

    def test_prefers_the_tournament_card_over_a_namesake(self):
        # MTGJSON lists a Mystery Booster playtest card under the same name
        # as the real one, and sometimes first
        playtest = card('Pick Your Poison', ['CMB1'], types=['Sorcery'], colors=['B', 'G'])[0]
        playtest.update(isFunny=True, convertedManaCost=5.0)
        real = card('Pick Your Poison', ['MKM'], types=['Sorcery'], colors=['G'])[0]
        real.update(convertedManaCost=1.0, legalities={
            'standard': 'Legal', 'modern': 'Legal', 'legacy': 'Legal'})
        unsanctioned = card('Everythingamajig', ['UST'], types=['Artifact'], colors=[])
        unsanctioned[0]['convertedManaCost'] = 5.0
        unsanctioned.append(dict(unsanctioned[0], convertedManaCost=6.0))
        result = generate({
            'Pick Your Poison': [playtest, real],
            'Everythingamajig': unsanctioned,
        })
        self.assertEqual(result['pick your poison'],
                         {'c': 'E', 't': '3', 'm': 1.0, 'n': 'Pick Your Poison'})
        # With no tournament card among them, the first is kept
        self.assertEqual(result['everythingamajig']['m'], 5.0)

    def test_meld_cards_are_keyed_by_their_own_face(self):
        # As MTGJSON gives them: each front is 'Front // Melded result', and
        # the melded result has an entry of its own
        def face(name, layout, **fields):
            return {'name': name, 'printings': ['MH3'], 'layout': layout,
                    'legalities': {}, **fields}
        result = generate({
            'The Mightstone and Weakstone // Urza, Planeswalker': [face(
                'The Mightstone and Weakstone // Urza, Planeswalker', 'meld',
                faceName='The Mightstone and Weakstone', side='a',
                types=['Artifact'], colors=[], convertedManaCost=5.0)],
            'Urza, Lord Protector // Urza, Planeswalker': [face(
                'Urza, Lord Protector // Urza, Planeswalker', 'meld',
                faceName='Urza, Lord Protector', side='a',
                types=['Creature'], colors=['U', 'W'], convertedManaCost=3.0)],
            'Urza, Planeswalker': [face(
                'Urza, Planeswalker', 'meld', faceName='Urza, Planeswalker', side='b',
                types=['Planeswalker'], colors=['U', 'W'], convertedManaCost=8.0)],
            'Fire // Ice': [
                face('Fire // Ice', 'split', faceName='Fire', side='a', types=['Instant'],
                     colors=['R'], colorIdentity=['R', 'U'], convertedManaCost=4.0),
                face('Fire // Ice', 'split', faceName='Ice', side='b', types=['Instant'],
                     colors=['U'], colorIdentity=['R', 'U'], convertedManaCost=4.0)],
            'Bonecrusher Giant // Stomp': [
                face('Bonecrusher Giant // Stomp', 'adventure', faceName='Bonecrusher Giant',
                     side='a', types=['Creature'], colors=['R'], convertedManaCost=3.0),
                face('Bonecrusher Giant // Stomp', 'adventure', faceName='Stomp',
                     side='b', types=['Instant'], colors=['R'], convertedManaCost=3.0)],
            'Delver of Secrets // Insectile Aberration': [
                face('Delver of Secrets // Insectile Aberration', 'transform',
                     faceName='Delver of Secrets', side='a', types=['Creature'],
                     colors=['U'], convertedManaCost=1.0),
                face('Delver of Secrets // Insectile Aberration', 'transform',
                     faceName='Insectile Aberration', side='b', types=['Creature'],
                     colors=['U'], convertedManaCost=1.0)],
        })
        self.assertEqual(result['the mightstone and weakstone'],
                         {'c': 'G', 't': '5', 'm': 5.0, 'b': 'sml', 'n': 'The Mightstone and Weakstone'})
        self.assertEqual(result['urza, lord protector'],
                         {'c': 'F', 't': '2', 'm': 3.0, 'b': 'sml', 'n': 'Urza, Lord Protector'})
        self.assertEqual(result['urza, planeswalker']['n'], 'Urza, Planeswalker')
        self.assertNotIn('the mightstone and weakstone // urza, planeswalker', result)
        self.assertNotIn('urza, lord protector // urza, planeswalker', result)
        # Other multi-face layouts keep their keys
        self.assertEqual(result['fire // ice']['n'], 'Fire // Ice')
        self.assertEqual(result['bonecrusher giant']['n'], 'Bonecrusher Giant')
        self.assertEqual(result['delver of secrets']['n'], 'Delver of Secrets')
        self.assertEqual(sorted(result), ['bonecrusher giant', 'delver of secrets', 'fire // ice',
                                          'the mightstone and weakstone', 'urza, lord protector',
                                          'urza, planeswalker'])

if __name__ == '__main__':
    unittest.main()
