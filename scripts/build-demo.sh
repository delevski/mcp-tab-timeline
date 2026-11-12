#!/usr/bin/env bash
# Copies the extension UI into docs/ so GitHub Pages can serve it as a live demo.
# docs/assets is kept (demo GIF).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p docs/assets
cp extension/app/* docs/
echo "docs/ updated"
