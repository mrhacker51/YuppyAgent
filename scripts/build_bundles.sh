#!/usr/bin/env bash
# Build the Linux bundles: backend → static UI → Tauri (.deb + .AppImage).
#
# The backend (`yuppy`) is copied into `desktop/src-tauri/binaries/` with the
# target-triple suffix Tauri requires, so both bundles are self-contained: the
# shell finds the sidecar next to its own executable (usr/bin/yuppy).
#
# Usage: scripts/build_bundles.sh [extra tauri build args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# cargo lives in ~/.cargo/bin; non-login shells need this.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

TRIPLE="${TAURI_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
echo "==> target triple: $TRIPLE"

echo "==> backend (release)"
cargo build --release -p yuppycode-cli

echo "==> frontend (static export)"
pnpm -C ui build:export

echo "==> sidecar: target/release/yuppy → desktop/src-tauri/binaries/yuppy-$TRIPLE"
mkdir -p desktop/src-tauri/binaries
cp target/release/yuppy "desktop/src-tauri/binaries/yuppy-$TRIPLE"
chmod +x "desktop/src-tauri/binaries/yuppy-$TRIPLE"

echo "==> Tauri bundles (.deb + .AppImage)"
cd desktop
# APPIMAGE_EXTRACT_AND_RUN lets the AppImage tooling run on hosts without
# FUSE2 (common in containers/CI); Tauri's bundler honors it.
APPIMAGE_EXTRACT_AND_RUN=1 pnpm dlx "@tauri-apps/cli@^2" build --bundles deb,appimage "$@"

echo "==> bundles"
ls -la target/release/bundle/deb/*.deb 2>/dev/null || true
ls -la target/release/bundle/appimage/*.AppImage 2>/dev/null || true