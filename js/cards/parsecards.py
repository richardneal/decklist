#!/usr/bin/env python3

from enum import Enum
import json
import unicodedata

# Each card is written out as {c, t, m, b, n}, keyed by its lowercase,
# accent-free name ('true name nemesis'):
#   c - Color
#   t - Type
#   m - mana value (NO_MANA_VALUE when MTGJSON gives none)
#   b - the first letter of each FORMATS entry the card is not legal in,
#       omitted when it is legal in all of them
#   n - the true name, 'True Name Nemesis'
# decklist.js sorts by these codes as strings, so their order is the color and
# type sort order on the sheet: renaming a member is free, changing a value is not.

class Color(str, Enum):
    WHITE     = 'A'
    BLUE      = 'B'
    BLACK     = 'C'
    RED       = 'D'
    GREEN     = 'E'
    GOLD      = 'F'
    ARTIFACT  = 'G'
    COLORLESS = 'X'
    LAND      = 'Z'

class Type(str, Enum):
    LAND     = '1'
    CREATURE = '2'
    SORCERY  = '3'
    INSTANT  = '4'
    OTHER    = '5'

MTGJSON_COLORS = {'W': Color.WHITE, 'U': Color.BLUE, 'B': Color.BLACK, 'R': Color.RED, 'G': Color.GREEN}

# Checked in order: an artifact creature is a creature, an artifact land a land
MTGJSON_TYPES = (('Land', Type.LAND), ('Creature', Type.CREATURE),
                 ('Sorcery', Type.SORCERY), ('Instant', Type.INSTANT))

NO_MANA_VALUE = 99

FORMATS = ('standard', 'modern', 'legacy')

FLIP_LAYOUTS = ('transform', 'modal_dfc', 'adventure')

# MTGJSON names each meld front 'Front // Melded result', and gives the melded
# result an entry of its own; the front is the card a deck lists.
FACE_NAME_LAYOUTS = FLIP_LAYOUTS + ('meld',)

def getLegalities(face):
    legalities = face.get('legalities', {})
    return ''.join(format[0] for format in FORMATS if legalities.get(format) != 'Legal')

def remove_accents(input_str):
    """Removes accents from a given string."""
    nfkd_form = unicodedata.normalize('NFKD', input_str)
    return "".join([c for c in nfkd_form if not unicodedata.combining(c)])

def getColorCode(colors):
    if len(colors) == 0:
        return Color.COLORLESS
    if len(colors) > 1:
        return Color.GOLD
    return MTGJSON_COLORS.get(colors[0], Color.COLORLESS)

def getFace(card):
    # We only care about the front face. MTGJSON can list more than one card
    # under a name, such as a Mystery Booster playtest Pick Your Poison beside
    # the real one; the first with legalities is the one decks register.
    fronts = [face for face in card if face.get('side', 'a') == 'a'] or card
    return min(fronts, key=lambda face: not face.get('legalities'))

def isFlip(face):
    return face['layout'] in FLIP_LAYOUTS

def getName(face):
    # Flip and meld cards are played, and written down, by their front face
    return face['faceName' if face['layout'] in FACE_NAME_LAYOUTS else 'name']

def getKey(face):
    # We're going to store them in lowercase, without accents.
    # Æ is a letter, not an accented A, so it stays as æ.
    return remove_accents(getName(face).lower())

def isDigital(face, online_sets):
    # Rebalanced Arena cards can share a paper set code with the original.
    # Keep cards with any paper (or unknown) printing; do not filter by legality.
    printings = face.get('printings', [])
    return face['name'].startswith('A-') or bool(printings and all(code in online_sets for code in printings))

def getColor(face):
    if 'Land' in face['types']:
        return Color.LAND
    # MTGJSON always lists colors, as an empty list for colorless cards
    if 'Artifact' in face['types'] and not face.get('colors'):
        return Color.ARTIFACT
    if face['layout'] == 'split' or isFlip(face):
        return getColorCode(face.get('colorIdentity', []))
    return getColorCode(face.get('colors', []))

def getType(face):
    for mtgjson_type, type_code in MTGJSON_TYPES:
        if mtgjson_type in face['types']:
            return type_code
    return Type.OTHER

def getManaValue(face):
    return face.get('convertedManaCost', NO_MANA_VALUE)

def getEntry(face):
    entry = {'c': getColor(face), 't': getType(face), 'm': getManaValue(face)}

    legality = getLegalities(face)
    if legality: entry['b'] = legality

    entry['n'] = getName(face)
    return entry

# Load all the cards into a giant dictionary
with open('AtomicCards.json', 'r') as jsonfh:
    cards = json.load(jsonfh)

# Atomic cards list their printing sets, but do not carry isOnlineOnly.
with open('SetList.json', 'r') as setfh:
    online_sets = {item['code'] for item in json.load(setfh)['data']
                   if item.get('isOnlineOnly', False)}

ocards = {}
for card in cards['data'].values():
    face = getFace(card)
    if face['layout'] == 'token' or isDigital(face, online_sets):
        continue
    ocards[getKey(face)] = getEntry(face)

# Print out the full list of cards
with open('decklist-cards.js', 'w') as ojsonfh:
    ojsonfh.write('cards=')
    json.dump(ocards, ojsonfh)
