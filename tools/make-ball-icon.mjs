// A Pokeball, drawn into a .icns for the notification app bundle.
//
// No image library: PNG is a handful of chunks around a zlib stream, and zlib ships
// with node. The ball is drawn analytically at every size Apple asks for, so it stays
// crisp at 16px instead of being one big image scaled down and going muddy.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RED = [237, 28, 36], WHITE = [245, 245, 245], BLACK = [26, 26, 26];

// Alpha-blended coverage: a circle sampled 3x3 per pixel, which is enough to keep the
// edge smooth without a real rasteriser.
function ball(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2, R = size * 0.47, band = size * 0.075, btn = size * 0.15;
  const ring = Math.max(1, size * 0.028);
  const S = 3, step = 1 / (S + 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 1; sy <= S; sy++) for (let sx = 1; sx <= S; sx++) {
        const px_ = x + sx * step - 0.5, py = y + sy * step - 0.5;
        const dx = px_ - c, dy = py - c, d = Math.hypot(dx, dy);
        if (d > R) continue;                                  // outside the ball
        let col;
        if (d <= btn - ring) col = WHITE;                     // the button
        else if (d <= btn) col = BLACK;                       // its ring
        else if (Math.abs(dy) <= band / 2) col = BLACK;       // the band across the middle
        else if (d > R - ring) col = BLACK;                   // the outline
        else col = dy < 0 ? RED : WHITE;                      // red on top, white below
        r += col[0]; g += col[1]; b += col[2]; a += 255;
      }
      const n = S * S, i = (y * size + x) * 4;
      if (!a) continue;
      const cover = a / (n * 255);
      px[i] = r / (a / 255); px[i + 1] = g / (a / 255); px[i + 2] = b / (a / 255);
      px[i + 3] = Math.round(cover * 255);
    }
  }
  return png(px, size);
}

const crc32 = (buf) => {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                                   // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                              // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))]);
}

const out = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.notifier', 'ball.icns');
const set = out.replace(/\.icns$/, '.iconset');
fs.rmSync(set, { recursive: true, force: true });
fs.mkdirSync(set, { recursive: true });
for (const [size, name] of [[16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'],
  [64, 'icon_32x32@2x'], [128, 'icon_128x128'], [256, 'icon_128x128@2x'], [256, 'icon_256x256'],
  [512, 'icon_256x256@2x'], [512, 'icon_512x512'], [1024, 'icon_512x512@2x']]) {
  fs.writeFileSync(path.join(set, `${name}.png`), ball(size));
}
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('iconutil', ['-c', 'icns', set, '-o', out]);
fs.rmSync(set, { recursive: true, force: true });
console.log(out);
