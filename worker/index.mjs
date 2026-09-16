const MAX_BYTES = 64 * 1024;

export function upstreamURL(source, id) {
  if (!/^[1-9]\d{0,11}$/.test(id || '')) return null;
  if (source === 'mtggoldfish') return 'https://www.mtggoldfish.com/deck/download/' + id;
  if (source === 'mtgtop8') return 'https://www.mtgtop8.com/mtgo?d=' + id;
  return null;
}

async function readDeck(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
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
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('Deck export is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const text = new TextDecoder().decode(bytes).trim();
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
  const target = upstreamURL(source, id);
  if (!target) return reply('Provide a supported source and a numeric deck ID.', 400);
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
    const response = await (services.fetch || fetch)(target, {
      redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'text/plain' }
    });
    if (!response.ok) {
      await response.body?.cancel();
      return reply('The deck source returned HTTP ' + response.status + '. Try exporting and pasting the deck text.', 502);
    }
    const text = await readDeck(response);
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
