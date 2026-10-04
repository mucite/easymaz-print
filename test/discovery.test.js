const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

/**
 * A printer that works out of the box.
 *
 * Nothing in .env is the ordinary first state of a box, and it used to mean every receipt went to
 * 127.0.0.1 and failed. A USB printer plugged in, or a single printer on the box's network, is found
 * instead — and two printers on the network are never guessed between, because a fiscal receipt
 * printed in the kitchen is worse than one that asks where the till's printer is.
 */

const DISCOVERY = path.join(__dirname, '..', 'src', 'discovery.js');
const PRINTER = path.join(__dirname, '..', 'src', 'printer.js');

const PRINTER_ENV = ['PRINTER_CMD', 'PRINTER_DEVICE', 'PRINTER_HOST', 'PRINTER_IP', 'PRINTER_PORT',
  'PRINTER_USB_DIR', 'BOX_LAN_ADDRESS', 'PRINTERS'];

/** printer.js and discovery.js loaded fresh under the given environment, then the environment put back. */
function freshWith(env) {
  const saved = {};
  for (const k of PRINTER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  delete require.cache[require.resolve(DISCOVERY)];
  delete require.cache[require.resolve(PRINTER)];
  const printer = require(PRINTER);
  const discovery = require(DISCOVERY);
  for (const k of PRINTER_ENV) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return { printer, discovery };
}

function usbDir(...nodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-'));
  for (const n of nodes) fs.writeFileSync(path.join(dir, n), '');
  return dir;
}

const RECEIPT = {
  restaurantName: 'Test', items: [{ name: 'Tea', quantity: 1, price: 10 }], total: 10
};

test('the lowest-numbered USB printer is found, and nothing else under /dev/usb', () => {
  const { discovery } = freshWith({});
  const dir = usbDir('lp10', 'lp1', 'hiddev0', 'lp2');
  assert.deepStrictEqual(discovery.usbNodes(dir), [`${dir}/lp1`, `${dir}/lp2`, `${dir}/lp10`]);
  assert.strictEqual(discovery.findUsbNode(dir), `${dir}/lp1`);
  assert.strictEqual(discovery.findUsbNode(path.join(dir, 'missing')), null);
});

test('the LAN to search is the /24 the box is on', () => {
  const { discovery } = freshWith({});
  assert.strictEqual(discovery.lanPrefix('192.168.1.20'), '192.168.1');
  assert.strictEqual(discovery.lanPrefix(' 10.0.5.7 '), '10.0.5');
  assert.strictEqual(discovery.lanPrefix(''), null);
  assert.strictEqual(discovery.lanPrefix('300.1.1.1'), null);
  assert.strictEqual(discovery.lanPrefix('box.local'), null);
});

test('a scan covers the /24, skips the box itself, and returns what answered in order', async () => {
  const { discovery } = freshWith({});
  const asked = [];
  const found = await discovery.scan('10.0.0', 9100, {
    exclude: ['10.0.0.5'],
    probeFn: async (host) => { asked.push(host); return host === '10.0.0.200' || host === '10.0.0.30'; }
  });
  assert.deepStrictEqual(found, ['10.0.0.30', '10.0.0.200']);
  assert.strictEqual(asked.length, 253);
  assert.ok(!asked.includes('10.0.0.5'));
});

test('one network printer is chosen; several are not guessed between', async () => {
  const { discovery } = freshWith({});
  const one = await discovery.networkPrinter({ lanAddress: '10.0.0.5', force: true, scanFn: async () => ['10.0.0.30'] });
  assert.strictEqual(one.host, '10.0.0.30');

  const two = await discovery.networkPrinter({ lanAddress: '10.0.0.5', force: true, scanFn: async () => ['10.0.0.30', '10.0.0.31'] });
  assert.strictEqual(two.host, null);
  assert.deepStrictEqual(two.candidates, ['10.0.0.30', '10.0.0.31']);

  const noLan = await discovery.networkPrinter({ lanAddress: '', force: true, scanFn: async () => { throw new Error('must not scan'); } });
  assert.strictEqual(noLan.noLan, true);
});

test('with nothing configured, a receipt prints to the USB printer that is plugged in', async () => {
  const dir = usbDir('lp0');
  const { printer } = freshWith({ PRINTER_USB_DIR: dir });
  assert.strictEqual(printer.registerConfigured(), true);
  assert.deepStrictEqual(printer.defaultPrinterStatus(), { mode: 'usb', device: `${dir}/lp0`, present: true, auto: true });

  await printer.printReceipt(RECEIPT);
  assert.ok(fs.statSync(`${dir}/lp0`).size > 0, 'the receipt bytes reached the device');
});

test('a configured USB device that was renumbered prints to the one that is there', async () => {
  const dir = usbDir('lp1');
  const { printer } = freshWith({ PRINTER_USB_DIR: dir, PRINTER_DEVICE: `${dir}/lp0` });
  await printer.printReceipt(RECEIPT);
  assert.ok(fs.statSync(`${dir}/lp1`).size > 0);
  assert.ok(!fs.existsSync(`${dir}/lp0`), 'nothing was created at the old path');
});

test('with nothing configured and no USB, a single network printer is found and printed to', async () => {
  // A real socket on loopback stands in for the printer: BOX_LAN_ADDRESS puts the box on 127.0.0.x,
  // so the scan reaches 127.0.0.1, where it listens.
  const received = [];
  const server = net.createServer(sock => sock.on('data', d => received.push(d)));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const { printer } = freshWith({
      PRINTER_USB_DIR: usbDir(), BOX_LAN_ADDRESS: '127.0.0.250', PRINTER_PORT: String(port)
    });
    await printer.printReceipt(RECEIPT);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(Buffer.concat(received).length > 0, 'the receipt bytes reached the network printer');
    assert.match(printer.defaultPrinterStatus().address, new RegExp(`^127\\.0\\.0\\.1:${port}$`));
  } finally {
    server.close();
  }
});

test('with nothing configured and nothing found, the error says what to do instead of naming 127.0.0.1', async () => {
  const { printer } = freshWith({ PRINTER_USB_DIR: usbDir() });
  assert.strictEqual(printer.registerConfigured(), false);
  await assert.rejects(printer.printReceipt(RECEIPT), (err) => {
    assert.match(err.message, /No printer found/);
    assert.doesNotMatch(err.message, /127\.0\.0\.1/);
    return true;
  });
});

test('a configured address still wins over a USB printer that is plugged in', async () => {
  const dir = usbDir('lp0');
  const { printer } = freshWith({ PRINTER_USB_DIR: dir, PRINTER_IP: '192.0.2.10' });
  const t = await printer.defaultTransport();
  assert.deepStrictEqual(t, { mode: 'tcp', host: '192.0.2.10', port: 9100, auto: false });
});
