/**
 * Headless browser shim for the HUD store tests.
 *
 * `src/lib/store.ts` is a browser module: it talks to `window`, `localStorage`
 * and `WebSocket`, and it early-returns out of `connect()` when `window` is
 * missing. Rather than mocking the store, this harness gives it a tiny fake
 * DOM so the *real* reducer, reconnect logic and layout persistence run
 * unmodified under `node --test`.
 *
 * Import order matters: the shim is installed at this module's top level and
 * the store is pulled in with a dynamic import afterwards, so the store never
 * observes a window-less environment.
 */
import type { Envelope, ServerPayload } from "@/lib/protocol";

const BRIDGE_TOKEN = "test-bridge-token";
const BRIDGE_URL = "ws://127.0.0.1:9090";

class FakeStorage {
  #data = new Map<string, string>();

  get length() {
    return this.#data.size;
  }

  getItem(key: string): string | null {
    return this.#data.has(key) ? (this.#data.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.#data.delete(key);
  }

  clear(): void {
    this.#data.clear();
  }

  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }
}

/** Minimal WebSocket double: records frames, lets the test drive the events. */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 1;
  frames: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.frames.push(String(data));
  }

  close(): void {
    this.readyState = 3;
  }

  /** Every JSON request the store has written to this socket, newest last. */
  requests(): Array<Record<string, unknown>> {
    return this.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  lastRequest(): Record<string, unknown> | undefined {
    const frame = this.frames[this.frames.length - 1];
    return frame ? (JSON.parse(frame) as Record<string, unknown>) : undefined;
  }

  /** Client-side open, i.e. the bridge accepted the TCP connection. */
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Server -> client frame. */
  deliver(payload: ServerPayload): void {
    this.onmessage?.({ data: JSON.stringify(makeEnvelope(payload)) });
  }

  /** Deliver a raw frame so malformed/unknown payloads can be exercised. */
  deliverRaw(data: string): void {
    this.onmessage?.({ data });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let seq = 0;

export function makeEnvelope(payload: ServerPayload): Envelope {
  return { version: 2, seq: (seq += 1), ts_ms: Date.now(), payload };
}

function installBrowserEnv(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.window) return;
  const storage = new FakeStorage();
  storage.setItem("yuppy.bridge.token", BRIDGE_TOKEN);
  g.localStorage = storage;
  g.window = {
    location: { search: "", href: "http://localhost:3434/" },
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
  };
  g.WebSocket = FakeWebSocket;
}

installBrowserEnv();

const { useHudStore } = await import("@/lib/store");
const pristineState = useHudStore.getState();

export type HudState = typeof pristineState;
export { useHudStore };

/** Full reset: drop timers/sockets, restore the module's initial state. */
export function resetHud(): void {
  useHudStore.getState().disconnect();
  useHudStore.setState(pristineState, true);
  FakeWebSocket.instances.length = 0;
  delete (globalThis as unknown as Record<string, unknown>).requestAnimationFrame;
}

export function hud(): HudState {
  return useHudStore.getState();
}

/** The socket created by the most recent `connect()` call. */
export function newestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!socket) throw new Error("no WebSocket was created; did connect() run?");
  return socket;
}

/**
 * Connect, complete the handshake and apply the bridge's `connected` frame.
 * Returns the socket so tests can keep pushing payloads.
 */
export function connectBridge(url = BRIDGE_URL): FakeWebSocket {
  useHudStore.getState().connect(url, BRIDGE_TOKEN);
  const socket = newestSocket();
  socket.serverOpen();
  socket.deliver({ type: "connected" });
  return socket;
}

export function logsMatching(fragment: string): string[] {
  return hud()
    .logs.filter((entry) => entry.message.includes(fragment))
    .map((entry) => entry.message);
}

/** Queue frames through a fake rAF, proving screen/task updates coalesce. */
export function installAnimationFrameQueue(): { flush: () => void } {
  const queue: Array<() => void> = [];
  (globalThis as unknown as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => {
    queue.push(cb);
    return queue.length;
  };
  return {
    flush() {
      const pending = queue.splice(0, queue.length);
      pending.forEach((cb) => cb());
    },
  };
}

export const connectToken = BRIDGE_TOKEN;
