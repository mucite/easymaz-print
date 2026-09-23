const net    = require('net');
const fs     = require('fs');
const { spawn } = require('child_process');
const { codePageByte, toPrintable } = require('./charset');

// Mac/Linux CUPS:  PRINTER_CMD=lp -d "TM-T88V" -o raw -
// Linux pipe:      PRINTER_CMD=cat > /dev/usb/lp0   (alternative to PRINTER_DEVICE)
const PRINTER_CMD       = process.env.PRINTER_CMD;

// Linux/Windows raw device file: /dev/usb/lp0  or  \\.\USB001
const PRINTER_DEVICE    = process.env.PRINTER_DEVICE;

// Network printer over Ethernet or Wi-Fi (TCP port 9100). The two are the same socket here; only
// how the printer got its address differs.
//
// PRINTER_IP is accepted as an alias. The box's .env names it that way — it is what an installer
// standing at the till calls it — and docker-compose remaps it to the name read here. Kept as an
// alias rather than left to the mapping because an .env passed through directly, or a compose file
// edited without it, would otherwise configure nothing at all: the value never arrives, the default
// below takes over, and every receipt goes to this container itself. That fault has happened once
// already, under the old name.
const CONFIGURED_HOST   = process.env.PRINTER_HOST || process.env.PRINTER_IP;
const PRINTER_HOST      = CONFIGURED_HOST || '127.0.0.1';
const PRINTER_PORT      = Number(process.env.PRINTER_PORT) || 9100;

/**
 * Whether a register printer was actually configured, as opposed to assumed.
 *
 * The default above is a guess, and a guess that looks like configuration: with nothing set, every
 * receipt is sent to 127.0.0.1:9100 and fails at connect time with a refused socket, which reads as
 * a dead printer rather than a box nobody finished setting up. The named stations are optional — a
 * restaurant with one printer at the till names none — but the till's own printer is not, because
 * a receipt is a fiscal document and there is nowhere else for it to go.
 *
 * Read from CONFIGURED_HOST, not from PRINTER_HOST above, which can never be empty.
 */
