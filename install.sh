#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case "${1:-}" in
  --auto) shift; exec bash "$project_dir/scripts/bootstrap.sh" "$@" ;;
  --install-deps) exec bash "$project_dir/scripts/install-dependencies.sh" ;;
  --build) exec bash "$project_dir/scripts/build-runtime.sh" ;;
  --check) exec python3 "$project_dir/scripts/doctor.py" ;;
  --install-wsl-deps) exec bash "$project_dir/scripts/install-wsl-dependencies.sh" ;;
  --install-youtube-deps) exec bash "$project_dir/scripts/install-youtube-dependencies.sh" ;;
  --youtube) exec python3 "$project_dir/scripts/setup-youtube.py" ;;
  --wsl) shift; exec python3 "$project_dir/scripts/install-wsl.py" "$@" ;;
  *) exec python3 "$project_dir/scripts/setup.py" "$@" ;;
esac
