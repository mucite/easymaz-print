const zlib = require('zlib');

/**
 * Printing a picture the Authority drew, rather than drawing one ourselves.
 *
 * Every other code on these slips is encoded by the printer's own QR engine from a string we hand
 * it, which is the right way to put our own receipt link on paper: the payload is ours, the module
 * pattern does not matter, and the printer does the work. The Authority's code is not that. EIMS
 * returns `signedQR`, a PNG it has already drawn and signed, and what their official app validates
 * is that image's content against their records. Re-encoding the payload would produce a different
 * picture — a different mask, a different error-correction level, possibly a different version —
 * and printing the payload as a line of text would not scan at all. Their acceptance suite ends
 * every case by scanning the code on the paper, so a slip that re-draws the code fails all of it.
 *
 * So the bytes they sent are the bytes that go on the paper, which means decoding a PNG here and
 * emitting it as a raster. That is what this file is: a PNG reader narrow enough to be worth
 * writing rather than depending on, a downscaler that keeps the modules square-edged, and the
 * ESC/POS command that prints the result.
 */

/** The eight bytes every PNG starts with, which is the cheapest way to reject something that is not one. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * How much of a payload is worth looking at before calling it a mistake.
 *
 * A 600x600 one-bit QR is a few kilobytes; the Authority's own is well under fifty. Anything past a
 * megabyte of base64 is a photograph, a wrong field, or somebody pointing a large file at the till,
 * and inflating it to find out would be the expensive way to learn so. The pixel ceiling is the
 * same argument after the header has been read: a declared size is four bytes of attacker-chosen
 * arithmetic, and allocating what it asks for before checking it is how a print job becomes an
 * out-of-memory on a box running the whole restaurant.
 */
const MAX_BASE64_CHARS = 1_000_000;
const MAX_DIMENSION    = 4000;
const MAX_PIXELS       = 4_000_000;

/**
 * How wide the Authority's code may be on the paper, in printer dots.
 *
 * At 203 dpi — which every thermal printer in this trade is — 600 dots is about 75 mm, and the
 * printable width of 80 mm paper is 72 mm, so the image they send is wider than the roll it has to
 * go on and far wider than 58 mm paper. 400 dots is about 50 mm: big enough that a phone reads it
 * off a slip held at arm's length, small enough to leave a visible margin either side so the code
 * is not touching the torn edge, where a scanner struggles to find the quiet zone.
 *
 * The budget below is read from the column width the station is configured with rather than from a
 * paper size nobody stores, because the two say the same thing: a character cell is 12 dots, so 48
 * columns is 576 dots of 80 mm paper and 32 columns is 384 dots of 58 mm. Eighty-five per cent of
 * that leaves the margin, and rounding down to a multiple of eight means the packed rows end on a
 * byte boundary with no padding bits to decide the colour of. On 80 mm that lands on 400 by way of
 * the ceiling; on 58 mm it lands on 320, which is 40 mm and the most that paper can carry.
 */
const MAX_QR_DOTS = 400;
const DOTS_PER_COLUMN = 12;

function qrDotsFor(lineWidth) {
    const columns = Number(lineWidth) > 0 ? Number(lineWidth) : 48;
    const budget = Math.floor((columns * DOTS_PER_COLUMN * 0.85) / 8) * 8;
    return Math.max(8, Math.min(MAX_QR_DOTS, budget));
}

/** PNG's filter 4, which predicts a byte from the three around it. Straight from the specification. */
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/** How many samples a pixel has, by PNG colour type. Anything else is not a colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Undo the per-scanline filter PNG applies before deflating.
 *
 * Each row arrives with a leading byte naming one of five predictors, and every one of them refers
 * to bytes that have already been reconstructed — the one `bpp` to the left, the one directly
 * above, and the one above-left. That is why this runs in place over the output rather than over
 * the inflated input: by the time a row is read, the row above it is already the real thing.
 *
 * `bpp` is a whole number of bytes per pixel and is clamped to one, because at bit depths below
 * eight several pixels share a byte and the specification says to step by a byte in that case.
 */
