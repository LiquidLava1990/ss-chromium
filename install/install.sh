#!/bin/sh
# SS Chromium installer for macOS and Linux. Non-interactive; safe to re-run (it upgrades).
#   curl -fsSL https://raw.githubusercontent.com/LiquidLava1990/ss-chromium/main/install/install.sh | sh
# Options (environment variables):
#   SS_CHROMIUM_PACKAGE      npm spec to install (default: the latest GitHub release tarball)
#   SS_CHROMIUM_NO_REGISTER  1 = don't register with Claude Code / Codex
#   SS_CHROMIUM_NO_BROWSER   1 = don't download Chromium (set SS_CHROMIUM_PATH instead)
#   SS_CHROMIUM_NO_SKILL     1 = don't install the Claude skill
#   NPM_CONFIG_PREFIX        where npm installs global packages (default: npm's own)
set -eu

MIN_NODE_MAJOR=20
DEFAULT_PACKAGE="https://github.com/LiquidLava1990/ss-chromium/releases/latest/download/ss-chromium.tgz"

die() {
  echo "ss-chromium installer: $*" >&2
  exit 1
}

node_major() {
  if command -v node >/dev/null 2>&1; then
    node --version | sed 's/^v//' | cut -d. -f1
  else
    echo 0
  fi
}

install_node_if_missing() {
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] && return 0
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  else
    die "Node.js $MIN_NODE_MAJOR+ is required. Install it (https://nodejs.org, or your package manager) and run this installer again."
  fi
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] || die "Node.js is still older than $MIN_NODE_MAJOR. Open a new terminal and run this installer again."
}

install_node_if_missing
PACKAGE="${SS_CHROMIUM_PACKAGE:-$DEFAULT_PACKAGE}"
echo "Installing ss-chromium from $PACKAGE ..."
if ! npm install --global --no-fund --no-audit "$PACKAGE"; then
  die "npm install failed. If it was a permissions error, set NPM_CONFIG_PREFIX=\$HOME/.npm-global (and add its bin to PATH), then run again."
fi

set -- install
[ "${SS_CHROMIUM_NO_REGISTER:-0}" = "1" ] && set -- "$@" --no-register
[ "${SS_CHROMIUM_NO_BROWSER:-0}" = "1" ] && set -- "$@" --no-browser
[ "${SS_CHROMIUM_NO_SKILL:-0}" = "1" ] && set -- "$@" --no-skill
node "$(npm root --global)/ss-chromium/bin/ss-chromium.mjs" "$@" || die "ss-chromium install failed. Run 'ss-chromium doctor' for details."
