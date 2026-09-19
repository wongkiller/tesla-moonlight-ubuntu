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
exec /usr/bin/supervisord -n -c /etc/tesla-moonlight-ubuntu/supervisord.conf