const REGISTER_CONFIGURED = Boolean(
    PRINTER_CMD || PRINTER_DEVICE || CONFIGURED_HOST
);

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

    // What this piece of paper is, before anything else on it — see statusBanners. Printed here,
    // under the name and above the taxpayer's identifiers, because the top of the slip is what a
    // diner reads first and what survives when the bottom is torn off at the cutter.
    statusBanners(receipt, centerLines, { bill: true }).forEach(l => lines.push(l));

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
    // Art 23(3): named on the invoice when the buyer asked to be.
    if (receipt.buyerName)   lines.push(formatInfoLine("Buyer", receipt.buyerName));
    if (receipt.buyerTin)    lines.push(formatInfoLine("Buyer TIN", receipt.buyerTin));
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

    // Art 22(5)(c): a reprint says so at both ends, so neither half of a torn slip passes for the
    // original. The fiscal notice is already repeated by fiscalLines above, and the bill title is
    // not repeated: it is a title, and one at the top is what makes it one.
    statusBanners(receipt, centerLines, { fiscal: false }).forEach(l => lines.push(l));

    // Art 4(1)(i): the buyer's own copy, fetched from this box by whoever scans it.
    receiptCodeLines(receipt, centerLines).forEach(l => lines.push(l));

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
    //
    // And never for a reprint. A DUPLICATE (Art 22(5)(c)) is a copy of a sale whose cash already
    // went into the drawer when the original printed; a customer asking for their receipt again is
    // not a reason to hand the cashier an open till with no money going into it.
    if (CASH_DRAWER && receipt.paidByCash && receipt.isPaid && receipt.isReceiptPrinted !== true) {
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
 * Whether the fiscal state is one where registration is on its way rather than absent.
 *
 * Art 4(4) allows a sale to be taken offline and transmitted when the connection returns, so a slip
 * in one of these states legitimately exists before its registration does: SUBMITTED has been sent,
 * OFFLINE_QUEUED is queued to be. PENDING is not among them. The API marks every paid sale PENDING —
 * registration is owed — but nothing sends it until the Authority publishes its specification, so a
 * PENDING slip is a sale the Authority has no record of and is not about to get one of, the same as
 * absent, NOT_REQUIRED, REJECTED or CANCELLED. Printing "awaiting" on every receipt would promise a
 * registration nobody is making.
 */
function awaitingRegistration(receipt) {
    const state = String(receipt.fiscalState || '').toUpperCase();
    return state === 'OFFLINE_QUEUED' || state === 'SUBMITTED';
}

/**
 * Whether this slip is a fiscal receipt at all.
 *
 * Art 4(1)(c): the system "issues an invoice or receipt only upon transmitting data ... and
 * obtaining an IRN, RRN and QR code". The IRN is the one that decides it. No sale is transmitted to
 * the Authority today — there is no published transmission spec and the API's FiscalService is not
 * wired — so today this is false for every slip that prints, and the slip has to say so.
 */
function fiscallyRegistered(receipt) {
    return Boolean(receipt.irn);
}

/**
 * The "NOT A FISCAL RECEIPT" notice, bold and centred.
 *
 * Printed at the top, under the business header, and again where the IRN would have been. Never
 * omitted: the old rule was that a sale with nothing to say about registration said nothing, which
 * left a slip with a TIN, a VAT line and a total on it looking, to a diner or an inspector, exactly
 * like the receipt Art 4(1)(c) says only a registered sale may produce.
 */
function notFiscalLines(centerLines) {
    const out = [ESC + 'a' + '\x01', ESC + 'E' + '\x01'];
    centerLines('NOT A FISCAL RECEIPT').forEach(l => out.push(l));
    out.push(ESC + 'E' + '\x00');
    centerLines('Not registered with the Revenue Authority').forEach(l => out.push(l));
    return out;
}

/**
 * The banners that say what this slip is, for the top of the paper and the bottom.
 *
 * Three facts, each of which changes what the paper means and none of which a diner can see
 * otherwise:
 *
 *   DUPLICATE              isReceiptPrinted — Art 22(5)(c) requires a copy "clearly marked as a
 *                          'DUPLICATE'". validation.js has accepted the flag all along; nothing here
 *                          read it, so a reprint was indistinguishable from the original.
 *   BILL - NOT A RECEIPT   isPaid === false — a bill presented before payment is not a receipt of
 *                          anything. Strictly false, not falsy: a payload that omits the flag is an
 *                          older client, and the payment line below already says UNPAID when it is.
 *   NOT A FISCAL RECEIPT   no IRN and not on its way to one — see fiscallyRegistered.
 *
 * One banner block rather than three separate ones: the bill title first, since it is the larger
 * claim, and the fiscal notice under it. The caller leaves the printer in whatever alignment it
 * wants afterwards; this restores centre, which is what the header around it uses.
 *
 * @param opts.bill   whether to print the bill title (top only)
 * @param opts.fiscal whether to print the fiscal notice (top only — fiscalLines prints the bottom one)
 */
function statusBanners(receipt, centerLines, opts = {}) {
    const bill = opts.bill === true;
    const fiscal = opts.fiscal !== false;
    const out = [];

    const bold = (text) => {
        out.push(ESC + 'a' + '\x01');
        out.push(ESC + 'E' + '\x01');
        centerLines(text).forEach(l => out.push(l));
        out.push(ESC + 'E' + '\x00');
    };

    if (receipt.isReceiptPrinted === true) bold('DUPLICATE');
    if (bill && receipt.isPaid === false) bold('BILL - NOT A RECEIPT');
    if (fiscal && !fiscallyRegistered(receipt) && !awaitingRegistration(receipt)) {
        notFiscalLines(centerLines).forEach(l => out.push(l));
    }

    if (out.length) out.unshift('\n');
    return out;
}

/**
 * What the Authority gave back for this sale, and what to say when it gave nothing.
 *
 * Art 4(3)(c) names three things a registered receipt carries: an IRN, an RRN and a QR code. Until
 * this, a receipt printed the taxpayer's four identifiers and said nothing whatever about the
 * registration that is supposed to make it a fiscal document.
 *
 * Three cases, and exactly one of them prints:
 *
 *   IRN issued          the IRN, the RRN and the Authority's QR.
 *   on its way          OFFLINE_QUEUED, PENDING or SUBMITTED. Art 4(4) allows a sale to be taken
 *                       offline and transmitted when the connection returns, so the paper
 *                       legitimately exists before its registration does — but it must not imply
 *                       it is registered, so it says it is awaiting registration.
 *   anything else       NOT A FISCAL RECEIPT. This used to be silence for NOT_REQUIRED and for an
 *                       absent state, which is every slip printed today: Art 4(1)(c) says a receipt
 *                       is issued "only upon ... obtaining an IRN, RRN and QR code", so a slip
 *                       without one has to say what it is rather than leave the reader to assume.
 *
 * The Authority's QR is printed only with an IRN. The three are issued together, and a Revenue
 * Authority code under a "not registered" notice would be the one thing on the slip that
 * contradicts it.
 */
function fiscalLines(receipt, centerLines, formatInfoLine) {
    const out = [];

    if (fiscallyRegistered(receipt)) {
        out.push(formatInfoLine('IRN', receipt.irn));
        if (receipt.rrn) out.push(formatInfoLine('RRN', receipt.rrn));

        if (receipt.fiscalQr) {
            out.push('\n');
            out.push(ESC + 'a' + '\x01');
            centerLines('Revenue Authority').forEach(l => out.push(l));
            qrLines(receipt.fiscalQr).forEach(l => out.push(l));
            out.push('\n');
            out.push(ESC + 'a' + '\x00');
        }
    } else if (awaitingRegistration(receipt)) {
        out.push('\n');
        out.push(ESC + 'a' + '\x01');
        centerLines('Awaiting fiscal registration').forEach(l => out.push(l));
        out.push(ESC + 'a' + '\x00');
    } else {
        out.push('\n');
        notFiscalLines(centerLines).forEach(l => out.push(l));
        out.push(ESC + 'a' + '\x00');
    }

    return out;
}

/**
 * The code on the slip — the diner's own copy of this receipt.
 *
 * Article 4(1)(i) asks the system to send the buyer the registered receipt "by email, SMS or other,
 * and print on request". The QR is that "other", and it is the argument the whole design leans on
 * for keeping sales data inside the building: the receipt is not mailed anywhere, the diner's phone
 * fetches it from the machine that registered it.
 *
 * That argument had nothing behind it. No renderer printed a code, and nothing served the route the
 * link pointed at, while two messages from the API told diners "the code on your slip opens the same
 * receipt". This is the code.
 *
 * Labelled, and kept separate from the Authority's QR above, because the two are different documents
 * to anybody who scans them: one is a tax registration and one is a bill. An unlabelled pair is a
 * guess.
 *
 * Deliberately not printed when the payload carries no URL. A code that scans to nothing is worse
 * than a blank space on the paper, because it looks like it works.
 */
function receiptCodeLines(receipt, centerLines) {
    if (!receipt.receiptUrl) {
        return [];
    }
    const out = ['\n', ESC + 'a' + '\x01'];
    centerLines('Your receipt').forEach(l => out.push(l));
    qrLines(receipt.receiptUrl, 5).forEach(l => out.push(l));
    out.push('\n');
    out.push(ESC + 'a' + '\x00');
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

module.exports = {
    printReceipt,
    parseStations,
    resolveStation,
    buildEscposData,
    stations: () => STATIONS,
    registerConfigured: () => REGISTER_CONFIGURED
};
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

// ---------- self test ----------

/**
 * A ruler across the paper, so a column width can be read off the slip rather than guessed.
 *
 * Every fifth column carries its own number, right-aligned on that column, and the last character
 * of the line sits in the last column. A printer set to 58 mm paper receiving a 48-column slip
 * wraps this line, and the wrap is the answer: the ruler is the one line where being one column too
 * wide is visible instead of merely making a total look untidy.
 */
function columnRuler(width) {
    const marks = new Array(width).fill('.');
    for (let column = 5; column <= width; column += 5) {
        const label = String(column);
        // Right-aligned so the label's last digit lands on the column it names.
        for (let offset = 0; offset < label.length; offset++) {
            marks[column - label.length + offset] = label[offset];
        }
    }
    return marks.join('');
}

/**
 * A slip that proves a printer works, carrying no sale.
 *
 * Built for somebody who has just wired a printer up and wants to know whether this bridge can
 * drive it — an installer at a till, or a manufacturer checking their model against it. So it
 * prints the settings it was driven with rather than assuming they are right: a slip that comes out
 * saying 48 columns on 58 mm paper has diagnosed itself, where a receipt with the same fault just
 * looks badly laid out.
 *
 * Each line below exercises one ESC/POS feature this bridge relies on for real documents — the code
 * page selected with ESC t, bold, double-height, centring, and the cut. A printer that renders all
 * of them renders every receipt and ticket this bridge emits, which is the question being asked.
 *
 * No cash drawer pulse: a test print should not open the till.
 */
function buildTestPage(info, opts = {}) {
    const ESC = '\x1B';
    const GS = '\x1D';
    const LINE_WIDTH = opts.lineWidth || DEFAULT_WIDTH;
    const FEED_LINES = opts.feedLines || 4;
    const CUT_STYLE  = opts.cut === 'partial' ? 'partial' : 'full';
    const CODE_PAGE  = codePageByte(opts.codepage);

    const out = [];
    const center = () => out.push(ESC + 'a' + '\x01');
    const left = () => out.push(ESC + 'a' + '\x00');
    const bold = (on) => out.push(ESC + 'E' + (on ? '\x01' : '\x00'));
    const big = (on) => out.push(GS + '!' + (on ? '\x11' : '\x00'));
    const rule = () => out.push('-'.repeat(LINE_WIDTH) + '\n');
    const field = (label, value) => out.push(label.padEnd(10) + String(value) + '\n');

    out.push(ESC + '@' + ESC + 't' + String.fromCharCode(CODE_PAGE));

    center();
    bold(true);
    big(true);
    out.push('TEST PRINT\n');
    big(false);
    out.push('easymaz-print\n');
    bold(false);
    left();
    rule();

    // What the bridge thinks it is driving. The address is here because the commonest fault on a
    // site with several printers is a correct slip coming out of the wrong room.
    field('Station', info.station);
    field('Target', info.target);
    field('Mode', info.mode);
    field('Width', LINE_WIDTH + ' columns');
    field('Codepage', `${opts.codepage || DEFAULT_CODE_PAGE} (ESC t ${CODE_PAGE})`);
    field('Cut', CUT_STYLE);
    field('Time', info.printedAt);
    rule();

    out.push('Ruler ends at the last column.\n');
    out.push('A wrap means the width is wrong.\n');
    out.push(columnRuler(LINE_WIDTH) + '\n');
    rule();

    bold(true);
    out.push('Bold text\n');
    bold(false);
    big(true);
    out.push('Double\n');
    big(false);
    center();
    out.push('Centred text\n');
    left();
    // Accented characters, to show the code page actually took. Wrong table and these come out as
    // box-drawing characters or Greek, which is the same fault that used to garble an item name.
    out.push('Accents: cafe 25\xB0C \xE1\xE9\xED\xF3\xFA\n');
    rule();

    // The QR engine, which is the part of a receipt most likely to be the thing a given printer
    // cannot do. Every fiscal receipt this bridge prints carries one — the Authority's code under
    // Art 4(1)(d), and the buyer's own copy — and they are drawn by the printer's own encoder with
    // GS ( k rather than rasterised here. A model with no QR engine ignores those commands
    // silently: the receipt prints, looks right, and is missing the one element the Directive
    // names. So it is tested here, where a blank space is the answer rather than a mystery.
    //
    // The payload is printed as text directly beneath it, so a scan can be checked against what it
    // was supposed to say instead of merely producing something.
    center();
    out.push('Scan: should read the line below\n');
    // Smaller modules on 58 mm paper, where six would run past the edge of the printable area.
    for (const line of qrLines(info.qrPayload, LINE_WIDTH >= 48 ? 6 : 4)) {
        out.push(line);
    }
    out.push(info.qrPayload + '\n');
    out.push('Nothing above = no QR engine.\n');
    left();
    rule();

    center();
    out.push('If this slip is complete\n');
    out.push('and the paper is cut,\n');
    out.push('the printer is supported.\n');
    left();

    out.push('\n'.repeat(FEED_LINES));
    out.push(GS + 'V' + (CUT_STYLE === 'partial' ? '\x01' : '\x00'));

    return out;
}

/**
 * Prints the test slip, and reports what it was sent to.
 *
 * The return value is the same information printed on the paper, so the answer is available to
 * somebody holding a terminal and to somebody holding the slip — and a caller who gets a 200 but no
 * paper can read the address back and find they are testing a printer in another room.
 */
/**
 * The test slip as bytes, without deciding how they travel.
 *
 * Separated from the route because the same slip has to be printable with the bridge not running at
 * all: scripts/test-print.js drives a printer directly, over a socket or over USB, and building the
 * page twice is how the two drift until the tool stops testing what the bridge sends.
 */
function testPageBuffer(target, mode, address) {
    const now = new Date();

    const info = {
        station: target.name,
        target: address,
        mode,
        time: now.toISOString(),
        // The ISO stamp above is for the caller; the paper gets a shorter one, because 58 mm paper is
        // 32 columns and a label plus a full ISO timestamp is 34.
        printedAt: now.toISOString().replace('T', ' ').slice(0, 19),
        // ASCII, and 32 characters so it fits 58 mm paper on the line beneath the code. Plain text
        // rather than a URL: a phone offering to open a link that goes nowhere is a worse answer
        // than one showing the words the slip says it should show.
        qrPayload: 'EASYMAZ TEST ' + now.toISOString().replace('T', ' ').slice(0, 19),
        width: target.width,
        cut: target.cut,
        codepage: target.codepage
    };

    const data = buildTestPage(info, {
        lineWidth: target.width,
        cut: target.cut,
        codepage: target.codepage
    });
    const buffer = Buffer.from(toPrintable(data.join('')), 'latin1');

    return { info: { ...info, bytes: buffer.length }, buffer };
}

function printTestPage(station) {
    const target = resolveStation(station);

    const mode = PRINTER_CMD ? 'cmd' : PRINTER_DEVICE ? 'usb' : 'tcp';
    const address = PRINTER_CMD
        ? PRINTER_CMD
        : PRINTER_DEVICE
            ? PRINTER_DEVICE
            : `${target.host}:${target.port}`;

    const { info, buffer } = testPageBuffer(target, mode, address);

    const sent = (PRINTER_CMD || PRINTER_DEVICE)
        ? (PRINTER_CMD ? printViaCommand(buffer) : printViaDevice(buffer))
        : printViaTcp(buffer, target);

    return sent.then(() => info);
}

module.exports.printTestPage = printTestPage;
module.exports.testPageBuffer = testPageBuffer;
// Exported so the standalone tool sends over a socket exactly the way the bridge does, timeout and
// error messages included, rather than growing its own half of the same thing.
module.exports.printViaTcp = printViaTcp;
module.exports.buildTestPage = buildTestPage;
module.exports.columnRuler = columnRuler;
