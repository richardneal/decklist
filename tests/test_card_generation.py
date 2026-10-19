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

if __name__ == '__main__':
    unittest.main()
