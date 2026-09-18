#!/usr/bin/env bash
set -euo pipefail
state_dir=${TESLA_WSL_STATE:?}
for ((attempt=0; attempt<50; attempt++)); do
  if xdpyinfo >/dev/null 2>&1 && pactl info >/dev/null 2>&1; then
    break
  fi
  sleep .2
done
xdpyinfo >/dev/null
pactl info >/dev/null
python3 "$state_dir/display-mode.py" native
xset s off
xset -dpms 2>/dev/null || true
xfwm4 --compositor=off &
window_manager=$!
xfce4-panel &
xfdesktop &
xfce4-terminal --disable-server --title='Ubuntu 26.04 — Tesla test desktop' \
  --geometry=95x24+160+140 --command="bash $state_dir/welcome.sh" &
wait "$window_manager"
