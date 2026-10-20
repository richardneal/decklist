// Runs only for requests that match no static asset. A deck link written after the
// site's address (decklist.nealston.com/https://moxfield.com/decks/…) is sent on to
// the page's deckimport parameter, which imports it on load; anything else is a 404.

// The deck sites whose links may be written without https://, as DeckImport.parse
// accepts them.
const BARE_HOST = /^(?:www\.)?(?:mtggoldfish|mtgtop8|moxfield|archidekt|scryfall)\.com\//i;

// The deck link in a path, or null. Any http(s) link counts, so a link from a site
// we don't import from still reaches the page, which says which sites it supports.
export function deckLink(url) {
  let link = url.pathname.slice(1) + url.search;
  // A link pasted already encoded, as https%3A%2F%2F…
  if (/^https?%3A/i.test(link)) {
    try { link = decodeURIComponent(link); } catch (_) { return null; }
  }
  // A proxy may merge the scheme's two slashes into one.
  if (/^https?:/i.test(link)) return link.replace(/^(https?):\/*/i, '$1://');
  return BARE_HOST.test(link) ? 'https://' + link : null;
}

export function handle(request) {
  const url = new URL(request.url);
  const link = (request.method === 'GET' || request.method === 'HEAD') && deckLink(url);
  if (!link) return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 302, headers: { Location: '/?deckimport=' + encodeURIComponent(link) } });
}

export default { fetch: handle };
