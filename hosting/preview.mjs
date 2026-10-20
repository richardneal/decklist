// Draws a deck's link preview image: a 1200×630 PNG with the deck's name, format and
// counts on the site's blue, and its first cards on a decklist sheet. The site Worker
// runs on the Workers Free plan, 10 ms of CPU a request, so nothing here rasterizes:
// text is copied from bitmaps drawn ahead of time (preview-font.mjs), the image is an
// indexed PNG of a few dozen colors, and a run-length deflate written for it (zlib())
// compresses it: CompressionStream's zlib alone takes more than half the budget.
import { CHARS, FONTS, ICON } from './preview-font.mjs';

export const WIDTH = 1200, HEIGHT = 630;
// The PNG's rows: a filter byte, 0, then the pixels. The canvas keeps the pixels alone,
// so that each row starts on a 4-byte word
const STRIDE = WIDTH + 1;

const BLUE = [0x1f, 0x5f, 0xa8], GRID = [0x26, 0x65, 0xad], WHITE = [0xff, 0xff, 0xff],
  PALE = [0xd6, 0xe5, 0xf8], BACK = [0xa9, 0xc4, 0xe8], INK = [0x21, 0x25, 0x29],
  GRAY = [0x6c, 0x75, 0x7d], RULE = [0xed, 0xf0, 0xf3];

// Coverage bitmaps, two pixels a byte, decoded from base64 on first use. Without a
// native decoder, a table one: atob and a per-byte callback cost more than the image
const BASE64 = new Uint8Array(128);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { BASE64[c.charCodeAt(0)] = i; });
function decode(base64) {
  const length = base64.length - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  const bytes = new Uint8Array(length * 3 >> 2);
  for (let i = 0, o = 0; i < length; i += 4) {
    const n = BASE64[base64.charCodeAt(i)] << 18 | BASE64[base64.charCodeAt(i + 1)] << 12
      | BASE64[base64.charCodeAt(i + 2)] << 6 | BASE64[base64.charCodeAt(i + 3)];
    bytes[o++] = n >> 16;
    if (o < bytes.length) bytes[o++] = n >> 8 & 255;
    if (o < bytes.length) bytes[o++] = n & 255;
  }
  return bytes;
}
const bitmaps = new Map();
function bitmap(key, base64) {
  if (!bitmaps.has(key)) {
    const glyphs = FONTS[key] && FONTS[key].glyphs;
    let offset = 0;
    const offsets = glyphs ? glyphs.map(([, , , w, h]) => { const at = offset; offset += w * h; return at; }) : null;
    // Workers decodes base64 natively; Node 22, where the tests run, does not
    const packed = Uint8Array.fromBase64 ? Uint8Array.fromBase64(base64) : decode(base64);
    bitmaps.set(key, { packed, offsets });
  }
  return bitmaps.get(key);
}

// Folds text to the characters the bitmaps hold: Lim-Dûl to Lim-Dul, Æther to AEther
export function fold(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/Æ/g, 'AE').replace(/æ/g, 'ae').replace(/Œ/g, 'OE').replace(/œ/g, 'oe').replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .split('').map(c => CHARS.includes(c) ? c : '?').join('');
}

function measure(font, text) {
  const { glyphs } = FONTS[font];
  let width = 0;
  for (const c of text) width += glyphs[CHARS.indexOf(c)][0] / 100;
  return width;
}

// Shortens text to fit a width, ending it with an ellipsis
function clip(font, text, width) {
  if (measure(font, text) <= width) return text;
  while (text && measure(font, text.trimEnd() + '…') > width) text = text.slice(0, -1);
  return text.trimEnd() + '…';
}

// Breaks text into at most `lines` lines that fit a width; the last one is clipped
function wrap(font, text, width, lines) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (!line || measure(font, next) <= width) line = next;
    else { out.push(line); line = word; }
  }
  out.push(line);
  if (out.length > lines) out.splice(lines - 1, Infinity, clip(font, out.slice(lines - 1).join(' ') + '…', width));
  return out.map(l => clip(font, l, width));
}

class Canvas {
  constructor() {
    this.colors = [BLUE];   // palette index 0, the background, so a zeroed row is blue
    this.lookup = new Map([[BLUE.join(), 0]]);
    this.ramps = new Map();
    this.pixels = new Uint8Array(WIDTH * HEIGHT);
  }

