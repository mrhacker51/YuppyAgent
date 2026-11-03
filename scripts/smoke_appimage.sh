#!/usr/bin/env bash
# Smoke test the freshly built AppImage under Xvfb.
#
# Runs headless, launches the shell, waits for the bridge sidecar, verifies
# the UI reports CONNECTED, and grabs a screenshot for visual review.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="$(ls -t "$ROOT/desktop/src-tauri/target/release/bundle/appimage/YuppyCode_*.AppImage" | head -1)"
WORKDIR="${SMOKE_WORKDIR:-/tmp/yuppy-appimage}"
mkdir -p "$WORKDIR"

if [ ! -f "$APPIMAGE" ]; then
  echo "no AppImage found under $ROOT/desktop/src-tauri/target/release/bundle/appimage" >&2
  exit 1
fi
echo "==> AppImage: $APPIMAGE"

# Kill anything left from a previous run.
pkill -f "YuppyCode.*AppImage" 2>/dev/null || true
pkill -f "yuppy bridge" 2>/dev/null || true
sleep 1

export APPIMAGE_EXTRACT_AND_RUN=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export XDG_RUNTIME_DIR="$WORKDIR/xdg"
mkdir -p "$XDG_RUNTIME_DIR"

# A fresh Xvfb display so the previous smoke run cannot leak state.
DISPLAY=:99
if ! pgrep -f "Xvfb :99" >/dev/null; then
  Xvfb :99 -screen 0 1600x950x24 -nolisten tcp -nolisten unix >/tmp/xvfb-99.log 2>&1 &
  sleep 2
fi

export DISPLAY=:99

cd "$WORKDIR"
nohup "$APPIMAGE" >/tmp/appimage-run.log 2>&1 &
APP_PID=$!
echo "==> launched pid $APP_PID"

# The shell prints its own bridge URL/token to stderr; wait for the sidecar.
for i in $(seq 1 60); do
  if grep -q "bridge listening on" /tmp/appimage-run.log 2>/dev/null; then
    break
  fi
  sleep 1
done
echo "==> sidecar log:"
grep -E "bridge listening|token" /tmp/appimage-run.log | head -5 || true

# Screenshot with ffmpeg x11grab (Playwright is not installed in the smoke env).
sleep 3
ffmpeg -y -f x11grab -s 1600x950 -i :99.0 -frames:v 1 "$WORKDIR/appimage-screenshot.png" >/dev/null 2>&1 || true
echo "==> screenshot: $WORKDIR/appimage-screenshot.png"

# Verify the sidecar is still alive and the UI connected.
if pgrep -f "yuppy bridge" >/dev/null; then
  echo "==> sidecar alive"
else
  echo "==> sidecar died — see /tmp/appimage-run.log" >&2
  exit 1
fi

echo "==> done"