const { z } = require('zod');

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
    vatRegistrationNumber: z.string().min(1).optional(),
    fsNumber: z.string().min(1).optional(),
    mrcNumber: z.string().min(1).optional(),

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
    phone: z.string().min(1).optional(),
    cashier: z.string().min(1).optional(),
    waiter: z.string().min(1).optional(),
    table: z.number().nullable().optional(),

    // Which printer this ticket belongs at — kitchen, bar, reception. Absent means the default,
    // which is the whole configuration for a restaurant with one printer at the till.
    station: z.string().min(1).optional(),

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
    paidByCash: z.boolean().optional().default(false),
    isPaid: z.boolean().optional().default(false),
    isReceiptPrinted: z.boolean().optional().default(false),

    // Was an enum of three names, one of which the API no longer has, and it excluded null — which
    // is every unpaid order. The bridge prints this word on a line; it does not authorise anything
    // with it, so an enum here was a validation rule with no one behind it that rejected real
    // receipts. What a payment method may be is the API's question, and it answers it in
    // PaymentMethod.from.
    paymentMethod: z.string().min(1).nullable().optional(),
    restaurantId: z.string().min(1, 'Restaurant ID is required'),

    paymentStatus: z.string().optional(),
    isReadOnlyMode: z.boolean().optional(),
    jobId: z.string().optional(),

    // Art 4(3)(c): what the Authority returns when it registers a sale. All optional, because there
    // is no transmission specification yet and nothing is registered — a receipt printed today
    // carries none of them, and the template omits what is absent. They are declared now so that
    // the day registration goes live the bridge accepts them instead of rejecting every receipt in
    // the country with a 400.
    irn: z.string().min(1).optional(),
    rrn: z.string().min(1).optional(),
    fiscalQr: z.string().min(1).optional(),
    fiscalState: z.string().min(1).optional()
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
    note: z.string().optional()
});

const TicketPayloadSchema = z.object({
    jobId: z.string().min(1, 'jobId is required'),
    station: z.string().min(1).optional(),
    orderNumber: z.string().min(1, 'Order number is required'),
    table: z.number().nullable().optional(),
    time: z.string().optional(),
    waiter: z.string().optional(),
    items: z.array(TicketItemSchema).min(1, 'A ticket with no items is not worth printing')
});

module.exports = {
    PrintPayloadSchema,
    TicketPayloadSchema
};
