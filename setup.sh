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
  echo "Node.js 24.16+ (but below 25) or 26.1+ is required by the OpenClaw build SDK." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 24 && minor >= 16) || (major >= 26 && (major > 26 || minor >= 1)) ? 0 : 1)'; then
  echo "Node.js 24.16+ (but below 25) or 26.1+ is required; found $(node --version)." >&2
  exit 1
fi

OPENCLAW_VERSION="$("$OPENCLAW_BIN" --version)"
if ! node -e 'const match = /(\d{4})\.(\d+)\.(\d+)/u.exec(process.argv[1] ?? ""); if (!match) process.exit(1); const [year, minor, patch] = match.slice(1).map(Number); process.exit(year > 2026 || (year === 2026 && (minor > 11 || (minor === 11 && patch >= 4))) ? 0 : 1)' "$OPENCLAW_VERSION"; then
  echo "OpenClaw 2026.11.4 or newer is required; found $OPENCLAW_VERSION. Upgrade your existing OpenClaw installation, then rerun setup.sh." >&2
  exit 1
fi

echo "Using $OPENCLAW_VERSION with Node.js $(node --version). OpenClaw will not be installed by this script."
cd "$ROOT"
npm install
npm test
npm run build
"$OPENCLAW_BIN" plugins validate --json
"$OPENCLAW_BIN" plugins install "$ROOT"

echo
echo "Group is installed. Open the OpenClaw Control UI and select Group in the sidebar."
