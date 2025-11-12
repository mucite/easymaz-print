# EasyMaz Printer Bridge - Setup Guide

## Overview

The EasyMaz Printer Bridge supports **three types of ESC/POS printers**:
- **USB Printers** (Direct connection)
- **Network/IP Printers** (Ethernet or WiFi)
- **Bluetooth Printers** (Optional - requires additional package)

## Configuration

### 1. USB Printer (Default)

**Automatic Detection:**
```bash
PRINTER_TYPE=usb
```

**Manual Configuration (if auto-detect fails):**
```bash
PRINTER_TYPE=usb
PRINTER_VENDOR_ID=0x04b8
PRINTER_PRODUCT_ID=0x0e15
```

**Find USB Printer IDs:**
```bash
# On Linux/Mac
lsusb

# Example output:
# Bus 001 Device 005: ID 04b8:0e15 Seiko Epson Corp. TM-T88V

# On Mini PC (inside Docker container)
docker exec easymaz-printer-bridge lsusb
```

### 2. Network/IP Printer

**Configuration:**
```bash
PRINTER_TYPE=network
PRINTER_IP=192.168.1.100
PRINTER_PORT=9100
```

**Test Network Connectivity:**
```bash
# Ping the printer
ping 192.168.1.100

# Test port (should connect)
telnet 192.168.1.100 9100
```

### 3. Bluetooth Printer

**Note:** Requires `escpos-bluetooth` package (not installed by default).

**Configuration:**
```bash
PRINTER_TYPE=bluetooth
PRINTER_BT_ADDRESS=00:11:22:33:44:55
```

**Setup:**
```bash
# Install bluetooth package
cd easymaz-print
npm install escpos-bluetooth

# Uncomment bluetooth lines in src/helper.js (lines 56-57)
```

## API Usage

### Print Receipt Endpoint

**URL:** `POST http://localhost:3001/print`

**Request Body:**
```json
{
  "printData": {
    "tin": "0123456789",
    "businessName": "Test Restaurant",
    "address": "123 Main St",
    "phone": "+251911234567",
    "fsNo": "ORDER-001",
    "date": "2025-11-11T12:00:00Z",
    "invoiceType": "SALE",
    "cashier": "John Doe",
    "waiter": "Jane Smith",
    "table": "Table 5",
    "items": [
      {
        "name": "Coffee",
        "quantity": 2,
        "price": 50.00
      }
    ],
    "subtotal": 100.00,
    "serviceCharge": 10.00,
    "serviceChargePercentage": 10,
    "vat": 16.50,
    "vatPercentage": 15,
    "total": 126.50,
    "paymentMethod": "CASH",
    "isPaid": true,
    "paidByCash": true,
    "isReceiptPrinted": false,
    "restaurantId": "12345"
  },
  "printerOptions": {
    "type": "usb"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Print job completed",
  "printerType": "usb"
}
```

## Docker Configuration

The printer-bridge service is configured with:

```yaml
privileged: true          # Required for USB access
devices:
  - /dev/bus/usb:/dev/bus/usb  # USB device mapping
volumes:
  - /dev:/dev             # Device access
```

## Troubleshooting

### USB Printer Not Detected

**Check USB devices:**
```bash
# List USB devices
docker exec easymaz-printer-bridge lsusb

# Check permissions
docker exec easymaz-printer-bridge ls -la /dev/bus/usb/
```

**Solution:**
- Ensure printer is powered on and connected
- Verify USB cable is working
- Try different USB port
- Check if printer drivers are needed (most ESC/POS printers don't need drivers)

### Network Printer Not Responding

**Check connectivity:**
```bash
# From host machine
ping 192.168.1.100
telnet 192.168.1.100 9100

# From Docker container
docker exec easymaz-printer-bridge ping -c 3 192.168.1.100
```

**Common Issues:**
- Printer IP changed (use static IP on printer)
- Firewall blocking port 9100
- Printer in power-saving mode
- Wrong network (ensure printer and mini PC on same subnet)

### Print Job Fails

**View logs:**
```bash
docker logs easymaz-printer-bridge -f
```

**Common Errors:**
- `ENOENT`: Printer device not found
- `EACCES`: Permission denied (check privileged mode)
- `ETIMEDOUT`: Network printer unreachable
- `Device busy`: Another process is using the printer

### Test Print Without Receipt Data

**Simple test:**
```bash
curl -X POST http://localhost:3001/print \
  -H "Content-Type: application/json" \
  -d '{
    "printData": {
      "tin": "TEST",
      "businessName": "Test Print",
      "address": "Test Address",
      "phone": "123456",
      "fsNo": "TEST-001",
      "invoiceType": "TEST",
      "cashier": "Test",
      "waiter": "Test",
      "table": "Test",
      "items": [{"name": "Test Item", "quantity": 1, "price": 10}],
      "subtotal": 10,
      "vat": 1.5,
      "vatPercentage": 15,
      "total": 11.5,
      "paymentMethod": "CASH",
      "isPaid": true
    }
  }'
```

## Printer Features

### Cash Drawer
- Opens automatically on **first print** of cash payment
- Requires ESC/POS compatible cash drawer
- Connected to printer via RJ11/RJ12 cable

### Receipt Reprinting
- Marked with `*** REPRINT ***` header
- Cash drawer **will not open** on reprint
- Tracked by `isReceiptPrinted` flag

## Supported Printers

**Tested with:**
- Epson TM series (TM-T88, TM-T20, TM-U220)
- Star Micronics TSP series
- Bixolon SRP series
- Generic ESC/POS thermal printers

**Requirements:**
- ESC/POS protocol support
- 48mm or 80mm paper width (configured for 48 characters)

## Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PRINTER_TYPE` | string | `usb` | Printer connection type |
| `PRINTER_IP` | string | - | Network printer IP address |
| `PRINTER_PORT` | number | `9100` | Network printer port |
| `PRINTER_VENDOR_ID` | hex | - | USB vendor ID (optional) |
| `PRINTER_PRODUCT_ID` | hex | - | USB product ID (optional) |
| `PRINTER_BT_ADDRESS` | string | - | Bluetooth MAC address |
| `API_URL` | string | - | API URL for marking receipts as printed |

## Migration from Firestore

If you're migrating from Firestore-based printing:

**Old (Firestore):**
- Prints pulled from Firestore collection
- Required Firebase credentials
- Internet connection required

**New (REST API):**
- Prints sent via HTTP POST
- No Firebase dependency
- Works offline (local network only)

**Migration Steps:**
1. Update admin/app to call printer-bridge API instead of Firestore
2. Remove Firebase dependencies (optional)
3. Configure printer type in `.env`
4. Test with sample receipt

## Health Check

```bash
curl http://localhost:3001/health

# Response:
# {"status":"ok","service":"easymaz-printer-bridge"}
```

## Performance

- **USB**: ~1-2 seconds per receipt
- **Network**: ~2-3 seconds per receipt
- **Concurrent prints**: Handled sequentially (one at a time)

## Security

- Service runs as non-root user (nodejs:1001)
- Only exposes `/health` and `/print` endpoints
- No authentication (intended for internal network only)
- Recommend: Firewall to block external access to port 3001
