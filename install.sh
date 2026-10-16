#!/usr/bin/env bash
#
# brushrouter installer — easy as hell.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/avinaxhroy/brushrouter/main/install.sh | bash
# or inside a clone:
#   ./install.sh
#

set -euo pipefail

# ANSI color helpers (only if stdout is a terminal)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="\033[1m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  RED="\033[31m"
  DIM="\033[2m"
  RESET="\033[0m"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  DIM=""
  RESET=""
fi

echo -e "${BOLD}brushrouter installer${RESET}\n"

# 1. Verify Node.js is installed
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Error: Node.js is required to run brushrouter.${RESET}"
  echo -e "\nPlease install Node.js 20 or newer:"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "  ${BOLD}brew install node${RESET}   # macOS Homebrew"
  else
    echo -e "  ${BOLD}curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs${RESET}"
  fi
  echo -e "  or with fnm: ${BOLD}curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20${RESET}"
  exit 1
fi

# 2. Verify Node.js version >= 20
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}Error: Node.js 20+ is required (found: $(node -v)).${RESET}"
  echo -e "Please upgrade Node.js to version 20 or later."
  exit 1
fi

echo -e "  ${GREEN}✓${RESET} Found Node.js $(node -v)"

# 3. Determine repository location
IS_UPDATE=0
if [ "$1" == "--update" ] || [ "$1" == "-u" ]; then
  IS_UPDATE=1
  shift
fi

SCRIPT_DIR=""
if [ -f "./bin/brushrouter.js" ] && [ -f "./package.json" ]; then
  SCRIPT_DIR="$(pwd)"
  if [ "$IS_UPDATE" -eq 1 ]; then
    echo -e "  ${GREEN}✓${RESET} Updating local repository: ${DIM}${SCRIPT_DIR}${RESET}"
    git pull --ff-only 2>/dev/null || true
  else
    echo -e "  ${GREEN}✓${RESET} Running in local checkout: ${DIM}${SCRIPT_DIR}${RESET}"
  fi
else
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/brushrouter"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "  ${GREEN}✓${RESET} Updating existing installation at ${DIM}${INSTALL_DIR}${RESET}..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || true
  else
    echo -e "  ${GREEN}✓${RESET} Installing to ${DIM}${INSTALL_DIR}${RESET}..."
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "https://github.com/avinaxhroy/brushrouter.git" "$INSTALL_DIR"
  fi
  SCRIPT_DIR="$INSTALL_DIR"
fi
# 4. Link binary to PATH
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "${SCRIPT_DIR}/bin/brushrouter.js" "${BIN_DIR}/brushrouter"
ln -sf "${SCRIPT_DIR}/bin/brushrouter.js" "${BIN_DIR}/br"
chmod +x "${SCRIPT_DIR}/bin/brushrouter.js" "${BIN_DIR}/brushrouter"
chmod +x "${SCRIPT_DIR}/bin/brushrouter.js" "${BIN_DIR}/br"
echo -e "  ${GREEN}✓${RESET} Linked executable to ${DIM}${BIN_DIR}/brushrouter${RESET} (and shorthand ${DIM}${BIN_DIR}/br${RESET})"

# Check if ~/.local/bin or brushrouter is reachable on PATH
if ! command -v brushrouter >/dev/null 2>&1; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo -e "\n  ${YELLOW}Notice:${RESET} ${BIN_DIR} is not in your PATH."
      echo -e "  Add this to your ${DIM}~/.zshrc${RESET} or ${DIM}~/.bashrc${RESET}:"
      echo -e "    ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
      ;;
  esac
fi

# 5. Launch brushrouter setup wizard or update confirmation
echo ""
if [ "$IS_UPDATE" -eq 1 ]; then
  echo -e "  ${GREEN}✓${RESET} Update complete! Verifying system health...\n"
  exec node "${SCRIPT_DIR}/bin/brushrouter.js" doctor "$@"
else
  exec node "${SCRIPT_DIR}/bin/brushrouter.js" setup "$@"
fi
