#!/usr/bin/env bash
set -euo pipefail

# Lobster Room plugin installer
# Installs into ~/.openclaw/extensions/lobster-room (shared for all agents on this machine)
# Then attempts `openclaw gateway restart` (best-effort).
#
# SECURITY NOTE
# - Prefer installing a pinned release version (VERSION=vX.Y.Z) to reduce supply-chain risk.
# - If VERSION is not set, we install the latest GitHub Release (best-effort).
# - To install a specific branch tip (dev/staging), set BRANCH=branch-name.

REPO="zacmoltbot/lobster-room"
EXT_DIR="${HOME}/.openclaw/extensions/lobster-room"
TMP="$(mktemp -d)"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing required command: $1"; exit 2; }
}

need_cmd curl
need_cmd tar

VERSION="${VERSION:-}"
BRANCH="${BRANCH:-}"

fetch_latest_release_tag() {
  # No jq dependency; parse tag_name with sed.
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name"\s*:\s*"\([^"]\+\)".*/\1/p' \
    | head -n 1
}

TARBALL_URL=""
STRIP_COMPONENTS=1

if [[ -n "$VERSION" ]]; then
  # Pinned tag (recommended)
  TARBALL_URL="https://github.com/${REPO}/archive/refs/tags/${VERSION}.tar.gz"
elif [[ -n "$BRANCH" ]]; then
  # Branch tip (dev/staging)
  TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
else
  # Latest release tag (best-effort); fallback to main if missing.
  LATEST_TAG="$(fetch_latest_release_tag || true)"
  if [[ -n "$LATEST_TAG" ]]; then
    VERSION="$LATEST_TAG"
    TARBALL_URL="https://github.com/${REPO}/archive/refs/tags/${VERSION}.tar.gz"
  else
    BRANCH="main"
    TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
  fi
fi

echo "Downloading: $TARBALL_URL"
curl -fsSL "$TARBALL_URL" -o "$TMP/repo.tgz"
mkdir -p "$TMP/src"
tar -xzf "$TMP/repo.tgz" -C "$TMP/src" --strip-components="$STRIP_COMPONENTS"

mkdir -p "$EXT_DIR"

# Copy plugin files
rm -rf "$EXT_DIR"/*
cp -R "$TMP/src/plugin/lobster-room/"* "$EXT_DIR/"

# Replace placeholder HTML with actual portal
cp -f "$TMP/src/lobster-room.html" "$EXT_DIR/assets/lobster-room.html"

echo "Installed plugin to: $EXT_DIR"
[[ -n "${VERSION:-}" ]] && echo "Installed version: ${VERSION}"
[[ -n "${BRANCH:-}" ]] && echo "Installed branch: ${BRANCH}"

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
