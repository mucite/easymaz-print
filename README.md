# easymaz-print

A small HTTP bridge that turns JSON into paper. It speaks raw ESC/POS to thermal printers over
TCP port 9100, a USB device file, or a CUPS queue, and it prints two documents: a fiscal receipt
for the diner and a production ticket for the kitchen.

It runs on its own. No database, no cloud, no account, no other service from the till system it
normally sits behind — `node src/server.js` and an address for a printer is the whole installation.
That is deliberate, and it is what makes the next section possible.

## Checking a printer against it

Use this if you make or sell printers and want to know whether this bridge drives yours, or if you
have just wired one up on a site and want to know it works before anything depends on it.

```bash
npm ci

PRINT_SHARED_SECRET=demo \
PRINTER_HOST=192.168.1.50 \
PRINTER_PORT=9100 \
npm start
```

Confirm the bridge agrees with you about what it is driving — this prints nothing:

```bash
curl localhost:3001/health
```

```json
{"status":"ok","registerConfigured":true,"printer":{"mode":"tcp","address":"192.168.1.50:9100"}}
```

`"status":"unconfigured"` means no printer address was set and the bridge is falling back to
`127.0.0.1:9100`, where it will fail with a refused socket that looks exactly like a dead printer.
Set `PRINTER_HOST` and try again.

Then put paper through it:

```bash
curl -X POST localhost:3001/test-print -H 'x-print-key: demo'
```

That is the entire test. It takes no payload, invents no sale, and needs nothing to be known about
receipts or Ethiopian tax law.

### Reading the slip

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

Each block answers one question, and a printer that renders all of them renders every receipt and
ticket this bridge emits:

| On the slip | What it tells you |
|---|---|
| **Station / Target / Mode** | Which printer this actually went to. On a site with several, the commonest fault is a perfect slip coming out of the wrong room. |
| **Ruler** | Whether the column width is right. The last digit must sit in the last column. If the line wraps, the paper is narrower than the setting — see `PRINTER_WIDTH` below. |
| **Bold / Double / Centred** | `ESC E`, `GS !` and `ESC a`. Receipts use all three. |
| **Accents** | Whether `ESC t` selected the code page. Wrong table and these come out as box-drawing characters or Greek. |
| **QR** | Whether the printer has a hardware QR engine (`GS ( k`). This is the one most likely to be missing, and the failure is silent: a model without it prints a receipt that looks correct and is missing the code the law requires. If the square is absent, scan nothing — that is the answer. |
| **The cut** | `GS V`. Set `PRINTER_CUT=partial` if the printer implements only partial cuts. |

Scan the QR and check the result against the text line printed directly beneath it. They must match
exactly. A code that scans to *something* is not the same as a code that scans to the right thing.

Press it as many times as you like — the test slip is deliberately not deduplicated, unlike
receipts and tickets.

### If nothing comes out

The response says where it tried:

```json
{"success":false,"error":"Printer \"default\" (192.168.1.50:9100) socket error: connect ECONNREFUSED"}
```

- `ECONNREFUSED` / `timed out` — nothing is answering on port 9100 at that address. Check the
  printer is on, on the same network, and that the address is current. `PRINTER_TIMEOUT_MS`
  defaults to 5000.
- `503 Printing is not configured` — `PRINT_SHARED_SECRET` is unset. Set it.
- `401 Not authorised to print here` — the `x-print-key` header does not match that secret.
- **200 with no paper** — read the `target` in the response. You are almost certainly testing a
  printer in another room.

## Connecting a printer

Three ways, checked in this order: `PRINTER_CMD`, then `PRINTER_DEVICE`, then TCP.

### Network, over Ethernet or Wi-Fi

```bash
PRINTER_HOST=192.168.1.50 PRINTER_PORT=9100
```

The common case, and the one everything else is compared against. `PRINTER_IP` is accepted as an
alias for `PRINTER_HOST`.

### USB on macOS

macOS has no raw USB device file, so a thermal printer is driven through a CUPS queue in raw mode.
Plug the printer in, then:

```bash
lpinfo -v | grep usb          # find the device URI, e.g. usb://EPSON/TM-T20II
sudo lpadmin -p thermal -E -v 'usb://EPSON/TM-T20II' -m raw
lpstat -p thermal             # should say idle
```

```bash
PRINT_SHARED_SECRET=demo PRINTER_CMD='lp -d thermal -o raw -' npm start
curl -X POST localhost:3001/test-print -H 'x-print-key: demo'
```

