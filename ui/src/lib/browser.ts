/**
 * Browser-tab helpers: URL normalization, URL extraction from real log/task
 * text, and opening URLs in an external browser.
 *
 * Opening strategy, in order: Tauri opener/shell plugin when the desktop
 * shell exposes it → window.open(url, "_blank") (web UI: a new tab in the
 * operator's own Chrome/Firefox; Tauri delegates external navigation to the
 * system browser) → clipboard fallback with a loud log, never silent.
 */

export const BROWSER_PINS_KEY = "yuppy.browser.pins.v1";
export const BROWSER_HISTORY_KEY = "yuppy.browser.history.v1";
const MAX_HISTORY = 24;
const MAX_PINS = 24;

/** Normalize operator-typed or log-found text into a URL, or null. Accepts
 * bare hosts (localhost:3000, example.com) by assuming http(s). */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim().replace(/^[("'<]+|[)"'>.,;!]+$/g, "");
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (!u.hostname) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  // bare host[:port][/path] — localhost and IPs default to http, others https
  if (!/^[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(t)) return null;
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(t);
  const withScheme = `${isLocal ? "http" : "https"}://${t}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}|\\^`]+/gi;

/** All URLs in a text, normalized and de-duplicated, order preserved. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const u = normalizeUrl(m[0]);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export type OpenResult = "tauri" | "window" | "clipboard";

/** Open a URL outside the app. Never throws; reports which path was taken. */
export async function openExternal(url: string): Promise<OpenResult> {
  const w = window as unknown as {
    __TAURI__?: {
      opener?: { openUrl?: (u: string) => Promise<unknown> };
      shell?: { open?: (u: string) => Promise<unknown> };
    };
  };
  try {
    if (w.__TAURI__?.opener?.openUrl) {
      await w.__TAURI__.opener.openUrl(url);
      return "tauri";
    }
    if (w.__TAURI__?.shell?.open) {
      await w.__TAURI__.shell.open(url);
      return "tauri";
    }
  } catch {
    // fall through to window.open
  }
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (win) return "window";
  try {
    await navigator.clipboard.writeText(url);
    return "clipboard";
  } catch {
    return "clipboard";
  }
}

function readList(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[], cap: number) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, cap)));
  } catch {
    // storage unavailable — pins/history are convenience only
  }
}

export function loadPins(): string[] {
  return readList(BROWSER_PINS_KEY);
}

export function loadHistory(): string[] {
  return readList(BROWSER_HISTORY_KEY);
}

export function togglePin(url: string): string[] {
  const pins = loadPins();
  const next = pins.includes(url) ? pins.filter((p) => p !== url) : [url, ...pins];
  writeList(BROWSER_PINS_KEY, next, MAX_PINS);
  return next;
}

/** Record an opened URL in history (newest first, de-duplicated). */
export function pushHistory(url: string): string[] {
  const next = [url, ...loadHistory().filter((h) => h !== url)];
  writeList(BROWSER_HISTORY_KEY, next, MAX_HISTORY);
  return next;
}
