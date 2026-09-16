# Website deployment

The site is served by Cloudflare Workers Static Assets at https://decklist.nealston.com, using the `nealston-decklist` Worker in Richard's Cloudflare account. The import API remains a separate Worker at `deck-import.nealston.com`.

From the repository root:

```sh
npm ci --prefix worker
node --test tests/*.test.*
node hosting/build.mjs
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc --dry-run
worker/node_modules/.bin/wrangler deploy --config hosting/wrangler.jsonc
```

The build copies only public website files into the ignored `hosting/dist` directory. Credentials, Worker source/configuration, tests, and card-generation scripts are excluded. The custom domain and certificate are managed by Cloudflare. Deploying is currently manual; pushing to GitHub does not update this Cloudflare deployment.

For import API changes, use `npm run deploy --prefix worker`. Its origin allowlist includes `https://decklist.nealston.com`.
