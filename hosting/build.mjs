import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const output = new URL('./dist/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'docs.html', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'llms.txt', 'LICENSE', 'css', 'images', 'js']) {
  await cp(new URL(file, root), new URL(file, output), {
    recursive: true,
    filter: source => !/\.(?:py|sh|map)$/.test(source)
  });
}
console.log('Site assets prepared in ' + fileURLToPath(output));
