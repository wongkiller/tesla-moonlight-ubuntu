#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $(uname -s) == Linux ]] || { echo 'Build inside Ubuntu / WSL2.' >&2; exit 1; }
for tool in cargo rustup npm node cmake clang pkg-config python3; do
  command -v "$tool" >/dev/null || { echo "Missing $tool; run bash install.sh --install-deps" >&2; exit 1; }
done
source_dir="$project_dir/moonlight-web-stream-tsla"
frontend_dir="$source_dir/moonlight-web/web-server"
# WSL builds are much faster on ext4 than /mnt/d. Override for CI if needed.
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tesla-moonlight-ubuntu/target}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-8}
# The vendored C project predates CMake 4. Keep compatibility with its minimum.
export CMAKE_POLICY_VERSION_MINIMUM=3.5
cd "$source_dir"
rustup run nightly-2025-09-01 rustc --version
cargo test --locked -p web-server -p streamer -p common -p moonlight-common -p moonlight-common-sys
cd "$frontend_dir"
npm ci --no-audit --no-fund
npm run build
version=$(tr -d '\r\n' < "$project_dir/FRONTEND_BUILD_VERSION")
[[ $version =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Invalid frontend version' >&2; exit 1; }
node "$project_dir/scripts/cache-bust-frontend.mjs" "$frontend_dir/dist" "$version"
cd "$source_dir"
cargo build --locked --release -p web-server -p streamer
python3 "$project_dir/scripts/stage-runtime.py" "$CARGO_TARGET_DIR/release"
python3 "$project_dir/tests/smoke.py" "$project_dir/build/runtime"
echo "Validated Linux runtime: $project_dir/build/runtime"
