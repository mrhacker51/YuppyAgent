/**
 * Patch fancy-ui-react's `useNow` server snapshot.
 *
 * Upstream ships `getServerNow() { return Number.NaN }`. React compares the
 * server snapshot with `Object.is`, and `Object.is(NaN, NaN)` is false — so in
 * development React reports "The result of getServerSnapshot should be cached
 * to avoid an infinite loop" on every screen that renders a ChatMessage,
 * ToolTimeline or ThreadList. The value is only used to format a relative
 * timestamp before hydration, where `0` behaves exactly like `NaN` (both are
 * "unknown"), but `0` is stable and self-equal.
 *
 * Idempotent and safe to run twice. Wired as `postinstall` so a fresh
 * `npm install` keeps the fix.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "node_modules/fancy-ui-react/dist/internals/use-elapsed.js");

if (!existsSync(target)) {
  // Peer not installed (e.g. a production image that strips devDeps): nothing
  // to patch, and that is not a failure.
  process.exit(0);
}

const before = readFileSync(target, "utf8");
const after = before.replace(
  /function getServerNow\(\)\s*\{\s*return Number\.NaN;?\s*\}/,
  "function getServerNow() { return 0; }",
);

if (after === before) {
  if (before.includes("function getServerNow() { return 0; }")) {
    process.exit(0); // already patched
  }
  console.warn(
    "[patch-fancy-ui] getServerNow not found — the package layout changed; review this patch.",
  );
  process.exit(0);
}

writeFileSync(target, after);
console.log("[patch-fancy-ui] useNow server snapshot is now cached (0 instead of NaN).");
