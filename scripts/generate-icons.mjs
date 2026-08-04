import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function icon(size) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const offset = row + 1 + x * 4;
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const rounded = edge > size * .09 || ((x - center) ** 2 + (y - center) ** 2 < (size * .48) ** 2);
      const inCard = rounded && x > size * .14 && x < size * .86 && y > size * .14 && y < size * .86;
      const inC = ((x - center) ** 2 + (y - center) ** 2 < (size * .22) ** 2) && ((x - center) ** 2 + (y - center) ** 2 > (size * .12) ** 2) && x < size * .58;
      const color = inC ? [9, 16, 24] : inCard ? [130, 232, 173] : [12, 21, 29];
      rows[offset] = color[0]; rows[offset + 1] = color[1]; rows[offset + 2] = color[2]; rows[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const directory = resolve(import.meta.dirname, '..', 'app/assets/icons');
await Promise.all([192, 512].map((size) => writeFile(resolve(directory, `icon-${size}.png`), icon(size))));
console.log('Generated PWA icons.');
