# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

decklist.nealston.com is a static website that generates Magic: The Gathering tournament registration sheets and decklists. It's a fork of the original [decklist.org](https://github.com/april/decklist) project by April King, enhanced with additional features and improvements.

The application runs entirely client-side using vanilla JavaScript, jQuery, and jsPDF. No build process is required to work on it — open `index.html` directly. Deployment adds two small Node pieces: `hosting/` (stages the static files and ships them to Cloudflare) and `worker/` (the Cloudflare Worker backing deck imports).

## Architecture

### Core JavaScript Modules

The application is split into three main JavaScript modules in `js/decklist/`, all loaded by `index.html`:

1. **decklist.js** - Core decklist parsing and manipulation
   - `Decklist.parse(deckmain, deckside)` - Parses various deck formats (MTGO, MWS, MTG Goldfish, Tappedout, etc.) into structured card objects
   - `Decklist.sort(deck, sortorder)` - Sorts decks by alphabetical, mana value, color, numeric, or type
   - `Decklist.section(deck, sectionType)` - Adds visual spacers between card groups
   - `Decklist.filter(deck, field, values, mode)` - Filters cards by properties
   - `Decklist.count(deck)` - Counts total cards in a deck
   - `Decklist.searchKey(name)` / `Decklist.searchIndex()` - Loose card-name form (case, accents and split-card slashes ignored) and a lazily built map from it to cards; used as the parser's loose lookup and by the deck autocomplete
   - A name that still matches nothing but contains `//` is retried as its front face, since double-faced, adventure, flip and prepare cards are stored under the front face alone while deck sites export both faces
   - Returns objects with structure: `{main: [], side: [], unrecognized: [], unparseable: []}`
   - Each card object has properties: `n` (name), `c` (color), `t` (type), `m` (mana value), `q` (quantity), `b` (formats it is not legal in)

2. **main.js** - Main application logic
   - Event handling for form inputs
   - PDF generation using jsPDF
   - URL parameter parsing for direct linking
   - History state management for permalinks
   - Input validation with debounced updates (400ms for validation, 1500ms for PDF generation)

3. **deckimport.js** - MTGGoldfish / MTGTop8 / Moxfield / Archidekt / Scryfall deck importing
   - `DeckImport.parse(value)` - Describes a recognized deck link as `{source, label, id, url}`; returns `null` for any other host, a URL carrying credentials or an explicit port, a non-http(s) scheme, or a missing/malformed deck ID. A Moxfield ID must be 16–32 base64url characters, which keeps routes such as `/decks/public` from reading as a deck; an Archidekt ID is numeric, optionally followed by the deck's name slug; a Scryfall ID is the UUID in `scryfall.com/@user/decks/<uuid>`, lowercased
   - `DeckImport.downloadURL(value)` - The canonical export URL from `parse`, or `null`
   - `DeckImport.split(text)` - Splits export text into `{main, side}`; throws if the response looks like HTML (a login or error page) or if any line is not quantity-prefixed
   - `DeckImport.load(value)` - Fetches through the import Worker with a 20s `AbortSignal.timeout`, then splits the result
   - `DeckImport.importFromParameters(params)` - Honors the `deckimport` URL parameter; an embedded `deckmain`/`deckside` takes precedence
   - `DeckImport.apiURL` points at the deployed Worker; set it to `http://localhost:8787/api/import` to test against `npm run dev --prefix worker`
   - Drives `#deckimport`, `#deckimport-button`, `#deckimport-help`, `#deckimport-status` and `#deckimport-undo`, and keeps an undo of the replaced deck text

### Card Data System

Card data is stored in `js/cards/decklist-cards-min.js` as a minified JavaScript object. The card database structure:
- Key: lowercase card name (with accents removed). Split cards keep the full `Fire // Ice` name; transform, modal DFC, adventure, flip, prepare and meld cards are keyed by their front face (`akki lavarunner`, `emeritus of woe`), and `getCard` falls back to the front face when a deck writes both halves. Tokens and `reversible_card` printings (doubled names such as `Forest // Forest`) are skipped
- Value: object with properties:
  - `c`: color code (A=White, B=Blue, C=Black, D=Red, E=Green, F=Gold, G=Artifact, Z=Land)
  - `t`: type code (1=Land, 2=Creature, 3=Sorcery, 4=Instant, 5=Other)
  - `m`: mana value (99 when MTGJSON gives none; lands are 0)
  - `b`: formats the card is not legal in (any combination of s/m/l for Standard/Modern/Legacy); generated but not yet read by the frontend
  - `n`: actual card name with proper capitalization

### URL Parameters for Direct Linking

The application supports extensive URL parameter support for pre-filling forms:
- Personal: `firstname`, `lastname`
- Event: `event`, `eventdate`, `eventlocation`
- Deck: `deckname`, `deckdesigner`, `deckmain`, `deckside`, `decksort`, `deckimport` (an MTGGoldfish, MTGTop8, Moxfield, Archidekt or Scryfall deck URL; ignored when `deckmain`/`deckside` are present)
- Display: `decksheet` (wotc/scg), `disableediting`

