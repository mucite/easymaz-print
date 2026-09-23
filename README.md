# easymaz-print

An HTTP bridge that turns JSON into paper. It speaks raw ESC/POS to an 80 mm thermal printer over
the network on TCP port 9100, or over USB.

It runs on its own: no database, no cloud, no account, nothing else from the till system it normally
sits behind. Node 20 or newer and a printer, and that is the whole installation.

## Testing a printer

You need the printer's IP address, and the printer must accept raw ESC/POS on TCP port 9100.
Ethernet and Wi-Fi are the same thing here — only how the printer got its address differs.

Node 20 or newer. Then, from a machine on the same network as the printer:

```bash
git clone https://github.com/mucite/easymaz-print.git
cd easymaz-print
npm ci

npm run test-print 192.168.1.50
```

A slip comes out of the printer, and the terminal says what it sent:

```
[test-print] 878 bytes to 192.168.1.50:9100
[test-print] 48 columns, cp437, full cut
[test-print] the QR should scan to exactly: EASYMAZ TEST 2026-09-22 08:17:48
```

That is the whole test. Nothing is configured, no server runs, and no sale is invented. Run it as
often as you like.

Non-default paper or cut:

```bash
npm run test-print 192.168.1.50 -- --width 32      # 58 mm paper; 48 (the default) is 80 mm
npm run test-print 192.168.1.50 -- --cut partial   # a printer that only does partial cuts
npm run test-print 192.168.1.50:9100 -- --codepage cp850
```

### A USB printer

The same slip, sent over USB instead of the network. Plug the printer in, then:

```bash
npm run test-print -- --usb
```

This finds the printer by its USB printer class through libusb, so it needs no print queue and no
device path, and works on macOS as well as Linux. The other options above apply unchanged.

Behind a till, the bridge writes to the printer's device file instead of a socket: set
`PRINTER_DEVICE` (on Linux, usually `/dev/usb/lp0`) and leave `PRINTER_HOST` unset.

### Testing the service itself

The above drives the printer directly. To exercise the running service, which is what a till talks
to, start it and ask it to print:

```bash
PRINT_SHARED_SECRET=demo PRINTER_HOST=192.168.1.50 npm start
```

```bash
curl localhost:3001/health
curl -X POST localhost:3001/test-print -H 'x-print-key: demo'
```

`/health` prints nothing and reports what the service thinks it is driving:

```json
{"status":"ok","registerConfigured":true,"printer":{"mode":"tcp","address":"192.168.1.50:9100"}}
```

The same slip comes out, having travelled the whole path a real receipt takes.

## Reading the slip

```
                 TEST PRINT
                easymaz-print
------------------------------------------------
Station   default
Target    192.168.1.50:9100
Mode      tcp
Width     48 columns
Codepage  cp437 (ESC t 0)
Cut       full
Time      2026-09-22 08:02:56
------------------------------------------------
Ruler ends at the last column.
A wrap means the width is wrong.
....5...10...15...20...25...30...35...40...45...
------------------------------------------------
Bold text
Double
                Centred text
Accents: cafe 25°C áéíóú
------------------------------------------------
        Scan: should read the line below
                 [QR CODE]
     EASYMAZ TEST 2026-09-22 08:02:56
        Nothing above = no QR engine.
------------------------------------------------
            If this slip is complete
              and the paper is cut,
            the printer is supported.
```

Each block is one question. A printer that renders all of them renders every receipt and ticket
this bridge produces.

| On the slip | What it tells you |
|---|---|
| **Target** | Which printer this actually reached. |
| **Ruler** | Whether the column width is right. The last digit must sit in the last column; a wrapped line means the paper is narrower than `PRINTER_WIDTH`. |
| **Bold / Double / Centred** | `ESC E`, `GS !`, `ESC a`. |
| **Accents** | Whether `ESC t` selected the code page. A wrong table prints box-drawing characters or Greek. |
| **QR** | Whether the printer has a hardware QR engine (`GS ( k`). Most likely thing to be missing, and it fails silently — a model without one prints a receipt that looks correct and lacks the code the law requires. |
| **The cut** | `GS V`. Set `PRINTER_CUT=partial` for a printer that only does partial cuts. |

Scan the QR and check the result against the text line printed directly beneath it. They must match
exactly — a code that scans to *something* is not a code that scans to the right thing.

## If nothing comes out

The response says where it tried.

| Response | Meaning |
|---|---|
| `ECONNREFUSED` or `timed out` | Nothing is answering on port 9100 at that address. Check the printer is on, on the same network, and that the address is current. |
| `"status":"unconfigured"` from `/health` | No address was set, so the bridge is falling back to `127.0.0.1:9100` and will fail in a way that looks like a dead printer. Set `PRINTER_HOST`. |
| `503 Printing is not configured` | `PRINT_SHARED_SECRET` is unset. |
| `401 Not authorised to print here` | The `x-print-key` header does not match that secret. |
| `200` and no paper | Read `target` in the response. You are testing a printer somewhere else. |

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PRINTER_HOST` | `127.0.0.1` | Printer IP address. |
| `PRINTER_DEVICE` | — | A USB printer's device file, such as `/dev/usb/lp0`. Used instead of `PRINTER_HOST` when set. |
| `PRINTER_PORT` | `9100` | Printer port. |
| `PRINTER_WIDTH` | `48` | Columns at Font A. **48 for 80 mm paper, 32 for 58 mm.** |
| `PRINTER_CUT` | `full` | `full` or `partial`. |
| `PRINTER_CODEPAGE` | `cp437` | Table selected with `ESC t`. |
| `PRINTER_TIMEOUT_MS` | `5000` | Connect timeout. |
| `CASH_DRAWER` | `on` | Pulse the printer's drawer kick port (RJ11) at the end of a cash sale. `off` for a site with no drawer. |
| `PRINT_SHARED_SECRET` | — | Required by every route but `/health`. Unset, the bridge refuses to print. |
| `PORT` | `3001` | HTTP port to listen on. |

80 mm paper is the default throughout. A 58 mm printer needs `PRINTER_WIDTH=32`, and the ruler is
how you confirm it took.

## Routes

| Route | Needs the key | What it does |
|---|---|---|
| `GET /health` | no | Reports the configured printer. Prints nothing. |
| `POST /test-print` | yes | The slip above. Not deduplicated. |
| `POST /print` | yes | A fiscal receipt: TIN, premises, items, VAT breakdown, total. |
| `POST /ticket` | yes | A production ticket: order, table, items. No money on it. |

The shared secret is the only thing between this bridge and anyone who can reach it. There is no
TLS: it is built to listen on a private network, not to be exposed beyond one.
