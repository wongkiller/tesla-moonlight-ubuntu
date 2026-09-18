#!/usr/bin/env bash
# One entry point for a clean Ubuntu container. No secret values are logged.
set -Eeuo pipefail
umask 077
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(id -u) == 0 ]] || exec sudo -H bash "$0" "$@"
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 26.04 ]] || { echo 'Ubuntu 26.04 is required.' >&2; exit 1; }
[[ -f /.dockerenv || -f /run/.containerenv ]] || { echo 'Use this bootstrap inside an Ubuntu container. Native/WSL installation: see install.sh.' >&2; exit 1; }
config=${TESLA_CONFIG:-$root_dir/config/internet.json}
mode=${1:---install}
mkdir -p "$(dirname -- "$config")" /var/log/tesla-moonlight-ubuntu
if [[ ! -f $config ]]; then
  if [[ -f /root/.config/tesla-moonlight-ubuntu/internet.json ]]; then
    cp /root/.config/tesla-moonlight-ubuntu/internet.json "$config"
  else
    cp "$root_dir/config/internet.example.json" "$config"
  fi
  chmod 600 "$config"
fi
if [[ $mode == --prepare ]]; then echo "Fill in $config, then run: bash scripts/bootstrap.sh"; exit 0; fi
[[ $mode == --install || $mode == --dependencies ]] || { echo 'Use --prepare, --dependencies or --install'; exit 1; }
exec 9>/var/lock/tesla-moonlight-install.lock
flock 9
log=/var/log/tesla-moonlight-ubuntu/install.log
exec > >(tee -a "$log") 2>&1
failed() {
  local result=$1 line=$2
  echo "INSTALL FAILED (exit $result, line $line). Log: $log. Fix the reported cause and rerun the same command; existing data is preserved."
  exit "$result"
}
trap 'failed "$?" "$LINENO"' ERR
export DEBIAN_FRONTEND=noninteractive
packages=(python3 git ca-certificates curl sudo supervisor dbus-x11 pulseaudio pulseaudio-utils libcap2-bin
  xauth x11-utils x11-xserver-utils xserver-xorg-core xserver-xorg-video-dummy
  xfwm4 xfce4-panel xfdesktop4 xfce4-terminal fonts-dejavu-core fonts-noto-cjk
  build-essential cmake clang libclang-dev libssl-dev pkg-config perl nodejs npm rustup jq shellcheck)
missing=()
for package in "${packages[@]}"; do
  [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) == 'install ok installed' ]] || missing+=("$package")
done
echo "Missing apt dependencies: ${missing[*]:-none}"
if ((${#missing[@]})); then
  apt-get -o Acquire::Retries=3 update
  apt-get -o Acquire::Retries=3 install -y --no-install-recommends "${missing[@]}"
fi
if [[ $mode == --install ]]; then
  python3 "$root_dir/scripts/container-setup.py" validate "$config"
  mkdir -p /root/.config/tesla-moonlight-ubuntu
  if [[ $(realpath "$config") != /root/.config/tesla-moonlight-ubuntu/internet.json ]]; then
    install -m 600 "$config" /root/.config/tesla-moonlight-ubuntu/internet.json
  fi
fi
for component in sunshine cloudflared; do
  if ! command -v "$component" >/dev/null; then
    python3 "$root_dir/scripts/install-host-package.py" "$component"
  fi
done
if [[ -n $(getcap /usr/bin/sunshine) ]]; then
  # Software X11 capture needs no elevated file capabilities in a container.
  setcap -r /usr/bin/sunshine
fi
if ! command -v google-chrome >/dev/null; then
  [[ $(dpkg --print-architecture) == amd64 ]] || { echo 'This Docker edition currently requires amd64 for official Google Chrome.'; exit 1; }
  temporary=$(mktemp -d)
  curl --fail --location --retry 3 --output "$temporary/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get -o Acquire::Retries=3 install -y "$temporary/chrome.deb"
  rm -f -- "$temporary/chrome.deb"
  rmdir -- "$temporary"
fi
if ! id sunshine >/dev/null 2>&1; then useradd --create-home --shell /bin/bash sunshine; fi
mkdir -p /home/sunshine
chown sunshine:sunshine /home/sunshine
if ! python3 "$root_dir/scripts/container-setup.py" verify-build >/dev/null 2>&1; then
  echo 'Building Linux runtime from the cloned, locked source (including tests).'
  rustup toolchain install nightly-2025-09-01 --profile minimal
  bash "$root_dir/scripts/build-runtime.sh"
fi
if [[ $mode == --dependencies ]]; then echo 'System dependencies and tested runtime are ready.'; exit 0; fi
python3 "$root_dir/scripts/container-setup.py" install "$config"
python3 "$root_dir/scripts/configure-container-route.py" "$config"
echo 'Installed. Start with: bash scripts/container-entrypoint.sh'
