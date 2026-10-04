const net = require('net');
const fs  = require('fs');

/**
 * Finding the till's printer when nobody has said where it is.
 *
 * A box should print out of the box. Until this, a USB printer needed PRINTER_DEVICE typed into .env
 * and a network one needed PRINTER_IP, and with neither every receipt went to 127.0.0.1 and failed
 * as a "dead printer" on a box nobody had finished setting up. Both can be found instead:
 *
 *   USB      — a usblp node under /dev/usb. compose mounts the directory, so a printer plugged in
 *              after the bridge started is seen too, and so is lp0 becoming lp1 after a replug.
 *   Network  — Ethernet and Wi-Fi printers are the same thing here: raw ESC/POS on TCP 9100. The
 *              box's own LAN (BOX_LAN_ADDRESS, the /24 it is on) is probed for that port.
 *
 * The network guess is taken only when it is unambiguous. A hotel has a printer in the kitchen and
 * one at the bar on the same network, and a fiscal receipt printed in the kitchen is worse than one
 * that asks for PRINTER_IP — so with more than one answer, none is chosen and the error names them.
 */

const USB_DIR = process.env.PRINTER_USB_DIR || '/dev/usb';
// This box's address on the restaurant's network, from easymaz-box.service via compose.
const LAN_ADDRESS = process.env.BOX_LAN_ADDRESS;

/** usblp nodes present now, lowest number first. */
function usbNodes(dir = USB_DIR) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter(n => /^lp\d+$/.test(n))
        .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
        .map(n => `${dir}/${n}`);
}

/** The first USB printer plugged in, or null. */
function findUsbNode(dir = USB_DIR) {
    return usbNodes(dir)[0] || null;
}

/** "192.168.1" from "192.168.1.20", or null when the address is not a plain IPv4 one. */
function lanPrefix(address) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address || '').trim());
    if (!m || m.slice(1).some(o => Number(o) > 255)) return null;
    return `${m[1]}.${m[2]}.${m[3]}`;
}

/** Whether something accepts a connection on host:port within the timeout. */
function probe(host, port, timeoutMs) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}

/**
 * Every host on prefix.1–254 answering on port, in address order. Bounded concurrency so a scan is
 * a couple of seconds on a quiet LAN rather than 254 sockets at once on a small router.
 */
async function scan(prefix, port, { timeoutMs = 400, concurrency = 64, exclude = [], probeFn = probe } = {}) {
    const hosts = [];
    for (let i = 1; i <= 254; i++) {
        const host = `${prefix}.${i}`;
        if (!exclude.includes(host)) hosts.push(host);
    }
    const found = [];
    let next = 0;
    async function worker() {
        while (next < hosts.length) {
            const host = hosts[next++];
            if (await probeFn(host, port, timeoutMs)) found.push(host);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    return found.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]));
}

// The last answer, so a receipt does not wait on a scan. Forgotten when a print to it fails — a
// printer that took a new DHCP lease is found again on the next receipt.
const FRESH_MS = 10 * 60 * 1000;
// Not finding one is remembered only briefly: a printer switched on after the box came up should be
// found by the next receipt but one, and a burst of receipts should not each wait on a scan.
const MISS_MS = 30 * 1000;
let cache = { at: 0, host: null, candidates: [] };
let inFlight = null;

/**
 * The single network printer on the box's LAN, or null.
 *
 * Resolves to { host, candidates }: host when exactly one device answers, candidates always, so the
 * caller can say "several answered" rather than "none did".
 */
async function networkPrinter({ port = 9100, lanAddress = LAN_ADDRESS, force = false, scanFn = scan } = {}) {
    const prefix = lanPrefix(lanAddress);
    if (!prefix) return { host: null, candidates: [], noLan: true };
    if (!force && cache.at && Date.now() - cache.at < (cache.host ? FRESH_MS : MISS_MS)) {
        return { host: cache.host, candidates: cache.candidates };
    }
    if (!inFlight) {
        inFlight = scanFn(prefix, port, { exclude: [String(lanAddress).trim()] })
            .then(found => {
                cache = { at: Date.now(), host: found.length === 1 ? found[0] : null, candidates: found };
                if (found.length === 1) console.log(`[printer] found a network printer at ${found[0]}:${port}`);
                else if (found.length > 1) console.warn(`[printer] several devices answer on port ${port}: ${found.join(', ')} — set PRINTER_IP to the till's`);
                return cache;
            })
            .finally(() => { inFlight = null; });
    }
    const result = await inFlight;
    return { host: result.host, candidates: result.candidates };
}

/** What the last scan found, without scanning. */
function cachedNetworkPrinter() {
    return { host: cache.host, candidates: cache.candidates, at: cache.at };
}

/** Forget the network answer, after a print to it failed. */
function forgetNetworkPrinter() {
    cache = { at: 0, host: null, candidates: [] };
}

module.exports = {
    usbNodes,
    findUsbNode,
    lanPrefix,
    probe,
    scan,
    networkPrinter,
    cachedNetworkPrinter,
    forgetNetworkPrinter
};
