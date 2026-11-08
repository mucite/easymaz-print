const test = require('node:test');
const assert = require('node:assert');
const { amountInWords } = require('../src/words');

/**
 * The total, written out.
 *
 * ANNEX 1 asks for the total in words as well as figures, and the words are the half that catches a
 * figure somebody altered. That only works while the two agree, so this is worked out in the bridge
 * from the number being printed — which makes this function the one place the agreement can break.
 * It is pure, it is read by nobody until a receipt is already on paper, and a mistake in it is the
 * quiet kind, so it is tested on its own rather than through a slip.
 */

test('zero is a total too, and says so', () => {
  assert.strictEqual(amountInWords(0), 'Zero Birr and 00/100');
});

test('santim are written as a fraction, the way a cheque writes them', () => {
  assert.strictEqual(amountInWords(0.5), 'Zero Birr and 50/100');
  assert.strictEqual(amountInWords(0.05), 'Zero Birr and 05/100');
  assert.strictEqual(amountInWords(1150.5), 'One thousand one hundred fifty Birr and 50/100');
  assert.strictEqual(amountInWords(401.5), 'Four hundred one Birr and 50/100');
});

test('one to nineteen are words of their own, not tens and units', () => {
  const expected = [
    'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen',
    'Nineteen'
  ];
  expected.forEach((word, n) => {
    assert.strictEqual(amountInWords(n), `${word} Birr and 00/100`);
  });
});

test('the tens are named, and a compound is hyphenated', () => {
  assert.strictEqual(amountInWords(20), 'Twenty Birr and 00/100');
  assert.strictEqual(amountInWords(21), 'Twenty-one Birr and 00/100');
  assert.strictEqual(amountInWords(42), 'Forty-two Birr and 00/100');
  assert.strictEqual(amountInWords(70), 'Seventy Birr and 00/100');
  assert.strictEqual(amountInWords(99), 'Ninety-nine Birr and 00/100');
});

test('the hundreds boundary', () => {
  assert.strictEqual(amountInWords(99), 'Ninety-nine Birr and 00/100');
  assert.strictEqual(amountInWords(100), 'One hundred Birr and 00/100');
  assert.strictEqual(amountInWords(101), 'One hundred one Birr and 00/100');
  assert.strictEqual(amountInWords(110), 'One hundred ten Birr and 00/100');
  assert.strictEqual(amountInWords(115), 'One hundred fifteen Birr and 00/100');
  assert.strictEqual(amountInWords(999), 'Nine hundred ninety-nine Birr and 00/100');
});

test('the thousands boundary', () => {
  assert.strictEqual(amountInWords(1000), 'One thousand Birr and 00/100');
  assert.strictEqual(amountInWords(1001), 'One thousand one Birr and 00/100');
  assert.strictEqual(amountInWords(1100), 'One thousand one hundred Birr and 00/100');
  assert.strictEqual(amountInWords(10000), 'Ten thousand Birr and 00/100');
  assert.strictEqual(amountInWords(100000), 'One hundred thousand Birr and 00/100');
  assert.strictEqual(
    amountInWords(999999),
    'Nine hundred ninety-nine thousand nine hundred ninety-nine Birr and 00/100'
  );
});

test('the millions boundary, and further up', () => {
  assert.strictEqual(amountInWords(1000000), 'One million Birr and 00/100');
  assert.strictEqual(amountInWords(1000001), 'One million one Birr and 00/100');
  assert.strictEqual(amountInWords(1234567), 'One million two hundred thirty-four thousand five hundred sixty-seven Birr and 00/100');
  assert.strictEqual(amountInWords(1000000000), 'One billion Birr and 00/100');
  assert.strictEqual(amountInWords(1000000000000), 'One trillion Birr and 00/100');
});

