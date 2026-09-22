const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * The print flow end to end, against the real server and real sockets.
 *
 * The other suites test pieces in process: the schema, and the parsing of the PRINTERS list. This
 * starts src/server.js as its own process and puts TCP listeners where the printers would be, so a
 * job travels the whole way — HTTP in, shared secret, schema, station routing, ESC/POS bytes, out
 * through a socket. Nothing inside the bridge is stubbed, which is the point: the faults worth
 * catching here live in the seams. A ticket routed to the wrong room, a receipt with the shop's
 * name eaten by a stray escape, a retry that prints the food twice — each of those passes every
 * unit test in this directory.
 *
 * Ports are taken from the operating system rather than fixed, so a developer with a bridge already
 * running, or two CI jobs on one runner, do not collide.
 */

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const KEY = 'e2e-secret';

/** A port nothing is using. Racy in principle; the window is a few milliseconds and it is a test. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A thermal printer, as far as the bridge can tell: something that accepts a TCP connection on its
 * port and is handed raw ESC/POS. Every stream it is sent is kept for the assertions.
 */
function fakePrinter() {
  return new Promise((resolve) => {
    const streams = [];
    const server = net.createServer((sock) => {
      const chunks = [];
      sock.on('data', (d) => chunks.push(d));
      sock.on('close', () => streams.push(Buffer.concat(chunks)));
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        streams,
        reset: () => (streams.length = 0),
        close: () => new Promise((r) => server.close(r))
      })
    );
  });
}

/** Starts the bridge and waits for it to say it is listening, rather than sleeping and hoping. */
async function startBridge(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bridge did not start within 10s:\n${log}`)),
      10_000
    );
    const onOut = (d) => {
      log += d.toString();
      if (log.includes('easymaz-print] HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited with ${code}:\n${log}`));
    });
  });

  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    log: () => log,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
    post: async (route, body, key = KEY) => {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['X-Print-Key'] = key;
      const res = await fetch(url + route, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    health: async () => (await fetch(`${url}/health`)).json()
  };
}

/**
 * Waits for a printer to have been handed something, instead of sleeping a guessed interval.
 *
 * A fixed sleep is the reason a suite like this goes flaky on a loaded runner: too short and it
 * fails for a machine being busy, too long and every run pays for the worst case.
 */
async function settled(printer, count = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (printer.streams.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return printer.streams.length >= count;
}

/** Nothing arrives, and we waited long enough to mean it. */
async function stayedEmpty(printer, ms = 600) {
  await new Promise((r) => setTimeout(r, ms));
  return printer.streams.length === 0;
}

/**
 * The printable text of an ESC/POS stream, so an assertion can read what the paper says.
 *
 * Each command is removed with its own parameter count. A generic "ESC and a byte or two" is wrong
 * in both directions: it leaves parameter bytes behind as visible characters, which makes every
 * measured line wider than the paper it was laid out for, and it eats the byte after ESC @ — which
 * takes no parameter — swallowing the first letter of whatever follows. The set below is exactly
 * what printer.js emits: ESC @, ESC t/a/E n, GS V n, and ESC p m t1 t2 for the drawer.
 */
/**
 * Removes the QR blocks, which are the one command here that carries a length rather than a fixed
 * number of parameters.
 *
 * GS ( k is pL pH and then that many bytes, and the bytes are the payload — so a pattern that eats a
 * fixed width leaves the payload behind as visible text. That is not cosmetic: it lands on the same
 * line as whatever follows, and every assertion about how wide the paper is then measures a string
 * no printer would ever render. The code's own commands go; the text line printed beneath it, which
 * is what a scan is checked against, is ordinary text and stays.
 */
function stripQr(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\x1d' && text[i + 1] === '(' && text[i + 2] === 'k') {
      i += 5 + (text.charCodeAt(i + 3) | (text.charCodeAt(i + 4) << 8));
      continue;
    }
    out += text[i++];
  }
  return out;
}

function paper(printer) {
  return stripQr(Buffer.concat(printer.streams).toString('latin1'))
    .replace(/\x1bp[\s\S]{3}/g, '')
    .replace(/\x1b@/g, '')
    .replace(/\x1b[taE][\s\S]/g, '')
    .replace(/\x1dV[\s\S]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '');
}

