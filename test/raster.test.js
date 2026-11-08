const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const path = require('node:path');

const {
  fiscalQrRaster, qrDotsFor, decodePng, downsample, packRaster, rasterCommand
} = require(path.join(__dirname, '..', 'src', 'raster.js'));

/**
 * Reading the Authority's QR off the paper it came on.
 *
 * EIMS hands back a PNG it has already drawn and signed, and the whole point of this path is that
 * the bytes on the slip are the bytes they sent rather than a code of our own making. So these
 * tests are mostly about pixels surviving the trip: a known picture out the other side as known
 * bytes, a 600x600 brought down to the paper without the module edges moving, and everything
 * unreadable turning into no code at all rather than a smear or a thrown job.
 *
 * The fixtures are built rather than checked in; see png-fixture.js for why.
 */

const { png, base64Png, grid, chunk, SIGNATURE } = require(path.join(__dirname, 'png-fixture.js'));

/** The eight header bytes of GS v 0, read back as the numbers they mean. */
function header(buffer) {
  return {
    command: [...buffer.subarray(0, 3)],
    mode: buffer[3],
    widthBytes: buffer[4] | (buffer[5] << 8),
    height: buffer[6] | (buffer[7] << 8),
    data: buffer.subarray(8)
  };
}

test('a known PNG comes back as the raster bytes that draw it', () => {
  // Eight wide so a row is exactly one byte, and four rows that spell out four byte values nobody
  // could arrive at by accident: a full row, an empty one, the left half and alternating pixels.
  const rows = [
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 0, 0, 0, 0],
    [1, 0, 1, 0, 1, 0, 1, 0]
  ];

  const out = fiscalQrRaster(base64Png(rows), 48);

  assert.deepStrictEqual(
    [...out],
    [0x1D, 0x76, 0x30, 0x00, 0x01, 0x00, 0x04, 0x00, 0xFF, 0x00, 0xF0, 0xAA],
    'the raster is not the picture that was sent'
  );
});

test('the command header counts the width in bytes and the height in dots', () => {
  // The one mistake this command invites: both numbers are sixteen bits and they look identical in
  // a hex dump, so a width counted in dots prints eight times too wide and a height counted in
  // bytes prints an eighth of the code.
  const out = header(fiscalQrRaster(base64Png(grid(24, 5, (x, y) => (x + y) % 2 === 0)), 48));

  assert.deepStrictEqual(out.command, [0x1D, 0x76, 0x30], 'this is not GS v 0');
  assert.strictEqual(out.mode, 0, 'the raster mode is not plain');
  assert.strictEqual(out.widthBytes, 3, '24 dots across is 3 bytes, not 24');
  assert.strictEqual(out.height, 5, '5 rows is 5 dots of height');
  assert.strictEqual(out.data.length, 15, 'the data is not 3 bytes by 5 rows');
});

test('a width that is not a whole number of bytes is padded with paper, not ink', () => {
  const out = header(fiscalQrRaster(base64Png(grid(12, 1, () => true)), 48));

  assert.strictEqual(out.widthBytes, 2);
  assert.deepStrictEqual([...out.data], [0xFF, 0xF0], 'the four padding bits were printed as dots');
});

test("the Authority's 600x600 is scaled to 400 dots and stays square", () => {
  // 600 dots at 203 dpi is about 75 mm, which is wider than the 72 mm an 80 mm roll can print and
  // would come out clipped. 400 is about 50 mm with a margin either side of it.
  const rows = grid(600, 600, (x, y) => Math.floor(x / 24) % 2 === Math.floor(y / 24) % 2);
  const out = header(fiscalQrRaster(base64Png(rows), 48));

  assert.strictEqual(out.widthBytes, 50, '400 dots across is 50 bytes');
  assert.strictEqual(out.height, 400, 'the code is no longer square');
  assert.strictEqual(out.data.length, 50 * 400);
});

test('58 mm paper takes a smaller code than 80 mm, because that is all it has', () => {
  const rows = grid(600, 600, (x, y) => Math.floor(x / 24) % 2 === Math.floor(y / 24) % 2);

  assert.strictEqual(qrDotsFor(48), 400, '80 mm paper');
  assert.strictEqual(qrDotsFor(32), 320, '58 mm paper');

  const narrow = header(fiscalQrRaster(base64Png(rows), 32));
  assert.strictEqual(narrow.widthBytes, 40, '320 dots across is 40 bytes');
  assert.strictEqual(narrow.height, 320, 'the narrow code is not square either');
});

