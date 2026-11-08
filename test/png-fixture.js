const zlib = require('node:zlib');

/**
 * PNGs built in code, for the tests that read the Authority's QR off one.
 *
 * Not a checked-in binary. A PNG in a repository is a file nobody can read in a diff, and a test
 * asserting against one cannot say which pixels it means. Here each fixture is a grid of dark and
 * light written out in the test that uses it, and this turns that grid into the bytes a real
 * encoder would have produced: signature, IHDR, a palette where there is one, a deflated IDAT and
 * IEND, each chunk carrying the CRC the format asks for.
 *
 * Deliberately not named *.test.js. `npm test` globs the test files, and a helper caught by that
 * glob would be a suite with no tests in it.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

const chunk = (type, data) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * A PNG built from a dark/light grid, in whichever form the test needs.
 *
 * `rows` is an array of arrays of 1 for a dark pixel and 0 for a light one, which is the only thing
 * a QR code is. The colour type decides how that gets written: eight-bit grey is the ordinary case,
 * and the others exist so the reader is shown the shapes a real generator actually emits.
 */
function png(rows, opts = {}) {
  const colorType = opts.colorType === undefined ? 0 : opts.colorType;
  const bitDepth = opts.bitDepth === undefined ? 8 : opts.bitDepth;
  const height = rows.length;
  const width = rows[0].length;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ? 1 : 0;

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = Math.ceil((width * bitDepth * channels) / 8);
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < width; x++) {
      const dark = rows[y][x];
      if (bitDepth === 1) {
        // One bit per pixel. In a grey image the sample is the brightness, so the bit is set for a
        // light pixel; in a palette image it is an index, and black sits at index 1 below.
        const set = colorType === 3 ? dark : !dark;
        if (set) line[x >> 3] |= 0x80 >> (x & 7);
      } else if (colorType === 3) {
        line[x] = dark ? 1 : 0;
      } else if (colorType === 0) {
        line[x] = dark ? 0 : 255;
      } else if (colorType === 4) {
        line[x * 2] = dark ? 0 : 255;
        line[x * 2 + 1] = opts.alphaOf ? opts.alphaOf(x, y) : 255;
      } else if (colorType === 2 || colorType === 6) {
        const value = dark ? 0 : 255;
        line[x * channels] = value;
        line[x * channels + 1] = value;
        line[x * channels + 2] = value;
        if (colorType === 6) line[x * channels + 3] = opts.alphaOf ? opts.alphaOf(x, y) : 255;
      }
    }
  }

  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  // A black-and-white palette, with black at index 1 so the grid above reads the same way it does
  // everywhere else in this helper.
  if (colorType === 3) parts.push(chunk('PLTE', Buffer.from([255, 255, 255, 0, 0, 0])));
  if (colorType === 3 && opts.paletteAlpha) parts.push(chunk('tRNS', Buffer.from(opts.paletteAlpha)));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const base64Png = (rows, opts) => png(rows, opts).toString('base64');

/** A grid that is dark wherever `fn` says so. */
const grid = (width, height, fn) =>
  Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (fn(x, y) ? 1 : 0)));


module.exports = { png, base64Png, grid, chunk, crc32, SIGNATURE };
