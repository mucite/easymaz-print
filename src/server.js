const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const { printReceipt } = require('./printer');
const { PrintPayloadSchema } = require('./validation');

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
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get('/health', (req, res) => {
  const printer = process.env.PRINTER_DEVICE
    ? { mode: 'usb', device: process.env.PRINTER_DEVICE }
    : { mode: 'tcp', address: `${process.env.PRINTER_HOST || '127.0.0.1'}:${process.env.PRINTER_PORT || 9100}` };

  res.status(200).json({ status: 'ok', tls: !!(SSL_CERT && SSL_KEY), printer });
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

  try {
    await printReceipt(parsed.data);
    return res.json({ success: true });
  } catch (err) {
    console.error('Print error:', err);
    return res.status(502).json({ success: false, error: err.message || 'Failed to print' });
  }
});

function logPrinterTarget() {
  if (process.env.PRINTER_DEVICE) {
    console.log(`[easymaz-print] Printer USB  ${process.env.PRINTER_DEVICE}`);
  } else {
    console.log(`[easymaz-print] Printer TCP  ${process.env.PRINTER_HOST || '127.0.0.1'}:${process.env.PRINTER_PORT || 9100}`);
  }
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