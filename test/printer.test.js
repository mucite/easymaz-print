const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PRINTER = path.join(__dirname, '..', 'src', 'printer.js');

/**
 * Where a ticket goes on a site with more than one printer.
 *
 * A restaurant has one printer at the till and needs none of this. A hotel does: food to the
 * kitchen, drinks to the bar, a folio to reception — and with a single destination somebody carries
 * paper across the building all evening. The list is typed into an env file by whoever is standing
 * at the router, so it has to survive stray spaces, a missing port and a line half-finished.
 */

function freshPrinter(printers) {
  delete require.cache[require.resolve(PRINTER)];
  const previous = process.env.PRINTERS;
  if (printers === undefined) delete process.env.PRINTERS;
  else process.env.PRINTERS = printers;
  const mod = require(PRINTER);
  if (previous === undefined) delete process.env.PRINTERS;
  else process.env.PRINTERS = previous;
  return mod;
}

test('a list of named printers is read', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('kitchen=192.168.1.50:9100,bar=192.168.1.51:9100'), {
    kitchen: { host: '192.168.1.50', port: 9100, width: 48, cut: 'full', codepage: 'cp437' },
    bar: { host: '192.168.1.51', port: 9100, width: 48, cut: 'full', codepage: 'cp437' }
  });
});

test('the port is optional, because every ESC/POS box on a LAN uses 9100', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('kitchen=192.168.1.50'), {
    kitchen: { host: '192.168.1.50', port: 9100, width: 48, cut: 'full', codepage: 'cp437' }
  });
});

test('stray whitespace is tolerated, since a person types this', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('  kitchen = 192.168.1.50:9100 ,  bar=192.168.1.51 '), {
    kitchen: { host: '192.168.1.50', port: 9100, width: 48, cut: 'full', codepage: 'cp437' },
    bar: { host: '192.168.1.51', port: 9100, width: 48, cut: 'full', codepage: 'cp437' }
  });
});

test('names are case-insensitive, so Kitchen and kitchen are one printer', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('KITCHEN=192.168.1.50'), {
    kitchen: { host: '192.168.1.50', port: 9100, width: 48, cut: 'full', codepage: 'cp437' }
  });
});

test('a half-finished entry is dropped rather than taking the others with it', () => {
  // An unparseable line must not cost a hotel the printers it typed correctly.
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('kitchen=192.168.1.50,broken,=1.2.3.4,bar=192.168.1.51'), {
    kitchen: { host: '192.168.1.50', port: 9100, width: 48, cut: 'full', codepage: 'cp437' },
    bar: { host: '192.168.1.51', port: 9100, width: 48, cut: 'full', codepage: 'cp437' }
  });
});

test('nothing configured is not an error — that is a one-printer restaurant', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations(undefined), {});
  assert.deepStrictEqual(parseStations(''), {});
});

test('a named station resolves to its own printer', () => {
  const { resolveStation } = freshPrinter('kitchen=192.168.1.50:9100,bar=192.168.1.51:9200');

  assert.deepStrictEqual(resolveStation('bar'), {
    host: '192.168.1.51',
    port: 9200,
    width: 48,
    cut: 'full',
    codepage: 'cp437',
    name: 'bar'
  });
});

test('no station named means the default printer', () => {
  const { resolveStation } = freshPrinter('kitchen=192.168.1.50');

  assert.strictEqual(resolveStation(undefined).name, 'default');
});

test('an unknown station falls back to the default rather than refusing', () => {
  // A ticket printed in the wrong room is confusing. A ticket that prints nowhere is an order the
  // kitchen never sees, so this fails towards the till printer and says so in the log.
  const { resolveStation } = freshPrinter('kitchen=192.168.1.50');

  assert.strictEqual(resolveStation('sauna').name, 'default');
});

/**
 * The production ticket's layout.
 *
 * A cook reads this across a hot kitchen while holding a pan, so the assertions are about what is
 * large, what is present, and above all what is absent: a ticket carrying VAT and a TIN is a page
 * of tax arithmetic to read past before finding the food.
 */

/**
 * The ticket as it lands on paper, one entry per printed line: its text, its width in columns
 * (double-width characters take two), and whether it was double-size or white on black.
 */
function paperLines(out) {
  const raw = out.join('');
  const lines = [];
  let wide = false, inv = false, text = '', cols = 0, anyWide = false, anyInv = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\x1B') { i += raw[i + 1] === '@' ? 1 : 2; continue; }
    if (c === '\x1D') {
      const n = raw.charCodeAt(i + 2);
      if (raw[i + 1] === '!') wide = (n & 0x10) !== 0;
      if (raw[i + 1] === 'B') inv = n === 1;
      i += 2;
      continue;
    }
    if (c === '\n') {
      lines.push({ text, cols, wide: anyWide, inverted: anyInv });
      text = ''; cols = 0; anyWide = false; anyInv = false;
      continue;
    }
    text += c;
    cols += wide ? 2 : 1;
    anyWide = anyWide || wide;
    anyInv = anyInv || inv;
  }
  return lines;
}

const LUNCH = {
  station: 'kitchen',
  orderNumber: 'A-0142',
  table: 12,
  time: '12:41',
  waiter: 'Selam',
  items: [
    { name: 'Doro Wat', quantity: 2, note: 'one mild, one extra spicy' },
    { name: 'Beyaynetu (fasting combination platter with misir, shiro, gomen and atakilt)', quantity: 1, note: 'no onion; extra injera on the side, please' },
    { name: 'Tibs', quantity: 12 }
  ]
};

for (const width of [48, 32]) {
  test(`a ticket never runs past the paper at ${width} columns`, () => {
    const { buildTicketData } = freshPrinter();
    const out = buildTicketData(
      { ...LUNCH, reprint: true, note: 'Guest has a nut allergy. Serve the fasting dishes first.' },
      { lineWidth: width }
    );
    for (const l of paperLines(out)) {
      assert.ok(l.cols <= width, `"${l.text}" is ${l.cols} columns on ${width}-column paper`);
    }
  });

  test(`a long dish name wraps under itself, not under the quantity, at ${width} columns`, () => {
    const { buildTicketData } = freshPrinter();
    const lines = paperLines(buildTicketData(LUNCH, { lineWidth: width }));
    // "12x" is the widest quantity: six columns double width, and one more before the names.
    const first = lines.findIndex(l => l.text.includes('Beyaynetu'));
    assert.ok(first > 0);
    assert.match(lines[first].text, /^ 1x Beyaynetu/);
    const next = lines[first + 1].text;
    assert.ok(next.startsWith(' '.repeat(7)) && next[7] !== ' ', `continuation "${next}"`);
    // Nothing of the name is lost to the wrap.
    const name = lines.slice(first, first + 5).map(l => l.text.trim()).join(' ');
    assert.match(name, /atakilt\)/);
  });
}