Use `%0A` for newlines in deck data, `%20` for spaces.

## Card Data Regeneration

The card database is refreshed daily by the **Refresh card data** workflow (`.github/workflows/generate-cards.yml`), on cron `17 4 * * *` or manual dispatch.

GitHub only runs scheduled workflows from the default branch, so the workflow lives on `main` and checks out `ref: main`. The site and the generated card data are published from that one branch.

### Manual Card Data Update

To manually regenerate the card database:

```bash
cd js/cards
./generatecards.sh
```

This script:
1. Downloads latest `AtomicCards.json.zip` from mtgjson.com
2. Runs `parsecards.py` to extract and compress card data
3. Minifies output using terser
4. Cleans up temporary files

**Requirements:**
- Python 3
- terser (install globally: `npm i terser -g`)
- curl and unzip

After generating the data the workflow runs the Python test gate (see Automated Tests), auto-commits `js/cards/decklist-cards-min.js` and its `.map` to `main` with the message `chore: refresh card data`, then builds and deploys the site to Cloudflare.

## Development Workflow

### Testing Changes

Since this is a static site:
1. Open `index.html` in a browser
2. Make changes to JavaScript/CSS files
3. Refresh the browser (hard refresh: Ctrl+F5 / Cmd+Shift+R)

For iframe preview testing, the app uses `srcdoc` attribute to render the decklist preview inline.

### Automated Tests

Five suites live in `tests/`. Install the worker dependencies once first (`wrangler` is the only one, and `worker.test.mjs` imports from `worker/`):

```bash
npm ci --prefix worker
```

Then, from the repository root:

```bash
node --test tests/*.test.*
python3 -m unittest discover --start-directory tests --pattern 'test_*.py'
```

- `tests/decklist.test.cjs` - Loads the real card data and `decklist.js` in a `vm`; covers loose name matching (split cards typed without `//`, double-faced cards spelled out in full) and front-face names for meld, flip and prepare cards
- `tests/deckimport.test.cjs` - Loads `deckimport.js` in a `vm` with a stubbed `$`; covers deck-URL recognition/rejection and export splitting
- `tests/decklist-sort.test.cjs` - Loads `decklist.js` in a `vm` with a stubbed `$`; covers mana value sorting and sectioning (0-mana spells first, then lands, then unrecognized cards)
- `tests/worker.test.mjs` - Imports `handle` from `worker/index.mjs` with a stubbed env, cache and fetch; covers the CORS origin allowlist, rate limiting, caching, and failure handling
- `tests/test_card_generation.py` - Drives `js/cards/parsecards.py` via subprocess; asserts digital-only cards (Alchemy `A-` prefixes, Arena-only printings) are excluded while paper cards are preserved. This is the gate the card-refresh workflow runs before committing.

### Common Modifications

**Adding a new deck format parser:**
- Edit `decklist.js`, add regex to `cardRE.main` or `cardRE.side` arrays
- Test with various inputs to ensure proper parsing

**Adding a new sort order:**
- Add sort function in `Decklist.sort()`
- Add corresponding UI radio button in `index.html`
- Add case to sort switch statement

**Adding sheet artwork:**
- Place the image file in `images/logos/` (JPEG, PNG or WebP)
- Add an entry to `LOGOS_CONFIG` at the top of `main.js`: `{ id, file, format }` (`format` is the jsPDF image format, e.g. `JPEG`)
- Every entry is preloaded into `logoCache` by `id` when the page loads; the layout functions draw from that cache. The WotC sheet always uses `mtg` — there is no logo picker or `logo` URL parameter

## Deployment

The site is served by **Cloudflare Workers Static Assets**, not GitHub Pages. Two separate Workers are involved:

- `nealston-decklist` — the static site at `decklist.nealston.com`, configured in `hosting/wrangler.jsonc`
- `decklist-import-api` — the import API at `deck-import.nealston.com`, source in `worker/index.mjs`, configured in `worker/wrangler.jsonc`

### Site

`.github/workflows/deploy-site.yml` deploys on every push to `main`, and on manual dispatch. It runs `npm ci --prefix worker`, `node hosting/build.mjs`, then `wrangler deploy --config hosting/wrangler.jsonc` using the `CLOUDFLARE_API_TOKEN` secret. The daily card refresh ends with those same build-and-deploy steps.

`hosting/build.mjs` stages the public files into the git-ignored `hosting/dist/`: `index.html`, `docs.html`, `favicon.ico`, `robots.txt`, `sitemap.xml`, `llms.txt`, `LICENSE`, `css/`, `images/` and `js/`. It filters out `*.py`, `*.sh` and `*.map`, so the card generator scripts and source maps never ship.

