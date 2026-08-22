/**
 * Getting text onto paper that a thermal printer can actually render.
 *
 * Two separate problems, and they were both being ignored.
 *
 * **Code pages.** A raw ESC/POS printer holds one 256-character table at a time and picks its
 * default at power-on. Nothing here selected one, so the same receipt printed different accented
 * characters on different brands — and that, not the brand of the printer, was the real thing
 * stopping any thermal printer being used. `ESC t n` settles it explicitly.
 *
 * **Amharic.** There is no ESC/POS code page for Ethiopic. Not an obscure one, not a vendor
 * extension: the character set does not exist in the standard, so no value of `ESC t n` will make
 * ገበታ appear. Everything was encoded as latin1, which silently turns every Ethiopic character into
 * a byte from the middle of the Latin table — so an Amharic item name printed as line noise on a
 * receipt that is a fiscal document.
 *
 * The honest options are transliteration or a bitmap. This module transliterates, and it is worth
 * being clear that this is second best: `GS v 0` prints a raster image and every ESC/POS printer
 * supports it, which would put real Amharic on the paper. It needs an Ethiopic font shipped with the
 * bridge and a rasteriser, which is a much bigger change than this, and until somebody wants it, a
 * legible "gebeta" beats an illegible one.
 *
 * Nothing about the Directive turns on this. Art 29(3)(c) names the identifiers a registration
 * quotes — TIN, FS number, MRC — and those are digits. The language an item name is spelled in is
 * not a fiscal field.
 */

/**
 * `ESC t n` values, for the code pages a printer in Ethiopia might sensibly be set to.
 *
 * PC437 is the default because it is the one table every ESC/POS printer implements — a printer that
 * supports nothing else still supports this.
 */
const CODE_PAGES = {
  cp437: 0,   // USA / standard Europe. Universal.
  cp850: 2,   // Multilingual Latin 1
  cp860: 3,
  cp863: 4,
  cp865: 5,
  cp1252: 16, // Windows Western European
  cp866: 17,
  cp852: 18,
  cp858: 19   // Latin 1 with the euro sign
};

/** The byte for `ESC t n`, or PC437's when the name means nothing here. */
function codePageByte(name) {
  if (!name) return CODE_PAGES.cp437;
  const key = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key in CODE_PAGES) return CODE_PAGES[key];
  console.warn(`[printer] unknown code page "${name}" — using cp437`);
  return CODE_PAGES.cp437;
}

/**
 * The Ethiopic syllabary, by construction rather than as a table of 350 entries.
 *
 * U+1200 onwards is laid out in rows of eight: one consonant, seven vowel forms and a gap. So the
 * consonant comes from the row and the vowel from the position in it, which is a dozen lines instead
 * of a list nobody will ever proofread.
 *
 * Approximate on purpose. This is the common SERA-style romanisation, not a scholarly one: it does
 * not mark gemination, and it flattens the four h-series and two s-series that Amharic spells
 * differently and pronounces the same. Somebody reading "kikil" off a receipt knows what they
 * ordered, which is the whole requirement.
 */
const CONSONANTS = [
  'h', 'l', 'h', 'm', 's', 'r', 's', 'sh',    // U+1200 ሀ  ለ  ሐ  መ  ሠ  ረ  ሰ  ሸ
  'q', 'q', 'q', 'q', 'b', 'v', 't', 'ch',    // U+1240 ቀ  ቈ  ቐ  ቘ  በ  ቨ  ተ  ቸ
  'h', 'n', 'ny', 'a', 'k', 'k', 'k', 'k',    // U+1280 ኀ  ኈ  ነ  ኘ  አ  ከ  ኰ  ኸ
  'h', 'w', 'a', 'z', 'zh', 'y', 'd', 'j',    // U+12C0
  'g', 'g', 'g', 'g', 't', 'ch', 'p', 'ts',   // U+1300
  'ts', 'f', 'p', 'ry', 'my', 'fy', '', ''    // U+1340
];

/** ä u i a e (none) o — the sixth form is the bare consonant. */
const VOWELS = ['e', 'u', 'i', 'a', 'ie', '', 'o'];

/** Digits and punctuation that are not syllables. */
const ETHIOPIC_EXTRAS = {
  0x1361: ':',   // ፡ word separator
  0x1362: '.',   // ።
  0x1363: ',',
  0x1364: ';',
  0x1365: ':',
  0x1366: '?',
  0x1367: '?',
  0x1368: ' ',
  0x1369: '1', 0x136A: '2', 0x136B: '3', 0x136C: '4', 0x136D: '5',
  0x136E: '6', 0x136F: '7', 0x1370: '8', 0x1371: '9', 0x1372: '10',
  0x1373: '20', 0x1374: '30', 0x1375: '40', 0x1376: '50', 0x1377: '60',
  0x1378: '70', 0x1379: '80', 0x137A: '90', 0x137B: '100', 0x137C: '10000'
};

function transliterateEthiopic(codePoint) {
  if (codePoint in ETHIOPIC_EXTRAS) return ETHIOPIC_EXTRAS[codePoint];
  if (codePoint < 0x1200 || codePoint > 0x137F) return null;

  const offset = codePoint - 0x1200;
  const row = Math.floor(offset / 8);
  const position = offset % 8;
  const consonant = CONSONANTS[row];
  if (consonant === undefined) return '';
  // The eighth position in a row is either unused or a labiovelar; treated as the bare consonant.
  const vowel = position < VOWELS.length ? VOWELS[position] : 'wa';
  return consonant + vowel;
}

/**
 * What a Latin-1 printer can be handed.
 *
 * Ethiopic is transliterated. Anything else outside the byte range — a curly quote pasted from a
 * phone, an emoji in an item name — is folded to a plain equivalent or dropped, because the
 * alternative is a byte the printer renders as an unrelated glyph. Losing a character is better
 * than printing a wrong one on a fiscal document.
 */
function toPrintable(text) {
  if (text === null || text === undefined) return '';

  let out = '';
  for (const character of String(text)) {
    const code = character.codePointAt(0);

    if (code < 0x80) {
      out += character;
      continue;
    }

    const ethiopic = transliterateEthiopic(code);
    if (ethiopic !== null) {
      out += ethiopic;
      continue;
    }

    // Typographic characters that arrive from phones and web forms constantly.
    const folded = {
      0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"',
      0x2013: '-', 0x2014: '-', 0x2026: '...', 0x00A0: ' ',
      0x20AC: 'EUR', 0x00B7: '.'
    }[code];
    if (folded !== undefined) {
      out += folded;
      continue;
    }

    // In the byte range and not something we fold: hand it over and let the code page decide.
    if (code <= 0xFF) {
      out += character;
      continue;
    }

    // Everything else. A space rather than nothing, so words do not run together.
    out += ' ';
  }
  return out;
}

module.exports = { codePageByte, toPrintable, CODE_PAGES };
