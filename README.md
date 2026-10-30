decklist
========

The code behind [decklist.app](https://decklist.app), which generates Magic: The Gathering tournament Registration Sheets, an enhanced version of the original [decklist](https://www.decklist.org) project created by April King.

This fork includes additional features and improvements aimed at providing a more comprehensive and user-friendly experience for generating MTG deck lists.

## Features

### Modern User Interface
- **Dark Mode**: Toggle between light and dark themes with persistent preference storage
- **Responsive Design**: Fully optimized for mobile, tablet, and desktop viewing
- **Modern Styling**: Clean, professional interface with smooth transitions and hover effects
- **Accessible**: High contrast ratios and keyboard-friendly controls

### Deck Management
- **Save/Load Functionality**: Save your decklist locally and load it anytime
- **Clear all**: Quick reset button to start fresh
- **Card Autocomplete**: Smart card name suggestions as you type (supports 2+ character searches)
- **Import by URL**: Paste an MTGGoldfish deck URL or an MTGTop8 event URL containing a deck ID, then click **Import Deck**. Downloads use a dedicated Cloudflare Worker at `https://import.decklist.app/api/import`; if it is unavailable, paste the exported deck text instead. See [Worker setup](worker/README.md).
- **Multiple Format Support**: Import from MTGO, MTGGoldfish, TappedOut, MWS, MTG Salvation, and Deckbox

### Deck Organization
- **Multiple Sort Options**:
  - Alphabetical
  - Mana Value
  - Color
  - Numeric
  - Type (recommended)
  - Original order
- **Separate Basic Lands**: Option to group basic lands separately

### Registration Sheets
- **WotC Format**: Official Wizards of the Coast tournament registration sheets
- **Direct Linking**: Pre-fill forms via URL parameters for tournament organizers

### Card Database
- **Daily Updates**: Automated card database updates from mtgjson.com
- **Comprehensive Coverage**: Includes all Magic: The Gathering cards with metadata
- **Smart Validation**: Real-time deck validation with helpful warnings and errors

## Direct Linking

Interested in directly linking to [decklist.app](https://decklist.app) for your tournament or for your deck building application?  It's super easy!  Simply set the following GET parameters to have the fields automatically populated:

- **`firstname`**: the participant's first name (e.g. April)
- **`lastname`**: the participant's last name (e.g. King)
- **`event`**: the name of the event (e.g. RCQ Minneapolis)
- **`eventdate`**: the date of the event (e.g. 2027-12-31)
- **`eventlocation`**: the physical location of the event (e.g. Minneapolis Convention Center)
- **`deckname`**: the name of the deck (e.g. "RUG Twin")
- **`deckdesigner`**: the name of the designer of the decklist
- **`deckmain`**: the deck itself; this can be in any format the website understands (use `%0A` for newlines)
- **`deckside`**: the side itself; this can be in any format the website understands (use `%0A` for newlines)
- **`decksort`**: change the order of the cards in the mainboard and sideboard (choices: `alphabetical`, `manavalue`, `color`, `numeric`, `original`, `type`, defaults to `type`)
- **`disableediting`**: prevent users from editing the fields above

Please note that any field not specifically set will simply be left blank on the form.

_Tournament organizer example, for an unregistered player:_

```
https://decklist.app/?eventdate=2027-12-31&event=RCQ%20Minneapolis&eventlocation=Minneapolis%20Convention%20Center
```

_Or a preregistered player:_

```
https://decklist.app/?firstname=April&lastname=King&eventdate=2027-12-31&event=RCQ%20Minneapolis&eventlocation=Minneapolis%20Convention%20Center
```

Just replace the values above with your tournament's values; that's all! Please note that when creating a link, to replace spaces with `%20`; this is important! :)

_Deck building website example:_

```
https://decklist.app/?deckmain=2%09Arid%20Mesa%0A4%09Brainstorm%0A1%09Council%27s%20Judgment%0A4%09Counterbalance%0A2%09Counterspell%0A2%09Entreat%20the%20Angels%0A4%09Flooded%20Strand%0A4%09Force%20of%20Will%0A4%09Island%0A3%09Jace%2C%20the%20Mind%20Sculptor%0A2%09Plains%0A2%09Polluted%20Delta%0A4%09Ponder%0A2%09Scalding%20Tarn%0A4%09Sensei%27s%20Divining%20Top%0A3%09Snapcaster%20Mage%0A4%09Swords%20to%20Plowshares%0A4%09Terminus%0A3%09Tundra%0A2%09Volcanic%20Island&deckside=1%09Council%27s%20Judgment%0A1%09Counterspell%0A1%09Disenchant%0A3%09Flusterstorm%0A1%09Keranos%2C%20God%20of%20Storms%0A1%09Path%20to%20Exile%0A1%09Pyroblast%0A2%09Red%20Elemental%20Blast%0A2%09Rest%20in%20Peace%0A1%09Supreme%20Verdict%0A1%09Surgical%20Extraction%0A
```
_Everything all together:_

```
https://decklist.app/?firstname=April&lastname=King&eventdate=2027-12-31&event=RCQ%20Minneapolis&eventlocation=Minneapolis%20Convention%20Center&deckname=Miracles&deckdesigner=CubeApril&deckmain=2%09Arid%20Mesa%0A4%09Brainstorm%0A1%09Council%27s%20Judgment%0A4%09Counterbalance%0A2%09Counterspell%0A2%09Entreat%20the%20Angels%0A4%09Flooded%20Strand%0A4%09Force%20of%20Will%0A4%09Island%0A3%09Jace%2C%20the%20Mind%20Sculptor%0A2%09Plains%0A2%09Polluted%20Delta%0A4%09Ponder%0A2%09Scalding%20Tarn%0A4%09Sensei%27s%20Divining%20Top%0A3%09Snapcaster%20Mage%0A4%09Swords%20to%20Plowshares%0A4%09Terminus%0A3%09Tundra%0A2%09Volcanic%20Island&deckside=1%09Council%27s%20Judgment%0A1%09Counterspell%0A1%09Disenchant%0A3%09Flusterstorm%0A1%09Keranos%2C%20God%20of%20Storms%0A1%09Path%20to%20Exile%0A1%09Pyroblast%0A2%09Red%20Elemental%20Blast%0A2%09Rest%20in%20Peace%0A1%09Supreme%20Verdict%0A1%09Surgical%20Extraction%0A
```

### Tests

Install the worker dependencies once (the Worker test imports from `worker/`):

```sh
npm ci --prefix worker
```

Then, from the repository root:

```sh
node --test tests/*.test.*
python3 -m unittest discover --start-directory tests --pattern 'test_*.py'
```

The Node suites cover deck-URL validation, export parsing, and import failures, plus the Worker's CORS allowlist, rate limiting and caching. The Python suite checks that card generation excludes digital-only cards; the daily card-refresh workflow runs it before committing new data.

### Import directly from a link

Put the site's address in front of an MTGGoldfish, MTGTop8, Moxfield, Archidekt or Scryfall deck link, and the page opens with that deck imported:

```text
https://decklist.app/https://www.mtggoldfish.com/deck/6837920
decklist.app/moxfield.com/decks/<id>
```

The deck link's `https://` is optional and nothing needs encoding, MTGTop8's `?e=…&d=…&f=…` included. `hosting/index.mjs` redirects such a path to the `deckimport` parameter.

To combine an import with event or player details, use `deckimport` directly:

```text
https://decklist.app/?event=FNM&deckimport=https%3A%2F%2Fwww.mtggoldfish.com%2Fdeck%2F6837920
```

Encode the deck link with `encodeURIComponent`, especially MTGTop8 URLs containing `&`. Explicit `deckmain` or `deckside` parameters take precedence and suppress automatic importing. Invalid links display an error; you can edit the link and retry with **Import Deck**.
