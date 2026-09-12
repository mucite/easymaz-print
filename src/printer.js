const net    = require('net');
const fs     = require('fs');
const { spawn } = require('child_process');
const { codePageByte, toPrintable } = require('./charset');

// Mac/Linux CUPS:  PRINTER_CMD=lp -d "TM-T88V" -o raw -
// Linux pipe:      PRINTER_CMD=cat > /dev/usb/lp0   (alternative to PRINTER_DEVICE)
const PRINTER_CMD       = process.env.PRINTER_CMD;

// Linux/Windows raw device file: /dev/usb/lp0  or  \\.\USB001
const PRINTER_DEVICE    = process.env.PRINTER_DEVICE;

// Network printer (TCP port 9100)
const PRINTER_HOST      = process.env.PRINTER_HOST || '127.0.0.1';
const PRINTER_PORT      = Number(process.env.PRINTER_PORT) || 9100;

// Defaults for the single unnamed printer, and the fallback for any station that does not say.
// 48 columns is 80 mm paper; 32 is 58 mm. cp437 is the one table every ESC/POS printer has.
const DEFAULT_WIDTH     = Number(process.env.PRINTER_WIDTH) || 48;
const DEFAULT_CUT       = (process.env.PRINTER_CUT || 'full').toLowerCase() === 'partial' ? 'partial' : 'full';
// PRINTER_ENCODING is read because it already exists: it is set to CP437 in the box's env template
// and passed through docker-compose, and nothing has ever read it. Somebody intended to configure
// the code page, and the bridge ignored them. PRINTER_CODEPAGE wins where both are set.
const DEFAULT_CODE_PAGE = process.env.PRINTER_CODEPAGE || process.env.PRINTER_ENCODING || 'cp437';

/**
 * Whether to fire the cash drawer at the end of a cash sale.
 *
 * On by default, because the drawer is wired into the printer's kick port on every till this is
 * installed on and nothing was ever sending the pulse — so the drawer simply never opened. A site
 * with no drawer sets this to off; a pulse to a port with nothing in it is harmless, but a
 * configurable is cheaper than explaining that.
 */
const CASH_DRAWER       = (process.env.CASH_DRAWER || 'on').toLowerCase() !== 'off';

/**
 * Named printers, for a site with more than one.
 *
 * A restaurant has one printer at the till and that is the whole story. A hotel does not: food
 * goes to the kitchen, drinks to the bar, a folio to reception, and a single destination means
 * somebody carries paper across the building all evening. That is the thing that stops this
 * being sold to a hotel — not the number of boxes.
 *
 * PRINTERS=kitchen=192.168.1.50:9100,bar=192.168.1.51,reception=192.168.1.52:9100
 *
 * A plain list rather than JSON because it is typed into an env file by whoever is standing at
 * the router, and JSON quoting inside an env file is a good way to lose an evening. The port is
 * optional and defaults to 9100, which is what every ESC/POS box on a LAN uses.
 *
 * Three more optional fields, so a site can mix printers without a code change — which is the whole
 * point of not tying this to one brand:
 *
 *   name=host:port:width:cut:codepage
 *   bar=192.168.1.51:9100:32:partial:cp437
 *
 * width    columns at Font A. 48 for 80 mm paper, 32 for 58 mm. Default 48.
 * cut      full or partial. Default full, because a printer that implements only one implements
 *          that one. Partial leaves a tab of paper joining the receipts.
 * codepage which 256-character table to select with ESC t. Default cp437, the only table every
 *          ESC/POS printer is guaranteed to have.
 *
 * Everything after the host is optional and positional, so existing PRINTERS values keep working
 * exactly as they did.
 */
