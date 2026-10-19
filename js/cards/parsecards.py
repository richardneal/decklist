#!/usr/bin/env python3

import json
import unicodedata

# Just FYI!
# b (not legal in) = [sml] (standard, modern, legacy)
# c (color) = White = A, Blue = B, Black = C, Red = D, Green = E, Gold = F, Artifact = G, Unknown = X, Land = Z
# m (mana value) = N
# n (actual name) = 'true name nemesis' to 'True Name Nemesis'
# t (type) = 1 = land, 2 = creature, 3 = sorcery, 4 = instant, 5 = other

FORMATS = ('standard', 'modern', 'legacy')

FLIP_LAYOUTS = ('transform', 'modal_dfc', 'adventure')

def getLegalities(face):
    # Let's figure out legalities
    banned = 'sml'

    for format in FORMATS:
        if face.get('legalities', {}).get(format) == 'Legal':
            banned = banned.replace(format[0].lower(), '')

    return(banned)

def remove_accents(input_str):
    """Removes accents from a given string."""
    nfkd_form = unicodedata.normalize('NFKD', input_str)
    return "".join([c for c in nfkd_form if not unicodedata.combining(c)])

def getColorCode(colors):
    color_map = {'W': 'A', 'U': 'B', 'B': 'C', 'R': 'D', 'G': 'E'}
    if len(colors) == 0:
        return 'X'  # X for unknown or no color
    if len(colors) > 1:
        return 'F'  # Gold for multiple colors
    return color_map.get(colors[0], 'X')

def getFace(card):
    # We only care about the first face
    if 'side' not in card[0] or len(card) == 1:
        return card[0]
    return card[0] if card[0]['side'] == 'a' else card[1]

def isFlip(face):
    return face['layout'] in FLIP_LAYOUTS

def getName(face):
    # Flip cards are played, and written down, by their front face
    return face['faceName' if isFlip(face) else 'name']

def getKey(face):
    # We're going to store them in lowercase, without accents
    key = remove_accents(getName(face).lower())

    # Python's Unicode support sucks, as does everybodies.  Manually
    # replace the Ae to lower case
    return key.replace(u'\xc6', u'\xe6')

def isDigital(face, online_sets):
    # Rebalanced Arena cards can share a paper set code with the original.
    # Keep cards with any paper (or unknown) printing; do not filter by legality.
    printings = face.get('printings', [])
    return face['name'].startswith('A-') or bool(printings and all(code in online_sets for code in printings))

def getColor(face):
    if 'Land' in face['types']:
        return 'Z'
    # MTGJSON always lists colors, as an empty list for colorless cards
    if 'Artifact' in face['types'] and not face.get('colors'):
        return 'G'
    if face['layout'] == 'split' or isFlip(face):
        return getColorCode(face.get('colorIdentity', []))
    return getColorCode(face.get('colors', []))

def getType(face):
    if   'Land'     in face['types']:  return '1'
    elif 'Creature' in face['types']:  return '2'
    elif 'Sorcery'  in face['types']:  return '3'
    elif 'Instant'  in face['types']:  return '4'
    else:                              return '5'

def getManaValue(face):
    return face.get('convertedManaCost', 99)

def getEntry(face):
    entry = {'c': getColor(face), 't': getType(face), 'm': getManaValue(face)}

    # Add it into the file if the banned list isn't empty
    legality = getLegalities(face)
    if legality != '': entry['b'] = legality

    # And put the true name in there as well
    entry['n'] = getName(face)
    return entry

# Load all the cards into a giant dictionary
with open('AtomicCards.json', 'r') as jsonfh:
    cards = json.load(jsonfh)

# Atomic cards list their printing sets, but do not carry isOnlineOnly.
with open('SetList.json', 'r') as setfh:
    online_sets = {item['code'] for item in json.load(setfh)['data']
                   if item.get('isOnlineOnly', False)}

# Okay, we need the colors but in a much shorter format
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
