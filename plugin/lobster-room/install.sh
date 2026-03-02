#!/usr/bin/env bash
set -euo pipefail

# Lobster Room plugin installer
# Installs into ~/.openclaw/extensions/lobster-room (shared for all agents on this machine)
# Then attempts `openclaw gateway restart` (best-effort).

REPO="zacmoltbot/lobster-room"
BRANCH="main"
EXT_DIR="${HOME}/.openclaw/extensions/lobster-room"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

echo "Downloading: $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$TMP/repo.tgz"
mkdir -p "$TMP/src"
tar -xzf "$TMP/repo.tgz" -C "$TMP/src" --strip-components=1

mkdir -p "$EXT_DIR"

# Copy plugin files
rm -rf "$EXT_DIR"/*
cp -R "$TMP/src/plugin/lobster-room/"* "$EXT_DIR/"

# Replace placeholder HTML with actual portal
cp -f "$TMP/src/lobster-room.html" "$EXT_DIR/assets/lobster-room.html"

echo "Installed plugin to: $EXT_DIR"

echo "Attempting: openclaw gateway restart"
if command -v openclaw >/dev/null 2>&1; then
  if openclaw gateway restart; then
    echo "Gateway restarted."
  else
    echo "WARN: gateway restart failed. Please restart OpenClaw gateway manually."
  fi
else
  echo "WARN: openclaw CLI not found. Please restart OpenClaw gateway manually."
fi

echo
echo "Verify (after restart):"
echo "- https://<openclaw-host>/lobster-room/"
echo "- https://<openclaw-host>/lobster-room/api/lobster-room"