function parseStations(spec) {
    const stations = {};
    if (!spec) return stations;

    for (const entry of spec.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;

        const eq = trimmed.indexOf('=');
        if (eq < 1) {
            console.warn(`[printer] ignoring malformed PRINTERS entry: ${trimmed}`);
            continue;
        }

        const name = trimmed.slice(0, eq).trim().toLowerCase();
        // Split on every colon rather than the last one. The old code took lastIndexOf(':') as the
        // port separator, which is correct for host:port and wrong the moment anything follows it.
        const parts = trimmed.slice(eq + 1).trim().split(':').map(part => part.trim());
        const host = parts[0];
        const port = parts[1] ? Number(parts[1]) : 9100;
        const width = parts[2] ? Number(parts[2]) : 48;
        const cut = parts[3] ? parts[3].toLowerCase() : 'full';
        const codepage = parts[4] || DEFAULT_CODE_PAGE;

        if (!host || !Number.isInteger(port) || port <= 0) {
            console.warn(`[printer] ignoring PRINTERS entry with no usable address: ${trimmed}`);
            continue;
        }
        if (!Number.isInteger(width) || width < 20 || width > 96) {
            console.warn(`[printer] ${name}: width "${parts[2]}" is not a column count — using 48`);
        }
        if (cut !== 'full' && cut !== 'partial') {
            console.warn(`[printer] ${name}: cut "${cut}" is not full or partial — using full`);
        }

        stations[name] = {
            host,
            port,
            width: Number.isInteger(width) && width >= 20 && width <= 96 ? width : 48,
            cut: cut === 'partial' ? 'partial' : 'full',
            codepage
        };
    }
    return stations;
}

const STATIONS = parseStations(process.env.PRINTERS);

/**
 * Where a ticket goes.
 *
 * An unknown station falls back to the default printer and says so, rather than refusing. A
 * ticket printed in the wrong room is confusing; a ticket that prints nowhere is an order the
 * kitchen never sees, and the default is the till printer where most tickets belong anyway.
 */
function defaultStation() {
    return {
        host: PRINTER_HOST,
        port: PRINTER_PORT,
        width: DEFAULT_WIDTH,
        cut: DEFAULT_CUT,
        codepage: DEFAULT_CODE_PAGE,
        name: 'default'
    };
}

function resolveStation(station) {
    if (!station) {
        return defaultStation();
    }
    const found = STATIONS[String(station).toLowerCase()];
    if (!found) {
        console.warn(
            `[printer] unknown station "${station}" — printing to the default instead. ` +
            `Configured: ${Object.keys(STATIONS).join(', ') || '(none)'}`
        );
        return defaultStation();
    }
    return { ...found, name: String(station).toLowerCase() };
}
const CONNECT_TIMEOUT_MS = Number(process.env.PRINTER_TIMEOUT_MS) || 5000;

/**
 * Build an ESC/POS data array from a PrintPayload object.
 * Options:
 *   lineWidth: chars per line (32, 42, 48...) default 32
 *   autoCut: whether to send cut command (GS V 1)
 *   feedLines: blank lines before cut
 */
