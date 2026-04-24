#!/bin/bash
# Starts the Cloudflare tunnel + easymaz-print server.
# Runs on every boot via systemd.

set -e

ENV_FILE="/etc/easymaz-print/pi.env"
APP_DIR="/opt/easymaz-print"

[ -f "$ENV_FILE" ] && export $(grep -v '^#' "$ENV_FILE" | xargs)

echo "[easymaz] Starting Cloudflare tunnel..."
cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
TUNNEL_PID=$!

# Wait until the tunnel is reachable (max 30s)
echo "[easymaz] Waiting for tunnel to be ready..."
for i in $(seq 1 15); do
  if curl -sf "https://${BRIDGE_PUBLIC_URL#https://}/health" > /dev/null 2>&1; then
    echo "[easymaz] Tunnel is up: $BRIDGE_PUBLIC_URL"
    break
  fi
  sleep 2
done

# Register this Pi's URL with the backend
echo "[easymaz] Registering bridge URL with API..."
node "$APP_DIR/scripts/register.js" || echo "[easymaz] Warning: registration failed (will retry next boot)"

# Start the print server (foreground so systemd tracks it)
echo "[easymaz] Starting print server..."
exec node "$APP_DIR/src/server.js"