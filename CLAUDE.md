# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

decklist.app is a static website that generates Magic: The Gathering tournament registration sheets and decklists. It's a fork of the original [decklist.org](https://github.com/april/decklist) project by April King, enhanced with additional features and improvements.

The application runs entirely client-side using vanilla JavaScript, jQuery, and jsPDF. No build process is required to work on it — open `index.html` directly. Deployment adds two small Node pieces: `hosting/` (stages the static files and ships them to Cloudflare, with a small script that gives deck permalinks their own link preview and redirects deck links written after the site's address) and `worker/` (the Cloudflare Worker backing deck imports).

## Architecture

### Core JavaScript Modules

The application is split into three main JavaScript modules in `js/decklist/`, all loaded by `index.html`, plus `report.js`, loaded first (see Error and outcome counts below):

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
   - `Decklist.check(deck, format)` - Checks a `parse()` result against a format: deck size (60/15 for constructed; exactly 100 counting the commander, or 101 with a companion, for Commander and its variants; exactly 60 counting the Oathbreaker and its signature spell, which make up a 2-card sideboard, for Oathbreaker; at least 40 for Limited), copies (4, or 1 in a singleton format or for a card restricted in a constructed format, unless the card's own `x` says otherwise; Limited has no limit) and legality. In a Commander variant a restricted card is one that may not be the commander (Duel Commander's list), reported as `notcommander` when it is in the sideboard. Returns `{deckmain, deckside}` lists of validation objects that `main.js` turns into messages; the card checks name their cards in `data.cards`, and `quantity` also gives `data.copies` (`{n, q, limit}`, worded by `Decklist.copiesNote()`)
   - `Decklist.detectFormat(deck)` - Auto-detect: `commander` for a 90+ card main deck with at most 3 sideboard cards, `limited` for a 40–45 card main deck, otherwise the narrowest of Standard, Pioneer, Pauper, Modern, Legacy and Vintage the deck passes, otherwise `constructed`. Because it picks a format the deck is legal in, auto-detect never reports an illegal card; only a chosen format does. It picks only these main formats, never Premodern, Old School, Oathbreaker or a Commander variant: a narrow card pool like Premodern's would claim decks that are really Legacy
   - Each card object has properties: `n` (name), `c` (color), `t` (type), `m` (mana value), `q` (quantity), `b` (formats it is not legal in), `r` (formats it is restricted in), `x` (its own copy limit)

2. **main.js** - Main application logic
   - Event handling for form inputs
   - PDF generation using jsPDF
   - The preview: on desktop the PDF goes into the `#decklist` iframe as a data URL, with `#view=Fit&zoom=page-fit` (Chrome reads the first, Firefox the second) so the browser's PDF viewer fits the whole page in the frame. Opened as wide as the frame, the page and the viewer's toolbar were taller than it, so a scroll over the preview moved the sheet inside the frame instead of the page. The viewer keeps its toolbar, so the sheet can be printed from the preview. A new sheet loads in a second iframe (class `loading`, hidden over the shown one) that replaces the shown one `PREVIEW_SWAP_DELAY` (400ms) after its `load`, since Chrome's viewer fires `load` 100–250ms before it has drawn the sheet; reloading the shown iframe blanked the preview each time it updated. On a touch screen (`touchScreen`, `(pointer: coarse)`) `drawPreview()` draws each page to a canvas with PDF.js instead, since iOS Safari shows a PDF in an iframe at full size, cropped to the frame. PDF.js is vendored in `js/pdfjs/` (the 5.7.284 legacy build, renamed to `.js` so any server sends a JavaScript type) and imported on the first touch screen preview, so desktop never downloads it
   - The preview is one letter page tall (`aspect-ratio: 8.5 / 11` on `#decklist`), and beside the form (wider than 1000px) the `.right` sidebar is `position: sticky`, so the preview stays in view while the form scrolls. One that fits in the window stays 16px below its top. A taller one (a short window, or a long status) moves with the page until its far end is in view, then stays: its bottom 16px above the window's while scrolling down, its top while scrolling up. `initStickySidebar()` does this by setting the sidebar's `top` on scroll, and rechecks on a `ResizeObserver` and window resize, since the status grows and shrinks with the deck's problems
   - The navbar's "decklist" brand and its Decklist link (the one marked `aria-current="page"`) go to `/`, but a plain click on the generator only scrolls to the top (`$('.navbar-brand, …')` in the ready handler): a reload would clear the form, which isn't saved as it's typed. A modified or middle click opens a fresh generator; on `docs.html` both are ordinary links home
   - Touch screens also get the native date picker (`#eventdate` becomes `type="date"`, which keeps the ISO value) in place of jQuery UI's, which opened alongside the keyboard
   - In the one-column layout (`oneColumn`, `max-width: 1000px`, matching `decklist.css`) each deck box lists its own problems in `#deckmain-messages`/`#deckside-messages` beneath it, filled by `statusAndTooltips()` with the problems that name no card (those that do are tagged `'cards'` and left to `markCards()`'s rows just below), and those two boxes open no tooltip. The status box moves above the download buttons there
   - Dark mode: a script at the top of `<body>` (in `index.html` and `docs.html`) defines `decklistTheme` and sets `dark-mode` before the first paint, from the saved choice or the system setting; `initDarkMode()` (and `docs.html`'s own copy) then follows the system and the toggle. The choice is a `theme=dark|light` cookie on `decklist.app`, so standings.decklist.app shares it; `decklistTheme.saved()` reads it, falling back to a `darkMode` localStorage value saved before the cookie, and `decklistTheme.save()` writes it (or clears it, when the choice matches the system) and drops that old value. The toggle's icon is drawn by CSS from that class
   - Card-name autocomplete in the deck boxes (`initAutocomplete()`, run once the card data loads): opens while typing (not on paste or import), ranks the card named exactly, then names starting with what was typed, then names with a word starting with it, then the rest, alphabetically within each, and shows ten. The first is highlighted; Enter or Tab takes the highlighted one, except that Enter after a name typed in full just ends the line. Picking keeps focus in the deck box (the list cancels `mousedown`/`pointerdown`), so a phone's keyboard stays up. The list sits at the caret's line, measured on a hidden copy of the textarea so wrapped lines count, and opens below the line, scrolling within the room there, unless that room is under a few rows (`MIN_ROOM_BELOW`, 150px) and there's more above inside `visualViewport`, which a phone's keyboard shrinks. The side goes by the room, not the suggestions left, so it doesn't jump as typing narrows the list
   - The Deck Name and Deck Designer placeholders are a famous archetype and its designer, picked at random from `ARCHETYPES` by an inline script right after the two inputs in `index.html`, so the pair is set before the first paint (the static The Deck / Brian Weissman shows only without JavaScript). Each is drawn dimmer and in italics (`--text-placeholder`), so it doesn't look filled in. The list ends with an easter egg, Simic Karn by Team ChannelFireball, from Pro Tour Dominaria
   - URL parameter parsing for direct linking
   - History state management for permalinks: `generatePermalink()` builds the link from the form as query parameters (`+` for spaces), adding `decksort` when it differs from the default (`type`). The address bar and history use it; the history state always keeps the sort, so Back restores a default one too. The sort order is the `#decksort` menu beside Format, whose values are the parameter's; a change records its step in `pushHistoryState()` after the current event, and `parseGET()` sets it back (to `type` when the link names none or an unknown one). Copy Permalink (`sharePermalink()`) shares that same link on the live origin, through the native share sheet on a touch device (`navigator.share` with a coarse pointer) and the clipboard everywhere else. The whole form rides in the link; nothing is sent to a shortener or any other service
   - `markCards()` runs after `statusAndTooltips()` and lists the deck as read under each textarea (`#deckmain-check`, `#deckside-check`): each card with a problem gets its own row with the warning/error icon and the reason, worded as the Status box words it, and a toggle shows every card with its quantity and its name as matched (`fire ice` as `Fire // Ice`). It reads the cards from the validation objects' `data.cards`, and for copy limits `data.copies`. Card images are left out, so nothing is sent to Scryfall
   - Input validation with debounced updates (400ms for validation, 1500ms for PDF generation); deck size, copy and legality checks come from `Decklist.check()` for the format in `#deckformat` (empty means auto-detect, and the Auto-detect option's text names the format it picked). The sheet sorts the sideboard with the main deck's sort order, except a singleton deck's (Commander, its variants and Oathbreaker; `sortSideboard()`), which keeps the order it was entered in so an imported commander stays on its first line

3. **deckimport.js** - MTGGoldfish / MTGTop8 / Moxfield / Archidekt / Scryfall deck importing
   - `DeckImport.parse(value)` - Describes a recognized deck link as `{source, label, id, url}`; returns `null` for any other host, a URL carrying credentials or an explicit port, a non-http(s) scheme, or a missing/malformed deck ID. A Moxfield ID must be 16–32 base64url characters, which keeps routes such as `/decks/public` from reading as a deck; an Archidekt ID is numeric, optionally followed by the deck's name slug; a Scryfall ID is the UUID in `scryfall.com/@user/decks/<uuid>`, lowercased
   - `DeckImport.downloadURL(value)` - The canonical export URL from `parse`, or `null`
   - `DeckImport.split(text)` - Splits export text into `{main, side}`; throws if the response looks like HTML (a login or error page) or if any line is not quantity-prefixed
   - `DeckImport.load(value)` - Fetches through the import Worker with a 20s `AbortSignal.timeout`, then splits the result and adds `format`: the Worker's `X-Deck-Format` header, else an MTGTop8 link's `f` parameter (`ST`, `PI`, `MO`, `LE`, `VI`, `PAU`, `PREM` for Premodern, `EDH` for Duel Commander), else `''`. The import sets `#deckformat` to it, so a deck with no format goes back to Auto-detect, and undo restores the previous choice. It also adds `name`, the Worker's `X-Deck-Name` header percent-decoded, else `''` (MTGTop8, a malformed encoding, or a Worker that predates the header). A name replaces `#deckname`; with none, or when the player typed a name while the deck was on its way, the field is left as it is. Undo puts back the replaced name unless the field has been edited since the import
   - `DeckImport.importFromParameters(params)` - Honors the `deckimport` URL parameter; an embedded `deckmain`/`deckside` takes precedence
   - `DeckImport.apiURL` points at the deployed Worker; set it to `http://localhost:8787/api/import` to test against `npm run dev --prefix worker`
   - `DeckImport.fromFile(text)` - Reads an uploaded deck file into `{main, side, name}`: an MTGO `.dek` or Cockatrice `.cod` (XML, read by `fromXML()` with regexes, merging printings and dropping Cockatrice's tokens zone; a `.cod`'s `<deckname>` is its name), or a text list. A plain list is split like an import; one `split()` refuses (Arena headers, `//` comments) goes into `#deckmain` whole with `side: null`, which clears `#deckside`, and an Arena `About`/`Name` line names it. It throws for a binary file or one with no quantity-prefixed line. A file names no format, so the form's stays. Files over `maxFileSize` (1 MB) are refused
   - The import box has two tabs (`.import-tabs`, ARIA tabs with arrow-key focus): Deck link (`#import-panel-link`) and Text file (`#import-panel-file`, with `#deckfile-button` opening the hidden `#deckfile` input). A file dropped on `#deckfile-drop` or either deck box is read the same way; dragged text still goes in as text. Both tabs share the status line and undo
   - Drives `#deckimport`, `#deckimport-button`, `#deckimport-help`, `#deckimport-status` and `#deckimport-undo`, and keeps an undo of the replaced deck text (`apply()`, shared by imports and uploads)

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
- Display: `decksort`, `disableediting`. There is one sheet, the WotC one (`generateStandardDecklist()`); the SCG sheet and its `decksheet` parameter were removed, and an old link's `decksheet` is ignored

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

The preview is an iframe on desktop and PDF.js canvases on a touch screen (see `main.js` above). To check a phone layout, use a narrow window with touch emulation, or the iOS Simulator against a local server: Mobile Safari is where the iframe preview broke.

### Automated Tests

Eight suites live in `tests/`. Install the worker dependencies once first (`wrangler` is the only one, and `worker.test.mjs` imports from `worker/`):

```bash
npm ci --prefix worker
```

Then, from the repository root:

```bash
node --test tests/*.test.*
python3 -m unittest discover --start-directory tests --pattern 'test_*.py'
```

- `tests/decklist.test.cjs` - Loads the real card data and `decklist.js` in a `vm`; covers loose name matching (split cards typed without `//`, double-faced cards spelled out in full), front-face names for meld, flip and prepare cards, pasted exports (Arena headers and companions, set codes and foil markers, `SB:` lines, the blank-line sideboard switch), and the format checks and auto-detection. The format tests rely on current ban lists, so a ban or unban can break one
- `tests/deckimport.test.cjs` - Loads `deckimport.js` in a `vm` with a stubbed `$`; covers deck-URL recognition/rejection, export splitting, the imported deck's format and name, reading uploaded deck files (text, `.dek`, `.cod`), and the failures it reports (with the real `report.js`)
- `tests/decklist-sort.test.cjs` - Loads `decklist.js` in a `vm` with a stubbed `$`; covers mana value sorting and sectioning (0-mana spells first, then lands, then unrecognized cards)
- `tests/worker.test.mjs` - Imports `handle` from `worker/index.mjs` with a stubbed env, cache and fetch; covers the CORS origin allowlist, rate limiting, caching, the `X-Deck-Format` and `X-Deck-Name` headers, failure handling, and the import outcomes it counts
- `tests/hosting.test.mjs` - Imports `handle` from `hosting/index.mjs` with a stubbed `ASSETS` binding serving the real `index.html`; covers a permalink's link preview (deck name, format, card counts, a Commander deck's commander, the image link and its query, escaping, and that the player's name and event stay out), the `/preview.png` image (a 1200×630 PNG, and a query that can't push it past its limits), the front page without a deck passing through untouched, `/api/event` (what it counts, and the reports it drops), which paths redirect to `deckimport` (with or without `https://`, a scheme with one slash, an encoded link, an MTGTop8 query) and which stay 404s
- `tests/browser/site.test.mjs` - Serves the repository and drives `index.html` in headless Chromium through Playwright: the Auto-detect label, the status messages for each format (illegal and restricted cards, copy limits with each card's count and limit, Commander and Limited sizes), the format in the URL and in Save/Load/Clear, Copy Permalink (it makes no outside request, the copied link reopens the same deck with its sort order, which Back and Forward also restore, and on a phone it opens the share sheet), an old link naming the removed `decksheet=scg`, a Commander sideboard's order, each card's problem marked on its own row under its textarea and the full list as read, an Arena export pasted into the main deck, a phone (touch, 375px wide: the PDF.js preview, the native date input, the deck problems listed under the deck box), the card-name autocomplete (ranking, focus after a pick, Enter and Tab, the list kept on screen), the brand link (a click scrolls to the top and keeps the deck), and imports against a stubbed Worker (`page.route`), including the deck name they fill in, the Text file tab's uploads, the error and outcome reports (what a download and a failed import send, nothing from the form, nothing under Global Privacy Control), with every other outside request dropped so it runs offline. It fails on any page error. It has its own `package.json`, so run it apart from the others:

  ```bash
  npm ci --prefix tests/browser
  npx --prefix tests/browser playwright install chromium   # once; skip where Chromium is preinstalled
  npm test --prefix tests/browser
  ```

  Keep `playwright` pinned to a version whose Chromium is installed; a Claude Code cloud session ships the browsers for 1.56.1 in `/opt/pw-browsers`. Like `decklist.test.cjs` it uses the real card data, so a ban list change can break a test
- `tests/health.test.mjs` - Covers `hosting/health.mjs`: which day's counts cross a threshold (a source's import failures, load failures, script errors, preview failures, failed imports in the browser), the notes on a quiet day, and the probe imports (stubbed fetch)
- `tests/test_card_generation.py` - Drives `js/cards/parsecards.py` via subprocess; asserts digital-only cards (Alchemy `A-` prefixes, Arena-only printings) are excluded while paper cards are preserved, and checks the legality, restriction and copy-limit fields. This is the gate the card-refresh workflow runs before committing.

### Common Modifications

**Adding a new deck format parser:**
- Edit `decklist.js`, add regex to `cardRE.main` or `cardRE.side` arrays
- Test with various inputs to ensure proper parsing

**Adding a new sort order:**
- Add sort function in `Decklist.sort()`
- Add an option to the `#decksort` menu in `index.html`, its value the `decksort` parameter's (`main.js` binds the form's `input` handler to every field but this one, whose `change` regenerates the sheet). A saved deck keeps the value; decks saved before the menu name the old radio (`sort-color`), and Load drops the `sort-`
- Add case to sort switch statement

**Adding sheet artwork:**
- Place the image file in `images/logos/` (JPEG, PNG or WebP)
- Add an entry to `LOGOS_CONFIG` at the top of `main.js`: `{ id, file, format }` (`format` is the jsPDF image format, e.g. `JPEG`)
- Every entry is preloaded into `logoCache` by `id` when the page loads; the layout functions draw from that cache. The sheet always uses `mtg` — there is no logo picker or `logo` URL parameter

## Deployment

The site is served by **Cloudflare Workers Static Assets**, not GitHub Pages. Two separate Workers are involved:

- `nealston-decklist` — the static site at `decklist.app`, configured in `hosting/wrangler.jsonc`, with `hosting/index.mjs` as its script. The old host, `decklist.nealston.com`, stays attached so a Redirect Rule in the `nealston.com` zone can send it to `decklist.app` with a 301 (rule in `hosting/README.md`)
- `decklist-import-api` — the import API at `import.decklist.app`, source in `worker/index.mjs`, configured in `worker/wrangler.jsonc`. Its original host, `deck-import.nealston.com`, stays attached for pages loaded before the move

### Site

`.github/workflows/deploy-site.yml` deploys on every push to `main`, and on manual dispatch. It runs `npm ci --prefix worker`, `node hosting/build.mjs`, then `wrangler deploy --config hosting/wrangler.jsonc` using the `CLOUDFLARE_API_TOKEN` secret. The daily card refresh ends with those same build-and-deploy steps.

`hosting/index.mjs` is the site Worker's script. It runs first for every request (`run_worker_first: true`). On `www.decklist.app` (a custom domain on the same Worker) it 301s to `decklist.app` with the same path and query. On `/` it makes sure a deck permalink unfurls in Discord, Slack or iMessage as that deck: when the query holds `deckname`, `deckmain` or `deckside`, it fetches `index.html` through the `ASSETS` binding and rewrites the `og:`/`twitter:` title, description, image and image alt tags. The title is the deck name (else `Modern decklist` or `MTG decklist`); the description gives the format, the card counts (a Commander variant's or Oathbreaker's total includes its sideboard, whose cards it names as the leaders) and the first eight main deck lines. `countDeck()` follows `Decklist.parse()`'s sections (headers, `SB:` lines, the blank-line sideboard, About and Maybeboard) without the card data, so it counts lines at their quantity. The player's name, the event and the designer never reach the preview, since it is shown to everyone a link is posted to. The rewrite matches the tags' exact `<meta property="og:title" content="…">` / `<meta name="twitter:title" content="…">` shape, so keep it when editing them in `index.html`. The `/` without a deck, and everything else that matches a file, is served as is. The front page's preview image is `images/og-image.png` (1200×630, linked as `?v=2`; bump the number when the image changes, since Discord caches an image by its URL).

A permalink's image is `/preview.png?v=1&name=…&format=…&main=60&side=15&leaders=…&cards=4+Lightning+Bolt%0A…`, drawn by `hosting/preview.mjs`: the deck name, format and counts on the left, the first 15 main deck lines on a sheet on the right (with "+ N more cards"), and "No more decklist problems". Its query carries only what it draws, so the link stays short however big the deck, and `imageDeck()` clips and checks every value, since anyone can write one. The site runs on the **Workers Free plan, 10 ms of CPU a request**, which no general renderer (satori, resvg) fits in, so nothing is rasterized at run time: `preview.mjs` copies glyphs from `hosting/preview-font.mjs`, Roboto at eight sizes plus the site icon drawn ahead of time as 4-bit coverage bitmaps, into an 8-bit indexed PNG whose palette grows as colors are blended, and compresses it with `zlib()`, a deflate encoder written for this image: a row matching the one above is one match, any other row is runs of one color (a literal, then matches one byte back), with fixed Huffman codes and the Adler-32 checksum summed a run at a time. Uncached images measured in `wrangler tail` (October 2026, 12–16 requests each): with `CompressionStream` (zlib alone about 4 ms), 6–31 ms of CPU; with this encoder, 4–25 ms, median about 9; with text rows stored uncompressed instead (about 500 KB an image), 5–31 ms, median 20, so don't retry that: Node showed it faster, but on Workers a bigger body costs CPU to send and cache, and Node's timings miss it. Most of the overruns land on a cold isolate's first request, and Cloudflare served every one of them (outcome `ok`), but they are over the Free plan's 10 ms, so a busy day could see an image refused with error 1102; the page's title and description still unfurl. Keep the hot loops free of calls and closures: a cold Worker runs them before the JIT warms up. The tests inflate the result with Node's zlib, which checks the stream and its checksum. Text is folded to the bitmaps' characters (`Lim-Dûl` to `Lim-Dul`, anything else to `?`). A drawn image goes into `caches.default` with a year's `immutable` Cache-Control, so each deck is drawn once per data center; bump `IMAGE_VERSION` in `index.mjs` when the design changes. If drawing throws, the static image is served instead. To change sizes or characters, edit `FONTS`/`CHARS` in `hosting/make-preview-font.mjs` and run it (`node hosting/make-preview-font.mjs`, after `npm ci --prefix tests/browser`; it renders the glyphs in Playwright's Chromium).

For every other path it passes the request to the `ASSETS` binding and serves the file if there is one; only a path that matches no file goes further: a path holding an http(s) link, or a link to one of the five deck sites without its scheme, gets a 302 to `/?deckimport=<encoded link>`, and the page imports it on load; anything else is a plain 404. It undoes a scheme whose `//` a proxy merged into `/`, and decodes a link pasted already encoded. It redirects any http(s) link, not only the supported sites, so a link from another site reaches the page's error message rather than a blank 404. Keep `not_found_handling` at `none`: another setting would answer unmatched paths before the script runs. To try it locally, `node hosting/build.mjs`, then `worker/node_modules/.bin/wrangler dev --config hosting/wrangler.jsonc`.

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

## Error and outcome counts

To see when people hit problems, without learning who they are or what their deck is:

- `js/decklist/report.js` defines `Report.event(name, ...codes)`, which posts `{e, d}` with `navigator.sendBeacon` to the site's own `/api/event`: at most 20 events a page, each once, and none under Global Privacy Control or from a `file:` page. It also catches uncaught errors in the site's own files (file, line, column and `Report.scrub()`'s message, with quoted text and links removed; a browser extension's errors are ignored) and any site file that fails to load. `index.html` loads it before jQuery so it sees every failed load
- The events: `download` (`<format>:<ok|warning|error>`, the deck's problem codes from `validateInput()`, unrecognized cards as `0`, `1-2` or `3+`; `reportDownload()` in `main.js`), `preview` (the PDF.js preview failed), `import` (source and `Report.kind()`: timeout, network or failed), `badlink` (`DeckImport.site()`: a host from `DeckImport.otherSites`, else `other`), `upload` (extension and `ok` or the error), `error` and `load`
- `recordEvent()` in `hosting/index.mjs` accepts only those names, at most three codes of 120 characters, from the site's own `Origin` and without `Sec-GPC: 1`, behind the `EVENT_LIMITER` rate limit (30 a minute per IP, which isn't stored), and writes `[event, code1, code2, code3, browser, device]` to the `decklist_events` Analytics Engine dataset (`EVENTS` binding). It always answers 204
- The import Worker's `record()` writes `[source, outcome, detail]` and the time taken in ms to `decklist_imports` (`IMPORTS` binding): outcomes `ok`, `cached`, `limited`, `badrequest`, `upstream` (detail: its HTTP status), `timeout` and `invalid` (detail: the error message). Never the deck ID
- `docs.html` ("What does decklist.app count?", `#what-we-count`) lists every field; keep it in step when adding an event. Never send what a player typed: names, the event, the deck name, card names, links
- Read the counts with `node hosting/counts.mjs [days]`. The token (`analyticsToken()` in `hosting/analytics.mjs`, shared with `health.mjs`) comes from `CLOUDFLARE_ANALYTICS_TOKEN` or `CLOUDFLARE_API_TOKEN`, else on a Mac the `decklist-counts` Keychain item. It needs Account Analytics: Read, which wrangler's login lacks
- The **Health check** workflow (`.github/workflows/health-check.yml`, daily at 14:23 UTC, or manual dispatch) runs `hosting/health.mjs`: it imports the test decks in `PROBES` through the import Worker (MTGGoldfish, MTGTop8, Archidekt; Moxfield refuses servers, and Scryfall has no public deck to find), then checks the last day's counts against `LIMITS` in `assess()`. Anything wrong fails the run, which GitHub emails about; the run's summary lists the problems and the day in brief. It reads the `CLOUDFLARE_ANALYTICS_TOKEN` secret. Its probe imports land in `decklist_imports` too, about three a day. If a test deck disappears, replace its ID in `PROBES`
- Don't turn on Workers Logs for the site Worker: its logs would record each request's URL, and a permalink's query holds the player's name and deck

## Important Notes

- All card name matching is case-insensitive with accent normalization
- The app HTML-encodes all user input to prevent XSS attacks
- Roboto is served from `css/fonts/` (Google Fonts' latin and latin-ext variable files, each declared at 400 and 700 in `decklist.css`), with the latin file preloaded and a `Roboto Fallback` face, Arial adjusted to Roboto's metrics, so the text doesn't reflow when the font swaps in. The page makes no request to Google Fonts
- PDF generation happens client-side using jsPDF library
- Icons are drawn by the site, never emoji or font glyphs, so they look the same on every device. The buttons' icons are line drawings on the dark mode toggle's grid (24px, 2px round stroke), kept as `--icon-*` mask URLs on `:root` in `decklist.css`. A button with the `icon-button` class shows the one its id sets as `--icon`, in its text color, and the `done` class swaps it for the check mark while the label says Copied!, Saved! or Loaded!. The Sort Order options mark the chosen one with `--icon-check` too. The status box has no large icon: a warning or error shows as its border color and each problem's icon, and a valid deck as one "Ready to print" line (`.statusmark`, shown only in `.valid`)
- The preview regenerates with debounced updates to avoid performance issues
- standings.decklist.app (the odds of making the cut at Melee.gg events, the `standings` repo) shares this site's design: the colors, Roboto, the navbar, bordered panels with ruled headings, 44px fields and solid accent buttons, plus the `theme` cookie. What is the same on both is `css/shared.css`: the light and dark colors, `--radius-sm`, `--radius-md` and `--transition` on `:root` and `body.dark-mode`, and the navbar with its dark mode toggle. `index.html` and `docs.html` load it before `decklist.css`, whose `:root` and `body.dark-mode` keep only this site's own tokens (the icons, shadows and `--radius-lg`). The standings repo keeps a copy in `app/static/shared.css`, fetched from the live `https://decklist.app/css/shared.css` by its `scripts/sync_shared_css.py`, and its Shared CSS check fails when the copy falls behind. So after a change to `shared.css` is deployed here, run that script in the standings repo. Keep the file to rules that are the same on both sites: fonts stay out (this site declares Roboto at 400 and 700, standings at 400–700), as does anything else one site sets for itself. The panels, fields and buttons have different class names on the two sites, so a change to those still belongs in both repos by hand
- The navbar is the same on every page of both sites: the brand mark and the site's name, its tagline (`.navbar-tagline`), then Decklist, Standings and Docs & FAQ (the current one marked `aria-current="page"`; " & FAQ" is dropped at 420px and below) and the dark mode toggle. Its CSS, in `css/shared.css`, is the same file on both sites, so the bar is the same height on both at every width; its HTML is written out in each page, so a change to the links belongs in `index.html`, `docs.html` and the standings repo's `app/main.py`. Its rules set every size they depend on rather than inheriting the page's, and its text is weight 400 or 700, since this site declares Roboto at only those weights
- `docs.html`'s section links (`.docs-nav`) stick to the top of the window as the page scrolls, and its own script marks the section being read with `aria-current="location"`: the last section whose top is in the upper third of the window, or the last section once the page reaches the bottom. On a narrow screen the links stay on one row and scroll sideways, bringing the marked one into view. A new section needs only its link there and a `docs-section` with the matching `id`. Each question (`.faq-item`) and topic (`.docs-subsection`) has its own `id`, written in the HTML so a link to one works without JavaScript, and a `.docs-anchor` link to itself after its `<h3>`, drawn with `--icon-link` and shown on hover (always, faintly, on a touch screen); give a new one both. The page's `<h1>` is its title, "Documentation & FAQ", so there the navbar tagline is a `<p>`, as on standings
- The form's fields match standings': labels without a trailing colon, and the Format and Sort order menus' caret drawn by CSS (two gradients, as standings draws its `select`) rather than the browser's own, which sits at a different inset in each browser
