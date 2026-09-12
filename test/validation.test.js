const test = require('node:test');
const assert = require('node:assert');
const { PrintPayloadSchema } = require('../src/validation');

/**
 * What a receipt must carry, and what it is allowed not to.
 *
 * These exist because a live box answered 400 BAD_REQUEST to a print and the till was told "it is
 * running, so this is not a cable" — a true sentence that named nothing. The schema was rejecting
 * fields a real sale does not have: no waiter at the counter, no payment method before payment.
 */

/** The smallest receipt that is still a lawful one. */
const lawful = () => ({
  tin: '0012345678',
  businessName: 'Zing Coffee',
  address: 'Mekanisa',
  fsNo: 'FS-1',
  orderNumber: '42',
  date: '2026-09-12',
  invoiceType: 'CASH INVOICE',
  items: [{ name: 'Macchiato', quantity: 1, price: 60 }],
  subtotal: 60,
  serviceCharge: 0,
  vat: 9,
  vatPercentage: 15,
  total: 69,
  restaurantId: 'r-1'
});

test('a sale rung up at the counter has no waiter and still prints', () => {
  const { waiter, ...counter } = { ...lawful(), cashier: 'Sara' };
  const parsed = PrintPayloadSchema.safeParse(counter);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test('an order that has not been paid yet has no payment method and still prints', () => {
  const parsed = PrintPayloadSchema.safeParse(lawful());
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.paymentMethod, undefined);
  assert.equal(parsed.data.isPaid, false, 'absent means not paid, not invalid');
  assert.equal(parsed.data.paidByCash, false);
  assert.equal(parsed.data.isReceiptPrinted, false);
});

test('a payment method the enum never listed is printed rather than refused', () => {
  // The bridge writes this word on a line. It authorises nothing with it, so an enum here only
  // ever rejected receipts — including every CASH sale once a fourth method exists.
  const parsed = PrintPayloadSchema.safeParse({ ...lawful(), paymentMethod: 'TELEBIRR' });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.paymentMethod, 'TELEBIRR');
});

test('a receipt with no TIN is still refused, and says which field', () => {
  const { tin, ...untaxed } = lawful();
  const parsed = PrintPayloadSchema.safeParse(untaxed);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some(i => i.path.join('.') === 'tin'));
});

test('a receipt with no items is refused', () => {
  const parsed = PrintPayloadSchema.safeParse({ ...lawful(), items: [] });
  assert.equal(parsed.success, false);
});

test('the premises and the invoice type stay required, because the document is evidence', () => {
  for (const field of ['address', 'invoiceType', 'businessName', 'restaurantId']) {
    const payload = lawful();
    delete payload[field];
    const parsed = PrintPayloadSchema.safeParse(payload);
    assert.equal(parsed.success, false, `${field} should still be required`);
  }
});