test('an empty group is silent, never "one million zero thousand"', () => {
  assert.strictEqual(amountInWords(1000005), 'One million five Birr and 00/100');
  assert.strictEqual(amountInWords(1000500), 'One million five hundred Birr and 00/100');
  assert.strictEqual(amountInWords(2000000), 'Two million Birr and 00/100');
  for (const n of [1000005, 1000500, 2000000, 1000000000]) {
    assert.ok(!/\bzero\b/.test(amountInWords(n)), `${n} said zero inside a number`);
    assert.ok(!/ {2}/.test(amountInWords(n)), `${n} left a double space`);
  }
});

test('santim are rounded to the nearest, and the carry reaches the Birr', () => {
  assert.strictEqual(amountInWords(1234.567), 'One thousand two hundred thirty-four Birr and 57/100');
  assert.strictEqual(amountInWords(1234.564), 'One thousand two hundred thirty-four Birr and 56/100');
  // The carry: 0.999 is one Birr on the paper, so it is one Birr in the words as well.
  assert.strictEqual(amountInWords(0.999), 'One Birr and 00/100');
  assert.strictEqual(amountInWords(99.999), 'One hundred Birr and 00/100');
  assert.strictEqual(amountInWords(999.995), 'One thousand Birr and 00/100');
});

test('the words agree with the figures the slip prints, santim for santim', () => {
  // The same rounding the receipt's own money() does: to the nearest santim, on the whole amount.
  const money = (v) => Math.round(Number(v) * 100) / 100;
  for (const amount of [0, 0.004, 0.005, 1.005, 12.345, 60, 365.449, 401.5, 9.995, 123456.789]) {
    const santim = Math.round((money(amount) % 1) * 100);
    const printed = amountInWords(amount);
    assert.match(printed, new RegExp(`and ${String(santim).padStart(2, '0')}/100$`), String(amount));
  }
});

test('a number given as a string is still a number', () => {
  assert.strictEqual(amountInWords('42'), 'Forty-two Birr and 00/100');
  assert.strictEqual(amountInWords('1150.50'), 'One thousand one hundred fifty Birr and 50/100');
});

test('a negative amount says so rather than losing its sign', () => {
  assert.strictEqual(amountInWords(-1.5), 'Minus one Birr and 50/100');
  assert.strictEqual(amountInWords(-1000), 'Minus one thousand Birr and 00/100');
});

test('what is not a number is no words at all, never a half-written total', () => {
  for (const value of [undefined, null, '', '   ', NaN, Infinity, -Infinity, 'abc', {}, []]) {
    assert.strictEqual(amountInWords(value), '', JSON.stringify(value));
  }
});

test('a number too large to name prints nothing rather than a sentence that stops halfway', () => {
  assert.strictEqual(amountInWords(1e15), '');
  assert.strictEqual(amountInWords(Number.MAX_SAFE_INTEGER), '');
  // And the last amount that can be named still is.
  assert.match(amountInWords(999999999999999 / 1000), /trillion|billion/);
});

test('the currency is what the caller says it is, and Birr when it says nothing', () => {
  assert.strictEqual(amountInWords(5), 'Five Birr and 00/100');
  assert.strictEqual(amountInWords(5, 'Birr'), 'Five Birr and 00/100');
  assert.strictEqual(amountInWords(5, 'USD'), 'Five USD and 00/100');
});

test('only the first letter is capitalised, so the line reads as a sentence', () => {
  const sentence = amountInWords(1234.56);
  assert.match(sentence, /^[A-Z][a-z]/);
  assert.ok(!/[A-Z]/.test(sentence.slice(1).replace('Birr', '')), 'something else was capitalised');
});

test('nothing it writes can reach the printer as a command', () => {
  // It is printed on a line of its own, so anything outside printable ASCII would be a byte the
  // layout did not put there.
  for (const amount of [0, 0.07, 19, 20.25, 345.6, 9007199254.74]) {
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[^\x20-\x7E]/.test(amountInWords(amount)), String(amount));
  }
});
