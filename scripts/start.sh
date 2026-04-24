#!/bin/bash
# Starts the Cloudflare tunnel + easymaz-print server.
# Runs on every boot via systemd.

set -e

ENV_FILE="/etc/easymaz-print/pi.env"
APP_DIR="/opt/easymaz-print"

[ -f "$ENV_FILE" ] && export $(grep -v '^#' "$ENV_FILE" | xargs)

# Start Cloudflare named tunnel in background
echo "[easymaz] Starting Cloudflare tunnel..."
cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &

# Start the print server in foreground so systemd tracks the process
echo "[easymaz] Starting print server..."
exec node "$APP_DIR/src/server.js"