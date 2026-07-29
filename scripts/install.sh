#!/usr/bin/env bash
set -euo pipefail

REPO="realrunner/ode"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="ode"

OS="$(uname -s)"
ARCH="$(uname -m)"

ASSET=""
if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    ASSET="ode-darwin-arm64"
  elif [ "$ARCH" = "x86_64" ]; then
    ASSET="ode-darwin-x64"
  fi
elif [ "$OS" = "Linux" ]; then
  if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
    ASSET="ode-linux-x64"
  fi
fi

if [ -z "$ASSET" ]; then
  echo "Unsupported platform: $OS $ARCH" >&2
  exit 1
fi

URL="https://github.com/$REPO/releases/latest/download/$ASSET"
TMP_DIR="$(mktemp -d)"
TMP_FILE="$TMP_DIR/$ASSET"

mkdir -p "$INSTALL_DIR"

echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP_FILE"
chmod +x "$TMP_FILE"
mv "$TMP_FILE" "$INSTALL_DIR/$BIN_NAME"
chmod +x "$INSTALL_DIR/$BIN_NAME"
rm -rf "$TMP_DIR"

echo "Installed ode to $INSTALL_DIR/$BIN_NAME"
if ! command -v ode >/dev/null 2>&1; then
  echo "Add $INSTALL_DIR to your PATH to use the ode command."
fi
