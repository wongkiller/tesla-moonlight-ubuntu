#!/usr/bin/env bash
set -euo pipefail
systemctl --user stop tesla-youtube-pause.timer tesla-youtube-pause.service 2>/dev/null || true
for service in tesla-youtube-browser.service tesla-youtube-control.service \
  tesla-moonlight-tunnel.service tesla-moonlight-origin.socket \
  tesla-moonlight-origin.service tesla-moonlight-web.service \
  tesla-wsl-sunshine.service tesla-wsl-desktop.service tesla-wsl-audio.service tesla-wsl-x11.service; do
  if [[ -f "$HOME/.config/systemd/user/$service" ]]; then
    systemctl --user disable --now "$service"
    rm -- "$HOME/.config/systemd/user/$service"
  fi
done
rm -f -- "$HOME/.config/systemd/user/tesla-moonlight-web.service.d/wsl.conf"
rm -f -- "$HOME/.config/systemd/user/tesla-moonlight-web.service.d/youtube.conf"
systemctl --user daemon-reload
echo 'Tesla services removed. Runtime, secrets, installed packages and pairing data preserved.'
