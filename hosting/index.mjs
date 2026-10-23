// Runs for every request. www.decklist.app redirects to decklist.app; a path that
// matches a static asset is served as it is.
// A permalink to a deck (/?deckname=…&deckmain=…) gets the page with its link preview
// naming the deck, and /preview.png draws that preview's image (preview.mjs). A deck
// link written after the site's address (decklist.app/https://moxfield.com/decks/…) is
// sent on to the page's deckimport parameter, which imports it on load; /api/event counts
// the page's error and outcome reports; anything else is a 404.

import { render } from './preview.mjs';

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

// The format and card counts a preview describes a deck by, as a list of parts
function summarize(format, main, side) {
  const plural = count => count + (count === 1 ? ' card' : ' cards');
  const parts = format ? [FORMATS[format]] : [];
  if (LED.has(format)) parts.push(plural(main + side));
  else if (main || side) parts.push(plural(main) + (side ? ' + ' + side + ' sideboard' : ''));
  return parts;
}

// Bump to make Discord and the cache fetch every deck's image again after its design changes
const IMAGE_VERSION = '1';
// The most cards the image lists, as preview.mjs fits them on its sheet
const IMAGE_CARDS = 15;

// The link preview for a permalink's query, or null when it holds no deck: its title and
// description, and the path of its image, whose query carries only what the image draws.
// The player's name and the event are left out: a preview is shown to everyone the link
// is posted to.
export function preview(params) {
  const deckname = (params.get('deckname') || '').trim();
  const deckmain = params.get('deckmain') || '', deckside = params.get('deckside') || '';
  if (!deckname && !deckmain.trim() && !deckside.trim()) return null;

  const format = Object.hasOwn(FORMATS, params.get('deckformat')) ? params.get('deckformat') : '';
  const deck = countDeck(deckmain, deckside);
  const summary = summarize(format, deck.main, deck.side);
  if (LED.has(format) && deck.leaders.length) summary.push(deck.leaders.join(' + '));
  const cards = deck.cards.slice(0, 8).map(card => card.q + ' ' + card.n).join(' · ')
    + (deck.cards.length > 8 ? ' · …' : '');
  const title = clip(deckname || (format ? FORMATS[format] + ' decklist' : 'MTG decklist'), 100);

  const image = new URLSearchParams({ v: IMAGE_VERSION, name: clip(deckname, 100), format, main: deck.main, side: deck.side });
  if (LED.has(format) && deck.leaders.length) image.set('leaders', deck.leaders.slice(0, 3).map(n => clip(n, 60)).join('\n'));
  image.set('cards', deck.cards.slice(0, IMAGE_CARDS).map(card => card.q + ' ' + clip(card.n, 60)).join('\n'));

  return {
    title,
    description: clip([summary.join(' · '), cards].filter(Boolean).join('. '), 300),
    image: '/preview.png?' + image,
    alt: 'Decklist for ' + title
  };
}

// What preview.mjs draws for an image's query, taking nothing on trust: the query is
// whatever a visitor writes
export function imageDeck(params) {
  const count = name => Math.min(Math.max(parseInt(params.get(name), 10) || 0, 0), 9999);
  const format = Object.hasOwn(FORMATS, params.get('format')) ? params.get('format') : '';
  const main = count('main'), side = count('side');
  const cards = (params.get('cards') || '').split('\n').slice(0, IMAGE_CARDS)
    .map(line => /^(\d{1,4}) (.+)$/.exec(line.trim())).filter(Boolean)
    .map(([, q, n]) => ({ q: Number(q), n: clip(n, 80) }));
  return {
    name: clip((params.get('name') || '').trim(), 150),
    format: format ? FORMATS[format] : '',
    summary: summarize(format, main, side).join(' · '),
    leaders: (params.get('leaders') || '').split('\n').filter(n => n.trim()).slice(0, 3).map(n => clip(n.trim(), 80)),
    cards,
    more: Math.max(main - cards.reduce((n, card) => n + card.q, 0), 0)
  };
}

function escapeAttribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Sets the page's Open Graph and Twitter title, description, image and image text.
// Accepts the page, preview()'s result, and the origin the image is served from, always
// https, as the site is (wrangler dev reports http)
export function rewrite(html, { title, description, image, alt }, origin) {
  const values = { title, description, image: origin + image, 'image:alt': alt };
  return html.replace(/(<meta (?:property="og|name="twitter):(title|description|image|image:alt)" content=")[^"]*(">)/g,
    (_, start, field, end) => start + escapeAttribute(values[field]) + end);
}

// A deck's preview image, from Cloudflare's cache when it was drawn before: each
// image's query names everything it shows, so it never changes
async function previewImage(request, url, env, ctx) {
  const key = new Request(url, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  let response = cache && await cache.match(key);
  if (!response) {
    let png;
    try {
      png = await render(imageDeck(url.searchParams));
    } catch (error) {
      console.error('Could not draw a preview image:', error);
      return env.ASSETS.fetch(new Request(new URL('/images/og-image.png', url)));
    }
    response = new Response(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' }
    });
    if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()));
  }
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

// The events the page reports (js/decklist/report.js), each with up to three short codes
const EVENTS = new Set(['error', 'load', 'preview', 'import', 'badlink', 'upload', 'download']);

// The browser family and kind of device, from the User-Agent, which isn't stored
export function client(agent = '') {
  const browser = /Edg\//.test(agent) ? 'edge' : /Firefox\/|FxiOS/.test(agent) ? 'firefox' :
    /SamsungBrowser/.test(agent) ? 'samsung' : /Chrome\/|CriOS/.test(agent) ? 'chrome' :
    /Safari\//.test(agent) ? 'safari' : 'other';
  return [browser, /Mobi|iPhone|iPad|Android/.test(agent) ? 'mobile' : 'desktop'];
}

// Records one of the page's events in Analytics Engine (the EVENTS binding): its name,
// its codes, the browser family and the device kind. No address, User-Agent, cookie or
// page URL is kept, and a browser sending Global Privacy Control is not counted. Every
// answer is a 204, so the page learns nothing either way.
export async function recordEvent(request, env) {
  const done = new Response(null, { status: 204 });
  if (request.method !== 'POST' || request.headers.get('Origin') !== new URL(request.url).origin ||
      request.headers.get('Sec-GPC') === '1' || !env.EVENTS) return done;
  if (Number(request.headers.get('Content-Length')) > 1024) return done;
  let event;
  try {
    const text = await request.text();
    if (text.length > 1024) return done;
    event = JSON.parse(text);
  } catch (_) {
    return done;
  }
  if (!event || !EVENTS.has(event.e) || !Array.isArray(event.d) || event.d.length > 3 ||
      !event.d.every(code => typeof code === 'string')) return done;
  const codes = event.d.map(code => code.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120));
  while (codes.length < 3) codes.push('');
  if (env.EVENT_LIMITER) {
    const { success } = await env.EVENT_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return done;
  }
  env.EVENTS.writeDataPoint({ indexes: [event.e], blobs: [event.e, ...codes, ...client(request.headers.get('User-Agent') || '')] });
  return done;
}

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const read = request.method === 'GET' || request.method === 'HEAD';

  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.href, 301);
  }

  if (url.pathname === '/api/event') return recordEvent(request, env);

  if (url.pathname !== '/') {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
  }

  if (url.pathname === '/') {
    const page = await env.ASSETS.fetch(request);
    const tags = read && page.ok && preview(url.searchParams);
    if (!tags) return page;
    const response = new Response(request.method === 'HEAD' ? null : rewrite(await page.text(), tags, 'https://' + url.host), page);
    response.headers.delete('Content-Length');
    response.headers.delete('ETag');
    return response;
  }

  if (read && url.pathname === '/preview.png') return previewImage(request, url, env, ctx);

  const link = read && deckLink(url);
  if (!link) return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 302, headers: { Location: '/?deckimport=' + encodeURIComponent(link) } });
}

export default { fetch: handle };
