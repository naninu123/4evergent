#!/usr/bin/env bash
# 4evergent local development script.
# Builds all packages and runs the test suite.
set -euo pipefail
cd "$(dirname "$0")/.."

# Preflight: ensure the running Node major matches .nvmrc.
# Fails fast (one `node -p`, no network) with an actionable message.
expected_node="$(tr -d '{\r\n}' < .nvmrc)"
if [[ -z "${expected_node}" ]]; then
  echo "error: .nvmrc is missing or empty" >&2
  exit 1
fi
actual_node="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${actual_node}" != "${expected_node}" ]]; then
  {
    echo "error: Node ${actual_node} is running, but .nvmrc requires Node ${expected_node}."
    echo "       run: nvm use   (or fnm use), then re-run scripts/dev.sh."
  } >&2
  exit 1
fi

echo "==> Installing dependencies"
pnpm install

echo "==> Building packages"
pnpm build

echo "==> Running tests"
pnpm test

echo "==> Type checking"
pnpm typecheck

echo "Done."
