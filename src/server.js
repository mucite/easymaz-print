require('dotenv').config();
const express = require('express');
const http    = require('http');
const crypto  = require('crypto');
const { printReceipt, printCreditNote, printTicket, printTestPage, openDrawer, stations, registerConfigured, defaultPrinterStatus } = require('./printer');
const { toField } = require('./charset');
const { networkPrinter } = require('./discovery');
const { PrintPayloadSchema, CreditNotePayloadSchema, TicketPayloadSchema, TestPrintSchema, DrawerPayloadSchema } = require('./validation');

const app  = express();
const PORT = Number(process.env.PORT) || 3001;

// Every interface, because inside a container that is the only way the API next door can reach it:
// bind 127.0.0.1 here and the loopback is the container's own, which nothing else shares. What
// keeps this off the restaurant's WiFi is not the bind address but the compose file, which
// publishes no port for this service - so the only sockets that can be opened here belong to the
// containers beside it.
//
// It is configurable for the one case that is not that: running the bridge bare on a machine, for
// a test or a repair, where every interface means the whole network and this process will open a
// cash drawer for anybody holding the secret. Set PRINT_BIND_ADDRESS=127.0.0.1 then.
const BIND_ADDRESS = process.env.PRINT_BIND_ADDRESS || '0.0.0.0';

// No CORS, and no TLS. Both existed for a browser talking to this bridge directly — an admin page
// on the restaurant's network reaching a mkcert-secured https://192.168.x.x, with an origin allowlist
// deciding who could ask.
//
// Nothing does that now. Receipts and tickets go through the API, which relays them over the
// compose network, and the compose file publishes no port for this service at all: the only things
// that can open a socket here are the API and the nginx container beside it. Both are server-side,
// neither sends an Origin, and neither preflights. An allowlist that no request is ever measured
// against is not protection, it is a comment that looks like protection — and the shared secret
// below is what actually decides whether a job prints.
//
// TLS went with it for the same reason. There is no network hop to encrypt: both ends are
// containers on one host, and the certificate existed so a browser would trust a LAN address.
app.use(express.json());

/**
 * The shared secret this bridge will accept print jobs with.
 *
 * Until this existed the only protection was CORS, which is a rule browsers agree to follow and
 * nothing else does — a plain POST from anywhere on the restaurant's network printed whatever it liked
 * on the till or kitchen printer. On a fiscal device that is a forged receipt, not a prank.
 */
const PRINT_KEY = process.env.PRINT_SHARED_SECRET || '';

if (!PRINT_KEY) {
  console.warn(
    'PRINT_SHARED_SECRET is not set — this bridge will accept print jobs from anyone who can reach ' +
    'it. Set it on the box and on the API so jobs have to come from a signed-in session.'
  );
}

/**
 * The presented key against the configured one, without telling the caller how far they got.
 *
 * `!==` on two strings stops at the first byte that differs, so a caller on the restaurant's network
 * can time a few thousand requests and read the secret out of the bridge one character at a time —
 * the whole point of the secret being that only the API holds it.
 *
 * Both sides are hashed before they are compared because timingSafeEqual refuses buffers of
 * different lengths, and checking the length first to avoid that would hand back the one fact the
 * comparison was meant to hide. A digest is always 32 bytes, so a key of the wrong length takes the
 * same path and the same time as a key of the right length with the wrong contents.
 */
function keyAccepted(presented) {
  const offered = crypto.createHash('sha256').update(String(presented == null ? '' : presented)).digest();
  const expected = crypto.createHash('sha256').update(PRINT_KEY).digest();
  return crypto.timingSafeEqual(offered, expected);
}

/**
 * Print jobs must carry the secret; /health need not.
 *
 * Health is how an engineer on the phone checks whether a printer is configured at all, and it
 * reveals a mode and an address rather than anything about a sale. Kept open deliberately, and it is
 * the one route a caller can reach without the key.
 */
app.use((req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  if (!PRINT_KEY) {
    // Nothing configured: refuse rather than silently accept. A bridge that prints for anybody is
    // worse than a till that says printing is not set up.
    return res.status(503).json({
      success: false,
      errors: ['Printing is not configured on this machine: PRINT_SHARED_SECRET is unset.']
    });
  }
  const presented = req.headers['x-print-key'];
  if (!keyAccepted(presented)) {
    console.warn(`Refused a print job with %s key from %s`,
      presented ? 'the wrong' : 'no', req.ip);
    return res.status(401).json({ success: false, errors: ['Not authorised to print here.'] });
  }
  next();
});

// Deduplication: track recently printed jobIds to prevent duplicate thermal prints
// when a retry fires after a successful-but-timed-out response.
const recentJobs = new Map(); // jobId -> timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function isDuplicate(jobId) {
  if (!jobId) return false;
  const ts = recentJobs.get(jobId);
  return ts != null && (Date.now() - ts) < DEDUP_WINDOW_MS;
}