To deploy the site by hand:

```bash
npm ci --prefix worker
node hosting/build.mjs
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc --dry-run
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc
```

### Import API

The import Worker is deployed separately — pushing to `main` does **not** update it:

```bash
npm run deploy --prefix worker
```

It exposes `GET /api/import?source=mtggoldfish&id=123` (or `source=mtgtop8`, `source=archidekt` with a numeric deck ID, `source=scryfall` with a deck UUID, or `source=moxfield` with a base64url deck ID), fetches only fixed export URLs, rejects redirects and HTML, caches successes for five minutes, and rate-limits to 20 requests per minute per IP per location. Sources are declared in the `SOURCES` table at the top of `worker/index.mjs`: an entry gives the ID pattern, the upstream URL, the `Accept` header and, optionally, a `convert` step. Its CORS allowlist is the `ALLOWED_ORIGINS` var in `worker/wrangler.jsonc` — add an origin there if you host the frontend elsewhere.

**Moxfield is a JSON source.** It publishes no text export — the Copy buttons in its Export dialog are built in the browser from the deck JSON and hit no endpoint — and it sends no CORS headers, so the deck has to come through the Worker. The Worker reads `https://api2.moxfield.com/v3/decks/all/<id>` and `moxfieldDeck()` folds the boards into decklist text: commanders lead the main deck, a companion joins the sideboard, separate printings of one card merge, and the maybeboard is dropped.

Two things follow from that. The JSON spells out every card in full, so a 60-card deck runs about 140 KB; the `moxfield` source therefore raises `readBody`'s cap to 2 MB, while the text sources keep the 64 KB default.

**Archidekt is a JSON source too.** The Worker reads the unofficial but public `https://archidekt.com/api/decks/<id>/`, and `archidektDeck()` folds it into decklist text. Archidekt keeps its boards as categories, and a card's *first* category places it: `Sideboard` is the sideboard (Archidekt counts it as part of the deck, so it must be checked before exclusion), a premier category (the commander) leads the main deck, and any other category with `includedInDeck: false` (the Maybeboard, "Tokens & Extras", or a player's own such as "Need to get") is dropped. A companion goes to the sideboard whether Archidekt's per-card `companion` flag marks it or the player filed it under a `Companion` category. Those placement totals match Archidekt's own deck `size`. Archidekt's CORS allows only its own dev origin, so the Worker is required here too. A 100-card Commander deck's JSON is about 250 KB, inside the shared 2 MB cap. The JSON sources all write their text through `deckText()`, which merges separate printings of one card.

**Scryfall is a JSON source as well.** The Worker reads `https://api.scryfall.com/decks/<uuid>/export/json` and `scryfallDeck()` folds it by section key, which follows the deck's layout: a constructed deck has `mainboard`, `sideboard` and `maybeboard`; a Commander deck has `commanders`, `nonlands`, `lands`, `outside` (cards from outside the game, such as a companion, which go to the sideboard) and `maybeboard`. The maybeboard is dropped, as are blank entries with no `card_digest`. The JSON is preferred to Scryfall's text export, which labels sections with display headers (`// Commander`, `// Outside the Game`) and lists the commander after the main deck. Scryfall's API asks clients to send a `User-Agent`; the `USER_AGENT` var in `worker/wrangler.jsonc` sets it.

**Don't test the Moxfield source with `curl`.** Moxfield fronts its API with Cloudflare bot management, and the verdict follows the *original visitor*, not the Worker: a request the site makes for a real browser is served, while the same deck requested from `curl` comes back 403, seconds apart, on a deck neither has cached. So `curl` reports a feature that works in a browser as broken — and the Worker caches a success for five minutes, so a `curl` that follows a browser import gets a 200 off the cache and reports it as fixed. Both readings are wrong. Test it through the site in a browser, and when a deck must be uncached, use one nothing has fetched in the last five minutes.

A genuine refusal surfaces as the Worker's 502 and the UI tells the user to paste the exported deck text instead, which is the right fallback for the automated clients Moxfield means to turn away. `MOXFIELD_USER_AGENT` in `worker/wrangler.jsonc` sets the User-Agent the Worker identifies itself with; if Moxfield ever starts refusing browser traffic too, ask their support for an allowlisted one and put it there. Also available: `npm run dev --prefix worker` (local server on :8787) and `npm run check --prefix worker` (dry-run deploy).

## Important Notes

- All card name matching is case-insensitive with accent normalization
- The app HTML-encodes all user input to prevent XSS attacks
- PDF generation happens client-side using jsPDF library
- The iframe preview regenerates with debounced updates to avoid performance issues
- `main.js` contains `posthog.capture(...)` analytics calls, all guarded by `typeof posthog !== 'undefined'`. No PostHog snippet is loaded in `index.html`, so they are inert; adding the snippet would switch analytics on site-wide
