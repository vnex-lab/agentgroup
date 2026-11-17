#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "OpenClaw CLI was not found. Install OpenClaw in this WSL environment, then rerun ./setup.sh." >&2
  exit 1
fi
OPENCLAW_BIN="$(command -v openclaw)"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build the plugin." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.12 or newer is required." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
  echo "Node.js 22.12 or newer is required; found $(node --version)." >&2
  exit 1
fi

echo "Using OpenClaw $(openclaw --version). OpenClaw will not be installed by this script."
cd "$ROOT"
npm install
npm test
npm run build
"$OPENCLAW_BIN" plugins validate --json
"$OPENCLAW_BIN" plugins install "$ROOT"

echo
echo "Group is installed. Open the OpenClaw Control UI and select Group in the sidebar."
