import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, checksum]);
}
/** App-owned deterministic media input for a real image-edit/reference smoke generation. */
export function ensureComfySmokeReference(directory: string): string {
  const width = 128,
    height = 128;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * (1 + width * 3) + 1 + x * 3;
      const foreground = x >= 36 && x < 92 && y >= 32 && y < 96;
      pixels[index] = foreground ? 200 : 225;
      pixels[index + 1] = foreground ? 40 : 215;
      pixels[index + 2] = foreground ? 30 : 200;
    }
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'smoke-reference.png');
  if (!fs.existsSync(file) || !fs.readFileSync(file).equals(png)) fs.writeFileSync(file, png);
  return file;
}
