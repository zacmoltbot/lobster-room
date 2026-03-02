#!/usr/bin/env bash
set -euo pipefail

# Lobster Room one-line installer (systemd path)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/skill/lobster-room/install.sh | sudo bash
#
# This installer:
# - Downloads this repo (main branch tarball)
# - Runs the systemd installer
#
# After install, configure /etc/default/lobster-room and reverse proxy /lobster-room.

REPO="zacmoltbot/lobster-room"
BRANCH="main"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)."
  exit 1
fi

TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

echo "Downloading: $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$TMP/repo.tgz"
mkdir -p "$TMP/src"
tar -xzf "$TMP/repo.tgz" -C "$TMP/src" --strip-components=1

cd "$TMP/src"

chmod +x ./skill/lobster-room/systemd/install-systemd.sh
./skill/lobster-room/systemd/install-systemd.sh

echo
echo "Next steps:"
echo "1) Edit /etc/default/lobster-room and fill values:"
echo "   nano /etc/default/lobster-room"
echo "   systemctl restart lobster-room"
echo "2) Configure reverse proxy /lobster-room using templates in skill/lobster-room/proxy/"