test('the station is a white-on-black bar, and the table is double size', () => {
  const { buildTicketData } = freshPrinter('bar=192.168.1.51');
  const out = buildTicketData({
    station: 'bar', orderNumber: '002', table: 7, time: '19:15', waiter: 'Sara',
    items: [{ name: 'Habesha Beer', quantity: 2 }]
  });
  const lines = paperLines(out);

  const station = lines[0];
  assert.strictEqual(station.text.trim(), 'BAR');
  assert.ok(station.inverted && station.wide, 'the station is inverted double-size type');
  assert.strictEqual(station.cols, 48, 'the bar runs the full width of the paper');

  const table = lines.find(l => l.text === 'TABLE 7');
  assert.ok(table && table.wide && !table.inverted, 'the table in double-size type');
  assert.ok(out.join('').includes('\x1D!\x11TABLE 7'), 'GS ! 0x11 before the table');

  const i = lines.indexOf(table);
  assert.strictEqual(lines[i + 1].text, '#002   19:15', 'order number and time on one line');
  assert.strictEqual(lines[i + 2].text, 'Waiter: Sara');
  assert.ok(!lines[i + 2].wide, 'the waiter in ordinary type');

  const dish = lines.find(l => l.text.includes('Habesha Beer'));
  assert.strictEqual(dish.text, '2x Habesha Beer');
  assert.ok(out.join('').includes('\x1BE\x01\x1D!\x112x\x1D!\x01 Habesha Beer'),
    'the quantity bold double size, the name bold double height');
});

test('a reprint says so in a black bar before the food, and a first print does not', () => {
  const { buildTicketData } = freshPrinter();
  const ticket = { orderNumber: '4', table: 3, items: [{ name: 'Tibs', quantity: 1 }] };

  const lines = paperLines(buildTicketData({ ...ticket, reprint: true }));
  const banner = lines.findIndex(l => l.text.trim() === 'REPRINT');
  assert.ok(banner > 0, 'no REPRINT banner');
  assert.ok(lines[banner].inverted && lines[banner].wide);
  assert.ok(banner < lines.findIndex(l => l.text.includes('Tibs')), 'REPRINT comes before the food');

  assert.ok(!buildTicketData(ticket).join('').includes('REPRINT'));
});

test('a remark sits under its dish behind a marker, wrapped with a hanging indent', () => {
  const { buildTicketData } = freshPrinter();
  const lines = paperLines(buildTicketData({
    orderNumber: '3',
    items: [{ name: 'Shiro', quantity: 1, note: 'no onion, no berbere, and bring it out with the injera already on the table' }]
  }, { lineWidth: 32 }));

  const dish = lines.findIndex(l => l.text.includes('Shiro'));
  const remark = lines.slice(dish + 1).filter(l => l.text.startsWith('     ') && l.text.trim());
  // Under the name: "1x" is four columns double width, and one more before the name.
  assert.match(remark[0].text, /^ {5}> no onion/);
  assert.ok(remark.length > 1, 'expected the remark to wrap at 32 columns');
  for (const more of remark.slice(1)) {
    assert.match(more.text, /^ {7}\S/, `"${more.text}" should hang under the remark, not the marker`);
  }
  assert.ok(remark.every(l => !l.wide), 'remarks in ordinary type');
});

test('a ticket carries no money at all', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({
    station: 'kitchen',
    orderNumber: '002',
    table: 7,
    // Even when the item arrives with a price, which a ticket has no field for.
    items: [{ name: 'Tibs', quantity: 1, price: 260 }]
  }).join('');

  for (const forbidden of ['VAT', 'TIN', 'Total', 'TOTAL', 'Subtotal', 'ETB', 'Birr', '260']) {
    assert.ok(!out.includes(forbidden), `a production ticket must not mention ${forbidden}`);
  }
});

test('a ticket with no table puts the order number large instead', () => {
  const { buildTicketData } = freshPrinter();
  const lines = paperLines(buildTicketData({
    station: 'kitchen', orderNumber: 'A-0139', table: null, time: '12:58',
    items: [{ name: 'Firfir', quantity: 1 }]
  }));

  assert.ok(!lines.some(l => l.text.includes('TABLE')), 'no table line when there is no table');
  const number = lines.find(l => l.text === '#A-0139');
  assert.ok(number && number.wide, 'the order number in double-size type');
  assert.strictEqual(lines[lines.indexOf(number) + 1].text, '12:58', 'the time alone beneath it');
});

test('table zero is still a table', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({ orderNumber: '5', table: 0, items: [{ name: 'Tibs', quantity: 1 }] });
  assert.ok(paperLines(out).some(l => l.text === 'TABLE 0'));
});

test('the foot counts dishes, not lines', () => {
  const { buildTicketData } = freshPrinter();
  const count = (items) => paperLines(buildTicketData({ orderNumber: '1', items }))
    .map(l => l.text).filter(t => /^\d+ items?$/.test(t));

  assert.deepStrictEqual(count([{ name: 'Beer', quantity: 3 }, { name: 'Tej', quantity: 2 }]), ['5 items']);
  assert.deepStrictEqual(count([{ name: 'Tej', quantity: 1 }]), ['1 item']);
});

test('a station prints the dishes it was sent and counts only those', () => {
  // The API splits an order by station; the bar's ticket holds the drinks and nothing else.
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({
    station: 'bar', orderNumber: '7', table: 2,
    items: [{ name: 'Habesha Beer', quantity: 2 }, { name: 'Ambo Water', quantity: 1 }]
  });
  const text = paperLines(out).map(l => l.text);

  assert.ok(text.includes('2x Habesha Beer'));
  assert.ok(text.includes('1x Ambo Water'));
  assert.ok(text.includes('3 items'));
});

