require('dotenv').config({ path: require('find-config')('.env') })
const escpos = require('escpos');
const axios = require('axios');

// Import adapters
escpos.USB = require('escpos-usb');
escpos.Network = require('escpos-network');
// Note: Bluetooth support requires escpos-bluetooth (optional)

const LINE_LENGTH = 48;
const API_URL = process.env.API_URL;
const PRINTER_TYPE = process.env.PRINTER_TYPE || 'usb'; // usb, network, or bluetooth
const PRINTER_IP = process.env.PRINTER_IP;
const PRINTER_PORT = process.env.PRINTER_PORT || 9100;

function padRight(text, length) {
  return text.length < length ? text + ' '.repeat(length - text.length) : text;
}

function padLeft(text, length) {
  return text.length < length ? ' '.repeat(length - text.length) + text : text;
}

function formatDate(date) {
  const d = new Date(date || Date.now());
  return `${d.toLocaleDateString()}  ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Get printer device based on configuration
 * @param {object} options - Printer options
 * @returns {object} Printer device
 */
function getPrinterDevice(options = {}) {
  const printerType = options.type || PRINTER_TYPE;

  switch (printerType.toLowerCase()) {
    case 'network':
    case 'ip':
      const ip = options.ip || PRINTER_IP;
      const port = options.port || PRINTER_PORT;
      if (!ip) {
        throw new Error('PRINTER_IP is required for network printer');
      }
      console.log(`Using network printer at ${ip}:${port}`);
      return new escpos.Network(ip, port);

    case 'bluetooth':
      // Bluetooth support (requires escpos-bluetooth package)
      const btAddress = options.address || process.env.PRINTER_BT_ADDRESS;
      if (!btAddress) {
        throw new Error('Bluetooth address is required for bluetooth printer');
      }
      console.log(`Using bluetooth printer at ${btAddress}`);
      // Uncomment when escpos-bluetooth is installed
      escpos.Bluetooth = require('escpos-bluetooth');
      return new escpos.Bluetooth(btAddress);

    case 'usb':
    default:
      const vendorId = options.vendorId;
      const productId = options.productId;
      console.log(`Using USB printer${vendorId ? ` (${vendorId}:${productId})` : ''}`);
      return vendorId && productId
        ? new escpos.USB(vendorId, productId)
        : new escpos.USB();
  }
}

/**
 * Print receipt and handle drawer opening only on the first print.
 * @param {object} data - Receipt data including receiptPrinted flag
 * @param {object} options - Printer options (type, ip, port, vendorId, productId)
 * @returns {Promise<void>}
 */
function printReceipt(data, options = {}) {
  return new Promise((resolve, reject) => {
    let device;

    try {
      device = getPrinterDevice(options);
    } catch (err) {
      return reject(err);
    }

    const printer = new escpos.Printer(device);
    const line48 = '-'.repeat(LINE_LENGTH);

    device.open(async (err) => {
      if (err) {
        console.error('Failed to open printer device:', err);
        return reject(err);
      }

      try {
        // Open cash drawer only if paid by cash, paid, and NOT printed before
        if (data.paidByCash && data.isPaid && !data.isReceiptPrinted) {
          printer.cashdraw(2);
        }

        // Print receipt header
        printer
          .align('ct')
          .text(`TIN: ${data.tin}`)

          .align('ct')
          .style('b')
          .size(1, 1)
          .text((data.businessName || '').toUpperCase())

          .align('ct')
          .style('normal')
          .size(0, 0)
          .text(data.address || '')
          .text(`TEL: ${data.phone || ''}`)
          .newLine();

        if (data.isReceiptPrinted) {
          printer.text('*** REPRINT ***');
        }

        printer
          .align('lt')
          .text(`Order #: ${data.fsNo || ''}`)
          .text(formatDate(data.date))
          .text(line48)
          .align('ct')
          .text(`=== ${data.invoiceType} ===`)
          .align('lt')
          .text(`Cashier: ${data.cashier || ''}`)
          .text(`Waiter: ${data.waiter || ''}`)
          .text(`Table: ${data.table || ''}`)
          .text(line48);

        // Print items
        data.items.forEach(item => {
          const qtyPrice = `${item.quantity} x ${item.price.toFixed(2)}`;
          const totalPrice = (item.quantity * item.price).toFixed(2);
          printer.text(padRight(qtyPrice, 20) + padLeft(totalPrice, 28));
          printer.text(item.name);
        });

        printer.text(line48);

        // Print totals
        printer.text(padRight('SUBTOTAL', 20) + padLeft(data.subtotal.toFixed(2), 28));
        if (data.serviceCharge) {
          printer.text(padRight(`SURCHARGE ${data.serviceChargePercentage}%`, 20) + padLeft(data.serviceCharge.toFixed(2), 28));
        }
        printer.text(padRight('TXBL1', 20) + padLeft((data.subtotal + (data.serviceCharge || 0)).toFixed(2), 28));
        printer.text(padRight(`TAX1 ${data.vatPercentage}%`, 20) + padLeft(data.vat.toFixed(2), 28));
        printer.text(line48);

        printer
          .style('b')
          .text(padRight('TOTAL', 20) + padLeft(data.total.toFixed(2), 28))
          .style('normal');

        printer.text(padRight(data.paymentMethod, 20) + padLeft(data.total.toFixed(2), 28));
        printer.text(padRight('STATUS', 20) + padLeft(data.isPaid ? 'PAID' : 'UNPAID', 28));
        printer.text(line48);

        // Print footer
        printer
          .align('ct')
          .newLine()
          .style('b')
          .text('WE LOOK FORWARD TO YOUR NEXT VISIT!')
          .style('normal')
          .text('Powered by Easymaz')
          .newLine()
          .cut()
          .close(async () => {
            // After printing, if this was the first print, notify backend
            if (data.paidByCash && data.isPaid && !data.isReceiptPrinted && API_URL) {
              try {
                const url = `${API_URL}/p/orders/${data.fsNo}/mark-receipt-printed?restaurantId=${data.restaurantId}`;
                await axios.put(url);
              } catch (apiErr) {
                console.error('Failed to mark receipt as printed:', apiErr.message);
                // Don't reject - print was successful
              }
            }
            resolve();
          });
      } catch (printErr) {
        console.error('Print error:', printErr);
        reject(printErr);
      }
    });
  });
}

module.exports = printReceipt;
