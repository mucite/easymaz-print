#!/usr/bin/env node
/**
 * Prints the test slip straight at a printer, with the bridge not running.
 *
 * The /test-print route answers the same question, and needs the bridge started, an address
 * configured and a shared secret set first. Somebody who has just unboxed a printer wants to know
 * whether it prints before any of that, and if it does not, wants the fault to be the printer's
 * rather than one of four things it could equally have been.
 *
 * Usage:
 *   node scripts/test-print.js 192.168.1.50          network printer, port 9100
 *   node scripts/test-print.js 192.168.1.50:9100     the same, said in full
 *   node scripts/test-print.js --usb                 USB, via libusb
 *
 *   --width 32        columns at Font A. 48 for 80 mm paper, 32 for 58 mm. Default 48.
 *   --cut partial     for a printer that implements only partial cuts
 *   --codepage cp850  the table to select with ESC t. Default cp437.
 *   --stdin           send bytes read from stdin instead of the test slip, which is what makes
 *                     this usable as the bridge's PRINTER_CMD on a machine that needs one
 *
 * Ethernet and Wi-Fi are the same thing here: both are a socket on port 9100, and only how the
 * printer got its address differs.
 */
const { testPageBuffer, printViaTcp } = require('../src/printer');

const PRINTER_CLASS = 0x07;

function parseArgs(argv) {
    const opts = { usb: false, stdin: false, width: 48, cut: 'full', codepage: 'cp437' };
    const rest = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--usb') opts.usb = true;
        else if (arg === '--stdin') opts.stdin = true;
        else if (arg === '--width') opts.width = Number(argv[++i]);
        else if (arg === '--cut') opts.cut = argv[++i];
        else if (arg === '--codepage') opts.codepage = argv[++i];
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        else rest.push(arg);
    }

    if (rest.length > 1) throw new Error('give one address, or --usb');
    if (rest.length === 1) {
        const [host, port] = rest[0].split(':');
        opts.host = host;
        opts.port = Number(port) || 9100;
    }

    if (!opts.usb && !opts.host) throw new Error('give a printer address, or --usb');
    if (opts.usb && opts.host) throw new Error('a printer is either on the network or on USB');
    if (!Number.isInteger(opts.width) || opts.width < 20 || opts.width > 96) {
        throw new Error('--width must be between 20 and 96');
    }

    return opts;
}

/**
 * Sends bytes to a USB printer-class device.
 *
 * libusb rather than a print queue, because on macOS there is no other way left: raw CUPS queues
 * were removed — `lpadmin -m raw` answers "Raw queues are no longer supported on macOS" — and macOS
 * has never had a /dev/usb/lp0 to write to. Linux has both and does not need this, but one path
 * that works everywhere beats two that each work somewhere.
 *
 * The dependency is optional and loaded only here, so a bridge that talks to a network printer —
 * which is every deployment — never installs a native module to do it.
 */
async function sendUsb(buffer) {
    let usb;
    try {
        ({ usb } = require('usb'));
    } catch {
        throw new Error(
            "USB support needs the 'usb' package, which is a dev dependency: run `npm install` " +
            '(not `npm ci --omit=dev`) and try again. A network printer needs none of this.'
        );
    }

    const devices = await usb.getDevices();
    let device, ifaceNumber, endpointNumber;

    for (const candidate of devices) {
        await candidate.open();
        if (!candidate.configuration) await candidate.selectConfiguration(1);

        for (const iface of candidate.configuration.interfaces) {
            for (const alt of iface.alternates) {
                if (alt.interfaceClass !== PRINTER_CLASS) continue;
                const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
                if (!out) continue;
                device = candidate;
                ifaceNumber = iface.interfaceNumber;
                endpointNumber = out.endpointNumber;
            }
        }

        if (device === candidate) break;
        await candidate.close();
    }

    if (!device) {
        throw new Error('no USB printer found: no device offering a printer-class bulk endpoint');
    }

    await device.claimInterface(ifaceNumber);
    try {
        const result = await device.transferOut(endpointNumber, buffer);
        if (result.status !== 'ok') throw new Error(`USB write status: ${result.status}`);
    } finally {
        await device.releaseInterface(ifaceNumber).catch(() => {});
        await device.close().catch(() => {});
    }

    return `USB ${device.productName || 'printer'}`;
}

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
        process.stdin.on('error', reject);
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.help) {
        console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }

    const target = {
        host: opts.host,
        port: opts.port,
        width: opts.width,
        cut: opts.cut === 'partial' ? 'partial' : 'full',
        codepage: opts.codepage,
        name: 'default'
    };

    const where = opts.usb ? 'usb' : `${opts.host}:${opts.port}`;

    // The same builder the bridge uses, so what this proves is what the bridge sends.
    const { info, buffer } = opts.stdin
        ? { info: null, buffer: await readStdin() }
        : testPageBuffer(target, opts.usb ? 'usb' : 'tcp', where);

    const sentTo = opts.usb ? await sendUsb(buffer) : (await printViaTcp(buffer, target), where);

    if (opts.stdin) {
        console.error(`[test-print] ${buffer.length} bytes to ${sentTo}`);
        return;
    }

    console.log(`[test-print] ${buffer.length} bytes to ${sentTo}`);
    console.log(`[test-print] ${info.width} columns, ${info.codepage}, ${info.cut} cut`);
    console.log(`[test-print] the QR should scan to exactly: ${info.qrPayload}`);
}

main().catch((err) => {
    console.error(`[test-print] ${err.message}`);
    process.exit(1);
});