test("the order's own note is boxed under the items", () => {
  const { buildTicketData } = freshPrinter();
  const lines = paperLines(buildTicketData({
    orderNumber: '8', table: 1,
    note: 'Guest has a nut allergy. Serve the fasting dishes first, the meat together after.',
    items: [{ name: 'Tibs', quantity: 1 }]
  }, { lineWidth: 32 })).map(l => l.text);

  const top = lines.indexOf('+' + '-'.repeat(30) + '+');
  assert.ok(top > lines.findIndex(t => t.includes('Tibs')), 'the box comes after the food');
  const inside = lines.slice(top + 1, lines.indexOf(lines[top], top + 1));
  assert.ok(inside.length > 1);
  assert.match(inside[0], /^\| NOTE: Guest has a nut/);
  for (const l of inside) assert.ok(l.length === 32 && l.endsWith(' |'), `"${l}"`);

  const plain = paperLines(buildTicketData({ orderNumber: '8', items: [{ name: 'Tibs', quantity: 1 }] }));
  assert.ok(!plain.some(l => l.text.includes('NOTE')), 'no box without a note');
});

test('an Amharic name is measured as it prints, transliterated', () => {
  const { buildTicketData } = freshPrinter();
  const lines = paperLines(buildTicketData({
    orderNumber: '6',
    items: [{ name: 'ሽሮ ፈሰስ በቅቤ ከአይብ ጋር ልዩ', quantity: 1 }]
  }, { lineWidth: 32 }));
  for (const l of lines) {
    assert.match(l.text, /^[\x20-\x7E]*$/, `"${l.text}" is not something the printer can show`);
    assert.ok(l.cols <= 32, `"${l.text}" is ${l.cols} columns`);
  }
  assert.ok(lines.some(l => l.text.includes('shro')));
});

test('a ticket ends with a cut, and has no buzzer to sound', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({ orderNumber: '3', items: [{ name: 'Tibs', quantity: 1 }] }).join('');

  assert.ok(out.endsWith('\x1DV\x00'), 'expected a paper cut at the end');
  assert.ok(!out.includes('\x07') && !out.includes('\x1BB'), 'no beep: nothing here drives a buzzer');
  assert.ok(buildTicketData({ orderNumber: '3', items: [{ name: 'Tibs', quantity: 1 }] }, { cut: 'partial' })
    .join('').endsWith('\x1DV\x01'), 'a station set to partial cuts partially');
});

/**
 * Working with any thermal printer, rather than with the one that happened to be on the desk.
 *
 * Nothing in this bridge was ever Epson-specific — it writes raw ESC/POS to port 9100 and every
 * command it sends is in the base set. What actually tied it to one printer was quieter: it never
 * selected a code page, so each brand used whatever table it powers on with; it never fired the cash
 * drawer, so a drawer in the printer's kick port simply never opened; and the cut was hardcoded, with
 * a comment claiming the opposite of what it sent.
 */

const CASH_SALE = {
  tin: '0012345678',
  businessName: 'EasyMaz Test Restaurant',
  address: 'Bole Road, Addis Ababa',
  phone: '+251 911 000 000',
  fsNo: 'FS-0001',
  orderNumber: 'ORD-0042',
  date: '22/08/2026 13:40',
  invoiceType: 'SALE',
  cashier: 'Admin',
  waiter: 'Kebede',
  table: 5,
  items: [
    { name: 'Tibs', quantity: 2, price: 120.0 },
    { name: 'Injera', quantity: 3, price: 15.0 },
    { name: 'Tej', quantity: 1, price: 80.0 }
  ],
  subtotal: 365.0,
  serviceCharge: 36.5,
  serviceChargePercentage: 10,
  taxableAmount: 0,
  vat: 0,
  vatPercentage: 0,
  convenienceFee: 0,
  total: 401.5,
  paidByCash: true,
  isPaid: true,
  paymentMethod: 'CASH',
  restaurantId: 'test-restaurant-001',
  isReceiptPrinted: false
};

const ESC = '\x1B';
const GS = '\x1D';

test('the full station form carries width, cut and code page', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('bar=192.168.1.51:9100:32:partial:cp858'), {
    bar: { host: '192.168.1.51', port: 9100, width: 32, cut: 'partial', codepage: 'cp858' }
  });
});

test('an existing host:port entry keeps working exactly as it did', () => {
  const { parseStations } = freshPrinter();

  // The parser used to take the last colon as the port separator, which is right for host:port and
  // wrong the moment anything follows it. Everything after the host is optional, so nobody has to
  // rewrite a PRINTERS line that already works.
  assert.deepStrictEqual(parseStations('kitchen=192.168.1.50:9100'), {
    kitchen: { host: '192.168.1.50', port: 9100, width: 48, cut: 'full', codepage: 'cp437' }
  });
});

test('a width that is not a column count falls back rather than printing one character per line', () => {
  const { parseStations } = freshPrinter();

  assert.strictEqual(parseStations('bar=10.0.0.5:9100:wide')['bar'].width, 48);
  assert.strictEqual(parseStations('bar=10.0.0.5:9100:4')['bar'].width, 48);
});

test('a real cash receipt selects a code page and opens the drawer', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(CASH_SALE, { lineWidth: 48, codepage: 'cp437' }).join('');

  // ESC t 0 — cp437. Without this the printer uses whatever it powers on with, which is why the
  // same receipt printed different characters on different brands.
  assert.ok(out.includes(ESC + 't' + '\x00'), 'selects a code page');

  // ESC p 0 25 250. Nothing sent this before, so a drawer in the kick port never opened.
  assert.ok(out.includes(ESC + 'p' + '\x00' + '\x19' + '\xFA'), 'fires the cash drawer');

  // The paper comes out before the drawer does.
  assert.ok(out.indexOf(GS + 'V') < out.indexOf(ESC + 'p'), 'cuts before it opens the drawer');

  // And the receipt is still a receipt.
  assert.ok(out.includes('0012345678'), 'carries the TIN');
  assert.ok(out.includes('FS-0001'), 'carries the invoice reference');
  assert.ok(out.includes('Tibs'), 'carries the items');
  assert.ok(out.includes('401.50'), 'carries the total');
});