  // The palette index of a color, added if there is room; else the nearest color
  index(rgb) {
    const key = rgb.join();
    if (this.lookup.has(key)) return this.lookup.get(key);
    if (this.colors.length < 256) {
      this.colors.push(rgb);
      this.lookup.set(key, this.colors.length - 1);
      return this.colors.length - 1;
    }
    let best = 0, distance = Infinity;
    this.colors.forEach((c, i) => {
      const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
      if (d < distance) { distance = d; best = i; }
    });
    return best;
  }

  // The index of a color laid over a pixel's color at a coverage of 0–15
  blend(color, under, coverage) {
    return this.ramp(color)(under, coverage);
  }

  // Blends one color over others: a function of the color under it and a coverage of
  // 0–15, remembered in a typed array, since glyph edges blend thousands of pixels
  ramp(color) {
    let ramp = this.ramps.get(color);
    if (!ramp) {
      const table = new Int16Array(256 * 16).fill(-1);
      const fg = this.colors[color];
      ramp = (under, coverage) => {
        const key = under * 16 + coverage;
        let index = table[key];
        if (index < 0) {
          const bg = this.colors[under];
          index = table[key] = this.index(fg.map((v, i) => Math.round(bg[i] + (v - bg[i]) * coverage / 15)));
        }
        return index;
      };
      ramp.table = table;
      this.ramps.set(color, ramp);
    }
    return ramp;
  }

  rect(x0, y0, x1, y1, rgb) {
    const color = this.index(rgb);
    for (let y = y0; y < y1; y++) this.pixels.fill(color, y * WIDTH + x0, y * WIDTH + x1);
  }

  // A rectangle with corners of radius r, smoothed against whatever is under them
  roundRect(x0, y0, x1, y1, r, rgb) {
    const color = this.index(rgb);
    for (let y = y0; y < y1; y++) {
      const dy = y < y0 + r ? y0 + r - y - 0.5 : y >= y1 - r ? y - (y1 - r) + 0.5 : 0;
      // How far in from each side the corner's curve leaves this row
      let inset = 0;
      if (dy) {
        while (inset < r && Math.hypot(r - inset - 0.5, dy) > r + 0.5) inset++;
        for (let i = inset; i < r; i++) {
          const coverage = Math.round(Math.max(0, Math.min(1, r + 0.5 - Math.hypot(r - i - 0.5, dy))) * 15);
          if (coverage === 15) break;
          for (const x of [x0 + i, x1 - 1 - i]) {
            const p = y * WIDTH + x;
            this.pixels[p] = this.blend(color, this.pixels[p], coverage);
          }
          inset = i + 1;
        }
      }
      this.pixels.fill(color, y * WIDTH + x0 + inset, y * WIDTH + x1 - inset);
    }
  }

  coverage(packed, offset, w, h, left, top, color) {
    const pixels = this.pixels, ramp = this.ramp(color), table = ramp.table;
    const x0 = Math.max(0, -left), x1 = Math.min(w, WIDTH - left);
    const y0 = Math.max(0, -top), y1 = Math.min(h, HEIGHT - top);
    for (let y = y0; y < y1; y++) {
      const row = (top + y) * WIDTH + left, start = offset + y * w;
      for (let x = x0; x < x1; x++) {
        const i = start + x;
        const c = i & 1 ? packed[i >> 1] & 15 : packed[i >> 1] >> 4;
        if (!c) continue;
        const p = row + x;
        if (c === 15) { pixels[p] = color; continue; }
        const index = table[pixels[p] * 16 + c];
        pixels[p] = index < 0 ? ramp(pixels[p], c) : index;
      }
    }
  }

  // Draws text with its baseline at y, from x (or ending at x when align is 'right')
  text(font, text, x, y, rgb, align = 'left') {
    const { glyphs } = FONTS[font];
    const { packed, offsets } = bitmap(font, FONTS[font].data);
    const color = this.index(rgb);
    let pen = align === 'right' ? x - measure(font, text) : x;
    for (const c of text) {
      const i = CHARS.indexOf(c);
      const [advance, left, top, w, h] = glyphs[i];
      if (w) this.coverage(packed, offsets[i], w, h, Math.round(pen + left), y + top, color);
      pen += advance / 100;
    }
  }

  icon(x, y, rgb) {
    const { packed } = bitmap('icon', ICON.data);
    this.coverage(packed, 0, ICON.size, ICON.size, x, y, this.index(rgb));
  }

