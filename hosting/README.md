# Website deployment

The site is served by Cloudflare Workers Static Assets at https://decklist.nealston.com, using the `nealston-decklist` Worker in Richard's Cloudflare account. The import API remains a separate Worker at `deck-import.nealston.com`.

Pushing to `main` deploys automatically — `.github/workflows/deploy-site.yml` runs the build and `wrangler deploy` steps below, and the daily card refresh ends with the same steps. To deploy by hand, from the repository root:

```sh
npm ci --prefix worker
node --test tests/*.test.*
node hosting/build.mjs
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc --dry-run
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc
```

The build copies only public website files into the ignored `hosting/dist` directory. Credentials, Worker source/configuration, tests, and card-generation scripts are excluded. The custom domain and certificate are managed by Cloudflare.

For import API changes, use `npm run deploy --prefix worker`. Its origin allowlist includes `https://decklist.nealston.com`.
