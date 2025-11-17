const { z } = require('zod');

const PrintItemSchema = z.object({
    name: z.string().min(1, 'Item name is required'),
    quantity: z.number().int().positive('Item quantity must be > 0'),
    price: z.number().nonnegative('Item price must be >= 0')
});

const PrintPayloadSchema = z.object({
    tin: z.number(), // you had "number" in TS, if it's string in JSON, change to z.string()
    businessName: z.string().min(1, 'Business name is required'),
    address: z.string().min(1, 'Address is required'),
    phone: z.string().min(1, 'Phone is required'),
    fsNo: z.string().min(1, 'FS number is required'),
    orderNumber: z.string().min(1, 'Order number is required'),
    date: z.string().min(1, 'Date is required'),
    invoiceType: z.string().min(1, 'Invoice type is required'),
    cashier: z.string().min(1, 'Cashier is required'),
    waiter: z.string().min(1, 'Waiter is required'),
    table: z.string().min(1, 'Table is required'),

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

    checkOutUrl: z.string().optional(),
    paymentStatus: z.string().optional(),
    isReadOnlyMode: z.boolean().optional()
});

module.exports = {
    PrintPayloadSchema
};
