# Website deployment

The site is served by Cloudflare Workers Static Assets at https://decklist.app, using the `nealston-decklist` Worker in Richard's Cloudflare account. The import API is a separate Worker at `import.decklist.app`.

Pushing to `main` deploys automatically — `.github/workflows/deploy-site.yml` runs the build and `wrangler deploy` steps below, and the daily card refresh ends with the same steps. To deploy by hand, from the repository root:

```sh
npm ci --prefix worker
node --test tests/*.test.*
node hosting/build.mjs
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc --dry-run
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc
```

`index.mjs` is the site Worker's script. It runs for every request (`run_worker_first: true`): it 301s `www.decklist.app` to `decklist.app`, keeping the path and query, serves any path that matches a file, and otherwise redirects a deck link written after the site's address (`/https://moxfield.com/decks/…`) to `/?deckimport=…`; any other such path is a 404.

The build copies only public website files into the ignored `hosting/dist` directory. Credentials, Worker source/configuration, tests, and card-generation scripts are excluded. The custom domain and certificate are managed by Cloudflare.

For import API changes, use `npm run deploy --prefix worker`. Its origin allowlist includes `https://decklist.app`.

## Error and outcome counts

The page (`js/decklist/report.js`) posts a few counts to `/api/event`, which `index.mjs` writes to the `decklist_events` Analytics Engine dataset; the import Worker writes each import's outcome to `decklist_imports`. Neither keeps an IP address, deck, name or URL (docs.html, "What does decklist.app count?", lists every field). Each dataset appears on its first write. To read the last week (or `node hosting/counts.mjs 30` for a month):

```sh
CLOUDFLARE_API_TOKEN=… node hosting/counts.mjs
```

The token needs **Account → Account Analytics → Read**; wrangler's login can't query Analytics Engine. Make one under My Profile → API Tokens.

## The old host

The site was served from `decklist.nealston.com` until October 2026. That host stays attached to the Worker in `wrangler.jsonc`, which keeps its DNS record and certificate, and a Redirect Rule in the `nealston.com` zone (Rules → Redirect Rules) sends every request to the new domain, so shared permalinks and tournament organizers' direct links keep working:

- **When:** `http.host eq "decklist.nealston.com"`
- **Then:** dynamic redirect to `concat("https://decklist.app", http.request.uri.path)`, status 301, preserve query string

Redirect Rules run before the Worker, so the old host never serves the site itself. Keep the rule indefinitely.

Saved decks and the dark mode setting are kept in `localStorage`, which belongs to the origin, so visitors from the old host start fresh on the new one.
