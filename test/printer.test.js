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