test('a code already narrow enough is printed at the size it was drawn', () => {
  // Enlarging gains no detail and puts a staircase on every module edge, which is the one thing a
  // scanner cannot forgive.
  const out = header(fiscalQrRaster(base64Png(grid(96, 96, (x, y) => (x + y) % 3 === 0)), 48));

  assert.strictEqual(out.widthBytes, 12, '96 dots across is 12 bytes');
  assert.strictEqual(out.height, 96, 'a small code was stretched to the paper');
});

test('the modules keep their edges: no block comes out a shade of grey', () => {
  // The failure this guards is interpolation. A QR scaled with an averaging filter has soft edges,
  // a one-bit printer turns soft edges into dither, and dither at this size is a grid of noise. So
  // every destination pixel of a scaled code must still be exactly one of the two values it was.
  const modules = 25;
  const source = grid(600, 600, (x, y) =>
    (Math.floor((x * modules) / 600) + Math.floor((y * modules) / 600)) % 2 === 0);
  const out = header(fiscalQrRaster(base64Png(source), 48));

  // Read the scaled code back and check that each module is still solid rather than speckled: the
  // middle of a 16-dot module must match its neighbours in the same module.
  const bit = (x, y) => (out.data[y * out.widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      const x0 = Math.floor((mx * 400) / modules) + 2;
      const y0 = Math.floor((my * 400) / modules) + 2;
      const expected = (mx + my) % 2 === 0 ? 1 : 0;
      assert.strictEqual(bit(x0, y0), expected, `module ${mx},${my} lost its colour`);
      assert.strictEqual(bit(x0 + 1, y0 + 1), expected, `module ${mx},${my} came out speckled`);
    }
  }
});