test('a receipt carries all four of the taxpayer\'s identifiers', () => {
  const { buildEscposData } = freshPrinter();
  const registered = {
    ...CASH_SALE,
    vatRegistrationNumber: 'ETH0098765',
    fsNumber: 'FS04121',
    mrcNumber: 'MRC882401'
  };

  const out = buildEscposData(registered, {}).join('');

  // Art 4(1) with Art 29(3)(c). Only the TIN used to print, and the API was feeding that
  // field the business licence number, so the paper named the wrong number under the right
  // label and omitted the rest.
  assert.ok(out.includes('TIN: 0012345678'), 'the TIN, labelled as the TIN');
  assert.ok(out.includes('VAT No: ETH0098765'), 'the VAT registration number');
  assert.ok(out.includes('FS No: FS04121'), 'the FS number');
  assert.ok(out.includes('MRC: MRC882401'), 'the machine registration code');
});

test('the three optional identifiers are omitted rather than printed empty', () => {
  const { buildEscposData } = freshPrinter();

  // A restaurant that is not VAT-registered has no VAT number, and a sale taken before the
  // box was commissioned has no FS or MRC. A label with nothing after it would read on paper
  // as a number that failed to print.
  const out = buildEscposData(CASH_SALE, {}).join('');

  assert.ok(out.includes('TIN: 0012345678'), 'the TIN still prints');
  assert.ok(!out.includes('VAT No:'), 'no empty VAT line');
  assert.ok(!out.includes('MRC:'), 'no empty MRC line');
});

test('a card sale does not open the drawer', () => {
  const { buildEscposData } = freshPrinter();
  const card = { ...CASH_SALE, paidByCash: false, paymentMethod: 'CHAPA' };

  const out = buildEscposData(card, {}).join('');

  assert.ok(!out.includes(ESC + 'p'), 'no drawer pulse for a card payment');
});

test('a restaurant with no drawer keeps it shut on a cash sale (cashDrawer: false)', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData({ ...CASH_SALE, cashDrawer: false }, {}).join('');
  assert.ok(!out.includes(ESC + 'p'), 'no drawer kick when the setting is off');
  const on = buildEscposData({ ...CASH_SALE, cashDrawer: true }, {}).join('');
  assert.ok(on.includes(ESC + 'p'), 'on, it opens as before');
});

test('an unpaid receipt does not open the drawer either', () => {
  const { buildEscposData } = freshPrinter();
  const unpaid = { ...CASH_SALE, isPaid: false };

  assert.ok(!buildEscposData(unpaid, {}).join('').includes(ESC + 'p'));
});

test('full and partial cut are the bytes they claim to be', () => {
  const { buildEscposData } = freshPrinter();

  // GS V 0 is the full cut and GS V 1 the partial. The old code sent 1 with a comment saying "full
  // cut", which is the sort of thing that is only discovered on a printer that supports one of them.
  assert.ok(buildEscposData(CASH_SALE, { cut: 'full' }).join('').includes(GS + 'V' + '\x00'));
  assert.ok(buildEscposData(CASH_SALE, { cut: 'partial' }).join('').includes(GS + 'V' + '\x01'));
});

test('an item name in Amharic prints as something legible rather than as noise', () => {
  const { buildEscposData } = freshPrinter();
  const amharic = { ...CASH_SALE, items: [{ name: 'ጠጅ', quantity: 1, price: 80.0 }] };

  const out = buildEscposData(amharic, {}).join('');
  const printed = Buffer.from(require('../src/charset').toPrintable(out), 'latin1').toString('latin1');

  // There is no ESC/POS code page for Ethiopic — no value of ESC t produces ጠ — so latin1 turned
  // every Amharic character into an unrelated byte from the middle of the Latin table. A
  // transliteration is second best and legible; the receipt is a fiscal document either way.
  assert.ok(!printed.includes('ጠ'), 'no Ethiopic left in the byte stream');
  assert.ok(/t/i.test(printed), 'transliterated rather than dropped');
});

test('a curly quote from a phone does not become an unrelated glyph', () => {
  const { toPrintable } = require('../src/charset');

  assert.strictEqual(toPrintable('Chef’s special — today'), "Chef's special - today");
});

/**
 * Art 4(3)(c): a registered receipt carries an IRN, an RRN and a QR code.
 *
 * None of the three reached paper before this. A receipt printed the taxpayer's own identifiers and
 * said nothing at all about the registration that is supposed to make it a fiscal document.
 */
const fiscalReceipt = (extra) => ({
  tin: '0012345678',
  businessName: 'Zing Coffee',
  address: 'Mekanisa',
  fsNo: 'FS-1',
  orderNumber: '42',
  date: '2026-09-12',
  invoiceType: 'Cash Invoice Paid',
  items: [{ name: 'Macchiato', quantity: 1, price: 60 }],
  subtotal: 60, serviceCharge: 0, vat: 9, vatPercentage: 15, total: 69,
  restaurantId: 'r-1', paidByCash: true, isPaid: true,
  ...extra
});

test('the IRN and RRN are printed when the Authority has issued them', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ irn: 'IRN-99', rrn: 'RRN-77' })).join('');
  assert.match(out, /IRN/);
  assert.match(out, /IRN-99/);
  assert.match(out, /RRN-77/);
});

test('the QR goes to the printer as GS ( k, not as a line of text', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ irn: 'IRN-1', fiscalQr: 'https://esr.mor.gov.et/v/ABC123' })).join('');
  // Model, size, error correction, store, print — all five, in that order.
  assert.ok(out.includes('\x1D(k\x04\x001A2\x00'), 'selects QR model 2');
  assert.ok(out.includes('\x1D(k\x03\x001E1'), 'sets error correction');
  assert.ok(out.includes('1P0https://esr.mor.gov.et/v/ABC123'), 'stores the payload verbatim');
  assert.ok(out.includes('\x1D(k\x03\x001Q0'), 'prints what was stored');
});

test('the stored length is the payload plus three, little-endian', () => {
  const payload = 'X'.repeat(300);
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ irn: 'IRN-1', fiscalQr: payload })).join('');
  const expected = '\x1D(k' + String.fromCharCode(303 & 0xFF) + String.fromCharCode(303 >> 8) + '1P0';
  assert.ok(out.includes(expected), 'a payload over 255 bytes needs the high byte set');
});

test('a payload the code page would mangle is printed as text rather than encoded wrong', () => {
  // toPrintable transliterates anything above 0x7F on its way to the buffer, which would alter the
  // bytes inside the QR and produce a code that scans to something the Authority never issued.
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ irn: 'IRN-1', fiscalQr: 'https://esr.mor.gov.et/ገበታ' })).join('');
  assert.ok(!out.includes('\x1D(k'), 'no QR command is emitted');
  assert.match(out, /QR: /);
});

