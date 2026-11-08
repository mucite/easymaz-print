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

/**
 * The same, for money and for a rate.
 *
 * A figure the restaurant does not have arrives as null from Jackson and as "" from a form, exactly
 * as a text field does, and `z.number().optional()` would have called either a type error and
 * refused the whole receipt over a discount nobody gave.
 */
const optionalAmount = z.preprocess(
    (value) => (absent(value) ? undefined : value),
    z.number().nonnegative().optional()
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

    /**
     * The seller's address as ANNEX 1 of the EIMS compliance guideline asks for it, and the day the
     * seller was registered for VAT.
     *
     * The Annex does not accept an address as one line: its `ከ / From` block names a city, a zone or
     * sub city, a woreda, a kebele and a house number, each on its own. They are optional all the
     * same, and the flat `address` above stays required and stays what prints when no part was sent,
     * because the restaurants printing today have their address saved as one line and a receipt must
     * not stop coming out of the printer on the day the Annex is read. Unprefixed, because this is
     * the seller — the buyer's own are below, under `buyer`.
     */
    city: optionalText,
    subCity: optionalText,
    woreda: optionalText,
    kebele: optionalText,
    houseNumber: optionalText,
    // Printed only beside a VAT number, because a restaurant that is not registered has neither.
    sellerVatRegisteredOn: optionalText,
    // The invoice's own serial, continuous per restaurant and assigned when the sale is settled (VAT
    // Regulation Art 20, through Directive 1142/2026 Art 4(1)(a)). Optional because an unsettled bill
    // has none yet, and a sale settled before the series existed never will. It used to be required,
    // and was fed the order's database id to satisfy that — a number that meant nothing to anyone.
    fsNo: optionalText,

    /**
     * The buyer, when they asked to be named on the invoice — Art 23(3).
     *
     * ANNEX 1's `ለ / To` block is the seller's repeated for the buyer, and almost all of it is for a
     * business buying from a business. A restaurant's customer is a diner: a sale here is B2C unless
     * somebody hands over a TIN, and the EIMS schema says as much — on a B2C sale the buyer's TIN
     * may be null and the buyer's VAT number must be. So the buyer has a name, an address and a TIN
     * here and nothing else. A buyer VAT number is not an optional field on this document, it is a
     * field this document does not have: a diner has no VAT registration to print, and a label with
     * nothing behind it is the thing somebody eventually fills in wrongly.
     *
     * Every one of them is optional, and the whole block is absent from an ordinary sale.
     */
    buyerName: optionalText,
    buyerTin: optionalText,
    buyerPhone: optionalText,
    buyerAddress: optionalText,
    buyerCity: optionalText,
    buyerSubCity: optionalText,
    buyerWoreda: optionalText,
    buyerKebele: optionalText,
    buyerHouseNumber: optionalText,
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
    // ANNEX 1 asks who made the document out as well as who took the money: `ያዘጋጀው ስምና ፊርማ /
    // Prepared By`, against the cashier it already names as the receiver. Nothing sends it today.
    preparedBy: optionalText,
    table: z.number().nullable().optional(),

    // Which printer this ticket belongs at — kitchen, bar, reception. Absent means the default,
    // which is the whole configuration for a restaurant with one printer at the till.
    station: optionalText,

    items: z.array(PrintItemSchema).min(1, 'At least one item is required'),

    subtotal: z.number().nonnegative('Subtotal must be >= 0'),
    serviceCharge: z.number().nonnegative('Service charge must be >= 0'),
    taxableAmount: z.number().nonnegative('Amount before VAT must be >= 0'),
    vat: z.number().nonnegative('VAT must be >= 0'),
    vatPercentage: z.number().nonnegative('VAT percentage must be >= 0'),

    serviceChargePercentage: z.number().nonnegative().optional(),
    /** VAT_INCLUSIVE or VAT_EXCLUSIVE; absent reads as inclusive. */
    menuPricing: z.enum(['VAT_INCLUSIVE', 'VAT_EXCLUSIVE']).optional(),
    convenienceFee: z.number().nonnegative().optional(),

    /**
     * The rest of ANNEX 1's totals block, as far as it applies to this trade.
     *
     * A discount given, and what was actually collected against the invoice. The Annex's other two —
     * the amount withheld at source, and the rate a foreign-currency invoice was converted at — are
     * not here at all: withholding is something a government body does when it pays a supplier, and
     * every bill this bridge prints is in Birr. Neither is computed here either way. The bridge
     * prints figures; the arithmetic belongs to whoever issued the invoice.
     */
    discountGiven: optionalAmount,
    collectedAmount: optionalAmount,

    total: z.number().nonnegative('Total must be >= 0'),

    // Absent means no, which is what an order that has never been paid or printed looks like on
    // the wire. Requiring the field meant a boolean that was simply never written failed the
    // schema, and the till was told the printer had a problem.
    paidByCash: optionalFlag,
    isPaid: optionalFlag,
    isReceiptPrinted: optionalFlag,
    // The restaurant's Cash drawer setting, sent by the API. Absent is on; only false keeps it shut.
    cashDrawer: z.boolean().optional(),

    // Was an enum of three names, one of which the API no longer has, and it excluded null — which
    // is every unpaid order. The bridge prints this word on a line; it does not authorise anything
    // with it, so an enum here was a validation rule with no one behind it that rejected real
    // receipts. What a payment method may be is the API's question, and it answers it in
    // PaymentMethod.from.
    paymentMethod: optionalText,
    // The cash handed over, for a change line; and the wallet a phone prompt went to, so the slip
    // says "MOBILE MONEY TELEBIRR" rather than the gateway's name. Both optional, both only printed.
    tenderedAmount: z.number().nonnegative().optional().nullable(),
    paymentWallet: optionalText,
    // ANNEX 1's `የክፍያ ሁኔታ / Mode of Payment` is four columns and the bridge already prints the
    // first of them as the payment line, in the words a diner knows. Of the other three it keeps
    // the reference the payment carries, and why the payment was made. The service provider is the
    // gateway, which this slip has never named and is not going to start naming; the ticket's
    // from-to belongs to a transport operator.
    paymentDescription: optionalText,
    paymentReference: optionalText,
    restaurantId: z.string().min(1, 'Restaurant ID is required'),

    paymentStatus: optionalText,
    jobId: optionalText,

    // Art 4(3)(c): what the Authority returns when it registers a sale. All optional, because there
    // is no transmission specification yet and nothing is registered — a receipt printed today
    // carries none of them, and the template omits what is absent. They are declared now so that
    // the day registration goes live the bridge accepts them instead of rejecting every receipt in
    // the country with a 400.
    irn: optionalText,
    rrn: optionalText,
    fiscalQr: optionalText,
    /**
     * The Authority's QR as the Authority drew it: EIMS returns `signedQR`, a 600x600 PNG at error
     * correction H, base64-encoded, and that image is what their official app validates against
     * their records. It is not the same thing as fiscalQr above, which is the content. Encoding
     * that content into a code of our own produces a picture the Ministry never signed, so where
     * this is present it is what prints.
     *
     * Not length-capped here. The cap belongs where the image is read, which knows what a QR code
     * can plausibly weigh; a cap in the schema would reject the whole job over a bad image rather
     * than print the slip without the code, which is the wrong answer for a diner who has paid.
     */
    fiscalQrImage: optionalText,
    fiscalState: optionalText,
    // Whether Directive 1142/2026 has commenced for this deployment. Until it has, a slip without an
    // IRN is an ordinary receipt under the rules that apply today, and says nothing about it.
    directiveInForce: optionalFlag,
    // On an orders-only pilot: every bill is settled on the restaurant's own register, so a slip
    // printed here always says it is not a fiscal receipt.
    ordersOnlyPilot: optionalFlag,
    // On a pilot: how the diner paid at the restaurant's own register, CASH or MOBILE.
    pilotPaidWith: optionalText,

    /**
     * Who approved this software for use, for the sentence ANNEX 1 puts at the foot of the paper:
     * the program was authorised for use by a tax authority, at a named tax centre, on a date.
     *
     * A group rather than three loose fields, because the three are one statement and two thirds of
     * it is not a smaller statement — it is a false one. Nothing sends it today, and nothing can:
     * no authority has approved this software for anything, which is the open item behind the whole
     * accreditation question. It is declared so the sentence prints itself the day one does, and
     * the bridge prints what it is given rather than being taught to write it.
     */
    authorisation: z.object({
        taxAuthority: optionalText,
        taxCentre: optionalText,
        authorisedOn: optionalText
    }).nullish(),

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

/**
 * Where a station's printer is, as the owner saved it in the admin.
 *
 * Sent with each job so the box's saved list decides where paper comes out, without anyone editing
 * PRINTERS in the box's .env. A host is an IPv4 address or a hostname — never a URL or a path.
 */
const HOST = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|(?![\d.]+$)(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;

const TargetSchema = z.object({
    host: z.string().trim().regex(HOST, 'host must be an IPv4 address or a hostname'),
    port: z.number().int().min(1).max(65535),
    width: z.number().int().min(20).max(96).optional(),
    cut: z.enum(['full', 'partial']).optional()
});

const TicketPayloadSchema = z.object({
    jobId: z.string().min(1, 'jobId is required'),
    station: optionalText,
    // The station's printer, from the list saved on the box. Absent: PRINTERS in .env, then the
    // register printer.
    target: TargetSchema.nullish(),
    orderNumber: z.string().min(1, 'Order number is required'),
    table: z.number().nullable().optional(),
    time: optionalText,
    waiter: optionalText,
    // A second copy of a ticket the kitchen may already have. Printed as such, so nobody cooks the
    // order twice.
    reprint: z.boolean().optional(),
    // A note for the whole order rather than one dish, printed boxed under the items. Nothing sends
    // one yet: an order has no note of its own (its remark is the reason it was cancelled).
    note: optionalText,
    items: z.array(TicketItemSchema).min(1, 'A ticket with no items is not worth printing')
});

/**
 * Opening the cash drawer with no sale behind it.
 *
 * The till legitimately needs this — a float counted in at the start of a shift, a miscount
 * corrected — so the route stays. What it had behind it was nothing at all: an empty POST carrying
 * the shared key opened the drawer, which is the one thing on this box that moves money and the one
 * job that left no record of who asked or why. A drawer that opens on request and records nothing is
 * an accounting hole wide enough to walk cash out of.
 *
 * So the body names a reason and a person, and carries a jobId like every other job here, so a relay
 * retrying a slow request opens the drawer once rather than twice. None of it is printed — there is
 * no paper — it goes in the log beside the pulse, which is where somebody reconciling a short till
 * has to be able to look.
 */
const DrawerPayloadSchema = z.object({
    jobId: z.string().min(1, 'jobId is required'),
    reason: z.string().trim().min(1, 'A reason is required'),
    openedBy: z.string().trim().min(1, 'Who is opening the drawer is required')
});

/** A test slip: which station, and optionally where its printer is. Both may be absent. */
const TestPrintSchema = z.object({
    station: optionalText,
    target: TargetSchema.nullish()
});

/**
 * A Tax Credit Note: the document Directive 1142/2018 E.C. Art 25 asks for when a sale is returned,
 * in part or in full.
 *
 * Its own schema rather than optional fields on the receipt's, because it is a different document
 * that happens to arrive on the same route. The API's print relay forwards whatever it is handed to
 * /print, and the `type` is how the bridge tells the two apart. Grafting it onto the receipt schema
 * would have meant a credit note carrying an invoice type, a subtotal and a service charge it does
 * not have, or every receipt field turning optional to make room for one.
 *
 * Lenient where the API may legitimately have nothing — the restaurant's identifiers, the invoice
 * being credited, the table, who issued and approved it. Those are printed when present and omitted
 * when not, the same rule the receipt follows, and refusing to print a refund over a missing phone
 * number would leave money handed back with no paper behind it.
 *
 * Strict on what the document is for: the money, the lines, the method, and whether the drawer
 * opens. A wrong amount on a credit note is a wrong tax return, and a drawer flag that is anything
 * but a boolean is a till opening on a guess.
 */
const CreditNoteLineSchema = z.object({
    name: z.string().min(1, 'Line name is required'),
    quantity: z.number().positive('Line quantity must be > 0'),
    amount: z.number().nonnegative('Line amount must be >= 0')
});

const CreditNotePayloadSchema = z.object({
    type: z.literal('CREDIT_NOTE'),
    // Required, unlike a receipt's. A refund printed twice is two documents saying the same money
    // went back twice, and the relay retries.
    jobId: z.string().min(1, 'jobId is required'),
    // nullish rather than required: the header prints what it is given, and a restaurant row with
    // nothing on it still has a credit note to issue.
    restaurant: z.object({
        name: optionalText,
        tin: optionalText,
        vatNumber: optionalText,
        address: optionalText,
        phone: optionalText
    }).nullish(),
    creditNoteNumber: z.string().min(1, 'Credit note number is required'),
    // A sale settled before the invoice series existed has no number to credit against. The order
    // number below still identifies it.
    originalInvoiceNumber: optionalText,
    orderNumber: z.string().min(1, 'Order number is required'),
    table: z.union([z.string(), z.number()]).nullish(),
    issuedAt: z.string().min(1, 'Issue time is required'),
    reason: z.string().trim().min(1, 'A reason is required'),
    lines: z.array(CreditNoteLineSchema).min(1, 'A credit note with no lines credits nothing'),
    amount: z.number().positive('Amount returned must be > 0'),
    vatIncluded: z.number().nonnegative('VAT included must be >= 0'),
    method: z.enum(['CASH', 'CHAPA']),
    issuedBy: optionalText,
    approvedBy: optionalText,
    openDrawer: z.boolean()
}).refine(note => note.vatIncluded <= note.amount, {
    // Included in the amount, as on the receipt. More VAT than money is arithmetic gone wrong
    // upstream, and paper is the wrong place to discover it.
    message: 'VAT included cannot exceed the amount returned',
    path: ['vatIncluded']
});

module.exports = {
    CreditNotePayloadSchema,
    DrawerPayloadSchema,
    PrintPayloadSchema,
    TicketPayloadSchema,
    TestPrintSchema,
    TargetSchema
};
