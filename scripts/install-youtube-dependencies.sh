#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y nodejs python3 curl ca-certificates
if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null; then
  arch=$(dpkg --print-architecture)
  [[ $arch == amd64 || $arch == arm64 ]] || { echo 'Install a supported Chrome/Chromium build first.' >&2; exit 1; }
  package_dir=$(mktemp -d)
  trap 'rm -rf -- "$package_dir"' EXIT
  curl -fL --retry 2 "https://dl.google.com/linux/direct/google-chrome-stable_current_${arch}.deb" -o "$package_dir/chrome.deb"
  sudo apt-get install -y "$package_dir/chrome.deb"
fi