test('a sale awaiting transmission says so instead of implying it is registered', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ fiscalState: 'OFFLINE_QUEUED' })).join('');
  assert.match(out, /Awaiting fiscal registration/);
});

test('a sale from before the regime does not claim to be awaiting registration', () => {
  // Once the directive is in force it says it is not a fiscal receipt — see the notices below.
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ fiscalState: 'NOT_REQUIRED', directiveInForce: true })).join('');
  assert.ok(!/Awaiting fiscal registration/.test(out));
  assert.ok(!out.includes('\x1D(k'));
  assert.match(out, /NOT A FISCAL RECEIPT/);
});

/**
 * Art 4(1)(i): the code on the slip, which is the diner's own copy.
 *
 * Two messages from the API have told diners "the code on your slip opens the same receipt" while
 * no renderer printed one and nothing served the route it pointed at. These cover the printing half.
 */
test('the slip carries a scannable code for the buyer\'s own copy', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ receiptUrl: 'http://192.168.1.50/app/r/abc123' })).join('');
  assert.match(out, /Your receipt/);
  assert.ok(out.includes('1P0http://192.168.1.50/app/r/abc123'), 'stores the URL verbatim');
  assert.ok(out.includes('\x1D(k\x03\x001Q0'), 'and prints it');
});

test('no URL means no code, because one that scans to nothing looks like it works', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({})).join('');
  assert.ok(!/Your receipt/.test(out));
});

test('the buyer\'s code and the Authority\'s are labelled apart', () => {
  // Different documents to anybody who scans them: one is a tax registration, one is a bill.
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({
    irn: 'IRN-1',
    fiscalQr: 'https://esr.mor.gov.et/v/ABC123',
    receiptUrl: 'http://192.168.1.50/app/r/abc123'
  })).join('');
  assert.match(out, /Revenue Authority/);
  assert.match(out, /Your receipt/);
  assert.ok(out.indexOf('Revenue Authority') < out.indexOf('Your receipt'), 'the tax code comes first');
});

/**
 * What the slip is, said on the slip.
 *
 * Art 4(1)(c): a receipt is issued "only upon transmitting data ... and obtaining an IRN, RRN and
 * QR code". Nothing is transmitted to the Authority today, so every slip that prints has no IRN, and
 * the old rule — say nothing for NOT_REQUIRED or an absent state — left every one of them looking
 * like a registered receipt. Art 22(5)(c): a copy is "clearly marked as a 'DUPLICATE'".
 */
const NOT_FISCAL = 'NOT A FISCAL RECEIPT';
const count = (haystack, needle) => haystack.split(needle).length - 1;

test('a registered sale prints its IRN and no not-fiscal notice', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({
    irn: 'IRN-99', rrn: 'RRN-77', fiscalQr: 'https://esr.mor.gov.et/v/ABC123'
  })).join('');
  assert.match(out, /IRN-99/);
  assert.match(out, /RRN-77/);
  assert.ok(out.includes('1P0https://esr.mor.gov.et/v/ABC123'), 'the Authority QR');
  assert.ok(!out.includes(NOT_FISCAL));
  assert.ok(!/Awaiting fiscal registration/.test(out));
});

for (const state of ['OFFLINE_QUEUED', 'SUBMITTED', 'submitted']) {
  test(`a sale in ${state} says it is awaiting registration and nothing more`, () => {
    const { buildEscposData } = freshPrinter();
    const out = buildEscposData(fiscalReceipt({ fiscalState: state })).join('');
    assert.strictEqual(count(out, 'Awaiting fiscal registration'), 1);
    assert.ok(!out.includes(NOT_FISCAL));
  });
}

for (const directiveInForce of [undefined, false]) {
  test(`before the directive commences (directiveInForce ${directiveInForce}) a slip without an IRN is an ordinary receipt`, () => {
    const { buildEscposData } = freshPrinter();
    const out = buildEscposData(fiscalReceipt({ fiscalState: 'PENDING', directiveInForce, isPaid: false, isReceiptPrinted: true })).join('');
    assert.ok(!out.includes(NOT_FISCAL));
    assert.ok(!out.includes('Not registered with the Revenue Authority'));
    // What the slip is still says so: those rules do not wait for the directive.
    assert.strictEqual(count(out, 'DUPLICATE'), 2);
    assert.strictEqual(count(out, 'BILL - NOT A RECEIPT'), 1);
  });
}

test('before the directive commences a registered sale still prints its IRN, RRN and QR', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({
    irn: 'IRN-99', rrn: 'RRN-77', fiscalQr: 'https://esr.mor.gov.et/v/ABC123'
  })).join('');
  assert.match(out, /IRN-99/);
  assert.match(out, /RRN-77/);
  assert.ok(out.includes('1P0https://esr.mor.gov.et/v/ABC123'));
});

for (const state of [undefined, 'PENDING', 'pending', 'NOT_REQUIRED', 'REJECTED', 'CANCELLED', 'SOMETHING_NEW']) {
  test(`once the directive is in force, a sale with no IRN in state ${state} is marked not fiscal, top and bottom`, () => {
    const { buildEscposData } = freshPrinter();
    const lines = buildEscposData(fiscalReceipt({ fiscalState: state, directiveInForce: true }));
    const out = lines.join('');

    assert.strictEqual(count(out, NOT_FISCAL), 2, 'once at the top, once at the bottom');
    assert.strictEqual(count(out, 'Not registered with the Revenue Authority'), 2);
    assert.ok(!/Awaiting fiscal registration/.test(out));

    // Bold and centred: ESC a 1, ESC E 1, the notice, ESC E 0.
    assert.ok(out.includes(ESC + 'a\x01' + ESC + 'E\x01' + NOT_FISCAL + '\n' + ESC + 'E\x00'));

    // The top one sits under the business header, above the identifiers and the items.
    const first = out.indexOf(NOT_FISCAL);
    assert.ok(out.indexOf('ZING COFFEE') < first, 'after the business name');
    assert.ok(first < out.indexOf('TIN: 0012345678'), 'before the identifiers');
    // The bottom one sits where the IRN would have been: after the total, before the thanks.
    const last = out.lastIndexOf(NOT_FISCAL);
    assert.ok(out.indexOf('TOTAL', out.indexOf('Macchiato')) < last, 'after the total');
    assert.ok(last < out.indexOf('Thank you!'), 'before the footer');
  });
}

