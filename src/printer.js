const net    = require('net');
const fs     = require('fs');
const { spawn } = require('child_process');

// Mac/Linux CUPS:  PRINTER_CMD=lp -d "TM-T88V" -o raw -
// Linux pipe:      PRINTER_CMD=cat > /dev/usb/lp0   (alternative to PRINTER_DEVICE)
const PRINTER_CMD       = process.env.PRINTER_CMD;

// Linux/Windows raw device file: /dev/usb/lp0  or  \\.\USB001
const PRINTER_DEVICE    = process.env.PRINTER_DEVICE;

// Network printer (TCP port 9100)
const PRINTER_HOST      = process.env.PRINTER_HOST || '127.0.0.1';
const PRINTER_PORT      = Number(process.env.PRINTER_PORT) || 9100;
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

    const LINE_WIDTH = opts.lineWidth || 32;
    const AUTO_CUT   = opts.autoCut !== undefined ? opts.autoCut : true;
    const FEED_LINES = opts.feedLines || 4;

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
        // Zero is a value, not an absence: table 0 is a real table now that takeaway has
        // moved off it, and `value || ""` printed its line with the number missing.
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
    lines.push(ESC + "a" + "\x01"); // center align

    lines.push(ESC + "E" + "\x01");
    centerLines(String(receipt.businessName).toUpperCase()).forEach(l => lines.push(l));
    lines.push(ESC + "E" + "\x00");

    if (receipt.address) centerLines(receipt.address).forEach(l => lines.push(l));
    if (receipt.phone)   centerLines("TEL: " + receipt.phone).forEach(l => lines.push(l));

    lines.push("\n");

    if (receipt.tin) centerLines("TIN: " + receipt.tin).forEach(l => lines.push(l));

    lines.push("\n");
    lines.push(ESC + "a" + "\x00"); // left align

    if (receipt.fsNo)        lines.push(formatInfoLine("Invoice", receipt.fsNo));
    if (receipt.orderNumber) lines.push(formatInfoLine("Order", receipt.orderNumber));
    if (receipt.invoiceType) lines.push(formatInfoLine("Type", receipt.invoiceType));
    if (receipt.date)        lines.push(formatInfoLine("Date", receipt.date));
    // Takeaway prints the word where the table number goes. Tested for presence rather than
    // truthiness, so table 0 — a real table since takeaway moved off it — still prints.
    if (receipt.isTakeaway)        lines.push(formatInfoLine("Table", "TAKEAWAY"));
    else if (receipt.table != null) lines.push(formatInfoLine("Table", receipt.table));
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

    lines.push("\n");
    lines.push(ESC + "a" + "\x01"); // center
    centerLines("Thank you!").forEach(l => lines.push(l));
    centerLines("Powered by EasyMaz").forEach(l => lines.push(l));

    lines.push("\n".repeat(FEED_LINES));

    if (AUTO_CUT) {
        lines.push(GS + "V" + "\x01"); // full cut
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
function printViaTcp(rawBuffer) {
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
            done(new Error(`Printer timed out connecting to ${PRINTER_HOST}:${PRINTER_PORT}`));
        });
        socket.on('error', (err) =>
            done(new Error(`Printer socket error: ${err.message}`))
        );
        socket.on('close', () => done(null));

        socket.connect(PRINTER_PORT, PRINTER_HOST, () => {
            socket.write(rawBuffer, (err) => {
                if (err) return done(new Error(`Printer write error: ${err.message}`));
                socket.end();
            });
        });
    });
}

// ---------- public entry point ----------
function printReceipt(receipt) {
    const data = buildEscposData(receipt, {
        lineWidth: 48,
        autoCut: true,
        feedLines: 4
    });

    // latin1 encodes each character as a single byte — required for raw ESC/POS
    const rawBuffer = Buffer.from(data.join(''), 'latin1');

    if (PRINTER_CMD)    return printViaCommand(rawBuffer);
    if (PRINTER_DEVICE) return printViaDevice(rawBuffer);
    return printViaTcp(rawBuffer);
}

module.exports = { printReceipt };