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

systemctl daemon-reload
systemctl enable --now lobster-room.service

echo "Installed. Service is listening on http://127.0.0.1:18080/"
echo "Next: configure reverse proxy to expose /lobster-room on your OpenClaw domain."