test('an Authority QR without an IRN is not printed under a not-fiscal notice', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ fiscalQr: 'https://esr.mor.gov.et/v/ABC123', directiveInForce: true })).join('');
  assert.ok(out.includes(NOT_FISCAL));
  assert.ok(!out.includes('\x1D(k'), 'no Authority QR');
});

test('the notices fit on 58 mm paper', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ isPaid: false, isReceiptPrinted: true, directiveInForce: true }), { lineWidth: 32 }).join('');
  for (const text of ['NOT A FISCAL RECEIPT', 'BILL - NOT A RECEIPT', 'DUPLICATE']) {
    assert.ok(out.includes(text), text);
  }
  // "Not registered with the Revenue Authority" is 41 characters, so it wraps rather than overrunning.
  assert.ok(!out.includes('Not registered with the Revenue Authority'));
  assert.ok(out.includes('Not registered with the Revenue\nAuthority\n'));
});

test('an unpaid bill is titled as a bill, with the fiscal notice under it', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ isPaid: false, directiveInForce: true })).join('');
  assert.strictEqual(count(out, 'BILL - NOT A RECEIPT'), 1, 'one title, at the top');
  const bill = out.indexOf('BILL - NOT A RECEIPT');
  assert.ok(out.indexOf('ZING COFFEE') < bill);
  assert.ok(bill < out.indexOf(NOT_FISCAL), 'the bill title, then the fiscal line');
  assert.ok(out.indexOf(NOT_FISCAL) < out.indexOf('TIN: 0012345678'));
  assert.ok(out.includes(ESC + 'E\x01' + 'BILL - NOT A RECEIPT\n' + ESC + 'E\x00'), 'bold');
});

test('a paid sale, or one that does not say, is not titled a bill', () => {
  const { buildEscposData } = freshPrinter();
  assert.ok(!buildEscposData(fiscalReceipt({ isPaid: true })).join('').includes('BILL - NOT A RECEIPT'));
  assert.ok(!buildEscposData(fiscalReceipt({ isPaid: undefined })).join('').includes('BILL - NOT A RECEIPT'));
});

test('a reprint is marked DUPLICATE at the top and the bottom', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ irn: 'IRN-99', isReceiptPrinted: true })).join('');
  assert.strictEqual(count(out, 'DUPLICATE'), 2);
  assert.ok(out.includes(ESC + 'a\x01' + ESC + 'E\x01' + 'DUPLICATE\n' + ESC + 'E\x00'), 'bold and centred');
  assert.ok(out.indexOf('DUPLICATE') < out.indexOf('TIN: 0012345678'), 'top');
  assert.ok(out.lastIndexOf('DUPLICATE') > out.indexOf('IRN-99'), 'bottom, after the registration');
  assert.ok(out.lastIndexOf('DUPLICATE') < out.indexOf('Thank you!'));
});

test('an original is not marked DUPLICATE', () => {
  const { buildEscposData } = freshPrinter();
  assert.ok(!buildEscposData(fiscalReceipt({ isReceiptPrinted: false })).join('').includes('DUPLICATE'));
  assert.ok(!buildEscposData(fiscalReceipt({})).join('').includes('DUPLICATE'));
});

test('a reprint of a cash sale does not open the drawer', () => {
  const { buildEscposData } = freshPrinter();
  const reprint = { ...CASH_SALE, isReceiptPrinted: true };
  assert.ok(!buildEscposData(reprint, {}).join('').includes(ESC + 'p'));
  // The original still does.
  assert.ok(buildEscposData(CASH_SALE, {}).join('').includes(ESC + 'p' + '\x00' + '\x19' + '\xFA'));
});

test('a kitchen ticket carries none of the receipt notices', () => {
  // A ticket is not a sale document, so it has nothing to declare — even for a reprint of an unpaid
  // order, which is exactly the receipt that carries all three.
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({
    station: 'kitchen', orderNumber: '9', isPaid: false, isReceiptPrinted: true,
    items: [{ name: 'Tibs', quantity: 1 }]
  }).join('');
  for (const notice of ['NOT A FISCAL RECEIPT', 'BILL - NOT A RECEIPT', 'DUPLICATE']) {
    assert.ok(!out.includes(notice), notice);
  }
});

test('a slip with no invoice number prints without one', () => {
  const { buildEscposData } = freshPrinter();
  const withNumber = buildEscposData(fiscalReceipt({ fsNo: 'INV-42' })).join('');
  const without = buildEscposData(fiscalReceipt({ fsNo: undefined })).join('');
  assert.ok(withNumber.includes('INV-42'));
  assert.ok(withNumber.includes('Invoice : '), 'the invoice line, when there is a number');
  assert.ok(!without.includes('Invoice : '), 'no invoice line when there is no number');
});

test('the buyer is named on the slip when they asked to be', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ buyerName: 'Abebe Kebede', buyerTin: '0098765432' })).join('');
  assert.ok(out.includes('Abebe Kebede'));
  assert.ok(out.includes('0098765432'));
});

/**
 * Directive 1142/2026 Art 4(1)(c), 4(1)(d) and 2(3): the IRN, the RRN and the Authority's QR belong
 * to an issued receipt, which is a sale. A bill printed before payment carries none of them, and no
 * link to a receipt either, whatever the payload says.
 */
const REGISTERED = {
  irn: 'IRN-1',
  rrn: 'RRN-1',
  fiscalQr: 'https://esr.mor.gov.et/v/ABC123',
  receiptUrl: 'http://192.168.1.50/app/r/abc123'
};

for (const paymentStatus of ['UNPAID', 'INITIATED', 'FAILED', 'CANCELLED', 'REJECTED', 'pending']) {
  test(`a bill whose payment is ${paymentStatus} prints no IRN, RRN, fiscal QR or receipt code`, () => {
    const { buildEscposData } = freshPrinter();
    const out = buildEscposData(fiscalReceipt({ ...REGISTERED, paymentStatus, isPaid: true, directiveInForce: true })).join('');
    assert.ok(!out.includes('IRN-1'), 'no IRN');
    assert.ok(!out.includes('RRN-1'), 'no RRN');
    // Not /Revenue Authority/: the not-fiscal notice names the Authority too.
    assert.ok(!out.includes('esr.mor.gov.et'), 'no fiscal QR');
    assert.ok(!/Your receipt/.test(out), 'no receipt code');
    assert.match(out, /NOT A FISCAL RECEIPT/, 'and it says what it is');
  });
}

