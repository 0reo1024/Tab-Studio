#!/bin/bash
set -euo pipefail
cd -- "$(dirname "$0")/.."
command -v node >/dev/null || { echo 'Node.js 22以降をインストールしてください。'; exit 1; }
command -v pnpm >/dev/null || { echo 'pnpm 11をインストールしてください。'; exit 1; }
pnpm install --frozen-lockfile
pnpm run prepare:assets
pnpm test
pnpm run dist:mac
echo 'release/0.3.9 にDMGとZIPを作成しました。'
