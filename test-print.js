#!/usr/bin/env node
// Quick test — run with: node test-print.js
const http = require('http');

const payload = {
  tin: '0012345678',
  businessName: 'EasyMaz Test Restaurant',
  address: 'Bole Road, Addis Ababa',
  phone: '+251 911 000 000',
  fsNo: 'FS-0001',
  orderNumber: 'ORD-0042',
  date: new Date().toLocaleString(),
  invoiceType: 'SALE',
  cashier: 'Admin',
  waiter: 'Kebede',
  table: 5,
  items: [
    { name: 'Tibs', quantity: 2, price: 120.00 },
    { name: 'Injera', quantity: 3, price: 15.00 },
    { name: 'Tej',    quantity: 1, price: 80.00 },
  ],
  subtotal: 365.00,
  serviceCharge: 36.50,
  serviceChargePercentage: 10,
  vat: 0,
  vatPercentage: 0,
  convenienceFee: 0,
  total: 401.50,
  paidByCash: true,
  isPaid: true,
  paymentMethod: 'CASH',
  restaurantId: 'test-restaurant-001',
  isReceiptPrinted: false,
};

const body = JSON.stringify(payload);
const options = {
  host: 'localhost',
  port: 3001,
  path: '/print',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}:`, data);
  });
});

req.on('error', (err) => {
  console.error('Request failed:', err.message);
});

req.write(body);
req.end();