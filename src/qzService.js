const qz = require('qz-tray');
const WebSocket = require('ws');

const PRINTER_NAME = process.env.PRINTER_NAME || 'EPSON';

qz.api.setWebSocketType(WebSocket);

// For QZ 2.1+ SHA-256 is built-in; SHA override only needed for 2.0.
// If you run 2.0, uncomment this and add 'sha.js':
// const crypto = require('crypto');
// qz.api.setSha256Type(data => crypto.createHash('sha256').update(data).digest('hex'));

/**
 * Ensure websocket connection to QZ Tray
 */
async function ensureConnected() {
    if (qz.websocket.isActive()) return;
    await qz.websocket.connect();
}

/**
 * Build an ESC / POS data array from a PrintPayload object.
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
        const val = String(value || "");
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

        // extra name-only lines
        for (let i = 1; i < wrapped.length; i++) {
            result.push(wrapped[i].slice(0, LINE_WIDTH) + "\n");
        }

        return result;
    };

    const formatTotalLine = (label, amount) => {
        const l = String(label);
        const r = fmt(amount);
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
    lines.push(ESC + "@"); // reset
    lines.push(ESC + "a" + "\x01"); // center

    // Business name bold
    lines.push(ESC + "E" + "\x01");
    centerLines(String(receipt.businessName).toUpperCase()).forEach(l => lines.push(l));
    lines.push(ESC + "E" + "\x00");

    if (receipt.address) centerLines(receipt.address).forEach(l => lines.push(l));
    if (receipt.phone)   centerLines("TEL: " + receipt.phone).forEach(l => lines.push(l));

    lines.push("\n");

    if (receipt.tin) centerLines("TIN: " + receipt.tin).forEach(l => lines.push(l));

    lines.push("\n");
    lines.push(ESC + "a" + "\x00"); // left align

    // meta
    if (receipt.fsNo)        lines.push(formatInfoLine("Invoice", receipt.fsNo));
    if (receipt.orderNumber) lines.push(formatInfoLine("Order", receipt.orderNumber));
    if (receipt.invoiceType) lines.push(formatInfoLine("Type", receipt.invoiceType));
    if (receipt.date)        lines.push(formatInfoLine("Date", receipt.date));
    if (receipt.table)       lines.push(formatInfoLine("Table", receipt.table));
    if (receipt.cashier)     lines.push(formatInfoLine("Cashier", receipt.cashier));
    if (receipt.waiter)      lines.push(formatInfoLine("Waiter", receipt.waiter));

    lines.push(repeat("-", LINE_WIDTH) + "\n");

    // item header
    lines.push(itemHeader());
    lines.push(repeat("-", LINE_WIDTH) + "\n");

    for (const it of items) {
        formatItemLines(it.name, it.quantity, it.price)
            .forEach(l => lines.push(l));
    }

    lines.push(repeat("-", LINE_WIDTH) + "\n");

    // totals
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

    // payment
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

    // footer
    lines.push("\n");
    lines.push(ESC + "a" + "\x01"); // center
    centerLines("Thank you!").forEach(l => lines.push(l));
    centerLines("Powered by EasyMaz").forEach(l => lines.push(l));

    lines.push("\n".repeat(FEED_LINES));

    if (AUTO_CUT) {
        lines.push(GS + "V" + "\x01");
        lines.push("\n");
    }

    return lines;
}

/**
 * Print a receipt via QZ Tray
 */
async function printReceipt(receipt) {
    await ensureConnected();

    // Create config for a specific printer
    const config = qz.configs.create(PRINTER_NAME);
    const data = buildEscposData(receipt, {
        lineWidth: 48,
        autoCut: true,
        feedLines: 4
    });

    // QZ raw printing: just pass the array of strings (ESC/POS commands)
    await qz.print(config, data);
}

module.exports = { printReceipt };
