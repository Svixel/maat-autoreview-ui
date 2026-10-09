/**
 * png.cjs — minimal, dependency-free PNG decode/encode/crop for autoreview-ui.
 *
 * The web driver gets region clipping for free from Playwright's
 * `page.screenshot({ clip })`. The simulator driver does not: `xcrun simctl io
 * screenshot` only ever writes the whole display, and macOS `sips` cannot do an
 * origin-anchored crop (`--cropOffset` is a no-op alongside `-c`, verified), so
 * region isolation and missing-state before/after diffs need a real codec.
 *
 * Scope is deliberately exactly what simctl emits: 8-bit, non-interlaced,
 * compression/filter method 0. Anything else throws rather than guessing.
 * Uses only node:zlib.
 */

"use strict";

const { deflateSync, inflateSync } = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channel count per PNG colour type (index = colour type). */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG buffer to raw, unfiltered samples.
 * @returns {{width:number,height:number,channels:number,data:Buffer}}
 */
function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("png: not a PNG (bad signature)");
  }
  let header = null;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new Error("png: no IHDR chunk");
  if (header.bitDepth !== 8) {
    throw new Error(`png: unsupported bit depth ${header.bitDepth} (only 8 is supported)`);
  }
  if (header.interlace !== 0) throw new Error("png: interlaced PNGs are not supported");
  if (header.colorType === 3) throw new Error("png: palette PNGs are not supported");
  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`png: unsupported colour type ${header.colorType}`);
  if (!idat.length) throw new Error("png: no IDAT chunk");

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`png: truncated image data (${raw.length} < ${expected})`);
  }

  const data = Buffer.allocUnsafe(stride * height);
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = data.subarray(y * stride, (y + 1) * stride);
    src.copy(row);
    switch (filterType) {
      case 0:
        break;
      case 1:
        for (let i = channels; i < stride; i++) row[i] = (row[i] + row[i - channels]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) row[i] = (row[i] + prevRow[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? row[i - channels] : 0;
          row[i] = (row[i] + ((a + prevRow[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? row[i - channels] : 0;
          const c = i >= channels ? prevRow[i - channels] : 0;
          row[i] = (row[i] + paeth(a, prevRow[i], c)) & 0xff;
        }
        break;
      default:
        throw new Error(`png: unknown filter type ${filterType} on row ${y}`);
    }
    prevRow = row;
  }
  return { width, height, channels, data };
}

function chunk(type, body) {
  const out = Buffer.allocUnsafe(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encode raw samples back to a PNG buffer (filter type 0 on every row). */
function encodePng({ width, height, channels, data }) {
  const colorType = Object.keys(CHANNELS).find(
    (k) => CHANNELS[k] === channels && k !== "3",
  );
  if (colorType === undefined) throw new Error(`png: cannot encode ${channels} channel(s)`);
  const stride = width * channels;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = Number(colorType);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Clamp a pixel rect to the image bounds; returns null if it has no area. */
function clampRect(image, rect) {
  const x = Math.max(0, Math.min(image.width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(image.height, Math.round(rect.y)));
  const width = Math.max(0, Math.min(image.width - x, Math.round(rect.width)));
  const height = Math.max(0, Math.min(image.height - y, Math.round(rect.height)));
  if (width === 0 || height === 0) return null;
  return { x, y, width, height };
}

/** Crop a decoded image to a pixel rect. Returns a new decoded image. */
function cropImage(image, rect) {
  const r = clampRect(image, rect);
  if (!r) return null;
  const { channels } = image;
  const out = Buffer.allocUnsafe(r.width * r.height * channels);
  const srcStride = image.width * channels;
  const dstStride = r.width * channels;
  for (let row = 0; row < r.height; row++) {
    const srcStart = (r.y + row) * srcStride + r.x * channels;
    image.data.copy(out, row * dstStride, srcStart, srcStart + dstStride);
  }
  return { width: r.width, height: r.height, channels, data: out };
}

/** Crop a PNG buffer to a pixel rect, returning a PNG buffer (null if empty). */
function cropPng(buffer, rect) {
  const cropped = cropImage(decodePng(buffer), rect);
  return cropped ? encodePng(cropped) : null;
}

/**
 * Resize a decoded PNG with bilinear sampling. Pixel centres are mapped to
 * pixel centres, which keeps exact source pixels at both edges rather than
 * introducing the half-pixel drift common to a naive `x * src / dst` loop.
 */
function resizeImage(image, width, height) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("png: resize dimensions must be positive integers");
  }
  if (image.width === width && image.height === height) {
    return { width, height, channels: image.channels, data: Buffer.from(image.data) };
  }
  const { channels } = image;
  const data = Buffer.allocUnsafe(width * height * channels);
  const xScale = width === 1 ? 0 : (image.width - 1) / (width - 1);
  const yScale = height === 1 ? 0 : (image.height - 1) / (height - 1);
  for (let y = 0; y < height; y++) {
    const sourceY = y * yScale;
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = x * xScale;
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const fx = sourceX - x0;
      const topLeft = (y0 * image.width + x0) * channels;
      const topRight = (y0 * image.width + x1) * channels;
      const bottomLeft = (y1 * image.width + x0) * channels;
      const bottomRight = (y1 * image.width + x1) * channels;
      const out = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel++) {
        const top = image.data[topLeft + channel] * (1 - fx) + image.data[topRight + channel] * fx;
        const bottom = image.data[bottomLeft + channel] * (1 - fx) + image.data[bottomRight + channel] * fx;
        data[out + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, channels, data };
}

/** Resize a PNG buffer to an exact pixel size. */
function resizePng(buffer, width, height) {
  return encodePng(resizeImage(decodePng(buffer), width, height));
}

/** Resize so the longest edge is exactly `longEdge`, preserving aspect ratio. */
function resizeLongEdgePng(buffer, longEdge) {
  if (!Number.isInteger(longEdge) || longEdge < 1) {
    throw new Error("png: long edge must be a positive integer");
  }
  const image = decodePng(buffer);
  const scale = longEdge / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return resizePng(buffer, width, height);
}

/**
 * Compare two PNG buffers over a pixel rect without re-encoding.
 * Differing dimensions count as "changed".
 */
function regionEquals(bufferA, bufferB, rect) {
  const a = decodePng(bufferA);
  const b = decodePng(bufferB);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return false;
  const r = clampRect(a, rect);
  if (!r) return true;
  const stride = a.width * a.channels;
  const span = r.width * a.channels;
  for (let row = 0; row < r.height; row++) {
    const start = (r.y + row) * stride + r.x * a.channels;
    if (a.data.compare(b.data, start, start + span, start, start + span) !== 0) return false;
  }
  return true;
}

module.exports = {
  decodePng,
  encodePng,
  cropImage,
  cropPng,
  resizeImage,
  resizeLongEdgePng,
  resizePng,
  regionEquals,
  clampRect,
};
