// Draws a deck's link preview image: a 1200×630 PNG with the deck's name, format and
// counts on the site's blue, and its first cards on a decklist sheet. The site Worker
// runs on the Workers Free plan, 10 ms of CPU a request, so nothing here rasterizes:
// text is copied from bitmaps drawn ahead of time (preview-font.mjs), the image is an
// indexed PNG of a few dozen colors, and the runtime's CompressionStream deflates it.
import { CHARS, FONTS, ICON } from './preview-font.mjs';

export const WIDTH = 1200, HEIGHT = 630;
const STRIDE = WIDTH + 1; // each PNG row starts with its filter byte, 0

const BLUE = [0x1f, 0x5f, 0xa8], GRID = [0x26, 0x65, 0xad], WHITE = [0xff, 0xff, 0xff],
  PALE = [0xd6, 0xe5, 0xf8], BACK = [0xa9, 0xc4, 0xe8], INK = [0x21, 0x25, 0x29],
  GRAY = [0x6c, 0x75, 0x7d], RULE = [0xed, 0xf0, 0xf3];

// Coverage bitmaps, two pixels a byte, decoded from base64 on first use. A table
// decoder: atob and a per-byte callback cost more CPU than the whole image
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
    bitmaps.set(key, { packed: decode(base64), offsets });
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
    this.blends = new Map();
    this.pixels = new Uint8Array(STRIDE * HEIGHT);
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
    const key = color * 4096 + under * 16 + coverage;
    let index = this.blends.get(key);
    if (index === undefined) {
      const fg = this.colors[color], bg = this.colors[under];
      index = this.index(fg.map((v, i) => Math.round(bg[i] + (v - bg[i]) * coverage / 15)));
      this.blends.set(key, index);
    }
    return index;
  }

  rect(x0, y0, x1, y1, rgb) {
    const color = this.index(rgb);
    for (let y = y0; y < y1; y++) this.pixels.fill(color, y * STRIDE + 1 + x0, y * STRIDE + 1 + x1);
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
            const p = y * STRIDE + 1 + x;
            this.pixels[p] = this.blend(color, this.pixels[p], coverage);
          }
          inset = i + 1;
        }
      }
      this.pixels.fill(color, y * STRIDE + 1 + x0 + inset, y * STRIDE + 1 + x1 - inset);
    }
  }

  coverage(packed, offset, w, h, left, top, color) {
    for (let y = 0; y < h; y++) {
      const py = top + y;
      if (py < 0 || py >= HEIGHT) continue;
      for (let x = 0; x < w; x++) {
        const px = left + x;
        const i = offset + y * w + x;
        const c = i & 1 ? packed[i >> 1] & 15 : packed[i >> 1] >> 4;
        if (!c || px < 0 || px >= WIDTH) continue;
        const p = py * STRIDE + 1 + px;
        this.pixels[p] = c === 15 ? color : this.blend(color, this.pixels[p], c);
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

  async png() {
    const chunks = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)];
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, WIDTH);
    new DataView(header.buffer).setUint32(4, HEIGHT);
    header.set([8, 3, 0, 0, 0], 8); // 8-bit indexed color
    chunks.push(chunk('IHDR', header));
    chunks.push(chunk('PLTE', Uint8Array.from(this.colors.flat())));
    const stream = new Blob([this.pixels]).stream().pipeThrough(new CompressionStream('deflate'));
    chunks.push(chunk('IDAT', new Uint8Array(await new Response(stream).arrayBuffer())));
    chunks.push(chunk('IEND', new Uint8Array(0)));
    const png = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { png.set(c, at); at += c.length; }
    return png;
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
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
    if (y % 42 === 0) canvas.pixels.fill(grid, y * STRIDE + 1, (y + 1) * STRIDE);
    else for (let x = 0; x < WIDTH; x += 42) canvas.pixels[y * STRIDE + 1 + x] = grid;
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