function unfilter(raw, width, height, bitsPerPixel) {
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    if (raw.length < (stride + 1) * height) {
        throw new Error('PNG image data is shorter than its declared size');
    }

    const out = Buffer.alloc(stride * height);
    let read = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[read++];
        const line = read;
        read += stride;
        const here = y * stride;
        const above = here - stride;

        for (let x = 0; x < stride; x++) {
            const value = raw[line + x];
            const a = x >= bpp ? out[here + x - bpp] : 0;
            const b = y > 0 ? out[above + x] : 0;
            const c = x >= bpp && y > 0 ? out[above + x - bpp] : 0;
            let restored;
            switch (filter) {
                case 0: restored = value; break;
                case 1: restored = value + a; break;
                case 2: restored = value + b; break;
                case 3: restored = value + ((a + b) >> 1); break;
                case 4: restored = value + paeth(a, b, c); break;
                default: throw new Error(`PNG row ${y} uses filter ${filter}, which is not one of the five`);
            }
            out[here + x] = restored & 0xFF;
        }
    }
    return { pixels: out, stride };
}

/** One sample out of a scanline, whatever bit depth it was packed at. Sixteen-bit samples keep the high byte, which is all a threshold can use. */
function sampleAt(line, index, bitDepth) {
    if (bitDepth === 8) return line[index];
    if (bitDepth === 16) return line[index * 2];
    const perByte = 8 / bitDepth;
    const byte = line[Math.floor(index / perByte)];
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    const value = (byte >> shift) & ((1 << bitDepth) - 1);
    return value;
}

/** A sub-byte grey sample stretched to the full 0-255 range, so one threshold works at every depth. */
function stretch(value, bitDepth) {
    if (bitDepth >= 8) return value;
    return Math.round((value * 255) / ((1 << bitDepth) - 1));
}

/**
 * A PNG, read down to one bit per pixel.
 *
 * PNG is deflate and a small amount of filtering, both of which Node already has, so this is a
 * reader rather than a dependency. It handles the colour types and bit depths a QR renderer
 * actually emits — one-bit grey, palette, and the eight-bit colour forms a generic library writes
 * when nobody asked it to be clever — and refuses interlaced images outright. Adam7 would double
 * the length of this file to support a feature no QR generator uses, and a refusal here prints the
 * slip without the code, which is the behaviour anything unreadable gets.
 *
 * What comes back is darkness, not colour: the Authority's code is black on white and a printer
 * head is on or off, so every path ends at a luminance and a threshold. Transparency composites
 * over white because the paper is white — a QR on a transparent background is otherwise read as a
 * solid black square, which is the one failure that still looks like it printed correctly.
 */
