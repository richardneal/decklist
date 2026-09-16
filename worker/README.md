# Deck import API

A Cloudflare Worker at `deck-import.nealston.com` provides `GET /api/import?source=mtggoldfish&id=123` (or `source=mtgtop8`). The frontend calls this endpoint instead of CORS Anywhere. No website migration is required.

Only fixed export URLs are fetched. Redirects are rejected. Exports have a 15-second timeout and 64 KiB limit; HTML and invalid exports are rejected. Successful exports are cached for five minutes per Cloudflare location. The rate-limit binding allows 20 requests per minute per IP per location; this is abuse mitigation, not a global quota. CORS allows only the origins configured in `wrangler.jsonc`; it is not authentication.

## Deploy

From this directory:

```sh
npm ci
npx wrangler login
npx wrangler whoami
npm run check
npm run deploy
```

Use the account for `richard@nealston.com` that owns the active `nealston.com` Cloudflare zone. If multiple accounts are available, set `account_id` in `wrangler.jsonc` to that account's ID. Deployment creates the custom domain and manages its DNS/certificate through Cloudflare. Do not replace an existing subdomain service without checking it first.

Set `ALLOWED_ORIGINS` to the exact origins hosting your frontend (no trailing slash or path). The current list supports `decklist.nealston.com`, `richardneal.github.io`, `nealston.com`, `www.nealston.com`, and local HTTP development on port 8000. Add another origin if you host the fork elsewhere. The original author's `decklist.xyz` domain is not assumed to belong to this fork.

The browser endpoint is configured in `js/decklist/deckimport.js` as `DeckImport.apiURL`. Deploy the Worker before publishing that frontend change. Upstream anti-bot restrictions may still prevent downloads; the API reports failures and the UI offers manual paste as a fallback.

## Test and develop

From the repository root:

```sh
node --test tests/*.test.*
npm run check --prefix worker
npm run dev --prefix worker
```

For local frontend testing, serve the site on port 8000 and temporarily set `DeckImport.apiURL` to `http://localhost:8787/api/import`. Keep credentials in Wrangler's login storage or environment variables, never in frontend JavaScript or tracked files.

## Verified deployment

Deployed to `https://deck-import.nealston.com/api/import`. Live checks on 2026-09-16 imported MTGGoldfish deck `6837920` and MTGTop8 deck `888489` through the frontend parser, each producing 60 main-deck cards and 15 sideboard cards. A request from an unlisted origin returned HTTP 403.
