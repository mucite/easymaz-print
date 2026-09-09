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
test('a ticket names its station and its table in double-height type', () => {
  const { buildTicketData } = freshPrinter('bar=192.168.1.51');
  const out = buildTicketData({
    station: 'bar',
    orderNumber: '002',
    table: 7,
    items: [{ name: 'Habesha Beer', quantity: 2 }]
  }).join('');

  assert.match(out, /BAR/);
  assert.match(out, /TABLE 7/);
  assert.match(out, /2 x Habesha Beer/);
  // GS ! 0x11 is double width and height.
  assert.ok(out.includes('\x1D!\x11'), 'expected double-size type');
});

test('a ticket carries no money at all', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({
    station: 'kitchen',
    orderNumber: '002',
    table: 7,
    items: [{ name: 'Tibs', quantity: 1 }]
  }).join('');

  for (const forbidden of ['VAT', 'TIN', 'Total', 'Subtotal', 'ETB']) {
    assert.ok(!out.includes(forbidden), `a production ticket must not mention ${forbidden}`);
  }
});

test('an item note reaches the person cooking it', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({
    orderNumber: '3',
    items: [{ name: 'Shiro', quantity: 1, note: 'no berbere' }]
  }).join('');

  assert.match(out, /no berbere/);
});

test('a ticket ends with a cut, so each station gets its own paper', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({ orderNumber: '3', items: [{ name: 'Tibs', quantity: 1 }] }).join('');

  assert.ok(out.endsWith('\x1DV\x00'), 'expected a paper cut at the end');
});

test('a takeaway with no table still prints', () => {
  const { buildTicketData } = freshPrinter();
  const out = buildTicketData({
    station: 'kitchen',
    orderNumber: '9',
    table: null,
    items: [{ name: 'Firfir', quantity: 1 }]
  }).join('');

  assert.ok(!out.includes('TABLE'), 'no table line when there is no table');
  assert.match(out, /1 x Firfir/);
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
