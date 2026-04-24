#!/bin/bash
# Run once on a fresh Raspberry Pi OS Lite (64-bit) to set up easymaz-print.
# Usage: sudo bash install.sh
# Prereq: pi.env.template filled in and placed at ./pi.env

set -e

APP_DIR="/opt/easymaz-print"
ENV_DIR="/etc/easymaz-print"

echo "=== easymaz-print installer ==="

# ── Node.js 20 ──────────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "[1/6] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[1/6] Node.js already installed: $(node -v)"
fi

# ── cloudflared ──────────────────────────────────────────────────────────────
if ! command -v cloudflared &> /dev/null; then
  echo "[2/6] Installing cloudflared..."
  ARCH=$(dpkg --print-architecture)
  curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
    -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared
else
  echo "[2/6] cloudflared already installed: $(cloudflared --version)"
fi

# ── CUPS (for USB printing) ──────────────────────────────────────────────────
echo "[3/6] Installing CUPS..."
apt-get install -y cups
usermod -aG lpadmin pi 2>/dev/null || true
systemctl enable cups
systemctl start cups

# ── App files ────────────────────────────────────────────────────────────────
echo "[4/6] Installing easymaz-print..."
mkdir -p "$APP_DIR"
cp -r src scripts package.json package-lock.json "$APP_DIR/"
cd "$APP_DIR" && npm ci --omit=dev
chmod +x "$APP_DIR/scripts/start.sh"

# ── Config ───────────────────────────────────────────────────────────────────
echo "[5/6] Installing config..."
mkdir -p "$ENV_DIR"
if [ -f "./pi.env" ]; then
  cp ./pi.env "$ENV_DIR/pi.env"
  chmod 600 "$ENV_DIR/pi.env"
  echo "      Config installed at $ENV_DIR/pi.env"
else
  echo "      WARNING: pi.env not found — copy pi.env.template, fill it in, then copy to $ENV_DIR/pi.env"
fi

# ── systemd service ──────────────────────────────────────────────────────────
echo "[6/6] Installing systemd service..."
cp systemd/easymaz-print.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable easymaz-print
systemctl start easymaz-print

echo ""
echo "=== Done! ==="
echo "Check status:  sudo systemctl status easymaz-print"
echo "View logs:     sudo journalctl -u easymaz-print -f"
echo "Test print:    node $APP_DIR/test-print.js"