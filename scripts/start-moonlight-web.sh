#!/usr/bin/env bash
set -euo pipefail
umask 077
runtime_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# EnvironmentFile supplies the TURN token. No Keychain or shell-sourced secrets.
# Wait for Sunshine only on a desktop install; bridge-only can use another host.
if [[ ${COCKPIT_WAIT_FOR_SUNSHINE:-0} == 1 ]]; then
  ready=0
  for ((attempt=0; attempt<60; attempt++)); do
    if curl -fsS --max-time 1 http://127.0.0.1:47989/serverinfo >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ $ready == 1 ]] || { echo 'Sunshine did not become ready; inspect the Sunshine user service journal' >&2; exit 1; }
fi
cd "$runtime_dir"
exec "$runtime_dir/web-server"