`-m raw` matters: it tells CUPS to pass the bytes through untouched. A queue with a real driver will
try to render the ESC/POS as a document and produce nonsense.

Point this only at a thermal printer. Raw ESC/POS sent to an inkjet or laser queue prints pages of
garbage characters.

### USB on Linux

```bash
PRINTER_DEVICE=/dev/usb/lp0
```

The user running the bridge needs write access to the device — usually membership of the `lp`
group. A CUPS queue works here too, with the same `PRINTER_CMD` as above.

### USB on Windows

```bash
PRINTER_DEVICE=\\.\USB001
```

### More than one printer

For a site where food goes to the kitchen and drinks to the bar:

```bash
PRINTERS=kitchen=192.168.1.50:9100,bar=192.168.1.51,reception=192.168.1.52
```

Each entry is `name=host:port:width:cut:codepage`, and everything after the host is optional:

```bash
PRINTERS=bar=192.168.1.51:9100:32:partial:cp437
```

Test one by name:

```bash
curl -X POST localhost:3001/test-print -H 'x-print-key: demo' \
  -H 'content-type: application/json' -d '{"station":"bar"}'
```

An unknown station prints at the register rather than refusing, and says so in the log. A ticket
that prints in the wrong room is confusing; one that prints nowhere is an order the kitchen never
sees.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3001` | HTTP port to listen on. |
| `PRINT_SHARED_SECRET` | — | Required for every route but `/health`. Unset, the bridge refuses to print at all. |
| `PRINTER_HOST` / `PRINTER_IP` | `127.0.0.1` | Network printer address. |
| `PRINTER_PORT` | `9100` | Network printer port. |
| `PRINTER_DEVICE` | — | USB device file. Takes precedence over TCP. |
| `PRINTER_CMD` | — | Command fed the raw bytes on stdin. Takes precedence over both. |
| `PRINTER_WIDTH` | `48` | Columns at Font A. **48 for 80 mm paper, 32 for 58 mm.** |
| `PRINTER_CUT` | `full` | `full` or `partial`. |
| `PRINTER_CODEPAGE` | `cp437` | Table selected with `ESC t`. `PRINTER_ENCODING` is read as a fallback. |
| `PRINTER_TIMEOUT_MS` | `5000` | Connect timeout for a network printer. |
| `PRINTERS` | — | Named stations, as above. |
| `CASH_DRAWER` | `on` | Whether a cash sale pulses the drawer kick port. Never fired by `/test-print`. |

80 mm paper is the default throughout. A 58 mm printer needs `PRINTER_WIDTH=32`, and the ruler on
the test slip is how you confirm it took.

## Routes

| Route | Needs the key | What it does |
|---|---|---|
| `GET /health` | no | Reports the configured printer and stations. Prints nothing. Deliberately open, so an engineer on the phone can check an install. |
| `POST /test-print` | yes | The slip above. Takes an optional `station`. Not deduplicated. |
| `POST /print` | yes | A fiscal receipt. Full payload: TIN, premises, items, VAT breakdown, total. |
| `POST /ticket` | yes | A production ticket: order, table, items. No money on it. |

`/print` and `/ticket` accept an optional `jobId` and ignore a repeat of one seen in the last five
minutes, so a till retrying after a timeout does not print the receipt twice or cook the food twice.

## Security

The shared secret is the only thing standing between this bridge and anyone who can reach it. There
is no TLS and no CORS: it is built to listen on a private network — a compose network, or a LAN
segment the till is on — and not to be exposed beyond one.

Without `PRINT_SHARED_SECRET` set, every print route answers 503 rather than accepting jobs. This is
not caution for its own sake: on a fiscal device an unauthenticated print is a forged receipt, and
before the secret existed a plain POST from anywhere on a restaurant's Wi-Fi printed whatever it
liked.

Do not put this on a public address.

## Docker

```bash
docker build -t easymaz-print .
docker run --rm -p 3001:3001 \
  -e PRINT_SHARED_SECRET=demo \
  -e PRINTER_HOST=192.168.1.50 \
  easymaz-print
```

The image runs as a non-root user and has a healthcheck on `/health`. A USB printer needs the device
passed through with `--device`; a network printer needs nothing.

## Tests

```bash
npm test
```

The suite spawns the real server and puts TCP listeners where the printers would be, so jobs travel
the whole way — HTTP in, shared secret, schema, station routing, ESC/POS bytes, out through a
socket. Nothing is stubbed. CI runs it on Node 20, which is what the Dockerfile ships, and Node 24.