/** The longest line, which is what the column width actually governs. */
function widestLine(printer) {
  return Math.max(...paper(printer).split(/[\r\n]/).map((l) => l.trimEnd().length));
}

function ticket(station, jobId, items) {
  return {
    jobId,
    ...(station ? { station } : {}),
    orderNumber: '002',
    table: 7,
    time: '19:15:00',
    waiter: 'Sara',
    items
  };
}

const RECEIPT = {
  tin: '0012345678',
  businessName: 'Test Kitchen',
  address: 'Bole, Addis Ababa',
  fsNo: '77',
  orderNumber: '002',
  date: '2026-09-13 19:15',
  invoiceType: 'CASH INVOICE',
  restaurantId: 'r1',
  items: [{ name: 'Tibs', quantity: 1, price: 260 }],
  subtotal: 260,
  serviceCharge: 0,
  vat: 39,
  vatPercentage: 15,
  total: 299
};

describe('a box with a register printer and two stations', () => {
  let register, kitchen, bar, bridge;

  before(async () => {
    [register, kitchen, bar] = await Promise.all([fakePrinter(), fakePrinter(), fakePrinter()]);
    bridge = await startBridge({
      PRINT_SHARED_SECRET: KEY,
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(register.port),
      // The bar runs 58 mm rolls, which is 32 columns against the register's 48.
      PRINTERS: `kitchen=127.0.0.1:${kitchen.port},bar=127.0.0.1:${bar.port}:32`
    });
  });

  after(async () => {
    await bridge?.stop();
    await Promise.all([register?.close(), kitchen?.close(), bar?.close()]);
  });

  test('health reports the register and both stations', async () => {
    const health = await bridge.health();

    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.registerConfigured, true);
    assert.deepStrictEqual(Object.keys(health.stations).sort(), ['bar', 'kitchen']);
  });

  test('an order splits across the rooms that make it', async () => {
    const food = await bridge.post('/ticket', ticket('kitchen', 'j-kitchen', [{ name: 'Tibs', quantity: 1 }]));
    const drink = await bridge.post(
      '/ticket',
      ticket('bar', 'j-bar', [{ name: 'Habesha Beer', quantity: 2, note: 'cold' }])
    );

    assert.strictEqual(food.status, 200, JSON.stringify(food.body));
    assert.strictEqual(drink.status, 200, JSON.stringify(drink.body));
    assert.ok(await settled(kitchen), 'the kitchen printer was never handed anything');
    assert.ok(await settled(bar), 'the bar printer was never handed anything');

    assert.match(paper(kitchen), /Tibs/);
    assert.match(paper(bar), /Habesha Beer/);
    // The half that matters: a cook handed the drinks has to work out which lines are theirs.
    assert.doesNotMatch(paper(kitchen), /Habesha/);
    assert.doesNotMatch(paper(bar), /Tibs/);
    assert.match(paper(bar), /cold/, 'the note did not reach the person making it');
    assert.doesNotMatch(paper(kitchen), /260/, 'a production ticket should carry no prices');
  });

  test('paper width is per station, so a bar can run 58 mm', async () => {
    assert.ok(await settled(kitchen), 'no kitchen ticket to measure');
    assert.ok(await settled(bar), 'no bar ticket to measure');

    assert.ok(widestLine(bar) <= 32, `bar wrapped at ${widestLine(bar)}, expected 32 or less`);
    assert.ok(widestLine(kitchen) > 32, `kitchen wrapped at ${widestLine(kitchen)}, expected wider than 32`);
  });

  test('an unknown station prints somewhere rather than nowhere', async () => {
    register.reset();
    await bridge.post('/ticket', ticket('bat', 'j-typo', [{ name: 'Shiro', quantity: 1 }]));

    assert.ok(await settled(register), 'a mistyped station printed nowhere at all');
    assert.match(paper(register), /Shiro/);
    assert.match(bridge.log(), /unknown station/);
  });

  test('a retry does not put the same food on twice', async () => {
    const before = kitchen.streams.length;
    await bridge.post('/ticket', ticket('kitchen', 'j-kitchen', [{ name: 'Tibs', quantity: 1 }]));

    assert.ok(await stayedEmpty({ streams: kitchen.streams.slice(before) }));
    assert.strictEqual(kitchen.streams.length, before, 'the duplicate jobId printed again');
  });

  test('a receipt reaches the register with its fiscal fields', async () => {
    register.reset();
    const res = await bridge.post('/print', { ...RECEIPT, jobId: 'j-receipt' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(await settled(register), 'the receipt never reached the printer');

    const slip = paper(register);
    assert.match(slip, /0012345678/, 'no taxpayer number on a fiscal document');
    assert.match(slip, /Bole/, 'no premises on a fiscal document');
    assert.match(slip, /39/, 'no VAT line');
    assert.match(slip, /299/, 'no total');
    // Printed in capitals, as a receipt header is.
    assert.match(slip.toUpperCase(), /TEST KITCHEN/);
  });

  test('the bridge will not print for a stranger', async () => {
    const noKey = await bridge.post('/ticket', ticket('bar', 'j-nokey', [{ name: 'Beer', quantity: 1 }]), null);
    const wrongKey = await bridge.post('/ticket', ticket('bar', 'j-wrong', [{ name: 'Beer', quantity: 1 }]), 'not-the-key');

    assert.strictEqual(noKey.status, 401);
    assert.strictEqual(wrongKey.status, 401);
  });

  test('a malformed job is refused by name, not swallowed', async () => {
    const bad = await bridge.post('/ticket', ticket('bar', 'j-bad', []));

    assert.strictEqual(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /items/, 'the answer did not say which field was wrong');
  });

  test('a whole order reaches three rooms at once, and each sees only its own', async () => {
    register.reset();
    kitchen.reset();
    bar.reset();

    // One order approved: the till has already grouped it, and the three tickets go out together
    // rather than in a tidy sequence. Sent concurrently on purpose — a routing table that is read
    // and mutated per request would cross the streams here and nowhere else.
    await Promise.all([
      bridge.post('/ticket', ticket('kitchen', 'three-food', [{ name: 'Tibs', quantity: 1 }])),
      bridge.post('/ticket', ticket('bar', 'three-drink', [{ name: 'Habesha Beer', quantity: 2 }])),
      bridge.post('/ticket', ticket(null, 'three-till', [{ name: 'Service Note', quantity: 1 }]))
    ]);

    assert.ok(await settled(kitchen), 'the kitchen got nothing');
    assert.ok(await settled(bar), 'the bar got nothing');
    assert.ok(await settled(register), 'the till got nothing');

    assert.match(paper(kitchen), /Tibs/);
    assert.match(paper(bar), /Habesha Beer/);
    assert.match(paper(register), /Service Note/);

    // Each room sees its own line and neither of the other two.
    assert.doesNotMatch(paper(kitchen), /Habesha|Service Note/);
    assert.doesNotMatch(paper(bar), /Tibs|Service Note/);
    assert.doesNotMatch(paper(register), /Tibs|Habesha/);
  });
});

/**
 * Three rooms, and the bar's printer is off.
 *
 * The till already treats stations independently and says why: "a bar printer that is off must not
 * stop the kitchen getting its food." That promise was only ever kept on the till's side of the
 * wire. This is the other side — the bridge refusing one station has to be a refusal of that
 * station and nothing else, or one unplugged cable in a corner stops dinner.
 */
describe('three rooms, with the bar printer switched off', () => {
  let register, kitchen, bar, bridge;

  before(async () => {
    [register, kitchen, bar] = await Promise.all([fakePrinter(), fakePrinter(), fakePrinter()]);
    bridge = await startBridge({
      PRINT_SHARED_SECRET: KEY,
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(register.port),
      PRINTERS: `kitchen=127.0.0.1:${kitchen.port},bar=127.0.0.1:${bar.port}`
    });

    // Unplugged after the bridge has its configuration, which is how it happens in a restaurant:
    // the address is still configured, there is simply nothing answering at it.
    await bar.close();
  });

  after(async () => {
    await bridge?.stop();
    await Promise.all([register?.close(), kitchen?.close()]);
  });

  test('the bar ticket fails, and says so rather than claiming success', async () => {
    const res = await bridge.post('/ticket', ticket('bar', 'off-drink', [{ name: 'Beer', quantity: 1 }]));

    assert.strictEqual(res.status, 502, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, false);
  });

  test('the kitchen still gets its food', async () => {
    kitchen.reset();
    const res = await bridge.post('/ticket', ticket('kitchen', 'off-food', [{ name: 'Tibs', quantity: 1 }]));

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(await settled(kitchen), 'a dead bar printer stopped the kitchen');
    assert.match(paper(kitchen), /Tibs/);
  });

  test('the receipt still prints at the till', async () => {
    register.reset();
    const res = await bridge.post('/print', { ...RECEIPT, jobId: 'off-receipt' });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(await settled(register), 'a dead bar printer stopped the receipt');
    assert.match(paper(register), /0012345678/);
  });

  /**
   * The failed ticket must not be remembered as printed. Dedup is keyed on jobId and skips anything
   * it has seen, so marking a refusal would mean the retry after the printer is switched back on is
   * silently dropped and the drink is never made.
   */
  test('a failed ticket can be retried once the printer is back', async () => {
    const revived = await fakePrinter();
    // It cannot come back on the same port, so this asserts the dedup window rather than the wire:
    // the same jobId must still be accepted, not skipped as already printed.
    const res = await bridge.post('/ticket', ticket('bar', 'off-drink', [{ name: 'Beer', quantity: 1 }]));

    assert.notStrictEqual(
      res.body.message,
      'duplicate, already printed',
      'the failed ticket was remembered as printed, so the retry was dropped'
    );
    await revived.close();
  });
});

describe('a box nobody finished setting up', () => {
  let bridge;

  before(async () => {
    bridge = await startBridge({ PRINT_SHARED_SECRET: KEY });
  });

  after(async () => {
    await bridge?.stop();
  });

  /**
   * With no printer named, the bridge used to assume 127.0.0.1 — itself, inside its own container —
   * and every receipt failed as a refused socket, which reads as a dead printer rather than an
   * install that was never finished. Named stations stay optional; the register's own printer is
   * not, because a receipt is a fiscal document with nowhere else to go.
   */
  test('says so, rather than guessing at a printer', async () => {
    const health = await bridge.health();

    assert.strictEqual(health.status, 'unconfigured');
    assert.strictEqual(health.registerConfigured, false);
    assert.match(bridge.log(), /No register printer configured/);
  });
});

describe('PRINTER_IP, the name the other deployment uses', () => {
  let register, bridge;

  before(async () => {
    register = await fakePrinter();
    bridge = await startBridge({
      PRINT_SHARED_SECRET: KEY,
      PRINTER_IP: '127.0.0.1',
      PRINTER_PORT: String(register.port)
    });
  });

  after(async () => {
    await bridge?.stop();
    await register?.close();
  });

  /**
   * The box's .env spells this PRINTER_IP and compose remaps it to PRINTER_HOST, which is the name
   * the bridge reads. An .env passed through directly, or a compose file edited without the mapping,
   * has to work — under the old behaviour it silently configured nothing and every receipt went to
   * the container itself.
   */
  test('is accepted where PRINTER_HOST would be, and actually prints', async () => {
    const health = await bridge.health();
    assert.strictEqual(health.registerConfigured, true);

    const res = await bridge.post('/print', { ...RECEIPT, jobId: 'j-alias' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));

    assert.ok(await settled(register), 'the alias was accepted but nothing was printed');
    assert.match(paper(register).toUpperCase(), /TEST KITCHEN/);
  });
});

/**
 * The ordinary upgrade: a till and a kitchen, and no bar.
 *
 * This is the shape most restaurants reach first, and it is not the three-printer case with one
 * removed. Drinks have nowhere of their own to go, so they land at the till beside the person
 * pouring them — and the receipt lands there too, on the same printer, at a different moment. What
 * has to hold is that the kitchen sees the food and nothing else: no drinks, no prices, and never a
 * receipt.
 */
describe('a till and a kitchen, with no bar', () => {
  let register, kitchen, bridge;

  before(async () => {
    [register, kitchen] = await Promise.all([fakePrinter(), fakePrinter()]);
    bridge = await startBridge({
      PRINT_SHARED_SECRET: KEY,
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(register.port),
      PRINTERS: `kitchen=127.0.0.1:${kitchen.port}`
    });
  });

  after(async () => {
    await bridge?.stop();
    await Promise.all([register?.close(), kitchen?.close()]);
  });

  test('health reports the one station it has', async () => {
    const health = await bridge.health();

    assert.strictEqual(health.registerConfigured, true);
    assert.deepStrictEqual(Object.keys(health.stations), ['kitchen']);
  });

  test('food goes to the kitchen and drinks stay at the till', async () => {
    register.reset();
    kitchen.reset();

    // What approving one order does: the split has already happened in the till, and each group
    // arrives as its own ticket. Untagged is the drinks group, because no category named a bar.
    await bridge.post('/ticket', ticket('kitchen', 'two-food', [{ name: 'Tibs', quantity: 1 }]));
    await bridge.post('/ticket', ticket(null, 'two-drinks', [{ name: 'Habesha Beer', quantity: 2 }]));

    assert.ok(await settled(kitchen), 'the kitchen was never handed the food');
    assert.ok(await settled(register), 'the till was never handed the drinks');

    assert.match(paper(kitchen), /Tibs/);
    assert.doesNotMatch(paper(kitchen), /Habesha/, 'the cook was handed the drinks');
    assert.match(paper(register), /Habesha Beer/);
    assert.doesNotMatch(paper(register), /Tibs/, 'the food was listed at the till as well');
  });

  /**
   * A category tagged for a room the box does not have — someone set up Drinks for a bar that was
   * never installed, or the bar printer was taken out and nobody untagged it. The drinks must still
   * be made, so the ticket goes to the till and the log says why.
   */
  test('a station the box does not have falls back to the till', async () => {
    register.reset();
    const before = kitchen.streams.length;

    await bridge.post('/ticket', ticket('bar', 'two-nobar', [{ name: 'Wine', quantity: 1 }]));

    assert.ok(await settled(register), 'a ticket for a missing station printed nowhere');
    assert.match(paper(register), /Wine/);
    assert.match(bridge.log(), /unknown station "bar"/);
    assert.strictEqual(kitchen.streams.length, before, 'it went to the kitchen instead');
  });

  test('the receipt prints at the till, never in the kitchen', async () => {
    register.reset();
    const before = kitchen.streams.length;

    const res = await bridge.post('/print', { ...RECEIPT, jobId: 'two-receipt' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(await settled(register), 'the receipt never printed');

    const slip = paper(register);
    assert.match(slip, /0012345678/);
    assert.match(slip, /299/);
    // The whole point of the split: the kitchen is not where money is handled.
    assert.strictEqual(kitchen.streams.length, before, 'a fiscal receipt printed in the kitchen');
  });

  test('the kitchen is never shown a price, across everything it was sent', async () => {
    const everything = paper(kitchen);

    assert.match(everything, /Tibs/, 'nothing reached the kitchen at all, so this proves nothing');
    assert.doesNotMatch(everything, /260|299|TIN|VAT/);
  });
});

/**
 * The test slip, which is the route somebody reaches for before this bridge has ever seen a sale.
 *
 * It is the first thing a new install runs and the only thing a printer manufacturer checking their
 * model against this bridge runs, so its failures are the expensive kind: they are read as "this
 * printer is not supported" by someone with no reason to look further. What is asserted here is
 * what that person would hold — a slip that names the printer it went to, and a ruler that measures
 * the paper it was laid out for.
 */
describe('the test slip', () => {
  let register, narrow, bridge;

  before(async () => {
    [register, narrow] = await Promise.all([fakePrinter(), fakePrinter()]);
    bridge = await startBridge({
      PRINT_SHARED_SECRET: KEY,
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(register.port),
      // 58 mm paper, as a named station, so both widths are exercised on one box.
      PRINTERS: `counter=127.0.0.1:${narrow.port}:32`
    });
  });

  after(async () => {
    await bridge.stop();
    await Promise.all([register.close(), narrow.close()]);
  });

  test('prints with no payload at all, and says where it went', async () => {
    register.reset();
    const res = await bridge.post('/test-print', {});

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.station, 'default');
    assert.equal(res.body.target, `127.0.0.1:${register.port}`);
    assert.ok(await settled(register), 'nothing reached the printer');

    const slip = paper(register);
    assert.match(slip, /TEST PRINT/);
    // The address is on the paper as well as in the response: on a site with several printers the
    // slip is found in a room, and the room is the thing in doubt.
    assert.match(slip, new RegExp(String(register.port)));
    // No sale anywhere on it. This is the whole reason the route exists.
    assert.doesNotMatch(slip, /\bTIN\b|\bVAT\b|\bTotal\b/i);
  });

  test('the ruler measures the paper it was laid out for', async () => {
    register.reset();
    await bridge.post('/test-print', {});
    assert.ok(await settled(register));

    // 80 mm paper: 48 columns, and the ruler is exactly that so a wrap on real paper means the
    // width is wrong rather than the line being long.
    assert.equal(widestLine(register), 48);
    assert.match(paper(register), /\.\.\.\.5.*45/);

    // Every fixed line fits the narrowest paper this slip can be sent to, so the same copy does not
    // wrap on 58 mm. Asserted on the wide printer too, because that is where the copy is edited.
    const longest = Math.max(
      ...paper(register)
        .split(/[\r\n]/)
        .filter((l) => !/^-+$/.test(l.trim()) && !/^\.*\d/.test(l.trim()))
        .map((l) => l.trimEnd().length)
    );
    assert.ok(longest <= 32, `a fixed line is ${longest} columns and will wrap on 58 mm paper`);
  });

  test('a named station is tested on its own printer, at its own width', async () => {
    narrow.reset();
    register.reset();

    const res = await bridge.post('/test-print', { station: 'counter' });

    assert.equal(res.status, 200);
    assert.equal(res.body.station, 'counter');
    assert.equal(res.body.width, 32);
    assert.ok(await settled(narrow), 'the named station printed nothing');
    assert.equal(widestLine(narrow), 32, '58 mm paper was given an 80 mm layout');
    assert.ok(await stayedEmpty(register), 'the register printed a slip meant for the counter');
  });

  test('the QR is drawn by the printer, and says what it should scan to', async () => {
    register.reset();
    const res = await bridge.post('/test-print', {});
    assert.ok(await settled(register));

    // Asserted on the raw stream, not on paper(): the QR is control bytes, and the helper that
    // makes a slip readable is the same helper that would strip the thing under test.
    const raw = Buffer.concat(register.streams).toString('latin1');

    // The five GS ( k commands, in the order a printer executes them: model, module size, error
    // correction, store, print. A printer sent only the first four draws nothing.
    assert.equal((raw.match(/\x1d\(k/g) || []).length, 5, 'the QR command block is incomplete');
    assert.match(raw, /\x1d\(k\x03\x00\x31\x51\x30/, 'the code was stored but never printed');

    // The payload is stored in the code and printed beneath it, so whoever scans it can check the
    // result against what the paper says it should be rather than trusting that any output is right.
    assert.ok(raw.includes('1P0' + res.body.qrPayload), 'the QR payload was not stored');
    assert.ok(
      paper(register).includes(res.body.qrPayload),
      'the payload is in the code but not printed beneath it, so a scan cannot be checked'
    );

    // ASCII only. qrLines falls back to a text line for anything above 0x7F, because transliteration
    // on the way to the buffer would alter the bytes inside the code and it would scan to the wrong
    // thing — a silent fault on a fiscal receipt, and one worth never shipping a test slip that hides.
    assert.doesNotMatch(res.body.qrPayload, /[^\x20-\x7E]/);
  });

  test('two presses print two slips', async () => {
    register.reset();
    await bridge.post('/test-print', {});
    await bridge.post('/test-print', {});

    // Receipts and tickets are deduplicated so a till's retry cannot cook the food twice. Somebody
    // stood at a printer pressing this means it every time, and a second press that silently
    // printed nothing would read as the printer having died.
    assert.ok(await settled(register, 2), 'the second test print was swallowed');
  });

  test('a dead printer answers with the address it could not reach', async () => {
    const off = await fakePrinter();
    const port = off.port;
    await off.close();

    const alone = await startBridge({
      PRINT_SHARED_SECRET: KEY,
      PRINTER_HOST: '127.0.0.1',
      PRINTER_PORT: String(port),
      PRINTER_TIMEOUT_MS: '1000'
    });

    try {
      const res = await alone.post('/test-print', {});
      assert.equal(res.status, 502);
      assert.equal(res.body.success, false);
      // Half of these are a printer that is off or has moved, so the address is the answer and
      // belongs in the failure rather than only in the log.
      assert.match(res.body.error, new RegExp(String(port)));
    } finally {
      await alone.stop();
    }
  });

  test('it still needs the key, because it uses the paper', async () => {
    const res = await bridge.post('/test-print', {}, null);
    assert.equal(res.status, 401);
  });
});
