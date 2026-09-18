#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -r) == *microsoft* ]] || { echo 'Run this inside Ubuntu WSL2.' >&2; exit 1; }
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sudo apt-get update
sudo apt-get install -y python3 ca-certificates xvfb xauth x11-utils x11-xserver-utils \
  dbus-x11 pulseaudio pulseaudio-utils xfwm4 xfce4-panel xfdesktop4 xfce4-terminal \
  xserver-xorg-core xserver-xorg-video-dummy
if ! command -v sunshine >/dev/null; then
  python3 "$project_dir/scripts/install-host-package.py" sunshine
fi
echo 'Sunshine and WSL desktop dependencies ready. Run: bash install.sh --wsl'
