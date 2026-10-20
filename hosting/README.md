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

The build copies only public website files into the ignored `hosting/dist` directory. Credentials, Worker source/configuration, tests, and card-generation scripts are excluded. The custom domain and certificate are managed by Cloudflare.

For import API changes, use `npm run deploy --prefix worker`. Its origin allowlist includes `https://decklist.app`.

## The old host

The site was served from `decklist.nealston.com` until October 2026. That host stays attached to the Worker in `wrangler.jsonc`, which keeps its DNS record and certificate, and a Redirect Rule in the `nealston.com` zone (Rules → Redirect Rules) sends every request to the new domain, so shared permalinks and tournament organizers' direct links keep working:

- **When:** `http.host eq "decklist.nealston.com"`
- **Then:** dynamic redirect to `concat("https://decklist.app", http.request.uri.path)`, status 301, preserve query string

Redirect Rules run before the Worker, so the old host never serves the site itself. Keep the rule indefinitely.

Saved decks and the dark mode setting are kept in `localStorage`, which belongs to the origin, so visitors from the old host start fresh on the new one.
