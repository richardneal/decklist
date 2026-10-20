# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

decklist.app is a static website that generates Magic: The Gathering tournament registration sheets and decklists. It's a fork of the original [decklist.org](https://github.com/april/decklist) project by April King, enhanced with additional features and improvements.

The application runs entirely client-side using vanilla JavaScript, jQuery, and jsPDF. No build process is required to work on it — open `index.html` directly. Deployment adds two small Node pieces: `hosting/` (stages the static files and ships them to Cloudflare, with a small script that redirects deck links written after the site's address) and `worker/` (the Cloudflare Worker backing deck imports).

## Architecture

### Core JavaScript Modules

The application is split into three main JavaScript modules in `js/decklist/`, all loaded by `index.html`:

1. **decklist.js** - Core decklist parsing and manipulation
   - `Decklist.parse(deckmain, deckside)` - Parses various deck formats (MTG Arena, Moxfield, MTGO, MWS, MTG Goldfish, Tappedout, etc.) into structured card objects
     - Header lines switch the section, in either textarea, in any case and with an optional colon or `(count)`: `Deck`/`Main`/`Mainboard`/`Maindeck`/`Main Deck` for the main deck, `Sideboard`/`Side Board`/`SB` (and, as before, any line starting with `Sideboard`) for the sideboard, `Commander(s)` and `Companion(s)`. Lookup is the `sections` table in `parse()`
     - Commander and Companion cards go to the sideboard, commanders first, then companions, then the rest of the sideboard, as the import Worker places them. A companion also listed under Sideboard (Arena lists it in both) is counted once
     - An `About` block (Arena's `Name <deck name>` line) is skipped up to the next blank line or header
     - Lines starting with `//` (MWS and Scryfall comments) are ignored without touching any section state, and a `Maybeboard` section is dropped up to the next header, as the import Worker drops it
     - A blank line after main deck cards in the main textarea still starts the sideboard, unless a header follows it, so an Arena export's blank lines don't move the main deck
     - `SB: 2 Blood Moon` lines go to the sideboard from either textarea
     - A trailing printing, ` (SET) 123` and any `*F*`/`*E*` foil markers, is stripped before lookup (`printingRE`), unless the full name is itself a card key, as `Hazmat Suit (Used)` and `Imaginary Friends (Plane)` are
   - `Decklist.sort(deck, sortorder)` - Sorts decks by alphabetical, mana value, color, numeric, or type
   - `Decklist.section(deck, sectionType)` - Adds visual spacers between card groups
   - `Decklist.filter(deck, field, values, mode)` - Filters cards by properties
   - `Decklist.count(deck)` - Counts total cards in a deck
   - `Decklist.searchKey(name)` / `Decklist.searchIndex()` - Loose card-name form (case, accents and split-card slashes ignored) and a lazily built map from it to cards; used as the parser's loose lookup and by the deck autocomplete
   - A name that still matches nothing but contains `//` is retried as its front face, since double-faced, adventure, flip and prepare cards are stored under the front face alone while deck sites export both faces
   - Returns objects with structure: `{main: [], side: [], unrecognized: [], unparseable: []}`
   - `Decklist.formats` - The formats a deck can be checked against (Standard, Pioneer, Modern, Legacy, Vintage, Pauper, Premodern, Old School, Commander, Duel Commander, Pauper Commander, PreDH, Oathbreaker, Other constructed, Limited), each with its rules (`constructed`, `commander`, `oathbreaker` or `limited`) and, for those with a card pool, the letter the card data's `b`/`r` fields use. Keys follow MTGJSON's legality names (`duel`, `paupercommander`, `predh`, `oldschool`…). Pauper Commander sets `uncheckedCommander`: its commander is a creature printed at uncommon, and the card data has no rarity, so a card only in its sideboard is not checked for legality
   - `Decklist.isSingleton(format)` - True for the `commander` and `oathbreaker` rules: one copy of each card, with the deck's leaders (commander, or Oathbreaker and signature spell) listed in the sideboard
   - `Decklist.check(deck, format)` - Checks a `parse()` result against a format: deck size (60/15 for constructed; exactly 100 counting the commander, or 101 with a companion, for Commander and its variants; exactly 60 counting the Oathbreaker and its signature spell, which make up a 2-card sideboard, for Oathbreaker; at least 40 for Limited), copies (4, or 1 in a singleton format or for a card restricted in a constructed format, unless the card's own `x` says otherwise; Limited has no limit) and legality. In a Commander variant a restricted card is one that may not be the commander (Duel Commander's list), reported as `notcommander` when it is in the sideboard. Returns `{deckmain, deckside}` lists of validation objects that `main.js` turns into messages
   - `Decklist.detectFormat(deck)` - Auto-detect: `commander` for a 90+ card main deck with at most 3 sideboard cards, `limited` for a 40–45 card main deck, otherwise the narrowest of Standard, Pioneer, Pauper, Modern, Legacy and Vintage the deck passes, otherwise `constructed`. Because it picks a format the deck is legal in, auto-detect never reports an illegal card; only a chosen format does. It picks only these main formats, never Premodern, Old School, Oathbreaker or a Commander variant: a narrow card pool like Premodern's would claim decks that are really Legacy
   - Each card object has properties: `n` (name), `c` (color), `t` (type), `m` (mana value), `q` (quantity), `b` (formats it is not legal in), `r` (formats it is restricted in), `x` (its own copy limit)

2. **main.js** - Main application logic
   - Event handling for form inputs
   - PDF generation using jsPDF
   - URL parameter parsing for direct linking
   - History state management for permalinks: `generatePermalink()` builds the link from the form as query parameters (`+` for spaces), adding `decksheet` and `decksort` when they differ from the defaults (`wotc`, `type`). The address bar and history use it; the history state always keeps the sheet and sort, so Back restores a default one too. A sheet or sort click records its step in `pushHistoryState()` after the current event, so a Back that clicks several radios finishes first. Copy Permalink (`sharePermalink()`) shares that same link on the live origin, through the native share sheet on a touch device (`navigator.share` with a coarse pointer) and the clipboard everywhere else. The whole form rides in the link; nothing is sent to a shortener or any other service
   - Input validation with debounced updates (400ms for validation, 1500ms for PDF generation); deck size, copy and legality checks come from `Decklist.check()` for the format in `#deckformat` (empty means auto-detect, and the Auto-detect option's text names the format it picked). Both sheets sort the sideboard with the main deck's sort order, except a singleton deck's (Commander, its variants and Oathbreaker; `sortSideboard()`), which keeps the order it was entered in so an imported commander stays on its first line

3. **deckimport.js** - MTGGoldfish / MTGTop8 / Moxfield / Archidekt / Scryfall deck importing
   - `DeckImport.parse(value)` - Describes a recognized deck link as `{source, label, id, url}`; returns `null` for any other host, a URL carrying credentials or an explicit port, a non-http(s) scheme, or a missing/malformed deck ID. A Moxfield ID must be 16–32 base64url characters, which keeps routes such as `/decks/public` from reading as a deck; an Archidekt ID is numeric, optionally followed by the deck's name slug; a Scryfall ID is the UUID in `scryfall.com/@user/decks/<uuid>`, lowercased
   - `DeckImport.downloadURL(value)` - The canonical export URL from `parse`, or `null`
   - `DeckImport.split(text)` - Splits export text into `{main, side}`; throws if the response looks like HTML (a login or error page) or if any line is not quantity-prefixed
   - `DeckImport.load(value)` - Fetches through the import Worker with a 20s `AbortSignal.timeout`, then splits the result and adds `format`: the Worker's `X-Deck-Format` header, else an MTGTop8 link's `f` parameter (`ST`, `PI`, `MO`, `LE`, `VI`, `PAU`, `PREM` for Premodern, `EDH` for Duel Commander), else `''`. The import sets `#deckformat` to it, so a deck with no format goes back to Auto-detect, and undo restores the previous choice. It also adds `name`, the Worker's `X-Deck-Name` header percent-decoded, else `''` (MTGTop8, a malformed encoding, or a Worker that predates the header). A name replaces `#deckname`; with none, or when the player typed a name while the deck was on its way, the field is left as it is. Undo puts back the replaced name unless the field has been edited since the import
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
  - `b`: formats the card is not legal in (banned, or outside the format's card pool), as letters from `FORMATS` in `parsecards.py`: s/p/m/l/v/u/c for Standard/Pioneer/Modern/Legacy/Vintage/Pauper/Commander, and e/o/d/a/h/t for Premodern/Old School/Duel Commander/Pauper Commander/PreDH/Oathbreaker. `Decklist.formats` uses the same letters. Pauper Commander's card pool is the commons, so an uncommon creature that may be a commander is marked not legal there
  - `r`: formats the card is restricted in, in the same letters: `v` and `o` (one copy in Vintage and Old School), and `d`, where MTGJSON's Restricted marks a card that may not be the commander in Duel Commander
  - `x`: the card's own copy limit, from its rules text ("A deck can have any number of cards named…", "up to seven", "only one"); `0` means any number, and every basic land gets `0`. It replaces the format's limit, so the frontend needs no list of basic lands
  - `n`: actual card name with proper capitalization

### URL Parameters for Direct Linking

The application supports extensive URL parameter support for pre-filling forms:
- Personal: `firstname`, `lastname`
- Event: `event`, `eventdate`, `eventlocation`
- Deck: `deckname`, `deckdesigner`, `deckformat` (a key of `Decklist.formats`; absent or unknown means auto-detect), `deckmain`, `deckside`, `decksort`, `deckimport` (an MTGGoldfish, MTGTop8, Moxfield, Archidekt or Scryfall deck URL; ignored when `deckmain`/`deckside` are present)
- Path: a deck link written after the site's address, `decklist.app/https://moxfield.com/decks/<id>` (the `https://` optional, nothing encoded), redirects to `/?deckimport=<link>`; see Deployment
- Display: `decksheet` (wotc/scg), `disableediting`

Use `%0A` for newlines in deck data, `%20` or `+` for spaces (generated permalinks use `+`).

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

Seven suites live in `tests/`. Install the worker dependencies once first (`wrangler` is the only one, and `worker.test.mjs` imports from `worker/`):

```bash
npm ci --prefix worker
```

Then, from the repository root:

```bash
node --test tests/*.test.*
python3 -m unittest discover --start-directory tests --pattern 'test_*.py'
```

- `tests/decklist.test.cjs` - Loads the real card data and `decklist.js` in a `vm`; covers loose name matching (split cards typed without `//`, double-faced cards spelled out in full), front-face names for meld, flip and prepare cards, pasted exports (Arena headers and companions, set codes and foil markers, `SB:` lines, the blank-line sideboard switch), and the format checks and auto-detection. The format tests rely on current ban lists, so a ban or unban can break one
- `tests/deckimport.test.cjs` - Loads `deckimport.js` in a `vm` with a stubbed `$`; covers deck-URL recognition/rejection, export splitting, and the imported deck's format and name
- `tests/decklist-sort.test.cjs` - Loads `decklist.js` in a `vm` with a stubbed `$`; covers mana value sorting and sectioning (0-mana spells first, then lands, then unrecognized cards)
- `tests/worker.test.mjs` - Imports `handle` from `worker/index.mjs` with a stubbed env, cache and fetch; covers the CORS origin allowlist, rate limiting, caching, the `X-Deck-Format` and `X-Deck-Name` headers, and failure handling
- `tests/hosting.test.mjs` - Imports `handle` from `hosting/index.mjs`; covers which paths redirect to `deckimport` (with or without `https://`, a scheme with one slash, an encoded link, an MTGTop8 query) and which stay 404s
- `tests/browser/site.test.mjs` - Serves the repository and drives `index.html` in headless Chromium through Playwright: the Auto-detect label, the status messages for each format (illegal and restricted cards, copy limits with each card's count and limit, Commander and Limited sizes), the format in the URL and in Save/Load/Clear, Copy Permalink (it makes no outside request, the copied link reopens the same deck with its sheet and sort order, which Back and Forward also restore, and on a phone it opens the share sheet), a Commander sideboard's order, an Arena export pasted into the main deck, and imports against a stubbed Worker (`page.route`), including the deck name they fill in, with every other outside request dropped so it runs offline. It fails on any page error. It has its own `package.json`, so run it apart from the others:

  ```bash
  npm ci --prefix tests/browser
  npx --prefix tests/browser playwright install chromium   # once; skip where Chromium is preinstalled
  npm test --prefix tests/browser
  ```

  Keep `playwright` pinned to a version whose Chromium is installed; a Claude Code cloud session ships the browsers for 1.56.1 in `/opt/pw-browsers`. Like `decklist.test.cjs` it uses the real card data, so a ban list change can break a test
- `tests/test_card_generation.py` - Drives `js/cards/parsecards.py` via subprocess; asserts digital-only cards (Alchemy `A-` prefixes, Arena-only printings) are excluded while paper cards are preserved, and checks the legality, restriction and copy-limit fields. This is the gate the card-refresh workflow runs before committing.

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

- `nealston-decklist` — the static site at `decklist.app`, configured in `hosting/wrangler.jsonc`, with `hosting/index.mjs` as its script. The old host, `decklist.nealston.com`, stays attached so a Redirect Rule in the `nealston.com` zone can send it to `decklist.app` with a 301 (rule in `hosting/README.md`)
- `decklist-import-api` — the import API at `import.decklist.app`, source in `worker/index.mjs`, configured in `worker/wrangler.jsonc`. Its original host, `deck-import.nealston.com`, stays attached for pages loaded before the move

### Site

`.github/workflows/deploy-site.yml` deploys on every push to `main`, and on manual dispatch. It runs `npm ci --prefix worker`, `node hosting/build.mjs`, then `wrangler deploy --config hosting/wrangler.jsonc` using the `CLOUDFLARE_API_TOKEN` secret. The daily card refresh ends with those same build-and-deploy steps.

`hosting/index.mjs` is the site Worker's script. Static assets are served first, so it runs only for a path that matches no file: a path holding an http(s) link, or a link to one of the five deck sites without its scheme, gets a 302 to `/?deckimport=<encoded link>`, and the page imports it on load; anything else is a plain 404. It undoes a scheme whose `//` a proxy merged into `/`, and decodes a link pasted already encoded. It redirects any http(s) link, not only the supported sites, so a link from another site reaches the page's error message rather than a blank 404. Keep `not_found_handling` at `none`: another setting would answer unmatched paths before the script runs. To try it locally, `node hosting/build.mjs`, then `worker/node_modules/.bin/wrangler dev --config hosting/wrangler.jsonc`.

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

It exposes `GET /api/import?source=mtggoldfish&id=123` (or `source=mtgtop8`, `source=archidekt` with a numeric deck ID, `source=scryfall` with a deck UUID, or `source=moxfield` with a base64url deck ID), fetches only fixed export URLs, rejects redirects and HTML, caches successes for five minutes, and rate-limits to 20 requests per minute per IP per location. Sources are declared in the `SOURCES` table at the top of `worker/index.mjs`: an entry gives the ID pattern, the upstream URL, the `Accept` header and, optionally, a `convert` step, or for a text source a `name` read from the response headers. Its CORS allowlist is the `ALLOWED_ORIGINS` var in `worker/wrangler.jsonc` — add an origin there if you host the frontend elsewhere.

The JSON sources' `convert` steps return `{text, format}`, and the Worker sends a known format back as an `X-Deck-Format` header (cached with the text, and listed in `Access-Control-Expose-Headers` so the page can read it). Only the formats the frontend checks are reported — `standard`, `pioneer`, `modern`, `legacy`, `vintage`, `pauper`, `commander`, `premodern`, `oldschool`, `duel`, `paupercommander`, `predh`, `oathbreaker` — under the frontend's keys, which are Scryfall's legality keys. Scryfall's `format` field uses those names, and so does Moxfield's, ignoring case (`oldSchool`), except for two mapped in `MOXFIELD_FORMATS`: `duelCommander` and `pauperEdh`. Archidekt numbers its formats, mapped in `ARCHIDEKT_FORMATS` (1 Standard, 2 Modern, 3 Commander, 4 Legacy, 5 Vintage, 6 Pauper, 12 Duel Commander, 14 Oathbreaker, 15 Pioneer, 17 Pauper EDH, 22 Premodern, 23 PreDH; its 11, 1v1 Commander, is not Duel Commander, and it has no Old School). Any other format, and the MTGGoldfish and MTGTop8 text exports, report none.

The deck's name comes back the same way, as an `X-Deck-Name` header, percent-encoded because a header value must be ASCII, cached with the text and also listed in `Access-Control-Expose-Headers`. The JSON sources' `convert` steps return it as `name`, from the top-level `name` field each of Moxfield, Archidekt and Scryfall has. MTGGoldfish's text export has none, but its download's `Content-Disposition` does: `filename*=UTF-8''Deck%20-%20<name>.txt`, which the `mtggoldfish` source's `name` step (`goldfishName()`) reads. MTGTop8 names its deck in neither export (`mtgtop8_deck.txt`), so it reports none. `deckName()` folds whitespace and control characters to single spaces, caps the name at 100 code points and replaces lone surrogates, and a blank name sends no header. The frontend works with a Worker that predates the header: it then leaves `#deckname` alone. The account that posted a deck (Moxfield's `createdByUser`, Archidekt's `owner`) is not read, since it isn't always the deck's designer.

**Moxfield is a JSON source.** It publishes no text export — the Copy buttons in its Export dialog are built in the browser from the deck JSON and hit no endpoint — and it sends no CORS headers, so the deck has to come through the Worker. The Worker reads `https://api2.moxfield.com/v3/decks/all/<id>` and `moxfieldDeck()` folds the boards into decklist text: commanders lead the sideboard (an Oathbreaker deck's Oathbreaker is in `commanders`, followed by its `signatureSpells` board), a companion joins them there, separate printings of one card merge, and the maybeboard is dropped. A deck with a commander also drops Moxfield's sideboard board, where players keep their cuts, since a Commander deck has no sideboard; a deck without one keeps it.

Two things follow from that. The JSON spells out every card in full, so a 60-card deck runs about 140 KB; the `moxfield` source therefore raises `readBody`'s cap to 2 MB, while the text sources keep the 64 KB default.

**Archidekt is a JSON source too.** The Worker reads the unofficial but public `https://archidekt.com/api/decks/<id>/`, and `archidektDeck()` folds it into decklist text. Archidekt keeps its boards as categories, and a card's *first* category places it: `Sideboard` is the sideboard (Archidekt counts it as part of the deck, so it must be checked before exclusion), a premier category (the commander, or an Oathbreaker with its signature spell) leads the sideboard, and any other category with `includedInDeck: false` (the Maybeboard, "Tokens & Extras", or a player's own such as "Need to get") is dropped. A companion goes to the sideboard whether Archidekt's per-card `companion` flag marks it or the player filed it under a `Companion` category. A deck with a commander drops its `Sideboard` category, as the Moxfield import does: Commander has no sideboard, and players keep their cuts there. Otherwise those placement totals match Archidekt's own deck `size`. Archidekt's CORS allows only its own dev origin, so the Worker is required here too. A 100-card Commander deck's JSON is about 250 KB, inside the shared 2 MB cap. The JSON sources all write their text through `deckText()`, which merges separate printings of one card. All three put a Commander deck's commander in the sideboard: Commander has no sideboard, and the main deck is sorted (by type, by default), which would file the commander among the other creatures where a judge can't pick it out.

**Scryfall is a JSON source as well.** The Worker reads `https://api.scryfall.com/decks/<uuid>/export/json` and `scryfallDeck()` folds it by section key, which follows the deck's layout: a constructed deck has `mainboard`, `sideboard` and `maybeboard`; a Commander deck has `commanders` (which go to the sideboard), `nonlands`, `lands`, `outside` (cards from outside the game, such as a companion, which go to the sideboard too) and `maybeboard`; an Oathbreaker deck keeps its Oathbreaker and signature spell in `oathbreakers`, which go to the sideboard after any `commanders`. The maybeboard is dropped, as are blank entries with no `card_digest`. The JSON is preferred to Scryfall's text export, which labels sections with display headers (`// Commander`, `// Outside the Game`). Scryfall's API asks clients to send a `User-Agent`; the `USER_AGENT` var in `worker/wrangler.jsonc` sets it.

**Don't test the Moxfield source with `curl`.** Moxfield fronts its API with Cloudflare bot management, and the verdict follows the *original visitor*, not the Worker: a request the site makes for a real browser is served, while the same deck requested from `curl` comes back 403, seconds apart, on a deck neither has cached. So `curl` reports a feature that works in a browser as broken — and the Worker caches a success for five minutes, so a `curl` that follows a browser import gets a 200 off the cache and reports it as fixed. Both readings are wrong. Test it through the site in a browser, and when a deck must be uncached, use one nothing has fetched in the last five minutes.

A genuine refusal surfaces as the Worker's 502 and the UI tells the user to paste the exported deck text instead, which is the right fallback for the automated clients Moxfield means to turn away. `MOXFIELD_USER_AGENT` in `worker/wrangler.jsonc` sets the User-Agent the Worker identifies itself with; if Moxfield ever starts refusing browser traffic too, ask their support for an allowlisted one and put it there. Also available: `npm run dev --prefix worker` (local server on :8787) and `npm run check --prefix worker` (dry-run deploy).

## Important Notes

- All card name matching is case-insensitive with accent normalization
- The app HTML-encodes all user input to prevent XSS attacks
- PDF generation happens client-side using jsPDF library
- The iframe preview regenerates with debounced updates to avoid performance issues
- `main.js` contains `posthog.capture(...)` analytics calls, all guarded by `typeof posthog !== 'undefined'`. No PostHog snippet is loaded in `index.html`, so they are inert; adding the snippet would switch analytics on site-wide