test('every module survives the scaling, at every version a receipt can carry', () => {
  // The acceptance criterion behind all of this is that a phone scans the code off the slip, which
  // means no module may change colour on the way down to the paper. So: a pattern no averaging
  // filter could get right by luck, at the module counts of QR versions 1 through 15, read back
  // module centre by module centre at both paper widths. A quiet zone of four modules is included
  // because a code printed without one does not scan however perfect its middle is.
  const seed = (i) => ((i * 1103515245 + 12345) >>> 8) % 2;

  for (const modules of [21, 25, 29, 37, 45, 57, 77]) {
    const quiet = 4;
    const span = modules + quiet * 2;
    const dark = (mx, my) =>
      (mx < 0 || my < 0 || mx >= modules || my >= modules) ? 0 : seed(my * modules + mx);

    // Drawn the way a QR renderer draws one: a whole number of pixels to the module, as near 600
    // across as that count allows.
    const px = Math.floor(600 / span);
    const size = px * span;
    const rows = grid(size, size, (x, y) => dark(Math.floor(x / px) - quiet, Math.floor(y / px) - quiet));
    const image = base64Png(rows);

    for (const columns of [48, 32]) {
      const out = header(fiscalQrRaster(image, columns));
      const bit = (x, y) => (out.data[y * out.widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const scale = out.height / size;

      for (let my = 0; my < span; my++) {
        for (let mx = 0; mx < span; mx++) {
          const cx = Math.floor((mx + 0.5) * px * scale);
          const cy = Math.floor((my + 0.5) * px * scale);
          assert.strictEqual(
            bit(cx, cy), dark(mx - quiet, my - quiet),
            `module ${mx},${my} of a ${modules}-module code changed colour at ${columns} columns`
          );
        }
      }
    }
  }
});

test('a block that is half dark keeps the ink', () => {
  // A tie has to go somewhere. Dark is the safer side: a module a shade heavy still scans, one
  // eroded at both edges can vanish, and thermal paper bleeds this way regardless.
  const source = Uint8Array.from([1, 0, 0, 1]);
  assert.deepStrictEqual([...downsample(source, 2, 2, 1, 1)], [1]);
});

test('one-bit grey, a palette, colour and alpha all read as the same code', () => {
  // A QR generator writes whichever of these its library felt like. The picture is the same one.
  const rows = grid(16, 16, (x, y) => (x * 3 + y * 5) % 4 === 0);
  const expected = fiscalQrRaster(base64Png(rows), 48);

  for (const opts of [
    { colorType: 0, bitDepth: 1 },
    { colorType: 3, bitDepth: 8 },
    { colorType: 3, bitDepth: 1 },
    { colorType: 2, bitDepth: 8 },
    { colorType: 4, bitDepth: 8 },
    { colorType: 6, bitDepth: 8 }
  ]) {
    assert.deepStrictEqual(
      [...fiscalQrRaster(base64Png(rows, opts), 48)], [...expected],
      `colour type ${opts.colorType} at ${opts.bitDepth} bits read as a different code`
    );
  }
});

test('a transparent background is paper, not a solid black square', () => {
  // The failure that still looks like it worked: a code drawn on transparency, read as if every
  // transparent pixel were the colour underneath it, prints as a filled rectangle.
  const rows = grid(8, 8, (x, y) => x === y);
  const opaque = fiscalQrRaster(base64Png(rows, { colorType: 0, bitDepth: 8 }), 48);
  const transparent = fiscalQrRaster(
    base64Png(rows, { colorType: 6, bitDepth: 8, alphaOf: (x, y) => (x === y ? 255 : 0) }), 48);

  assert.deepStrictEqual([...transparent], [...opaque], 'transparency was printed as ink');
});

test('a data URL is accepted, because that is how a client will send one', () => {
  const rows = grid(8, 8, (x) => x < 4);
  const plain = fiscalQrRaster(base64Png(rows), 48);
  const wrapped = fiscalQrRaster('data:image/png;base64,' + base64Png(rows), 48);

  assert.deepStrictEqual([...wrapped], [...plain]);
});

test('an image that is not one is refused rather than guessed at', () => {
  const rows = grid(8, 8, (x) => x < 4);
  const good = png(rows);

  const bad = {
    'nothing at all': '',
    'not base64 and not a PNG': 'this is a receipt URL, not a picture',
    'a JPEG': Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]).toString('base64'),
    'a PNG cut in half': good.subarray(0, Math.floor(good.length / 2)).toString('base64'),
    'a PNG with its pixels truncated': Buffer.concat([
      good.subarray(0, 8), chunk('IHDR', (() => {
        const h = Buffer.alloc(13); h.writeUInt32BE(8, 0); h.writeUInt32BE(8, 4); h[8] = 8; h[9] = 0; return h;
      })()), chunk('IDAT', zlib.deflateSync(Buffer.alloc(9))), chunk('IEND', Buffer.alloc(0))
    ]).toString('base64'),
    'an interlaced PNG': base64Png(rows, { interlace: true }),
    'a PNG with no pixels in it': Buffer.concat([
      good.subarray(0, 8), chunk('IHDR', (() => {
        const h = Buffer.alloc(13); h.writeUInt32BE(8, 0); h.writeUInt32BE(8, 4); h[8] = 8; h[9] = 0; return h;
      })()), chunk('IEND', Buffer.alloc(0))
    ]).toString('base64')
  };

  for (const [what, payload] of Object.entries(bad)) {
    assert.throws(() => fiscalQrRaster(payload, 48), Error, `${what} was accepted as a QR code`);
  }
});

test('something far too big to be a QR code is refused before it is unpacked', () => {
  // A declared size is four attacker-chosen bytes, and allocating what they ask for to find out is
  // how a print job becomes an out-of-memory on the box running the restaurant.
  const huge = Buffer.alloc(13);
  huge.writeUInt32BE(30000, 0);
  huge.writeUInt32BE(30000, 4);
  huge[8] = 8;
  huge[9] = 0;
  const claim = Buffer.concat([
    SIGNATURE, chunk('IHDR', huge), chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))
  ]).toString('base64');

  assert.throws(() => fiscalQrRaster(claim, 48), /larger than a receipt can use/);
  assert.throws(() => fiscalQrRaster('A'.repeat(2_000_000), 48), /far larger than a QR code/);
});

test('the pieces compose the way the command says they do', () => {
  // packRaster and rasterCommand are separate so each can be read on its own; this is the seam
  // between them, which is the only place the byte order of the header is decided.
  const bitmap = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepStrictEqual([...packRaster(bitmap, 8, 2)], [0x80, 0x01], 'the leftmost pixel is not the high bit');
  assert.deepStrictEqual(
    [...rasterCommand(bitmap, 8, 2)], [0x1D, 0x76, 0x30, 0x00, 1, 0, 2, 0, 0x80, 0x01]);
});

test('the decoder reports the picture it read, not the one it was given to read', () => {
  const rows = [[1, 0], [0, 1]];
  const image = decodePng(png(rows));

  assert.strictEqual(image.width, 2);
  assert.strictEqual(image.height, 2);
  assert.deepStrictEqual([...image.dark], [1, 0, 0, 1]);
});
