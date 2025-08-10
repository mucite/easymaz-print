const escpos = require('escpos');
escpos.USB = require('escpos-usb');

function padRight(text, length) {
  return text.length < length ? text + ' '.repeat(length - text.length) : text;
}
function padLeft(text, length) {
  return text.length < length ? ' '.repeat(length - text.length) + text : text;
}

function printReceipt(data, options = {}) {
  return new Promise((resolve, reject) => {
    const device = options.vendorId && options.productId
      ? new escpos.USB(options.vendorId, options.productId)
      : new escpos.USB();

    const printer = new escpos.Printer(device);

    device.open(err => {
      if (err) return reject(err);

      try {
        if (data.paidByCash) {
          printer.cashdraw(2); // open drawer
        }

        const line48 = '-'.repeat(48);

        // Header
        printer
          .align('ct')
          .text(`TIN: ${data.tin || '0000000000'}`) // Added TIN
          .style('b')
          .size(1, 1)
          .text((data.businessName || '').toUpperCase())
          .style('normal')
          .size(0, 0)
          .text(data.address || '')
          .text(`TEL: ${data.phone || ''}`)
          .newLine()
          .align('lt')
          .text(`FS No: ${data.fsNo || ''}`)
          .text(
            `${new Date(data.date || Date.now()).toLocaleDateString()}  ${new Date(data.date || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          )
          .text(line48)
          .align('ct')
          .text(`=== ${data.invoiceType || 'CASH INVOICE'} ===`)
          .align('lt')
          .text(`Cashier: ${data.cashier || ''}`)
          .text(`Waiter: ${data.waiter || ''}`)
          .text(`Table: ${data.table || ''}`)
          .text(line48);

        // Items
        data.items.forEach(item => {
          const qtyPrice = `${item.quantity} x ${item.price.toFixed(2)}`;
          const totalPrice = `${(item.quantity * item.price).toFixed(2)}`;
          printer.text(padRight(qtyPrice, 20) + padLeft(totalPrice, 28));
          printer.text(item.name);
        });

        printer.text(line48);

        // Totals
        printer.text(padRight('SUBTOTAL', 20) + padLeft(`${data.subtotal.toFixed(2)}`, 28));
        if (data.serviceCharge) {
          printer.text(padRight('SURCHARGE', 20) + padLeft(`${data.serviceCharge.toFixed(2)}`, 28));
        }
        printer.text(padRight('TXBL1', 20) + padLeft(`${(data.subtotal + (data.serviceCharge || 0)).toFixed(2)}`, 28));
        printer.text(padRight(`TAX1 ${data.taxRate || '15.00'}%`, 20) + padLeft(`${data.vat.toFixed(2)}`, 28));
        printer.text(line48);
        printer.style('b').text(padRight('TOTAL', 20) + padLeft(`${data.total.toFixed(2)}`, 28)).style('normal');
        printer.text(padRight(data.paymentMethod || 'CASH', 20) + padLeft(`${data.total.toFixed(2)}`, 28));
        printer.text(line48);

        // Footer
        printer
          .align('ct')
          .newLine()
          .style('b')
          .text('WE LOOK FORWARD TO YOUR NEXT VISIT!')
          .style('normal')
          .text('Powered by Easymaz')
          .newLine()
          .cut()
          .close();

        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = printReceipt;
