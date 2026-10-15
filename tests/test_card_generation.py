import json
from pathlib import Path
import subprocess
import tempfile
import unittest

GENERATOR = Path(__file__).resolve().parents[1] / 'js/cards/parsecards.py'

class CardGenerationTests(unittest.TestCase):
    def test_excludes_digital_cards_and_preserves_paper_cards(self):
        def card(name, printings):
            return [{'name': name, 'printings': printings, 'layout': 'normal',
                     'types': ['Creature'], 'colors': ['W'], 'legalities': {}}]
        data = {
            'A-Guide of Souls': card('A-Guide of Souls', ['MH3']),
            'Guide of Souls': card('Guide of Souls', ['MH3']),
            'Inquisitor Captain': card('Inquisitor Captain', ['YMID']),
            'Paper and digital': card('Paper and digital', ['YMID', 'MH3']),
            'Unknown printing': card('Unknown printing', ['FUTURE']),
            'No printing data': card('No printing data', []),
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'AtomicCards.json').write_text(json.dumps({'data': data}))
            (root / 'SetList.json').write_text(json.dumps({'data': [
                {'code': 'MH3', 'isOnlineOnly': False}, {'code': 'YMID', 'isOnlineOnly': True}
            ]}))
            subprocess.run(['python3', str(GENERATOR)], cwd=root, check=True)
            result = json.loads((root / 'decklist-cards.js').read_text()[6:])
        self.assertNotIn('a-guide of souls', result)
        self.assertNotIn('inquisitor captain', result)
        self.assertIn('guide of souls', result)
        self.assertIn('paper and digital', result)
        self.assertIn('unknown printing', result)
        self.assertIn('no printing data', result)

if __name__ == '__main__':
    unittest.main()
