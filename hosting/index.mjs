// Runs for the front page, and for any other request that matches no static asset.
// A permalink to a deck (/?deckname=…&deckmain=…) gets the page with its link preview
// naming the deck. A deck link written after the site's address
// (decklist.nealston.com/https://moxfield.com/decks/…) is sent on to the page's
// deckimport parameter, which imports it on load; anything else is a 404.

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

// The names of Decklist.formats, for the preview. The formats led by cards in the
// sideboard (a commander, or an Oathbreaker and its signature spell) count them in
// the deck and name them.
const FORMATS = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy', vintage: 'Vintage',
  pauper: 'Pauper', premodern: 'Premodern', oldschool: 'Old School', commander: 'Commander',
  duel: 'Duel Commander', paupercommander: 'Pauper Commander', predh: 'PreDH', oathbreaker: 'Oathbreaker',
  constructed: 'Constructed', limited: 'Limited'
};
const LED = new Set(['commander', 'duel', 'paupercommander', 'predh', 'oathbreaker']);

// Section headers as Decklist.parse reads them; commanders and companions go to the
// sideboard, and the maybeboard and an About block are left out.
const SECTIONS = {
  deck: 'main', main: 'main', mainboard: 'main', maindeck: 'main',
  sideboard: 'side', sb: 'side', commander: 'side', commanders: 'side', companion: 'side', companions: 'side',
  maybeboard: 'skip', about: 'about'
};
function headerOf(line) {
  if (/^\s*side ?board\b/i.test(line)) return 'side';
  const match = /^\s*([a-z]+(?: [a-z]+)?)\s*(?:\(\d+\))?\s*:?\s*$/i.exec(line);
  const word = match && match[1].toLowerCase().replace(' ', '');
  return word && Object.hasOwn(SECTIONS, word) ? SECTIONS[word] : null;
}

// Counts a deck's cards the way Decklist.parse sorts them into the main deck and
// sideboard, without the card data: lines are taken at their quantity, recognized or not.
// Returns {main, side, cards: [{q, n}] for the main deck, leaders: [names] from the sideboard}
export function countDeck(deckmain = '', deckside = '') {
  const deck = { main: 0, side: 0, cards: [], leaders: [] };
  [[deckmain, 'main'], [deckside, 'side']].forEach(([text, start]) => {
    const lines = text.split(/\r?\n/);
    let section = start, sawMain = false;
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (section === 'about') {
        if (!line.trim()) section = start;
        return;
      }
      const header = headerOf(line);
      if (header) { section = header; return; }
      if (!line.trim()) {
        // A blank line after main deck cards starts the sideboard, unless a header follows
        const next = lines.slice(i + 1).find(l => l.trim() && !/^\s*\/\//.test(l));
        if (start === 'main' && section === 'main' && sawMain && !(next && headerOf(next))) section = 'side';
        return;
      }
      if (section === 'skip') return;
      const sb = /^\s*SB:\s*/i.test(line);
      const match = /^\s*(?:SB:\s*)?(?:(\d+)x*\s+(?:\[.*?\]\s+)?)?(.+?)\s*$/i.exec(line);
      const q = match[1] ? Number(match[1]) : 1;
      // Leave off the printing Arena and Moxfield follow a name with: (MH2) 290 *F*
      const n = match[2].replace(/(?:\s+\([a-z0-9]{2,8}\)(?:\s+[^\s()*]+)?)?(?:\s+\*[a-z]+\*)*$/i, '');
      if (sb || section === 'side') {
        deck.side += q;
        deck.leaders.push(n);
      } else {
        deck.main += q;
        deck.cards.push({ q, n });
        sawMain = true;
      }
    });
  });
  return deck;
}

function clip(text, length) {
  return text.length > length ? text.slice(0, length - 1).trimEnd() + '…' : text;
}

// The link preview's title and description for a permalink's query, or null when it
// holds no deck. The player's name and the event are left out: a preview is shown to
// everyone the link is posted to.
export function preview(params) {
  const deckname = (params.get('deckname') || '').trim();
  const deckmain = params.get('deckmain') || '', deckside = params.get('deckside') || '';
  if (!deckname && !deckmain.trim() && !deckside.trim()) return null;

  const format = Object.hasOwn(FORMATS, params.get('deckformat')) ? params.get('deckformat') : '';
  const deck = countDeck(deckmain, deckside);
  const plural = count => count + (count === 1 ? ' card' : ' cards');
  const summary = [];
  if (format) summary.push(FORMATS[format]);
  if (LED.has(format)) {
    summary.push(plural(deck.main + deck.side));
    if (deck.leaders.length) summary.push(deck.leaders.join(' + '));
  } else if (deck.main || deck.side) {
    summary.push(plural(deck.main) + (deck.side ? ' + ' + deck.side + ' sideboard' : ''));
  }
  const cards = deck.cards.slice(0, 8).map(card => card.q + ' ' + card.n).join(' · ')
    + (deck.cards.length > 8 ? ' · …' : '');

  return {
    title: clip(deckname || (format ? FORMATS[format] + ' decklist' : 'MTG decklist'), 100),
    description: clip([summary.join(' · '), cards].filter(Boolean).join('. '), 300)
  };
}

function escapeAttribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Sets the page's Open Graph and Twitter title and description tags
export function rewrite(html, { title, description }) {
  const values = { title: escapeAttribute(title), description: escapeAttribute(description) };
  return html.replace(/(<meta (?:property="og|name="twitter):(title|description)" content=")[^"]*(">)/g,
    (_, start, field, end) => start + values[field] + end);
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const read = request.method === 'GET' || request.method === 'HEAD';

  if (url.pathname === '/') {
    const page = await env.ASSETS.fetch(request);
    const tags = read && page.ok && preview(url.searchParams);
    if (!tags) return page;
    const response = new Response(request.method === 'HEAD' ? null : rewrite(await page.text(), tags), page);
    response.headers.delete('Content-Length');
    response.headers.delete('ETag');
    return response;
  }

  const link = read && deckLink(url);
  if (!link) return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 302, headers: { Location: '/?deckimport=' + encodeURIComponent(link) } });
}

export default { fetch: handle };
