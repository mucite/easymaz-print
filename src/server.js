require('dotenv').config();
const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const { printReceipt, printTicket, stations, registerConfigured } = require('./printer');
const { PrintPayloadSchema, TicketPayloadSchema } = require('./validation');

const app  = express();
const PORT = Number(process.env.PORT) || 3001;

const SSL_CERT = process.env.SSL_CERT_PATH;
const SSL_KEY  = process.env.SSL_KEY_PATH;

// When using a local mkcert cert the Origin will be https://192.168.x.x or
// https://admin.easymaz.com; allow both. Local dev origins included for convenience.
const ALLOWED_ORIGINS = new Set([
  'https://admin.easymaz.com',
  'http://localhost:4200',
  'http://localhost:3000',
]);

// Any https:// origin on a private LAN IP is also allowed so that the admin
// works offline (no tunnel) from any device on the restaurant's WiFi.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // https://<private-IP>:<any-port>  — covers mkcert-secured LAN access
  return /^https:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Chrome 94+ Private Network Access: allows https pages to call http://localhost
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

/**
 * The shared secret this bridge will accept print jobs with.
 *
 * Until this existed the only protection was CORS, which is a rule browsers agree to follow and
 * nothing else does — a plain POST from anywhere on the restaurant's WiFi printed whatever it liked
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
 * Print jobs must carry the secret; /health need not.
 *
 * Health is how an engineer on the phone checks whether a printer is configured at all, and it
 * reveals a mode and an address rather than anything about a sale. Kept open deliberately, and it is
 * the one route a caller can reach without the key.
 */
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/health') {
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
  if (presented !== PRINT_KEY) {
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
  const printer = process.env.PRINTER_CMD
    ? { mode: 'cmd', command: process.env.PRINTER_CMD }
    : process.env.PRINTER_DEVICE
      ? { mode: 'usb', device: process.env.PRINTER_DEVICE }
      : { mode: 'tcp', address: `${process.env.PRINTER_HOST || '127.0.0.1'}:${process.env.PRINTER_PORT || 9100}` };

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
    tls: !!(SSL_CERT && SSL_KEY),
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

  const { jobId, ...ticket } = parsed.data;

  // Same dedup as receipts. A till retrying a request must not put a second copy of the same food
  // on the pass — the kitchen would cook it.
  if (isDuplicate(jobId)) {
    console.log(`[dedup] Skipping duplicate ticket ${jobId}`);
    return res.json({ success: true, message: 'duplicate, already printed' });
  }

  try {
    await printTicket(ticket);
    markPrinted(jobId);
    return res.json({ success: true, station: ticket.station || 'default' });
  } catch (err) {
    console.error(`[ticket] ${err.message}`);
    return res.status(502).json({ success: false, error: err.message });
  }
});

app.post('/print', async (req, res) => {
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

function logPrinterTarget() {
  if (process.env.PRINTER_CMD) {
    console.log(`[easymaz-print] Printer CMD  ${process.env.PRINTER_CMD}`);
  } else if (process.env.PRINTER_DEVICE) {
    console.log(`[easymaz-print] Printer USB  ${process.env.PRINTER_DEVICE}`);
  } else if (process.env.PRINTER_HOST || process.env.PRINTER_IP) {
    const host = process.env.PRINTER_HOST || process.env.PRINTER_IP;
    console.log(`[easymaz-print] Printer TCP  ${host}:${process.env.PRINTER_PORT || 9100}`);
  } else {
    // Said once, at the top, rather than discovered later as a refused socket per receipt. Named
    // stations are optional and most restaurants configure none; the register's printer is the one
    // that is not, because a receipt is a fiscal document with nowhere else to go.
    console.warn(
      '[easymaz-print] No register printer configured — set PRINTER_CMD, PRINTER_DEVICE or ' +
      'PRINTER_HOST (PRINTER_IP is accepted too). ' +
      `Receipts will be sent to 127.0.0.1:${process.env.PRINTER_PORT || 9100} and fail.`
    );
  }

  const named = Object.keys(stations());
  console.log(
    named.length
      ? `[easymaz-print] Stations     ${named.join(', ')}`
      : '[easymaz-print] Stations     none — everything prints at the register'
  );
}

function startServer() {
  if (SSL_CERT && SSL_KEY) {
    let cert, key;
    try {
      cert = fs.readFileSync(SSL_CERT);
      key  = fs.readFileSync(SSL_KEY);
    } catch (err) {
      console.error(`[TLS] Failed to load cert/key: ${err.message}`);
      console.error(`[TLS] SSL_CERT_PATH=${SSL_CERT}  SSL_KEY_PATH=${SSL_KEY}`);
      process.exit(1);
    }

    https.createServer({ cert, key }, app).listen(PORT, '0.0.0.0', () => {
      console.log(`[easymaz-print] HTTPS  https://0.0.0.0:${PORT}`);
      logPrinterTarget();
      console.log('[easymaz-print] TLS enabled — works offline on LAN');
    });
  } else {
    http.createServer(app).listen(PORT, '0.0.0.0', () => {
      console.log(`[easymaz-print] HTTP   http://0.0.0.0:${PORT}`);
      logPrinterTarget();
      console.log('[easymaz-print] No TLS — only works from localhost (set SSL_CERT_PATH + SSL_KEY_PATH for LAN access)');
    });
  }
}

startServer();