function buildEscposData(receipt, opts = {}) {
    const ESC = '\x1B';
    const GS  = '\x1D';

    const LINE_WIDTH = opts.lineWidth || DEFAULT_WIDTH;
    const AUTO_CUT   = opts.autoCut !== undefined ? opts.autoCut : true;
    const FEED_LINES = opts.feedLines || 4;
    const CUT_STYLE  = opts.cut === 'partial' ? 'partial' : 'full';
    const CODE_PAGE  = codePageByte(opts.codepage);

    const lines = [];
    const fmt = (v) => Number(v || 0).toFixed(2);
    const repeat = (ch, n) => ch.repeat(Math.max(0, n));

    const wrapText = (text) => {
        const words = String(text || '').split(/\s+/);
        const res = [];
        let line = '';
        for (const word of words) {
            if (!word) continue;
            const test = (line ? line + ' ' + word : word);
            if (test.length > LINE_WIDTH) {
                if (line) res.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        if (line) res.push(line);
        return res;
    };

    const centerLines = (text) =>
        wrapText(text).map(l => l + "\n");

    const formatInfoLine = (label, value) => {
        const left = (label + " : ");
        // Zero is a value, not an absence: `value || ""` printed the line with the number
        // missing.
        const val = value === null || value === undefined ? "" : String(value);
        const spaces = Math.max(1, LINE_WIDTH - left.length - val.length);
        return left + " ".repeat(spaces) + val + "\n";
    };

    const QTY_W    = 5;
    const UPRICE_W = 8;
    const TOTAL_W  = 8;
    const NAME_W   = LINE_WIDTH - (QTY_W + UPRICE_W + TOTAL_W + 3);

    const itemHeader = () => {
        const n = "ITEM".padEnd(NAME_W);
        const q = "QTY".padStart(QTY_W);
        const u = "PRICE".padStart(UPRICE_W);
        const t = "TOTAL".padStart(TOTAL_W);
        return `${n} ${q} ${u} ${t}\n`;
    };

    const formatItemLines = (name, qty, price) => {
        const total = qty * price;

        const wrapped = wrapText(name);
        const primary = (wrapped[0] || "").slice(0, NAME_W);

        const n = primary.padEnd(NAME_W);
        const q = String(qty).padStart(QTY_W);
        const u = fmt(price).padStart(UPRICE_W);
        const t = fmt(total).padStart(TOTAL_W);

        const result = [];
        result.push(`${n} ${q} ${u} ${t}\n`);

        for (let i = 1; i < wrapped.length; i++) {
            result.push(wrapped[i].slice(0, LINE_WIDTH) + "\n");
        }

        return result;
    };

    const formatTotalLine = (label, amount) => {
        const l = String(label);
        const n = Number(amount);

        if (!Number.isFinite(n)) {
            return l + "\n";
        }

        const r = fmt(n);
        const spaces = Math.max(1, LINE_WIDTH - l.length - r.length);
        return l + " ".repeat(spaces) + r + "\n";
    };

    // ---------- TOTAL CALCULATIONS ----------
    const items = receipt.items || [];
    const computedSubtotal = items.reduce(
        (s, it) => s + (Number(it.quantity) * Number(it.price)),
        0
    );

    const subtotal = receipt.subtotal ?? computedSubtotal;

    const svcPct = Number(receipt.serviceChargePercentage || 0);
    const vatPct = Number(receipt.vatPercentage || 0);

    const serviceAmount = receipt.serviceCharge ?? (subtotal * svcPct / 100);
    const vatAmount     = receipt.vat ?? (subtotal * vatPct / 100);

    const convenienceFee =
        Number(receipt.convenienceFee || 0) +
        Number(receipt.roundingDifference || 0);

    const computedTotal =
        subtotal + serviceAmount + vatAmount + convenienceFee;

    const total = receipt.total ?? computedTotal;

    // ---------- PRINT START ----------
    lines.push(ESC + "@");          // initialize printer
    // Which 256-character table the printer should use. Nothing selected one before, so every brand
    // used whatever it powers on with and the same receipt printed different accented characters on
    // different printers — the actual reason this looked tied to one make of printer.
    lines.push(ESC + "t" + String.fromCharCode(CODE_PAGE));
    lines.push(ESC + "a" + "\x01"); // center align

    lines.push(ESC + "E" + "\x01");
    centerLines(String(receipt.businessName).toUpperCase()).forEach(l => lines.push(l));
    lines.push(ESC + "E" + "\x00");

    if (receipt.address) centerLines(receipt.address).forEach(l => lines.push(l));
    if (receipt.phone)   centerLines("TEL: " + receipt.phone).forEach(l => lines.push(l));

    lines.push("\n");

    // The taxpayer's four identifiers. Art 4(1) with Art 29(3)(c) asks for all of them
    // that the restaurant has, and until this printed only the first — which was itself
    // being fed the business licence number by the API — a receipt named the wrong number
    // under the right label and omitted the other three entirely.
    if (receipt.tin)                   centerLines("TIN: " + receipt.tin).forEach(l => lines.push(l));
    if (receipt.vatRegistrationNumber) centerLines("VAT No: " + receipt.vatRegistrationNumber).forEach(l => lines.push(l));
    if (receipt.fsNumber)              centerLines("FS No: " + receipt.fsNumber).forEach(l => lines.push(l));
    if (receipt.mrcNumber)             centerLines("MRC: " + receipt.mrcNumber).forEach(l => lines.push(l));

    lines.push("\n");
    lines.push(ESC + "a" + "\x00"); // left align

    if (receipt.fsNo)        lines.push(formatInfoLine("Invoice", receipt.fsNo));
    if (receipt.orderNumber) lines.push(formatInfoLine("Order", receipt.orderNumber));
    if (receipt.invoiceType) lines.push(formatInfoLine("Type", receipt.invoiceType));
    if (receipt.date)        lines.push(formatInfoLine("Date", receipt.date));
    // Presence, not truthiness: a table number is printed even when it is zero, which
    // `value || ""` would have dropped.
    if (receipt.table != null) lines.push(formatInfoLine("Table", receipt.table));
    if (receipt.cashier)     lines.push(formatInfoLine("Cashier", receipt.cashier));
    if (receipt.waiter)      lines.push(formatInfoLine("Waiter", receipt.waiter));

    lines.push(repeat("-", LINE_WIDTH) + "\n");

    lines.push(itemHeader());
    lines.push(repeat("-", LINE_WIDTH) + "\n");

    for (const it of items) {
        formatItemLines(it.name, it.quantity, it.price)
            .forEach(l => lines.push(l));
    }

    lines.push(repeat("-", LINE_WIDTH) + "\n");

    lines.push(formatTotalLine("SUBTOTAL", subtotal));

    if (serviceAmount) {
        const lbl = svcPct ? `SERVICE ${svcPct}%` : "SERVICE";
        lines.push(formatTotalLine(lbl, serviceAmount));
    }

    if (vatAmount) {
        const lbl = vatPct ? `TAX ${vatPct}%` : "TAX";
        lines.push(formatTotalLine(lbl, vatAmount));
    }

    if (convenienceFee) {
        lines.push(formatTotalLine("CONVENIENCE FEE", convenienceFee));
    }

    lines.push(repeat("-", LINE_WIDTH) + "\n");

    lines.push(ESC + 'E' + '\x01');
    lines.push(formatTotalLine("TOTAL", total));
    lines.push(ESC + 'E' + '\x00');

    lines.push("\n");

    let paymentLabel = receipt.paidByCash
        ? "CASH"
        : receipt.paymentMethod || "";

    if (paymentLabel) {
        if (receipt.isPaid === false) {
            lines.push(formatTotalLine(paymentLabel, "UNPAID"));
        } else {
            lines.push(formatTotalLine(paymentLabel, total));
        }
    }

    if (receipt.paymentStatus)
        lines.push(`Status: ${receipt.paymentStatus}\n`);

    // Art 4(3)(c): the IRN, the RRN and the QR the Authority issued for this sale — or, when it has
    // issued none yet, the fact that it has not. See fiscalLines.
    fiscalLines(receipt, centerLines, formatInfoLine).forEach(l => lines.push(l));

    lines.push("\n");
    lines.push(ESC + "a" + "\x01"); // center
    centerLines("Thank you!").forEach(l => lines.push(l));
    centerLines("Powered by EasyMaz").forEach(l => lines.push(l));

    lines.push("\n".repeat(FEED_LINES));

    if (AUTO_CUT) {
        // GS V 0 is a full cut, GS V 1 a partial one. This said "full cut" and sent 1, which is the
        // partial. Full is the default now because a printer that implements only one implements
        // that one, and a station can ask for partial if its paper tears badly.
        lines.push(GS + "V" + (CUT_STYLE === 'partial' ? "\x01" : "\x00"));
    }

    // The drawer, last, so the paper is already out when it opens.
    //
    // ESC p m t1 t2: pin 0, on for 25 ms, off for 250. Nothing in this bridge ever sent it, so a
    // cash drawer wired into the printer's kick port — which is where every one of these is wired —
    // simply never opened. Only for a cash sale that has actually been paid: a card sale has no
    // reason to open it, and an unpaid one is not finished.
    if (CASH_DRAWER && receipt.paidByCash && receipt.isPaid) {
        lines.push(ESC + "p" + "\x00" + "\x19" + "\xFA");
    }

    return lines;
}

// ---------- CUPS / shell command (Mac + Linux) ----------
function printViaCommand(rawBuffer) {
    return new Promise((resolve, reject) => {
        // Split on spaces but keep quoted strings intact
        const parts = PRINTER_CMD.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        const [cmd, ...args] = parts.map(p => p.replace(/^['"]|['"]$/g, ''));

        const proc = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });

        proc.on('error', (err) =>
            reject(new Error(`Print command failed: ${err.message}`))
        );
        proc.on('close', (code) => {
            code === 0
                ? resolve()
                : reject(new Error(`Print command exited with code ${code}`));
        });

        proc.stdin.write(rawBuffer);
        proc.stdin.end();
    });
}

// ---------- USB device file (Linux/Mac: /dev/usb/lp0, Windows: \\.\USB001) ----------
function printViaDevice(rawBuffer) {
    return new Promise((resolve, reject) => {
        // 'a' flag — non-destructive append; avoids truncating the device
        const stream = fs.createWriteStream(PRINTER_DEVICE, { flags: 'a' });
        let settled = false;

        const done = (err) => {
            if (settled) return;
            settled = true;
            err ? reject(err) : resolve();
        };

        stream.on('error', (err) =>
            done(new Error(`USB device error (${PRINTER_DEVICE}): ${err.message}`))
        );
        stream.write(rawBuffer, (err) => {
            if (err) return done(new Error(`USB write error: ${err.message}`));
            stream.end();
        });
        stream.on('close', () => done(null));
    });
}

// ---------- TCP socket (network printer on port 9100) ----------
function printViaTcp(rawBuffer, target) {
    const { host, port, name } = target;
    return new Promise((resolve, reject) => {
        let settled = false;

        const done = (err) => {
            if (settled) return;
            settled = true;
            err ? reject(err) : resolve();
        };

        const socket = new net.Socket();
        socket.setTimeout(CONNECT_TIMEOUT_MS);

        socket.on('timeout', () => {
            socket.destroy();
            done(new Error(`Printer "${name}" timed out connecting to ${host}:${port}`));
        });
        socket.on('error', (err) =>
            done(new Error(`Printer "${name}" (${host}:${port}) socket error: ${err.message}`))
        );
        socket.on('close', () => done(null));

        socket.connect(port, host, () => {
            socket.write(rawBuffer, (err) => {
                if (err) return done(new Error(`Printer write error: ${err.message}`));
                socket.end();
            });
        });
    });
}

// ---------- public entry point ----------
// ESC and GS are declared again inside each builder below, which shadow these harmlessly. These
// exist because the fiscal helpers are module scope: they are called from the receipt builder but
// are too long to live inside it.
const ESC = '\x1B';
const GS = '\x1D';

/**
 * The Authority's QR code, in the printer's own hardware encoder.
 *
 * Art 4(1)(d) requires the QR printed or displayed legibly. GS ( k is the ESC/POS QR family and
 * every printer that has a QR engine implements it; the alternative is rasterising one here and
 * sending GS v 0, which needs an encoder in the bridge and prints worse.
 *
 * Four commands, in this order and no other: select model, set module size, set error correction,
 * store the payload, print what was stored.
 *
 * The payload must be ASCII. toPrintable transliterates anything above 0x7F on its way to the
 * buffer, which would silently alter the bytes inside the QR and produce a code that scans to
 * something other than what the Authority issued — so a non-ASCII payload is printed as a text line
 * instead of encoded wrong. That has never happened with a URL or a base64 token, which is what
 * these are, and it is cheap to be certain.
 *
 * @param payload the QR content exactly as the Authority returned it
 * @param moduleSize 1-16; 6 is about 25mm on 80mm paper, which scans off a phone at arm's length
 */
function qrLines(payload, moduleSize = 6) {
    const data = String(payload || '');
    if (!data) return [];

    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7E]/.test(data)) {
        return ['QR: ' + data + '\n'];
    }

    const GS_K = GS + '(' + 'k';
    const size = Math.min(16, Math.max(1, Number(moduleSize) || 6));

    // Store: pL pH are the length of (payload + the three bytes 49 80 48) in little-endian.
    const storeLength = data.length + 3;
    const pL = String.fromCharCode(storeLength & 0xFF);
    const pH = String.fromCharCode((storeLength >> 8) & 0xFF);

    return [
        GS_K + '\x04\x00\x31\x41\x32\x00',                      // model 2
        GS_K + '\x03\x00\x31\x43' + String.fromCharCode(size),    // module size
        GS_K + '\x03\x00\x31\x45\x31',                           // error correction M
        GS_K + pL + pH + '\x31\x50\x30' + data,                    // store payload
        GS_K + '\x03\x00\x31\x51\x30'                            // print it
    ];
}

/**
 * What the Authority gave back for this sale, and what to say when it gave nothing.
 *
 * Art 4(3)(c) names three things a registered receipt carries: an IRN, an RRN and a QR code. Until
 * this, a receipt printed the taxpayer's four identifiers and said nothing whatever about the
 * registration that is supposed to make it a fiscal document.
 *
 * A receipt with no IRN is not automatically wrong. Art 4(4) allows a sale to be taken offline and
 * transmitted when the connection returns, so the paper legitimately exists before its registration
 * does — but the customer's copy must not imply it is registered when it is not. OFFLINE_QUEUED and
 * PENDING say so; NOT_REQUIRED is a sale from before the regime and says nothing, because there is
 * nothing to say.
 */
function fiscalLines(receipt, centerLines, formatInfoLine) {
    const out = [];
    const state = String(receipt.fiscalState || '').toUpperCase();

    if (receipt.irn) out.push(formatInfoLine('IRN', receipt.irn));
    if (receipt.rrn) out.push(formatInfoLine('RRN', receipt.rrn));

    if (receipt.fiscalQr) {
        out.push('\n');
        out.push(ESC + 'a' + '\x01');
        qrLines(receipt.fiscalQr).forEach(l => out.push(l));
        out.push('\n');
        out.push(ESC + 'a' + '\x00');
    } else if (state === 'OFFLINE_QUEUED' || state === 'PENDING' || state === 'SUBMITTED') {
        out.push('\n');
        out.push(ESC + 'a' + '\x01');
        centerLines('Awaiting fiscal registration').forEach(l => out.push(l));
        out.push(ESC + 'a' + '\x00');
    }

    return out;
}

function printReceipt(receipt, station) {
    // Resolved before the data is built, not after. The width, the cut style and the code page are
    // properties of the printer this is going to, so a site can put a 58 mm printer at the bar and an
    // 80 mm one at the till without a code change — which is the point of not tying this to one make.
    const target = resolveStation(station);
    const data = buildEscposData(receipt, {
        lineWidth: target.width,
        cut: target.cut,
        codepage: target.codepage,
        autoCut: true,
        feedLines: 4
    });

    // toPrintable before latin1, not instead of it. latin1 maps each character to one byte, which is
    // what raw ESC/POS needs — but it maps Ethiopic and typographic characters to whatever byte sits
    // at that value, so an Amharic item name printed as line noise on a fiscal document. Control
    // bytes are all below 0x80 and pass through untouched, so this is safe to apply to the whole
    // stream rather than to each field.
    const rawBuffer = Buffer.from(toPrintable(data.join('')), 'latin1');

    // A command or a USB device is one physical printer by definition, so a station cannot mean
    // anything there. Worth saying out loud rather than ignoring silently.
    if (PRINTER_CMD || PRINTER_DEVICE) {
        if (station) {
            console.warn(
                `[printer] station "${station}" ignored: PRINTER_CMD/PRINTER_DEVICE addresses one printer`
            );
        }
        return PRINTER_CMD ? printViaCommand(rawBuffer) : printViaDevice(rawBuffer);
    }

    return printViaTcp(rawBuffer, target);
}

module.exports = { printReceipt, parseStations, resolveStation, buildEscposData, stations: () => STATIONS };
// ---------- production tickets ----------

/**
 * A ticket for the people making the order, not for the diner.
 *
 * Deliberately not the receipt. A receipt carries the TIN, the VAT breakdown and the total,
 * because it is a fiscal document the diner keeps; a cook needs to know what to make and for which
 * table, in type readable across a hot kitchen, and no money at all. Printing a receipt in the
 * kitchen gives someone a page of tax arithmetic to read past before they find the food.
 *
 * One ticket per station, so an order of tibs and two beers prints food in the kitchen and drinks
 * at the bar rather than one list somebody has to divide by hand.
 */
function buildTicketData(ticket, opts = {}) {
    const ESC = '\x1B';
    const GS = '\x1D';
    const LINE_WIDTH = opts.lineWidth || DEFAULT_WIDTH;
    const FEED_LINES = opts.feedLines || 4;
    const CUT_STYLE  = opts.cut === 'partial' ? 'partial' : 'full';
    const CODE_PAGE  = codePageByte(opts.codepage);

    const out = [];
    const init = () => out.push(ESC + '@' + ESC + 't' + String.fromCharCode(CODE_PAGE));
    const center = () => out.push(ESC + 'a' + '\x01');
    const left = () => out.push(ESC + 'a' + '\x00');
    const bold = (on) => out.push(ESC + 'E' + (on ? '\x01' : '\x00'));
    // Double height and width. A cook reads this at arm's length over a pass.
    const big = (on) => out.push(GS + '!' + (on ? '\x11' : '\x00'));
    const rule = () => out.push('-'.repeat(LINE_WIDTH) + '\n');

    init();

    center();
    bold(true);
    big(true);
    out.push(String(ticket.station || 'ORDER').toUpperCase() + '\n');
    big(false);
    bold(false);

    // The table is what a waiter carries the plate to, so it is the largest thing after the
    // station. An order number identifies the ticket if two tables order the same thing.
    if (ticket.table !== null && ticket.table !== undefined) {
        big(true);
        out.push('TABLE ' + ticket.table + '\n');
        big(false);
    }
    out.push('#' + String(ticket.orderNumber || '') + '\n');
    if (ticket.time) out.push(String(ticket.time) + '\n');
    left();
    rule();

    for (const item of ticket.items || []) {
        big(true);
        out.push(String(item.quantity) + ' x ' + String(item.name) + '\n');
        big(false);
        if (item.note) {
            out.push('   ** ' + String(item.note) + '\n');
        }
    }

    rule();
    if (ticket.waiter) out.push('Waiter: ' + String(ticket.waiter) + '\n');

    out.push('\n'.repeat(FEED_LINES));
    // Cut, so the next station's ticket is a separate piece of paper.
    out.push(GS + 'V' + (CUT_STYLE === 'partial' ? '\x01' : '\x00'));

    return out;
}

/**
 * Prints one production ticket at the station it names.
 *
 * Routed the same way a receipt is, so an unknown station still lands at the default printer
 * rather than nowhere.
 */
function printTicket(ticket) {
    const target = resolveStation(ticket.station);
    const data = buildTicketData(ticket, {
        lineWidth: target.width,
        cut: target.cut,
        codepage: target.codepage
    });
    const rawBuffer = Buffer.from(toPrintable(data.join('')), 'latin1');

    if (PRINTER_CMD || PRINTER_DEVICE) {
        return PRINTER_CMD ? printViaCommand(rawBuffer) : printViaDevice(rawBuffer);
    }
    return printViaTcp(rawBuffer, target);
}

module.exports.printTicket = printTicket;
module.exports.buildTicketData = buildTicketData;