  png() {
    const chunks = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)];
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, WIDTH);
    new DataView(header.buffer).setUint32(4, HEIGHT);
    header.set([8, 3, 0, 0, 0], 8); // 8-bit indexed color
    chunks.push(chunk('IHDR', header));
    chunks.push(chunk('PLTE', Uint8Array.from(this.colors.flat())));
    chunks.push(chunk('IDAT', zlib(this.pixels)));
    chunks.push(chunk('IEND', new Uint8Array(0)));
    const png = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { png.set(c, at); at += c.length; }
    return png;
  }
}

// Deflate's fixed Huffman codes, with their bits reversed, since deflate writes a code
// from its most significant bit into a stream read from the least. Codes and their
// lengths sit in typed arrays, which a cold Worker reads faster than [bits, count] pairs
function reverse(code, length) {
  let out = 0;
  for (let i = 0; i < length; i++) { out = out << 1 | code & 1; code >>= 1; }
  return out;
}
const LITERAL_BITS = new Int32Array(288), LITERAL_COUNT = new Uint8Array(288);
for (let v = 0; v < 288; v++) {
  const [code, count] = v < 144 ? [0x30 + v, 8] : v < 256 ? [0x190 + v - 144, 9] : v < 280 ? [v - 256, 7] : [0xc0 + v - 280, 8];
  LITERAL_BITS[v] = reverse(code, count);
  LITERAL_COUNT[v] = count;
}
// A match length's code and extra bits, together
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const LENGTH_BITS = new Int32Array(259), LENGTH_COUNT = new Uint8Array(259);
for (let length = 3; length <= 258; length++) {
  let i = LENGTH_BASE.length - 1;
  while (LENGTH_BASE[i] > length) i--;
  LENGTH_BITS[length] = LITERAL_BITS[257 + i] | (length - LENGTH_BASE[i]) << LITERAL_COUNT[257 + i];
  LENGTH_COUNT[length] = LITERAL_COUNT[257 + i] + LENGTH_EXTRA[i];
}
// The two distances it matches at: the pixel before (code 0), and the row above (code
// 20, distances 1025–1536, 9 extra bits)
const BEFORE_COUNT = 5;
const ABOVE_BITS = reverse(20, 5) | (STRIDE - 1025) << 5, ABOVE_COUNT = 14;
const ROW_MATCHES = [258, 258, 258, 258, STRIDE - 4 * 258];

// Compresses the image into a zlib stream of PNG rows: a row the same as the one above
// is one match, and any other is runs of one color, each a literal and a match a pixel
// back. That catches most of what zlib would, in one pass without hash chains. Rows are
// compared, and runs scanned, a word (4 pixels) at a time, and the Adler-32 checksum
// is summed a run at a time: a cold Worker's CPU limit leaves no room for byte loops
function zlib(pixels) {
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >> 2);
  const out = new Uint8Array(Math.ceil(HEIGHT * STRIDE * 9 / 8) + 64);
  out[0] = 0x78; out[1] = 0x01; // deflate, 32K window, no preset dictionary
  // The bit writer is written out inline, in locals: before the JIT warms up, a call
  // or a closure's variable per symbol costs more than the rest of the image together.
  // Each write adds at most 24 bits to fewer than 8, and then writes out whole bytes
  let at = 2, buffer = 0b011, count = 3; // the final block, with fixed codes
  // Adler-32 adds a row of n bytes x[k] as a += Σx[k], b += n·a + Σx[k]·(n - k)
  let a = 1, b = 0, sum = 0, weighted = 0;
  const ROW_WORDS = WIDTH >> 2;
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * WIDTH, rowWords = y * ROW_WORDS;
    let same = y > 0;
    for (let w = 0; same && w < ROW_WORDS; w++) same = words[rowWords + w] === words[rowWords - ROW_WORDS + w];
    if (same) {
      // The row above, 1201 bytes back: four matches of 258 and one of 169
      for (const take of ROW_MATCHES) {
        buffer |= LENGTH_BITS[take] << count; count += LENGTH_COUNT[take];
        while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
        buffer |= ABOVE_BITS << count; count += ABOVE_COUNT;
        while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
      }
    } else {
      buffer |= LITERAL_BITS[0] << count; count += LITERAL_COUNT[0]; // filter: none
      while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
      sum = 0; weighted = 0;
      for (let i = row, end = row + WIDTH; i < end;) {
        const color = pixels[i], fill = color * 0x01010101 >>> 0;
        let j = i + 1;
        while (j < end && j & 3 && pixels[j] === color) j++;
        if (!(j & 3)) while (j + 4 <= end && words[j >> 2] === fill) j += 4;
        while (j < end && pixels[j] === color) j++;
        const length = j - i, k = i - row + 1; // k: the run's place in the PNG row
        sum += color * length;
        weighted += color * (length * (STRIDE - k) - length * (length - 1) / 2);
        // The run's first pixel as a literal, the rest as matches one byte back (none
        // shorter than 3, so a long run leaves 3 at least), and any 1 or 2 left as literals
        const literalBits = LITERAL_BITS[color], literalCount = LITERAL_COUNT[color];
        buffer |= literalBits << count; count += literalCount;
        while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
        let left = length - 1;
        while (left >= 3) {
          const take = left <= 258 ? left : left - 258 < 3 ? left - 3 : 258;
          buffer |= LENGTH_BITS[take] << count; count += LENGTH_COUNT[take];
          while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
          count += BEFORE_COUNT; // distance 1: code 0, all zero bits
          while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
          left -= take;
        }
        for (; left > 0; left--) {
          buffer |= literalBits << count; count += literalCount;
          while (count >= 8) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
        }
        i = j;
      }
      sum %= 65521; weighted %= 65521;
    }
    b = (b + STRIDE * a + weighted) % 65521;
    a = (a + sum) % 65521;
  }
  buffer |= LITERAL_BITS[256] << count; count += LITERAL_COUNT[256]; // end of block
  while (count > 0) { out[at++] = buffer & 255; buffer >>>= 8; count -= 8; }
  new DataView(out.buffer).setUint32(at, (b << 16 | a) >>> 0);
  return out.subarray(0, at + 4);
}

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}

