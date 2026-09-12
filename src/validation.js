const { z } = require('zod');

/**
 * A field a real sale may simply not have.
 *
 * Three spellings of "absent" reach this bridge and only one of them used to pass. `.optional()`
 * in zod permits `undefined` and nothing else, so a JSON body carrying an explicit `null` — which
 * is what Jackson serialises an unset field as, and therefore what the API sends for every fiscal
 * identifier until registration goes live — was rejected as the wrong type. An empty string is the
 * third: a restaurant that is not VAT-registered sends `vatRegistrationNumber: ""`, and `min(1)`
 * refused to print its receipt over a number it is not required to hold.
 *
 * All three mean the same thing to a receipt, and the template already omits what is not there. So
 * they are normalised to `undefined` before the string rules run, rather than each caller being
 * asked to remember which spelling this particular schema accepts.
 *
 * Whitespace counts as absent too. " " is not a cashier's name.
 */
const absent = (value) =>
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '');

const optionalText = z.preprocess(
    (value) => (absent(value) ? undefined : value),
    z.string().min(1).optional()
);

/** The same, for a flag that is false when nobody wrote it. */
const optionalFlag = z.preprocess(
    (value) => (value === null || value === undefined ? false : value),
    z.boolean()
);

const PrintItemSchema = z.object({
    name: z.string().min(1, 'Item name is required'),
    quantity: z.number().int().positive('Item quantity must be > 0'),
    price: z.number().nonnegative('Item price must be >= 0')
});

const PrintPayloadSchema = z.object({
    tin: z.string().min(10, 'TIN is required'),

    // The other three identifiers a receipt has to carry. Optional, and deliberately so:
    // a restaurant that is not VAT-registered has no VAT number, and a sale taken before
    // the box was commissioned has no FS number or MRC. Rejecting the job would refuse a
    // customer their receipt over a field the restaurant is not required to have; the
    // template prints what is present.
    vatRegistrationNumber: optionalText,
    fsNumber: optionalText,
    mrcNumber: optionalText,

    businessName: z.string().min(1, 'Business name is required'),
    address: z.string().min(1, 'Address is required'),
    fsNo: z.string().min(1, 'FS number is required'),
    orderNumber: z.string().min(1, 'Order number is required'),
    date: z.string().min(1, 'Date is required'),
    invoiceType: z.string().min(1, 'Invoice type is required'),

    // Optional, all four, and it took a rejected receipt at a counter to establish why. A sale rung
    // up at the till has no waiter; a restaurant may have no published phone; an order that has not
    // been paid yet has no payment method at all. The template already prints each only when it is
    // there, so requiring them bought nothing and refused to print a lawful receipt over a field
    // the sale does not have. What a receipt must carry — the TIN, the premises, the invoice type,
    // the items and the arithmetic — is still required above and below.
    phone: optionalText,
    cashier: optionalText,
    waiter: optionalText,
    table: z.number().nullable().optional(),

    // Which printer this ticket belongs at — kitchen, bar, reception. Absent means the default,
    // which is the whole configuration for a restaurant with one printer at the till.
    station: optionalText,

    items: z.array(PrintItemSchema).min(1, 'At least one item is required'),

    subtotal: z.number().nonnegative('Subtotal must be >= 0'),
    serviceCharge: z.number().nonnegative('Service charge must be >= 0'),
    vat: z.number().nonnegative('VAT must be >= 0'),
    vatPercentage: z.number().nonnegative('VAT percentage must be >= 0'),

    serviceChargePercentage: z.number().nonnegative().optional(),
    convenienceFee: z.number().nonnegative().optional(),
    roundingDifference: z.number().optional(),

    total: z.number().nonnegative('Total must be >= 0'),

    // Absent means no, which is what an order that has never been paid or printed actually looks
    // like coming out of Mongo. Requiring the field meant a boolean that was simply never written
    // failed the schema, and the till was told the printer had a problem.
    paidByCash: optionalFlag,
    isPaid: optionalFlag,
    isReceiptPrinted: optionalFlag,

    // Was an enum of three names, one of which the API no longer has, and it excluded null — which
    // is every unpaid order. The bridge prints this word on a line; it does not authorise anything
    // with it, so an enum here was a validation rule with no one behind it that rejected real
    // receipts. What a payment method may be is the API's question, and it answers it in
    // PaymentMethod.from.
    paymentMethod: optionalText,
    restaurantId: z.string().min(1, 'Restaurant ID is required'),

    paymentStatus: optionalText,
    isReadOnlyMode: optionalFlag,
    jobId: optionalText,

    // Art 4(3)(c): what the Authority returns when it registers a sale. All optional, because there
    // is no transmission specification yet and nothing is registered — a receipt printed today
    // carries none of them, and the template omits what is absent. They are declared now so that
    // the day registration goes live the bridge accepts them instead of rejecting every receipt in
    // the country with a 400.
    irn: optionalText,
    rrn: optionalText,
    fiscalQr: optionalText,
    fiscalState: optionalText,

    // Where the diner's own copy of this receipt lives, encoded into the QR at the foot of the
    // slip. Built by the till from its own origin, because the address it reached this box on is by
    // construction one the restaurant's network resolves.
    receiptUrl: optionalText
});


/**
 * A production ticket: what to make, for which table, at which station.
 *
 * Almost nothing in common with a receipt, which is the point — no TIN, no VAT, no totals. A cook
 * needs the food and the table; the tax arithmetic belongs on the diner's copy.
 */
const TicketItemSchema = z.object({
    name: z.string().min(1, 'Item name is required'),
    quantity: z.number().int().positive('Item quantity must be > 0'),
    note: optionalText
});

const TicketPayloadSchema = z.object({
    jobId: z.string().min(1, 'jobId is required'),
    station: optionalText,
    orderNumber: z.string().min(1, 'Order number is required'),
    table: z.number().nullable().optional(),
    time: optionalText,
    waiter: optionalText,
    items: z.array(TicketItemSchema).min(1, 'A ticket with no items is not worth printing')
});

module.exports = {
    PrintPayloadSchema,
    TicketPayloadSchema
};
