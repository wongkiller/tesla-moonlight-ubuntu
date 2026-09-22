#!/usr/bin/env bash
set -Eeuo pipefail
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
config=${TESLA_CONFIG:-$root_dir/config/internet.json}
bash "$root_dir/scripts/bootstrap.sh" --prepare
while ! command -v python3 >/dev/null || ! command -v nano >/dev/null; do
  apt-get -o Acquire::Retries=3 update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y python3 nano && break
  echo 'Initial dependency download failed; retrying in 30 seconds.'
  sleep 30
done
bash "$root_dir/scripts/bootstrap.sh" --dependencies
while ! python3 "$root_dir/scripts/container-setup.py" validate "$config"; do
  echo "WAITING FOR CONFIG: $config (edit it without posting credentials to GitHub)."
  sleep 15
done
bash "$root_dir/scripts/bootstrap.sh"
# CasaOS custom apps often strip compose shm_size, so Docker still gives 64 MiB.
# Root in this namespace can enlarge the tmpfs without recreating the container.
mount -o remount,size=1G /dev/shm || true
# VAAPI when /dev/dri is present and writable; software otherwise.
conf=/home/sunshine/.local/share/tesla-moonlight-ubuntu/wsl-desktop/sunshine/sunshine.conf
python3 "$root_dir/scripts/select-sunshine-encoder.py" --apply "$conf" || true
# Docker recreate changes hostname; Xauth cookies are hostname-scoped.
auth=/home/sunshine/.local/share/tesla-moonlight-ubuntu/wsl-desktop/Xauthority
if [ -f "$auth" ] && command -v xauth >/dev/null; then
  cookie=$(xauth -f "$auth" list 2>/dev/null | awk 'NF>=3 {print $3; exit}')
  if [ -n "$cookie" ]; then
    xauth -f "$auth" add "$(hostname)/unix:99" MIT-MAGIC-COOKIE-1 "$cookie" 2>/dev/null || true
  fi
fi
exec /usr/bin/supervisord -n -c /etc/tesla-moonlight-ubuntu/supervisord.conf