test('a payload with no status and isPaid false is a bill, and loses the codes', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ ...REGISTERED, isPaid: false })).join('');
  assert.ok(!out.includes('IRN-1'));
  assert.ok(!/Your receipt/.test(out));
});

for (const paymentStatus of ['PAID', 'paid', 'REFUNDED']) {
  test(`a ${paymentStatus} sale keeps its IRN, RRN, fiscal QR and receipt code`, () => {
    const { buildEscposData } = freshPrinter();
    const out = buildEscposData(fiscalReceipt({ ...REGISTERED, paymentStatus })).join('');
    assert.ok(out.includes('IRN-1'));
    assert.ok(out.includes('RRN-1'));
    assert.ok(out.includes('esr.mor.gov.et'));
    assert.match(out, /Your receipt/);
  });
}

test('stripping the codes leaves the payload it was given alone', () => {
  const { withoutUnsoldCodes } = freshPrinter();
  const input = { ...REGISTERED, paymentStatus: 'UNPAID' };
  withoutUnsoldCodes(input);
  assert.strictEqual(input.irn, 'IRN-1');
});


test('the convenience fee prints on its own line, and no ROUNDING line', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(
    { ...CASH_SALE, paidByCash: false, paymentMethod: 'CHAPA', convenienceFee: 5, roundingDifference: 0.97 },
    {}
  ).join('');

  assert.match(out, /CONVENIENCE FEE\s+5\n/);
  assert.doesNotMatch(out, /ROUNDING/);
});

test('a fee of zero prints no line at all', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData({ ...CASH_SALE, convenienceFee: 0 }, {}).join('');

  assert.doesNotMatch(out, /CONVENIENCE FEE/);
});

test('an unpaid bill says what is owed and commits to no method', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData({ ...CASH_SALE, isPaid: false }, {}).join('');

  assert.match(out, /AMOUNT DUE/);
  assert.doesNotMatch(out, /UNPAID/);
});

test('a cash receipt shows the cash received and the change', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData({ ...CASH_SALE, isPaid: true, tenderedAmount: CASH_SALE.total + 50 }, {}).join('');

  assert.match(out, /CASH RECEIVED/);
  assert.match(out, /CHANGE\s+50/);
});

test('mobile money names the wallet, never the gateway', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(
    { ...CASH_SALE, paidByCash: false, isPaid: true, paymentMethod: 'CHAPA', paymentWallet: 'telebirr' },
    {}
  ).join('');

  assert.match(out, /MOBILE MONEY TELEBIRR/);
  assert.doesNotMatch(out, /CHAPA/);
  assert.doesNotMatch(out, /Status:/);
});

test('menu prices include VAT: it prints under the total, as included, never added', () => {
  const { buildEscposData } = freshPrinter();
  // 365 at menu prices and 10% service: 349.13 food and service before VAT, 52.37 VAT inside.
  const registered = {
    ...CASH_SALE,
    vatRegistrationNumber: 'VAT-0001',
    taxableAmount: 349.13,
    vat: 52.37,
    vatPercentage: 15
  };

  const out = buildEscposData(registered, {}).join('');

  assert.ok(out.includes('BEFORE VAT'), 'the amount before VAT is shown');
  assert.ok(out.includes('VAT 15% INCL'), 'the VAT is shown as included');
  assert.ok(!out.includes('TAX 15%'), 'no VAT line that adds to the total');
  assert.ok(out.indexOf('TOTAL') < out.indexOf('VAT 15% INCL'), 'under the total, not above it');
});

test('a VAT-registered restaurant prints its VAT lines on every receipt, even at 0', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(
    { ...CASH_SALE, vatRegistrationNumber: 'VAT-0001', taxableAmount: 0, vat: 0, vatPercentage: 15 },
    {}
  ).join('');
  assert.match(out, /BEFORE VAT/);
  assert.match(out, /VAT 15% INCL +0\n/);
});

test('a restaurant that is not VAT registered prints no VAT at all', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(CASH_SALE, {}).join('');
  assert.ok(!out.includes('VAT'), 'nothing about VAT');
});

/**
 * The Tax Credit Note (Directive 1142/2018 E.C. Art 25): the paper behind money handed back.
 *
 * It shares the receipt's header and printer handling and almost nothing else. The tests below pin
 * the parts that make it a different document — the title, the sale it reverses, the money going
 * back and how — and the parts it must never borrow from a receipt: a QR, an IRN, a DUPLICATE
 * banner, or a drawer that opens for mobile money.
 */

const CREDIT_NOTE = {
  type: 'CREDIT_NOTE',
  jobId: 'cn-1',
  restaurant: {
    name: 'Zing Coffee',
    tin: '0012345678',
    vatNumber: 'ETH0098765',
    address: 'Bole Road, Addis Ababa',
    phone: '+251 911 000 000'
  },
  creditNoteNumber: 'CN-000017',
  originalInvoiceNumber: '000231',
  orderNumber: 'ORD-0042',
  table: 5,
  issuedAt: '2026-10-16 14:05',
  reason: 'Dish returned cold',
  lines: [
    { name: 'Tibs', quantity: 2, amount: 240 },
    { name: 'Macchiato', quantity: 1, amount: 60.5 }
  ],
  amount: 300.5,
  vatIncluded: 39.2,
  method: 'CASH',
  issuedBy: 'Sara',
  approvedBy: 'Musie',
  openDrawer: true
};

const DRAWER = ESC + 'p' + '\x00' + '\x19' + '\xFA';