const ROWS = 15, ROW = 30, FIRST_ROW = 136;

// Draws a deck's preview image
// Accepts {name, format, summary, leaders: [names], cards: [{q, n}], more: cards not listed}
// Returns the PNG's bytes
export async function render({ name = '', format = '', summary = '', leaders = [], cards = [], more = 0 }) {
  const canvas = new Canvas();

  // The background's faint grid
  const grid = canvas.index(GRID);
  for (let y = 0; y < HEIGHT; y++) {
    if (y % 42 === 0) canvas.pixels.fill(grid, y * WIDTH, (y + 1) * WIDTH);
    else for (let x = 0; x < WIDTH; x += 42) canvas.pixels[y * WIDTH + x] = grid;
  }

  // Left: the site, then the deck
  canvas.icon(60, 50, WHITE);
  canvas.text('brand', 'decklist.app', 120, 85, WHITE);
  let y = 190;
  for (const line of wrap('title', fold(name || 'MTG decklist'), 520, 3)) {
    canvas.text('title', line, 64, y, WHITE);
    y += 64;
  }
  y += 2;
  if (summary) { canvas.text('summary', clip('summary', fold(summary), 520), 64, y, PALE); y += 42; }
  for (const leader of leaders.slice(0, 3)) {
    if (y > 520) break;
    canvas.text('leader', clip('leader', fold(leader), 520), 64, y, WHITE);
    y += 38;
  }
  canvas.text('summary', 'No more decklist problems', 64, 572, PALE);

  // Right: the sheet, over a second one behind it
  canvas.roundRect(678, 60, 1152, 598, 14, BACK);
  canvas.roundRect(660, 44, 1134, 582, 14, WHITE);
  canvas.text('count', 'DECKLIST', 690, 88, BLUE);
  if (format) canvas.text('small', clip('small', fold(format), 260), 1104, 87, GRAY, 'right');
  canvas.rect(690, 99, 1104, 102, BLUE);
  // A full sheet with cards left over gives its last row to how many
  const full = cards.length > ROWS || (more > 0 && cards.length >= ROWS);
  const shown = full ? cards.slice(0, ROWS - 1) : cards;
  for (let row = 0; row < ROWS; row++) {
    const base = FIRST_ROW + row * ROW;
    canvas.rect(690, base + 10, 1104, base + 11, RULE);
    const card = shown[row];
    if (card) {
      canvas.text('count', String(card.q), 720, base, BLUE, 'right');
      canvas.text('card', clip('card', fold(card.n), 370), 732, base, INK);
    }
  }
  const rest = more + cards.slice(shown.length).reduce((n, card) => n + card.q, 0);
  if (rest) canvas.text('small', '+ ' + rest + (rest === 1 ? ' more card' : ' more cards'), 732, FIRST_ROW + (ROWS - 1) * ROW, GRAY);

  return canvas.png();
}
