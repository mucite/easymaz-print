/**
 * The total, written out in words.
 *
 * ANNEX 1 of the EIMS compliance guideline asks a printed receipt for its total twice: once in
 * figures and once as `ጠቅላላ ዋጋ በፊደል ብር / In Words Birr`. The words are the half a reader can check
 * a tampered figure against, which is the only reason a form asks for both.
 *
 * So the words are worked out here, from the number the slip is actually printing, and never read
 * from the payload. A figure and a spelling of it that arrive separately can disagree — a total
 * recalculated upstream after the words were written, a rounding rule applied in one place and not
 * the other — and a receipt that disagrees with itself about how much money changed hands is worse
 * than one that carries no words at all. The bridge is the last thing to touch the number before it
 * reaches paper, so it is the only place that can be certain the two match.
 *
 * Santim are left in figures as `and 50/100`, the way a cheque writes them. Spelling them out as
 * "fifty cents" invites the question of what a cent is called here, and the fraction is unambiguous
 * in both languages.
 *
 * English only. There is no ESC/POS code page for Ethiopic, so Amharic words cannot be put on this
 * paper at all — see the note in charset.js, and the label note in printer.js.
 */

const ONES = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen'
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * The scale words, in groups of three digits.
 *
 * The list is also the ceiling: a number with more groups than there are names for it cannot be
 * written out, and the caller is told so by an empty string rather than handed a sentence that
 * stops halfway. A trillion Birr is eleven orders of magnitude past any restaurant bill, so the
 * list ends where the names stop being ones a reader would recognise.
 */
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

/** 0 to 999, with nothing for zero — an empty group prints no words at all. */
function underThousand(value) {
    const parts = [];
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;

    if (hundreds) parts.push(ONES[hundreds] + ' hundred');

    if (rest && rest < 20) {
        parts.push(ONES[rest]);
    } else if (rest) {
        const unit = rest % 10;
        const ten = TENS[Math.floor(rest / 10)];
        // Hyphenated, as English writes a compound number: twenty-one, not twenty one.
        parts.push(unit ? ten + '-' + ONES[unit] : ten);
    }

    return parts.join(' ');
}

/** The whole Birr. Null where the number is past the last scale word. */
function wholeInWords(whole) {
    if (whole === 0) return 'zero';

    const groups = [];
    let rest = whole;
    while (rest > 0) {
        groups.push(rest % 1000);
        rest = Math.floor(rest / 1000);
    }
    if (groups.length > SCALES.length) return null;

    const said = [];
    for (let i = groups.length - 1; i >= 0; i--) {
        // An empty group is silent: a million and five is "one million five", never "one million
        // zero thousand five".
        if (!groups[i]) continue;
        said.push(SCALES[i] ? underThousand(groups[i]) + ' ' + SCALES[i] : underThousand(groups[i]));
    }
    return said.join(' ');
}

/**
 * An amount as a sentence: "One thousand one hundred fifty Birr and 50/100".
 *
 * The santim are rounded the same way the figures on the slip are — to the nearest santim, on the
 * amount as a whole — so a total of 0.999 is one Birr in both places rather than one in figures and
 * zero in words. The carry falls out of rounding the santim first and taking the Birr from them.
 *
 * Anything that is not a finite number gives back an empty string, and so does a number too large
 * to name. The caller prints nothing rather than a half-written total: a line that reads "In words:"
 * followed by nothing is a field that failed, and this is a document somebody has to be able to
 * trust.
 */
function amountInWords(amount, currency = 'Birr') {
    // Null, undefined, an empty string and an empty array all become zero under Number(), so an
    // absent total would be written out as "Zero Birr" by anything that trusted the conversion.
    if (typeof amount !== 'number' && typeof amount !== 'string') return '';
    if (typeof amount === 'string' && amount.trim() === '') return '';

    const value = Number(amount);
    if (!Number.isFinite(value)) return '';

    const santim = Math.round(Math.abs(value) * 100);
    if (!Number.isSafeInteger(santim)) return '';

    const whole = wholeInWords(Math.floor(santim / 100));
    if (whole === null) return '';

    const fraction = String(santim % 100).padStart(2, '0');
    const sentence =
        (value < 0 ? 'minus ' : '') + whole + ' ' + currency + ' and ' + fraction + '/100';

    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

module.exports = { amountInWords };
