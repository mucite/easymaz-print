#!/usr/bin/env node
/**
 * Registers this Pi's public bridge URL with the easymaz API.
 * Called on every boot after the Cloudflare tunnel is up.
 *
 * Usage: node scripts/register.js
 * Reads from pi.env (or environment variables).
 */

require('dotenv').config({ path: '/etc/easymaz-print/pi.env' });

const https = require('https');
const url   = require('url');

const RESTAURANT_ID = process.env.RESTAURANT_ID;
const API_TOKEN     = process.env.API_TOKEN;
const API_URL       = process.env.API_URL || 'https://api.easymaz.com';
const BRIDGE_URL    = process.env.BRIDGE_PUBLIC_URL;

if (!RESTAURANT_ID || !API_TOKEN || !BRIDGE_URL) {
  console.error('[register] Missing RESTAURANT_ID, API_TOKEN, or BRIDGE_PUBLIC_URL in pi.env');
  process.exit(1);
}

const endpoint = `${API_URL}/in/restaurant/printer-bridge`;
const body = JSON.stringify({ printerBridgeUrl: BRIDGE_URL });

const parsed = url.parse(endpoint);
const options = {
  hostname: parsed.hostname,
  port:     parsed.port || 443,
  path:     parsed.path,
  method:   'PUT',
  headers: {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Authorization':  `Bearer ${API_TOKEN}`,
  },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200 || res.statusCode === 204) {
      console.log(`[register] Bridge URL registered: ${BRIDGE_URL}`);
    } else {
      console.error(`[register] API returned ${res.statusCode}: ${data}`);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error('[register] Failed to reach API:', err.message);
  process.exit(1);
});

req.write(body);
req.end();