function markPrinted(jobId) {
  if (!jobId) return;
  recentJobs.set(jobId, Date.now());
  if (recentJobs.size > 500) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [id, ts] of recentJobs) {
      if (ts < cutoff) recentJobs.delete(id);
    }
  }
}

app.get('/health', (req, res) => {
  // Where the register printer is, configured or found. `auto` says it was found rather than set;
  // mode "none" means nothing is plugged in and no single network printer answered the last look.
  const printer = defaultPrinterStatus();

  // The configured stations are reported so an installer can confirm what the box thinks it has
  // without printing a test ticket at every one of them.
  const configured = stations();
  const named = Object.fromEntries(
    Object.entries(configured).map(([name, t]) => [name, `${t.host}:${t.port}`])
  );

  // Named stations are optional; the register's own printer is not. Reported rather than assumed,
  // because with nothing configured the address above is a guess at 127.0.0.1 that looks like a
  // setting and fails as a refused socket — which reads as a broken printer instead of an
  // unfinished install. 200 either way: the bridge is up and answering, and that is what a status
  // code is for. The field is the answer.
  const register = registerConfigured();

  res.status(200).json({
    status: register ? 'ok' : 'unconfigured',
    registerConfigured: register,
    printer,
    stations: named
  });
});

/**
 * A production ticket, for the station that makes the order.
 *
 * Its own route rather than a flag on /print because it is a different document: no TIN, no VAT,
 * no totals, and a layout in double-height type meant to be read across a hot kitchen. Sharing the
 * receipt's schema would have meant inventing tax fields for a ticket that has no business
 * carrying them.
 */
app.post('/ticket', async (req, res) => {
  const parsed = TicketPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return res.status(400).json({ success: false, errors });
  }

  const { jobId, target, ...ticket } = parsed.data;

  // Same dedup as receipts. A till retrying a request must not put a second copy of the same food
  // on the pass — the kitchen would cook it.
  if (isDuplicate(jobId)) {
    console.log(`[dedup] Skipping duplicate ticket ${jobId}`);
    return res.json({ success: true, message: 'duplicate, already printed' });
  }

  try {
    await printTicket(ticket, target);
    markPrinted(jobId);
    return res.json({ success: true, station: ticket.station || 'default' });
  } catch (err) {
    console.error(`[ticket] ${err.message}`);
    return res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * A Tax Credit Note, which reaches the bridge on /print because the API's relay forwards every print
 * job there unchanged.
 *
 * Split off by its `type` before the receipt schema sees it: a credit note has none of a receipt's
 * required fields, and would otherwise be refused as a receipt missing its TIN. Anything without
 * that type is a receipt, exactly as before.
 */
async function printCreditNoteJob(req, res) {
  const parsed = CreditNotePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return res.status(400).json({ success: false, errors });
  }

  const note = parsed.data;

  // The same window as receipts. A relay retry after a slow printer must not hand the customer a
  // second credit note — or open the drawer a second time for money that has already gone out.
  if (isDuplicate(note.jobId)) {
    console.log(`[dedup] Skipping duplicate credit note ${note.jobId}`);
    return res.json({ success: true, message: 'duplicate, already printed' });
  }

  try {
    await printCreditNote(note);
    markPrinted(note.jobId);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[credit-note] ${err.message}`);
    return res.status(502).json({ success: false, error: err.message || 'Failed to print' });
  }
}

app.post('/print', async (req, res) => {
  if (req.body && req.body.type === 'CREDIT_NOTE') {
    return printCreditNoteJob(req, res);
  }

  const parsed = PrintPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return res.status(400).json({ success: false, errors });
  }

  const { jobId, station, ...printData } = parsed.data;

  if (isDuplicate(jobId)) {
    console.log(`[dedup] Skipping duplicate job ${jobId}`);
    return res.json({ success: true, message: 'duplicate, already printed' });
  }

  try {
    await printReceipt(printData, station);
    markPrinted(jobId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Print error:', err);
    return res.status(502).json({ success: false, error: err.message || 'Failed to print' });
  }
});

/**
 * Prints a slip that proves the printer works, carrying no sale.
 *
 * The other two routes need a document before they will print anything: a receipt needs a TIN, a
 * VAT breakdown and an arithmetic-consistent total, and a ticket needs an order. Neither is
 * something a person holding a newly wired printer has, and inventing a plausible sale to find out
 * whether paper comes out is a poor first hour — worse on a fiscal device, where the invented sale
 * prints as a receipt.
 *
 * So this route takes nothing. An optional station names which printer to test on a site with
 * several; absent, it is the register's, which is the whole configuration for most sites. An
 * optional target is that station's address as saved on the box, and wins over PRINTERS.
 *
 * Not deduplicated, deliberately. The jobId window exists so a till's retry does not cook the food
 * twice; somebody testing a printer presses this repeatedly and means it every time.
 */
app.post('/test-print', async (req, res) => {
  const parsed = TestPrintSchema.safeParse({
    station: (req.body && req.body.station) || req.query.station,
    target: req.body && req.body.target
  });
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return res.status(400).json({ success: false, errors });
  }
  const { station, target } = parsed.data;

  try {
    const info = await printTestPage(station, target);
    console.log(`[test-print] sent ${info.bytes} bytes to ${info.target} (${info.station})`);
    return res.json({ success: true, ...info });
  } catch (err) {
    // The address is reported alongside the failure because it is the answer half the time: the
    // bridge is fine and is talking to a printer that is off, or at an address nobody has moved
    // since it was typed in.
    console.error(`[test-print] ${err.message}`);
    return res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * The cash drawer, opened on its own for a shift's count.
 *
 * Behind the same print key as every job, and behind a body as well. The key says the request came
 * from the API; it says nothing about why the till is opening with no sale behind it, and this is
 * the only route here that moves money rather than paper. So the API has to name the reason and the
 * person, and the pair goes to the log where somebody reconciling a short drawer can find it.
 *
 * Deduplicated like a receipt, and for a sharper reason than a receipt has: a relay retrying a
 * request that was slow rather than refused would open the drawer a second time, with a different
 * person possibly standing at it.
 */
app.post('/drawer', async (req, res) => {
  const parsed = DrawerPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return res.status(400).json({ success: false, errors });
  }

  const { jobId, reason, openedBy } = parsed.data;

  if (isDuplicate(jobId)) {
    console.log(`[dedup] Skipping duplicate drawer open ${jobId}`);
    return res.json({ success: true, message: 'duplicate, already opened' });
  }

  try {
    await openDrawer();
    markPrinted(jobId);
    // Through the same filter the paper goes through. A reason is free text typed by somebody, and a
    // log line is read in a terminal that obeys escape sequences much as a printer does.
    console.log(`[drawer] opened for ${toField(reason, 80)} by ${toField(openedBy, 40)} (job ${toField(jobId, 64)})`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[drawer] ${err.message}`);
    return res.status(502).json({ success: false, error: err.message });
  }
});