function decodePng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 12) {
        throw new Error('not a PNG: too short to hold a header');
    }
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('not a PNG: the signature is wrong');
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette = null;
    let paletteAlpha = null;
    const idat = [];

    let at = 8;
    while (at + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(at);
        const type = buffer.toString('latin1', at + 4, at + 8);
        const start = at + 8;
        const end = start + length;
        // The CRC is four bytes past the data, and a chunk claiming to run past the end of the file
        // is the file being truncated rather than the chunk being long.
        if (end + 4 > buffer.length) {
            throw new Error(`PNG chunk ${type} runs past the end of the file`);
        }

        if (type === 'IHDR') {
            width = buffer.readUInt32BE(start);
            height = buffer.readUInt32BE(start + 4);
            bitDepth = buffer[start + 8];
            colorType = buffer[start + 9];
            interlace = buffer[start + 12];
        } else if (type === 'PLTE') {
            palette = buffer.subarray(start, end);
        } else if (type === 'tRNS') {
            paletteAlpha = buffer.subarray(start, end);
        } else if (type === 'IDAT') {
            idat.push(buffer.subarray(start, end));
        } else if (type === 'IEND') {
            break;
        }

        at = end + 4;
    }

    if (!width || !height) throw new Error('PNG has no IHDR, or declares an empty image');
    if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
        throw new Error(`PNG is ${width}x${height}, which is larger than a receipt can use`);
    }
    if (interlace !== 0) throw new Error('PNG is interlaced, which this reader does not read');
    const channels = CHANNELS[colorType];
    if (!channels) throw new Error(`PNG colour type ${colorType} is not a colour type`);
    if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG bit depth ${bitDepth} is not a bit depth`);
    if (colorType === 3 && !palette) throw new Error('PNG says it is palette-indexed and carries no palette');
    if (!idat.length) throw new Error('PNG carries no image data');

    // Bounded by what the header said the image is. Deflate expands, a megabyte of base64 can carry
    // a great deal more than a megabyte of pixels, and a print job is not a place to find that out:
    // the declared size is the only honest claim about how much there should be, so anything past it
    // plus a scanline of slack is a payload doing something other than drawing a QR code.
    const declared = (Math.ceil((width * bitDepth * channels) / 8) + 1) * height;
    const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: declared + 4096 });
    const { pixels, stride } = unfilter(raw, width, height, bitDepth * channels);

    const dark = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const line = pixels.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < width; x++) {
            let r;
            let g;
            let b;
            let alpha = 255;

            if (colorType === 3) {
                const index = sampleAt(line, x, bitDepth);
                r = palette[index * 3];
                g = palette[index * 3 + 1];
                b = palette[index * 3 + 2];
                if (r === undefined) throw new Error('PNG uses a palette entry it did not supply');
                if (paletteAlpha && index < paletteAlpha.length) alpha = paletteAlpha[index];
            } else if (colorType === 0 || colorType === 4) {
                const grey = stretch(sampleAt(line, x * channels, bitDepth), bitDepth);
                r = g = b = grey;
                if (colorType === 4) alpha = sampleAt(line, x * channels + 1, bitDepth);
            } else {
                r = sampleAt(line, x * channels, bitDepth);
                g = sampleAt(line, x * channels + 1, bitDepth);
                b = sampleAt(line, x * channels + 2, bitDepth);
                if (colorType === 6) alpha = sampleAt(line, x * channels + 3, bitDepth);
            }

            // Rec. 601 luminance, then composited over white paper. A half-transparent black module
            // on white paper is grey, and grey below the threshold is still a module.
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            const onPaper = (luminance * alpha) / 255 + 255 * (1 - alpha / 255);
            dark[y * width + x] = onPaper < 128 ? 1 : 0;
        }
    }

    return { width, height, dark };
}

/**
 * The same code, smaller, with its module edges still where they were.
 *
 * The only thing that matters here is that a scanner can still tell one module from the next, and
 * the way to lose that is to interpolate: an averaged pixel is grey, grey on a one-bit printer
 * becomes dither, and a dithered QR is a grid of noise at the size these print at. So every
 * destination pixel takes the block of source pixels that falls underneath it and comes out black
 * or white by a count of which the block mostly was — no intermediate values exist at any point, so
 * there is nothing to smooth.
 *
 * The blocks are laid out by integer arithmetic on the ratio rather than by a single divisor, which
 * matters because the Authority's 600 does not divide by the 400 we want. At 600 to 400 the blocks
 * run one source pixel, two, one, two, repeating exactly every three — an integer ratio, just not a
 * whole-number one — so an edge can land at most half a destination pixel from where it truly was.
 * A version 5 code at 600 pixels has about eleven destination pixels to a module, and half of one of
 * those is far inside what a scanner's own binarisation absorbs.
 *
 * A tie inside a two-pixel block goes dark. It has to go somewhere, and a module that comes out a
 * shade heavy still reads, where one eroded at both edges can disappear; thermal paper bleeds dark
 * anyway, so this is the direction the printer was going to take regardless.
 */
function downsample(src, srcWidth, srcHeight, dstWidth, dstHeight) {
    const out = new Uint8Array(dstWidth * dstHeight);
    for (let y = 0; y < dstHeight; y++) {
        const top = Math.floor((y * srcHeight) / dstHeight);
        const bottom = Math.max(top + 1, Math.floor(((y + 1) * srcHeight) / dstHeight));
        for (let x = 0; x < dstWidth; x++) {
            const left = Math.floor((x * srcWidth) / dstWidth);
            const right = Math.max(left + 1, Math.floor(((x + 1) * srcWidth) / dstWidth));

            let dark = 0;
            let total = 0;
            for (let sy = top; sy < bottom; sy++) {
                for (let sx = left; sx < right; sx++) {
                    total++;
                    dark += src[sy * srcWidth + sx];
                }
            }
            out[y * dstWidth + x] = dark * 2 >= total ? 1 : 0;
        }
    }
    return out;
}

/**
 * One bit per pixel, eight pixels to a byte, leftmost pixel in the high bit.
 *
 * That is the order GS v 0 reads, and it is also the order the paper comes out in: rows top to
 * bottom, each row padded to a whole byte. The padding bits are left zero, which is white, so a
 * width that is not a multiple of eight ends in blank dots rather than a stripe down the edge.
 */
function packRaster(bitmap, width, height) {
    const widthBytes = Math.ceil(width / 8);
    const out = Buffer.alloc(widthBytes * height);
    for (let y = 0; y < height; y++) {
        const row = y * widthBytes;
        for (let x = 0; x < width; x++) {
            if (bitmap[y * width + x]) out[row + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    return out;
}

/**
 * GS v 0, the raster bit image.
 *
 * Chosen over GS ( L, which is the newer and more capable command — it can store an image in the
 * printer and reprint it, and it carries a colour model nothing here needs. What it does not have
 * is the support: GS v 0 is in every ESC/POS implementation written since the TM-T88, including the
 * unbranded boxes that are most of what a restaurant in Addis already owns and all of what it would
 * buy to go with this one. The receipts these print have to come out of whatever is on the counter,
 * and a command that works everywhere beats a command that works better.
 *
 * The header is m, then the width in bytes and the height in dots, each as two bytes low-first. The
 * width being counted in bytes and the height in dots is the detail worth remembering, because the
 * two look identical in a hex dump and a code that is eight times too wide prints as a smear.
 */
function rasterCommand(bitmap, width, height) {
    const widthBytes = Math.ceil(width / 8);
    const header = Buffer.from([
        0x1D, 0x76, 0x30, 0x00,
        widthBytes & 0xFF, (widthBytes >> 8) & 0xFF,
        height & 0xFF, (height >> 8) & 0xFF
    ]);
    return Buffer.concat([header, packRaster(bitmap, width, height)]);
}

/**
 * The Authority's signed PNG, as bytes a printer prints.
 *
 * Throws rather than returning nothing on a bad image, because the caller has the receipt in hand
 * and is the only one able to say which sale lost its code. A slip still prints without it; see the
 * caller for why that is the right trade and why it is also a defect worth a line in the log.
 *
 * Never enlarged. A code that arrived smaller than the paper can take was drawn at the size it was
 * drawn at, and scaling one up by whole pixels gains no detail while scaling it up by anything else
 * puts a staircase on every module edge.
 *
 * @param base64 the PNG as EIMS returned it, base64 with or without a data: prefix
 * @param lineWidth the station's column count, which is how this bridge knows the paper
 */
function fiscalQrRaster(base64, lineWidth) {
    const text = String(base64 || '').trim();
    if (!text) throw new Error('no image was sent');
    if (text.length > MAX_BASE64_CHARS) {
        throw new Error(`image is ${text.length} base64 characters, which is far larger than a QR code`);
    }

    // A browser or a Java client will happily hand over a data URL where a field asked for base64,
    // and the prefix is the only part of it that is not already what we want.
    const payload = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text;
    const bytes = Buffer.from(payload, 'base64');

    const { width, height, dark } = decodePng(bytes);

    const budget = qrDotsFor(lineWidth);
    const dstWidth = width <= budget ? width : budget;
    // Scaled by one ratio in both directions, so a square code stays square. The Authority's is
    // square; anything else is not the field it claims to be, and distorting it would hide that.
    const dstHeight = width <= budget ? height : Math.max(1, Math.round((height * dstWidth) / width));

    const bitmap = dstWidth === width && dstHeight === height
        ? dark
        : downsample(dark, width, height, dstWidth, dstHeight);

    return rasterCommand(bitmap, dstWidth, dstHeight);
}

module.exports = {
    fiscalQrRaster,
    qrDotsFor,
    decodePng,
    downsample,
    packRaster,
    rasterCommand,
    MAX_QR_DOTS
};