test('a credit note says what it is, which sale it reverses, and what went back', () => {
  const { buildCreditNoteData } = freshPrinter();
  const out = buildCreditNoteData(CREDIT_NOTE, { lineWidth: 48 }).join('');

  assert.match(out, /TAX CREDIT NOTE/);
  assert.match(out, /ZING COFFEE/, 'the business name, capitalised as on the receipt');
  assert.ok(out.includes('TIN: 0012345678'));
  assert.ok(out.includes('VAT No: ETH0098765'));
  assert.ok(out.includes('TEL: +251 911 000 000'));
  assert.match(out, /Credit note : +CN-000017\n/);
  assert.match(out, /For invoice : +000231\n/);
  assert.match(out, /Order : +ORD-0042\n/);
  assert.match(out, /Table : +5\n/);
  assert.match(out, /Issued : +2026-10-16 14:05\n/);
  assert.match(out, /2 x Tibs +240\n/);
  assert.match(out, /1 x Macchiato +60\.50\n/);
  assert.match(out, /TOTAL RETURNED +300\.50\n/);
  assert.match(out, /VAT included +39\.20\n/);
  assert.match(out, /Returned in cash\n/);
  assert.match(out, /Reason: Dish returned cold\n/);
  assert.match(out, /Issued by : +Sara\n/);
  assert.match(out, /Approved by : +Musie\n/);
  assert.match(out, /Received by: _+\n/, 'the customer signs for cash');
});

test('the total returned is bold and tall, and the title is too', () => {
  const { buildCreditNoteData } = freshPrinter();
  const out = buildCreditNoteData(CREDIT_NOTE, {}).join('');

  // Bold, then double height, then the words: what the reader sees first and what a torn slip keeps.
  const large = ESC + 'E' + '\x01' + GS + '!' + '\x01';
  assert.ok(out.includes(large + 'TAX CREDIT NOTE\n'), 'the title is printed large');
  assert.ok(out.includes(large + 'TOTAL RETURNED'), 'the total is printed large');
  // And switched off again, so the reason is not printed in headline type.
  assert.ok(out.indexOf(GS + '!' + '\x00', out.indexOf('TOTAL RETURNED')) < out.indexOf('Reason'));
});

test('a credit note carries no fiscal QR, IRN, receipt link or DUPLICATE banner', () => {
  const { buildCreditNoteData } = freshPrinter();
  // Fields a receipt would act on, smuggled in: none of them may reach the paper.
  const out = buildCreditNoteData(
    { ...CREDIT_NOTE, irn: 'IRN-1', rrn: 'RRN-1', fiscalQr: 'https://qr', receiptUrl: 'https://r', isReceiptPrinted: true },
    {}
  ).join('');

  assert.ok(!out.includes(GS + '(' + 'k'), 'no QR command');
  assert.doesNotMatch(out, /IRN|RRN|QR|DUPLICATE|https:/);
});

test('a mobile-money return says so, has no signature line and never opens the drawer', () => {
  const { buildCreditNoteData } = freshPrinter();
  const out = buildCreditNoteData({ ...CREDIT_NOTE, method: 'CHAPA', openDrawer: true }, {}).join('');

  assert.match(out, /Returned to mobile money\n/);
  assert.doesNotMatch(out, /CHAPA/, 'the gateway is not a word a customer knows');
  assert.doesNotMatch(out, /Received by/);
  assert.ok(!out.includes(ESC + 'p'), 'no drawer pulse for mobile money');
});

test('a cash return opens the drawer only when asked, and after the cut', () => {
  const { buildCreditNoteData } = freshPrinter();

  const opened = buildCreditNoteData(CREDIT_NOTE, {}).join('');
  assert.ok(opened.includes(DRAWER), 'CASH + openDrawer fires the drawer');
  assert.ok(opened.indexOf(GS + 'V') < opened.indexOf(DRAWER), 'paper out before the drawer opens');

  const notAsked = buildCreditNoteData({ ...CREDIT_NOTE, openDrawer: false }, {}).join('');
  assert.ok(!notAsked.includes(ESC + 'p'), 'openDrawer false keeps it shut');
});

test('what the API may not have is omitted, not printed empty', () => {
  const { buildCreditNoteData } = freshPrinter();
  const bare = {
    ...CREDIT_NOTE,
    restaurant: { name: null, tin: null, vatNumber: null, address: null, phone: null },
    originalInvoiceNumber: undefined,
    table: null,
    issuedBy: undefined,
    approvedBy: undefined,
    vatIncluded: 0
  };
  const out = buildCreditNoteData(bare, {}).join('');

  assert.match(out, /TAX CREDIT NOTE/);
  assert.doesNotMatch(out, /TIN:|VAT No:|TEL:|For invoice|Table|Issued by|Approved by|VAT included/);
  assert.match(out, /TOTAL RETURNED +300\.50/);
});

test('a VAT-registered restaurant prints VAT included on every credit note, even at 0', () => {
  const { buildCreditNoteData } = freshPrinter();
  const out = buildCreditNoteData({ ...CREDIT_NOTE, vatIncluded: 0 }, { lineWidth: 48 }).join('');

  assert.match(out, /VAT included +0\n/);
});

test('a credit note fits 58 mm paper, long names and all', () => {
  const { buildCreditNoteData } = freshPrinter();
  const long = { ...CREDIT_NOTE, lines: [{ name: 'Special combination platter with extra injera', quantity: 1, amount: 300.5 }] };
  const text = buildCreditNoteData(long, { lineWidth: 32 }).join('')
    .replace(/\x1bp[\s\S]{3}/g, '').replace(/\x1b@/g, '').replace(/\x1b[taE][\s\S]/g, '')
    .replace(/\x1d[!V][\s\S]/g, '');
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 32, `"${line}" is ${line.length} columns`);
  }
  assert.match(text, /300\.50/);
});

test('the drawer pulse is ESC p on pin 0 and nothing else', () => {
  const { buildDrawerPulse } = require('../src/printer');
  assert.deepStrictEqual(buildDrawerPulse(), ['\x1bp\x00\x19\xFA']);
});

/**
 * Orders-only pilot: the restaurant's own register issues every receipt, so a slip from Easymaz
 * says it is not one whatever the directive's calendar, and points the diner at the register.
 */
test('a pilot slip says it is not a fiscal receipt even before the directive commences', () => {
  const { buildEscposData } = freshPrinter();
  for (const directiveInForce of [undefined, false]) {
    const out = buildEscposData(fiscalReceipt({ ordersOnlyPilot: true, directiveInForce })).join('');
    assert.match(out, /NOT A FISCAL RECEIPT/);
    assert.match(out, /Your receipt is issued at the register/);
  }
});

test('a slip outside a pilot is unchanged before the directive commences', () => {
  const { buildEscposData } = freshPrinter();
  const out = buildEscposData(fiscalReceipt({ ordersOnlyPilot: false })).join('');
  assert.ok(!/NOT A FISCAL RECEIPT/.test(out));
  assert.ok(!/issued at the register/.test(out));
});
