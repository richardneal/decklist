#!/usr/bin/env python3

from enum import Enum
import json
import re
import unicodedata

# Each card is written out as {c, t, m, b, r, x, n}, keyed by its lowercase,
# accent-free name ('true name nemesis'):
#   c - Color
#   t - Type
#   m - mana value (NO_MANA_VALUE when MTGJSON gives none)
#   b - the FORMATS letter of each format the card is not legal in, omitted
#       when it is legal in all of them
#   r - the FORMATS letter of each format the card is restricted in (one
#       copy only), omitted when there are none
#   x - how many copies a deck may hold when the card itself says so, with 0
#       for any number (basic lands, Relentless Rats); omitted otherwise
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

# The MTGJSON layouts the generator treats specially; any other is read as a
# single-faced card
class Layout(str, Enum):
    SPLIT     = 'split'
    TRANSFORM = 'transform'
    MODAL_DFC = 'modal_dfc'
    ADVENTURE = 'adventure'
    FLIP      = 'flip'
    PREPARE   = 'prepare'
    MELD      = 'meld'
    TOKEN     = 'token'
    REVERSIBLE_CARD = 'reversible_card'

MTGJSON_COLORS = {'W': Color.WHITE, 'U': Color.BLUE, 'B': Color.BLACK, 'R': Color.RED, 'G': Color.GREEN}

# Checked in order: an artifact creature is a creature, an artifact land a land
MTGJSON_TYPES = (('Land', Type.LAND), ('Creature', Type.CREATURE),
                 ('Sorcery', Type.SORCERY), ('Instant', Type.INSTANT))

NO_MANA_VALUE = 99

# MTGJSON's name for each format a deck can be checked against, and the letter
# the b and r fields write it as; decklist.js reads the same letters
FORMATS = {'standard': 's', 'pioneer': 'p', 'modern': 'm', 'legacy': 'l',
           'vintage': 'v', 'pauper': 'u', 'commander': 'c'}

# 'A deck can have any number of cards named Relentless Rats.'
# 'A deck can have up to seven cards named Seven Dwarves.'
# 'A deck can have only one card named Once More with Feeling.'
COPY_LIMIT_RE = re.compile(r'A deck can have (any number of|up to \w+|only one) cards? named')
NUMBER_WORDS = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6,
                'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10}

# A card with a second face or spell, written down by its front face and
# coloured by both. Kamigawa flip cards and prepare cards (a creature
# with a spell it can cast a copy of) are named 'Front // Back' by MTGJSON.
FLIP_LAYOUTS = (Layout.TRANSFORM, Layout.MODAL_DFC, Layout.ADVENTURE, Layout.FLIP, Layout.PREPARE)

# MTGJSON names each meld front 'Front // Melded result', and gives the melded
# result an entry of its own; the front is the card a deck lists.
FACE_NAME_LAYOUTS = FLIP_LAYOUTS + (Layout.MELD,)

# Reversible cards print one card on both sides and only reprint cards that
# have entries of their own, under doubled names such as 'Forest // Forest'
SKIPPED_LAYOUTS = (Layout.TOKEN, Layout.REVERSIBLE_CARD)

def getLegalities(face, statuses):
    legalities = face.get('legalities', {})
    return ''.join(code for format, code in FORMATS.items() if legalities.get(format) in statuses)

def getIllegal(face):
    # MTGJSON leaves out the formats a card is not legal in, and names the
    # rest Legal, Restricted or Banned
    return getLegalities(face, (None, 'Banned', 'Not Legal'))

def getCopyLimit(face):
    if 'Basic' in face.get('supertypes', []):
        return 0
    match = COPY_LIMIT_RE.search(face.get('text', ''))
    if not match:
        return None
    amount = match.group(1)
    return 0 if amount == 'any number of' else NUMBER_WORDS.get(amount.split()[-1])

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
    if face['layout'] == Layout.SPLIT or isFlip(face):
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

    illegal = getIllegal(face)
    if illegal: entry['b'] = illegal
    restricted = getLegalities(face, ('Restricted',))
    if restricted: entry['r'] = restricted
    limit = getCopyLimit(face)
    if limit is not None: entry['x'] = limit

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
    if face['layout'] in SKIPPED_LAYOUTS or isDigital(face, online_sets):
        continue
    ocards[getKey(face)] = getEntry(face)

# Print out the full list of cards
with open('decklist-cards.js', 'w') as ojsonfh:
    ojsonfh.write('cards=')
    json.dump(ocards, ojsonfh)
