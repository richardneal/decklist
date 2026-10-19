// Plenty for a text export. The JSON sources raise their own cap.
const MAX_BYTES = 64 * 1024;

const SOURCES = {
  mtggoldfish: {
    id: /^[1-9]\d{0,11}$/,
    url: id => 'https://www.mtggoldfish.com/deck/download/' + id,
    accept: 'text/plain'
  },
  mtgtop8: {
    id: /^[1-9]\d{0,11}$/,
    url: id => 'https://www.mtgtop8.com/mtgo?d=' + id,
    accept: 'text/plain'
  },
  moxfield: {
    // Public deck IDs are base64url-encoded GUIDs, so 22 characters in practice. The
    // lower bound keeps route names such as /decks/public from reading as a deck ID.
    id: /^[A-Za-z0-9_-]{16,32}$/,
    url: id => 'https://api2.moxfield.com/v3/decks/all/' + id,
    accept: 'application/json',
    // A 60-card deck's JSON runs about 140 KB, since every card is spelled out in
    // full; this leaves room for a Commander deck with 100 distinct cards.
    limit: 2 * 1024 * 1024,
    convert: moxfieldDeck,
    // Moxfield fronts its API with Cloudflare, which turns some clients away; this
    // names us politely, and takes an allowlisted string if they ever ask for one.
    agent: env => env.MOXFIELD_USER_AGENT
  },
  archidekt: {
    id: /^[1-9]\d{0,11}$/,
    url: id => 'https://archidekt.com/api/decks/' + id + '/',
    accept: 'application/json',
    // Each card carries its full printing and oracle data, as with Moxfield.
    limit: 2 * 1024 * 1024,
    convert: archidektDeck
  },
  scryfall: {
    // Deck IDs are UUIDs; the frontend lowercases them so a deck caches only once.
    id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    url: id => 'https://api.scryfall.com/decks/' + id + '/export/json',
    accept: 'application/json',
    // A Commander deck with a long maybeboard runs about 240 KB.
    limit: 2 * 1024 * 1024,
    convert: scryfallDeck,
    // Scryfall's API asks every client to name itself.
    agent: env => env.USER_AGENT
  }
};

export function upstreamURL(source, id) {
  const definition = SOURCES[source];
  return definition && definition.id.test(id || '') ? definition.url(id) : null;
}

// Writes main and side boards of [name, quantity] pairs as quantity-prefixed decklist
// text, merging separate printings of one card, since a decklist names each card once.
function deckText(main, side) {
  const lines = entries => {
    const totals = new Map();
    for (const [card, quantity] of entries) {
      if (!card || typeof card !== 'string' || !Number.isInteger(quantity) || quantity < 1) continue;
      totals.set(card, (totals.get(card) || 0) + quantity);
    }
    return [...totals].map(([name, quantity]) => quantity + ' ' + name);
  };
  const sideLines = lines(side);
  return lines(main).concat(sideLines.length ? ['Sideboard'].concat(sideLines) : []).join('\n');
}

// Collapses the boards of a Moxfield deck into quantity-prefixed decklist text.
export function moxfieldDeck(text) {
  let deck;
  try { deck = JSON.parse(text); } catch (_) { throw new Error('Moxfield did not return deck data.'); }
  if (!deck || !deck.boards || typeof deck.boards !== 'object') {
    throw new Error('Moxfield did not return deck data.');
  }
  const board = names => names.flatMap(name => Object.values(deck.boards[name]?.cards || {}))
    .map(entry => [entry?.card?.name, entry?.quantity]);
  // Commander has no sideboard, so the commander leads it, where sorting the main deck
  // cannot bury it among the other creatures; a companion is played from there too.
  return deckText(board(['mainboard']), board(['commanders', 'sideboard', 'companions']));
}

// Collapses an Archidekt deck into quantity-prefixed decklist text. Archidekt keeps its
// boards as categories, and a card's first category is the one that places it: the
// Sideboard category is the sideboard, and any other category marked as left out of the
// deck (the Maybeboard, say) is dropped. The commander leads the sideboard, and a
// companion is played from there, whether Archidekt flags it or the player filed it
// under a Companion category.
export function archidektDeck(text) {
  let deck;
  try { deck = JSON.parse(text); } catch (_) { throw new Error('Archidekt did not return deck data.'); }
  if (!deck || !Array.isArray(deck.cards)) throw new Error('Archidekt did not return deck data.');
  const categories = Array.isArray(deck.categories) ? deck.categories.filter(Boolean) : [];
  const excluded = new Set(categories.filter(category => category.includedInDeck === false).map(category => category.name));
  // Premier categories hold the commander, which leads the sideboard.
  const premier = new Set(categories.filter(category => category.isPremier).map(category => category.name));
  const commanders = [], main = [], side = [];
  for (const entry of deck.cards) {
    const category = Array.isArray(entry?.categories) ? entry.categories[0] : undefined;
    const card = [entry?.card?.oracleCard?.name, entry?.quantity];
    if (category === 'Sideboard' || category === 'Companion' || entry?.companion === true) side.push(card);
    else if (premier.has(category)) commanders.push(card);
    else if (!excluded.has(category)) main.push(card);
  }
  return deckText(main, commanders.concat(side));
}

