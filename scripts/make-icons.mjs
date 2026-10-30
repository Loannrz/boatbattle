// Génère les icônes PNG de l'app (sans dépendance) : node scripts/make-icons.mjs
// Dessin : fond marine, laser cyan qui rebondit sur un triangle-miroir mauve, bloc bleu.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Formes dans un repère 0..64 : feuille quadrillée, triangle de papier mauve,
// barre bleue, fil rouge qui rebondit sur la diagonale.
function shapes(full) {
  const list = [];
  if (full) list.push({ kind: 'rect', x: 0, y: 0, w: 64, h: 64, color: '#FBF8F1' });
  else list.push({ kind: 'rrect', x: 2, y: 2, w: 60, h: 60, r: 10, color: '#FBF8F1' });
  for (let i = 1; i < 6; i++) {
    list.push({ kind: 'seg', a: [7 + i * 8.33, 7], b: [7 + i * 8.33, 57], w: 0.45, color: '#A9A296' });
    list.push({ kind: 'seg', a: [7, 7 + i * 8.33], b: [57, 7 + i * 8.33], w: 0.45, color: '#A9A296' });
  }
  list.push({ kind: 'rect', x: 32, y: 40.3, w: 16.7, h: 8.3, color: '#3F6FAE' });
  list.push({ kind: 'tri', p: [[32, 15.3], [48.7, 15.3], [48.7, 32]], color: '#9A6DAF' });
  list.push({ kind: 'seg', a: [32, 15.3], b: [48.7, 32], w: 0.9, color: '#5F3F70' });
  list.push({ kind: 'seg', a: [7, 36], b: [40.3, 36], w: 1.6, color: '#B3261E' });
  list.push({ kind: 'seg', a: [40.3, 36], b: [40.3, 23.6], w: 1.6, color: '#B3261E' });
  list.push({ kind: 'seg', a: [40.3, 23.6], b: [7, 23.6], w: 1.6, color: '#B3261E' });
  return list;
}

function inside(s, x, y) {
  switch (s.kind) {
    case 'rect':
      return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
    case 'rrect': {
      const cx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r);
      const cy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= s.r ** 2;
    }
    case 'tri': {
      const [[x1, y1], [x2, y2], [x3, y3]] = s.p;
      const d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
      const d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3);
      const d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      return !(neg && pos);
    }
    case 'seg': {
      const [ax, ay] = s.a;
      const [bx, by] = s.b;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (s.w / 2) ** 2;
    }
  }
  return false;
}

function render(size, { full = false, pad = 0 } = {}) {
  const list = shapes(full);
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  const scale = (64 + pad * 2) / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) * scale - pad;
          const v = (y + (sy + 0.5) / ss) * scale - pad;
          let col = null;
          if (full) col = hex('#FBF8F1');
          for (const s of list) if (inside(s, u, v)) col = hex(s.color);
          if (col) {
            r += col[0]; g += col[1]; b += col[2]; a += 255;
          }
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const alpha = a / n;
      px[i] = alpha ? Math.round((r / n) * (255 / alpha)) : 0;
      px[i + 1] = alpha ? Math.round((g / n) * (255 / alpha)) : 0;
      px[i + 2] = alpha ? Math.round((b / n) * (255 / alpha)) : 0;
      px[i + 3] = Math.round(alpha);
    }
  }
  return px;
}

// ---- encodeur PNG minimal ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const write = (name, size, opts) => {
  writeFileSync(new URL(name, OUT), png(size, render(size, opts)));
  console.log('écrit', name);
};
write('icon-192.png', 192);
write('icon-512.png', 512);
write('icon-maskable-512.png', 512, { full: true, pad: 10 });
write('apple-touch-icon.png', 180, { full: true, pad: 2 });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="10" fill="#FBF8F1"/><path d="M15.3 7v50M23.7 7v50M32 7v50M40.3 7v50M48.7 7v50M7 15.3h50M7 23.7h50M7 32h50M7 40.3h50M7 48.7h50" stroke="#A9A296" stroke-width=".45"/><rect x="32" y="40.3" width="16.7" height="8.3" fill="#3F6FAE"/><path d="M32 15.3H48.7V32Z" fill="#9A6DAF"/><path d="M32 15.3L48.7 32" stroke="#5F3F70" stroke-width=".9"/><path d="M7 36H40.3V23.6H7" fill="none" stroke="#B3261E" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
writeFileSync(new URL('icon.svg', OUT), svg);
console.log('écrit icon.svg');
