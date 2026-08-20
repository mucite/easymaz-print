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
    kitchen: { host: '192.168.1.50', port: 9100 },
    bar: { host: '192.168.1.51', port: 9100 }
  });
});

test('the port is optional, because every ESC/POS box on a LAN uses 9100', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('kitchen=192.168.1.50'), {
    kitchen: { host: '192.168.1.50', port: 9100 }
  });
});

test('stray whitespace is tolerated, since a person types this', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('  kitchen = 192.168.1.50:9100 ,  bar=192.168.1.51 '), {
    kitchen: { host: '192.168.1.50', port: 9100 },
    bar: { host: '192.168.1.51', port: 9100 }
  });
});

test('names are case-insensitive, so Kitchen and kitchen are one printer', () => {
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('KITCHEN=192.168.1.50'), {
    kitchen: { host: '192.168.1.50', port: 9100 }
  });
});

test('a half-finished entry is dropped rather than taking the others with it', () => {
  // An unparseable line must not cost a hotel the printers it typed correctly.
  const { parseStations } = freshPrinter();

  assert.deepStrictEqual(parseStations('kitchen=192.168.1.50,broken,=1.2.3.4,bar=192.168.1.51'), {
    kitchen: { host: '192.168.1.50', port: 9100 },
    bar: { host: '192.168.1.51', port: 9100 }
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