// Collapses a Scryfall deck into quantity-prefixed decklist text. The sections follow the
// deck's layout: a constructed deck has a mainboard and a sideboard, a Commander deck its
// nonlands and lands, plus its commanders and cards from outside the game (a companion,
// say), which a registration sheet lists as the sideboard. The maybeboard is dropped, as are
// blank entries Scryfall could not match to a card.
export function scryfallDeck(text) {
  let deck;
  try { deck = JSON.parse(text); } catch (_) { throw new Error('Scryfall did not return deck data.'); }
  if (!deck || !deck.entries || typeof deck.entries !== 'object') throw new Error('Scryfall did not return deck data.');
  const board = names => names.flatMap(name => Array.isArray(deck.entries[name]) ? deck.entries[name] : [])
    .map(entry => [entry?.card_digest?.name, entry?.count]);
  return deckText(board(['mainboard', 'nonlands', 'lands']), board(['commanders', 'sideboard', 'outside']));
}

async function readBody(response, limit = MAX_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Deck export is too large.');
  }
  if (!response.body) throw new Error('Empty deck export.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Deck export is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes).trim();
}

function validateDeck(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => /^\d+x?\s+\S/.test(line)) ||
      !lines.every(line => /^(?:\d+x?\s+\S|SB:\s*\d+\s+\S|Sideboard\b)/i.test(line)) ||
      /<\/?(?:html|head|body)\b/i.test(text)) {
    throw new Error('The source did not return a deck export.');
  }
  return text;
}

export async function handle(request, env, ctx, services = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
  const corsOrigin = origin && (origin === url.origin || allowed.includes(origin)) ? origin : null;
  function reply(body, status = 200, extra = {}) {
    return new Response(body, { status, headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Origin',
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      ...extra
    } });
  }
  if (origin && !corsOrigin) return reply('This website is not allowed to use the import API.', 403);
  if (url.pathname !== '/api/import') return reply('Not found.', 404);
  if (request.method === 'OPTIONS') return reply(null, 204, {
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400'
  });
  if (request.method !== 'GET') return reply('Use GET.', 405, { Allow: 'GET, OPTIONS' });
  const source = url.searchParams.get('source'), id = url.searchParams.get('id');
  const definition = SOURCES[source], target = upstreamURL(source, id);
  if (!target) return reply('Provide a supported source and a valid deck ID.', 400);
  if (!env.IMPORT_LIMITER) return reply('Import service is not configured.', 503);
  const { success } = await env.IMPORT_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
  if (!success) return reply('Too many imports. Please try again in a minute.', 429, { 'Retry-After': '60' });
  const cache = services.cache || caches.default;
  const key = new Request(url.origin + '/api/import?source=' + source + '&id=' + id);
  const cached = await cache.match(key);
  if (cached) return reply(await cached.text());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const agent = definition.agent?.(env);
    const response = await (services.fetch || fetch)(target, {
      redirect: 'manual', signal: controller.signal,
      headers: { Accept: definition.accept, ...(agent ? { 'User-Agent': agent } : {}) }
    });
    if (!response.ok) {
      await response.body?.cancel();
      return reply('The deck source returned HTTP ' + response.status + '. Try exporting and pasting the deck text.', 502);
    }
    const body = await readBody(response, definition.limit);
    const text = validateDeck(definition.convert ? definition.convert(body) : body);
    // Cache only validated data; add origin-specific headers after retrieving it.
    ctx.waitUntil(cache.put(key, new Response(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
    })).catch(() => {}));
    return reply(text);
  } catch (error) {
    console.error('Deck import failed:', error.name, error.message);
    if (controller.signal.aborted) return reply('The deck source timed out. Please try again.', 504);
    return reply('Unable to download a valid deck export. Try exporting and pasting the deck text.', 502);
  } finally {
    clearTimeout(timeout);
  }
}

export default { fetch: handle };
