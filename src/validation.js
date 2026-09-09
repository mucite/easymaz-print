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
    phone: z.string().min(1, 'Phone is required'),
    fsNo: z.string().min(1, 'FS number is required'),
    orderNumber: z.string().min(1, 'Order number is required'),
    date: z.string().min(1, 'Date is required'),
    invoiceType: z.string().min(1, 'Invoice type is required'),
    cashier: z.string().min(1, 'Cashier is required'),
    waiter: z.string().min(1, 'Waiter is required'),
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

    paidByCash: z.boolean(),
    isPaid: z.boolean(),

    paymentMethod: z.enum(['CHAPA', 'CASH', 'STRIPE']),
    restaurantId: z.string().min(1, 'Restaurant ID is required'),
    isReceiptPrinted: z.boolean(),

    paymentStatus: z.string().optional(),
    isReadOnlyMode: z.boolean().optional(),
    jobId: z.string().optional()
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
