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
  taxableAmount: 0,
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

/**
 * Three spellings of "absent", and only one of them used to pass.
 *
 * A live box answered 400 to every print with:
 *   vatRegistrationNumber: Too small: expected string to have >=1 characters
 *   irn: Invalid input: expected string, received null
 *
 * `.optional()` permits undefined and nothing else, so an explicit null — which is what Jackson
 * serialises an unset field as, and therefore what the API sends for every fiscal identifier until
 * registration goes live — was the wrong type. And a restaurant that is not VAT-registered sends
 * an empty string for a number it is not required to hold.
 */
test('null, empty string and whitespace all mean the field is not there', () => {
  const parsed = PrintPayloadSchema.safeParse({
    ...lawful(),
    vatRegistrationNumber: '',
    cashier: null,
    waiter: '   ',
    paymentMethod: null,
    irn: null,
    rrn: null,
    fiscalQr: null,
    fiscalState: null
  });

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  for (const field of ['vatRegistrationNumber', 'cashier', 'waiter', 'paymentMethod', 'irn', 'rrn']) {
    assert.equal(parsed.data[field], undefined, `${field} should normalise to absent`);
  }
});

test('a flag nobody wrote is false, not a type error', () => {
  const parsed = PrintPayloadSchema.safeParse({
    ...lawful(), paidByCash: null, isPaid: null, isReceiptPrinted: null
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.paidByCash, false);
  assert.equal(parsed.data.isPaid, false);
  assert.equal(parsed.data.isReceiptPrinted, false);
});

test('a required field spelled as null is still refused, and named', () => {
  const parsed = PrintPayloadSchema.safeParse({ ...lawful(), tin: null });
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some(i => i.path.join('.') === 'tin'));
});

test('a receipt without an invoice number is accepted', () => {
  const { fsNo, ...rest } = lawful();
  const result = PrintPayloadSchema.safeParse(rest);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test('a saved printer address is an IPv4 address or a hostname, on a real port', () => {
  const { TargetSchema } = require('../src/validation');
  for (const host of ['192.168.1.50', 'kitchen-printer', 'bar.local']) {
    assert.ok(TargetSchema.safeParse({ host, port: 9100 }).success, host);
  }
  for (const host of ['999.1.1.1', '192.168.1', 'http://x', 'a b', '']) {
    assert.ok(!TargetSchema.safeParse({ host, port: 9100 }).success, host);
  }
  assert.ok(!TargetSchema.safeParse({ host: '10.0.0.5', port: 0 }).success);
  assert.ok(!TargetSchema.safeParse({ host: '10.0.0.5', port: 65536 }).success);
  assert.ok(!TargetSchema.safeParse({ host: '10.0.0.5', port: 9100, cut: 'half' }).success);
});

/**
 * The Tax Credit Note job, exactly as the API's print relay forwards it.
 */
const { CreditNotePayloadSchema } = require('../src/validation');

const creditNote = () => ({
  type: 'CREDIT_NOTE',
  jobId: 'cn-1',
  restaurant: { name: 'Zing Coffee', tin: '0012345678', vatNumber: null, address: 'Mekanisa', phone: null },
  creditNoteNumber: 'CN-000017',
  originalInvoiceNumber: '000231',
  orderNumber: '42',
  table: 'A3',
  issuedAt: '2026-10-16 14:05',
  reason: 'Dish returned cold',
  lines: [{ name: 'Macchiato', quantity: 1, amount: 60 }],
  amount: 60,
  vatIncluded: 7.83,
  method: 'CASH',
  issuedBy: null,
  approvedBy: null,
  openDrawer: true
});

test('the API\'s credit note payload is accepted, nulls and all', () => {
  const parsed = CreditNotePayloadSchema.safeParse(creditNote());
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  // Normalised to absent, which is what the template tests for.
  assert.strictEqual(parsed.data.restaurant.vatNumber, undefined);
  assert.strictEqual(parsed.data.issuedBy, undefined);
});

test('a credit note with no invoice, no table and an empty restaurant still prints', () => {
  const note = {
    ...creditNote(),
    originalInvoiceNumber: null,
    table: null,
    restaurant: { name: null, tin: null, vatNumber: null, address: null, phone: null }
  };
  const parsed = CreditNotePayloadSchema.safeParse(note);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.ok(CreditNotePayloadSchema.safeParse({ ...creditNote(), table: 7 }).success, 'a numeric table');
});

test('a malformed credit note is refused, and the field named', () => {
  const refused = (patch, field) => {
    const parsed = CreditNotePayloadSchema.safeParse({ ...creditNote(), ...patch });
    assert.ok(!parsed.success, `accepted ${JSON.stringify(patch)}`);
    assert.ok(
      parsed.error.issues.some(i => i.path[0] === field),
      `${JSON.stringify(patch)} did not name ${field}: ${JSON.stringify(parsed.error.issues)}`
    );
  };

  refused({ jobId: undefined }, 'jobId');
  refused({ jobId: '' }, 'jobId');
  refused({ type: 'RECEIPT' }, 'type');
  refused({ creditNoteNumber: '' }, 'creditNoteNumber');
  refused({ lines: [] }, 'lines');
  refused({ lines: [{ name: 'Tea', quantity: 0, amount: 10 }] }, 'lines');
  refused({ lines: [{ name: 'Tea', quantity: 1, amount: -1 }] }, 'lines');
  refused({ lines: [{ name: '', quantity: 1, amount: 1 }] }, 'lines');
  refused({ amount: '60' }, 'amount');
  refused({ amount: 0 }, 'amount');
  refused({ vatIncluded: -1 }, 'vatIncluded');
  refused({ vatIncluded: 61 }, 'vatIncluded');
  refused({ method: 'CARD' }, 'method');
  refused({ openDrawer: 'yes' }, 'openDrawer');
  refused({ openDrawer: undefined }, 'openDrawer');
  refused({ reason: '  ' }, 'reason');
});

/**
 * The kitchen ticket's payload, as the API sends it from KitchenTickets.ticket.
 */
const { TicketPayloadSchema } = require('../src/validation');

const apiTicket = () => ({
  jobId: 'ticket-o1-kitchen',
  orderNumber: 'A-12',
  table: 4,
  time: '12:41',
  waiter: 'Sara',
  station: 'kitchen',
  items: [{ name: 'Tibs', quantity: 1, note: 'no berbere' }, { name: 'Shiro', quantity: 2 }]
});

test('the ticket the API sends today is accepted as it is', () => {
  const parsed = TicketPayloadSchema.safeParse(apiTicket());
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test('a reprint and an order note are carried through', () => {
  const parsed = TicketPayloadSchema.safeParse({ ...apiTicket(), reprint: true, note: 'Nut allergy' });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.strictEqual(parsed.data.reprint, true);
  assert.strictEqual(parsed.data.note, 'Nut allergy');
});

test('an empty order note is no note', () => {
  for (const note of [null, '', '   ']) {
    const parsed = TicketPayloadSchema.safeParse({ ...apiTicket(), note });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.strictEqual(parsed.data.note, undefined);
  }
});

test('a price sent with a ticket item is dropped, never printed', () => {
  const ticket = apiTicket();
  ticket.items[0].price = 260;
  const parsed = TicketPayloadSchema.safeParse(ticket);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.ok(!('price' in parsed.data.items[0]));
});
