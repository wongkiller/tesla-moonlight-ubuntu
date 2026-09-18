#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'Run this inside Ubuntu.' >&2; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu ]] || { echo 'This installer targets Ubuntu.' >&2; exit 1; }
sudo apt-get update
sudo apt-get install -y build-essential cmake clang libclang-dev libssl-dev \
  pkg-config perl nodejs npm rustup python3 curl ca-certificates jq shellcheck
rustup toolchain install nightly-2025-09-01 --profile minimal
echo 'Build dependencies ready. Sunshine and cloudflared are separate; see README.md.'