function logPrinterTarget() {
  if (process.env.PRINTER_CMD) {
    console.log(`[easymaz-print] Printer CMD  ${process.env.PRINTER_CMD}`);
  } else if (process.env.PRINTER_DEVICE) {
    console.log(`[easymaz-print] Printer USB  ${process.env.PRINTER_DEVICE}`);
  } else if (process.env.PRINTER_HOST || process.env.PRINTER_IP) {
    const host = process.env.PRINTER_HOST || process.env.PRINTER_IP;
    console.log(`[easymaz-print] Printer TCP  ${host}:${process.env.PRINTER_PORT || 9100}`);
  } else {
    // Nothing configured is the ordinary case now: the register printer is found, not typed in. A
    // USB printer is used as soon as it is plugged in; otherwise the box's LAN is looked over for a
    // single printer on the raw port, now rather than on the first receipt, so that receipt does
    // not wait on the scan.
    const found = defaultPrinterStatus();
    if (found.mode === 'usb') {
      console.log(`[easymaz-print] Printer USB  ${found.device} (found)`);
    } else {
      console.log('[easymaz-print] Printer      none configured — looking for one (USB, or the network)');
      networkPrinter({ port: Number(process.env.PRINTER_PORT) || 9100 })
        .then(({ host, candidates, noLan }) => {
          if (host) console.log(`[easymaz-print] Printer TCP  ${host} (found)`);
          else if (noLan) console.warn('[easymaz-print] BOX_LAN_ADDRESS is unset, so the network is not searched — plug a USB printer in or set PRINTER_IP');
          else if (candidates.length > 1) console.warn(`[easymaz-print] several printers answer (${candidates.join(', ')}) — set PRINTER_IP to the sales register's`);
          else console.warn('[easymaz-print] no printer found yet — plug one in by USB or connect it to the network; each receipt looks again');
        })
        .catch(() => {});
    }
  }

  const named = Object.keys(stations());
  console.log(
    named.length
      ? `[easymaz-print] Stations     ${named.join(', ')}`
      : '[easymaz-print] Stations     none — everything prints at the register'
  );
}

function startServer() {
  http.createServer(app).listen(PORT, BIND_ADDRESS, () => {
    console.log(`[easymaz-print] HTTP   http://0.0.0.0:${PORT}`);
    logPrinterTarget();
  });
}

startServer();
