#!/usr/bin/env bash
set -euo pipefail

# Lobster Room (systemd) installer
# - Copies current repo files to /opt/lobster-room
# - Installs systemd unit
# - Enables and starts service

DEST=${DEST:-/opt/lobster-room}
UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/lobster-room.service"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)."
  exit 1
fi

mkdir -p "$DEST"

# Copy minimal runtime files
SCRIPT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cp -f "$SCRIPT_DIR/server.py" "$DEST/server.py"
cp -f "$SCRIPT_DIR/lobster-room.html" "$DEST/lobster-room.html"

# Optional: keep LICENSE/README for reference
cp -f "$SCRIPT_DIR/LICENSE" "$DEST/LICENSE" || true
cp -f "$SCRIPT_DIR/README.md" "$DEST/README.md" || true

install -m 0644 "$UNIT_SRC" /etc/systemd/system/lobster-room.service

# Install env file template if missing
mkdir -p /etc/default
if [[ ! -f /etc/default/lobster-room ]]; then
  if [[ -f "$SCRIPT_DIR/skill/lobster-room/examples/default.env" ]]; then
    cp -f "$SCRIPT_DIR/skill/lobster-room/examples/default.env" /etc/default/lobster-room
    chmod 600 /etc/default/lobster-room || true
  fi
fi

systemctl daemon-reload
systemctl enable --now lobster-room.service

echo "Installed. Service is listening on http://127.0.0.1:18080/"
echo
echo "Next steps:"
echo "1) Edit /etc/default/lobster-room (required): set LOBSTER_ROOM_GATEWAYS_JSON + token envs"
echo "2) Restart: systemctl restart lobster-room"
echo "3) Quick check: curl -fsS http://127.0.0.1:18080/healthz && echo"
echo "4) Configure reverse proxy to expose https://<openclaw-host>/lobster-room/ (templates in skill/lobster-room/proxy/)"
