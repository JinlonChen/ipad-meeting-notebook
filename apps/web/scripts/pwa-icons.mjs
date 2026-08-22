import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const background = [247, 247, 245, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function roundedRect(x, y, left, top, right, bottom, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

function circle(x, y, centerX, centerY, radius) {
  return (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
}

function iconPixels(size, maskable) {
  const pixels = Buffer.alloc(size * size * 4);
  const inset = maskable ? 0.22 : 0.16;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      let color = background;
      if (roundedRect(nx, ny, inset, inset, 1 - inset, 1 - inset, 0.075)) color = [37, 47, 45, 255];
      if (roundedRect(nx, ny, inset + 0.055, inset + 0.035, 1 - inset - 0.035, 1 - inset - 0.035, 0.045)) color = [255, 255, 253, 255];
      if (roundedRect(nx, ny, inset, inset, inset + 0.105, 1 - inset, 0.06)) color = [210, 75, 57, 255];
      if (circle(nx, ny, inset + 0.265, inset + 0.22, 0.052)) color = [210, 75, 57, 255];
      if (circle(nx, ny, inset + 0.405, inset + 0.22, 0.052)) color = [51, 113, 105, 255];
      if (roundedRect(nx, ny, inset + 0.19, inset + 0.355, 1 - inset - 0.09, inset + 0.39, 0.017)) color = [37, 47, 45, 255];
      if (roundedRect(nx, ny, inset + 0.19, inset + 0.445, 1 - inset - 0.16, inset + 0.48, 0.017)) color = [37, 47, 45, 255];
      pixels.set(color, (y * size + x) * 4);
    }
  }
  return pixels;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) pixels.copy(rows, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function decodePng(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), signature);
  const size = buffer.readUInt32BE(16);
  assert.equal(buffer.readUInt32BE(20), size);
  assert.deepEqual([...buffer.subarray(24, 29)], [8, 6, 0, 0, 0]);
  const idat = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    assert.equal(rows[y * (1 + size * 4)], 0);
    rows.copy(pixels, y * size * 4, y * (1 + size * 4) + 1, (y + 1) * (1 + size * 4));
  }
  return { size, pixels };
}

function verify(buffer, expectedSize, safeInset) {
  const { size, pixels } = decodePng(buffer);
  assert.equal(size, expectedSize);
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      assert.equal(pixels[offset + 3], 255);
      if (!background.every((channel, index) => pixels[offset + index] === channel)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const minimum = Math.floor(size * safeInset);
  assert.ok(minX >= minimum && minY >= minimum);
  assert.ok(maxX < size - minimum && maxY < size - minimum);
  for (const corner of [0, (size - 1) * 4, (size - 1) * size * 4, (size * size - 1) * 4]) {
    assert.deepEqual([...pixels.subarray(corner, corner + 4)], background);
  }
}

const root = resolve(import.meta.dirname, "..");
const icons = [
  { name: "icon-192.png", size: 192, maskable: false, safeInset: 0.15 },
  { name: "icon-512.png", size: 512, maskable: false, safeInset: 0.15 },
  { name: "icon-maskable-512.png", size: 512, maskable: true, safeInset: 0.2 },
];

for (const icon of icons) {
  const path = resolve(root, "public/icons", icon.name);
  if (process.argv.includes("--verify")) {
    verify(await readFile(path), icon.size, icon.safeInset);
  } else {
    await mkdir(dirname(path), { recursive: true });
    const png = encodePng(icon.size, iconPixels(icon.size, icon.maskable));
    verify(png, icon.size, icon.safeInset);
    await writeFile(path, png);
  }
}

console.log(`${process.argv.includes("--verify") ? "Verified" : "Generated"} ${icons.length} opaque PWA icons.`);
