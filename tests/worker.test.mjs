import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/index.mjs';

function setup(options = {}) {
  const entries = new Map();
  const calls = [];
  const env = {
    ALLOWED_ORIGINS: 'https://nealston.com,https://richardneal.github.io',
    IMPORT_LIMITER: { limit: async () => ({ success: !options.limited }) }
  };
  const ctx = { waitUntil: promise => promise };
  const services = {
    cache: {
      match: async key => entries.get(key.url)?.clone(),
      put: async (key, value) => { entries.set(key.url, value.clone()); }
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (options.throws) throw new Error('Network failure');
      return new Response(options.body ?? '4 Island\n\n2 Negate', { status: options.status || 200 });
    }
  };
  return { calls, entries, run: (query = '?source=mtggoldfish&id=123', origin = 'https://nealston.com', method = 'GET') =>
    handle(new Request('https://deck-import.nealston.com/api/import' + query, {
      method, headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1' }
    }), env, ctx, services) };
}

test('fetches only fixed export endpoints and caches validated text', async () => {
  const s = setup();
  const first = await s.run();
  assert.equal(first.status, 200);
  assert.equal(await first.text(), '4 Island\n\n2 Negate');
  assert.equal(s.calls[0].url, 'https://www.mtggoldfish.com/deck/download/123');
  assert.equal(s.calls[0].init.redirect, 'manual');
  const cached = await s.run(undefined, 'https://richardneal.github.io');
  assert.equal(cached.headers.get('Access-Control-Allow-Origin'), 'https://richardneal.github.io');
  assert.equal(s.calls.length, 1);
  await s.run('?source=mtgtop8&id=456');
  assert.equal(s.calls[1].url, 'https://www.mtgtop8.com/mtgo?d=456');
});
test('rejects arbitrary targets, invalid IDs, origins, and methods before fetching', async () => {
  const s = setup();
  for (const query of ['?source=evil&id=123', '?source=mtgtop8&id=0', '?source=mtggoldfish&id=../123', '?url=https://example.com']) {
    assert.equal((await s.run(query)).status, 400);
  }
  const denied = await s.run(undefined, 'https://evil.example');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await s.run(undefined, undefined, 'POST')).status, 405);
  assert.equal((await s.run(undefined, undefined, 'OPTIONS')).status, 204);
  assert.equal(s.calls.length, 0);
});
test('rate limits imports without contacting the source', async () => {
  const s = setup({ limited: true });
  const response = await s.run();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(s.calls.length, 0);
});
test('does not cache source errors, HTML, oversized exports or network failures', async () => {
  for (const options of [{ status: 403 }, { body: '<html>challenge</html>' }, { body: '' },
    { body: '4 ' + 'a'.repeat(65536) }, { throws: true }]) {
    const s = setup(options);
    assert.equal((await s.run()).status, 502);
    assert.equal(s.entries.size, 0);
  }
});
