/**
 * Desktop pairing regression.
 *
 * The Tauri shell hands the webview a per-launch port + token through
 * `bridge_config`. The store's `bridgeUrl` is computed at module load, i.e.
 * *before* that async call resolves, so it must never win over the
 * shell-provided URL — this was the bug that made the first AppImage dial
 * 127.0.0.1:9090 while its sidecar listened on a random port.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { hud, newestSocket, resetHud } from "./helpers/dom-env";
import { applyDesktopBridgeConfig } from "@/lib/store";

const SHELL_TOKEN = "a".repeat(64);

beforeEach(() => {
  resetHud();
  localStorage.removeItem("yuppy.bridge.url");
});

test("the shell-provided URL and token win over the module-load default", () => {
  assert.equal(hud().bridgeUrl, "ws://127.0.0.1:9090", "stale default before pairing");

  applyDesktopBridgeConfig({ url: "ws://127.0.0.1:40233", token: SHELL_TOKEN });

  assert.equal(hud().bridgeUrl, "ws://127.0.0.1:40233");
  const socket = newestSocket();
  assert.equal(socket.url, "ws://127.0.0.1:40233", "dialed the shell port, not 9090");

  socket.serverOpen();
  const handshake = socket.requests()[0] as { version?: number; token?: string };
  assert.equal(handshake.version, 2);
  assert.equal(handshake.token, SHELL_TOKEN, "the shell token reaches the handshake");
});

test("the desktop port is not written into the browser pairing storage", () => {
  applyDesktopBridgeConfig({ url: "ws://127.0.0.1:40234", token: SHELL_TOKEN });
  assert.equal(
    localStorage.getItem("yuppy.bridge.url"),
    null,
    "the next browser launch must not chase a dead desktop port",
  );
});
