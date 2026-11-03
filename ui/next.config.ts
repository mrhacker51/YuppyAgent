import type { NextConfig } from "next";

/**
 * Two build modes:
 * - default (`next dev` / `next build`): the developer workflow, unchanged
 *   (cacheComponents + partial prefetching on the Next dev server).
 * - `NEXT_EXPORT=1 next build`: static export for the Tauri desktop shell.
 *   The app is a client-only shell (every component is "use client", state
 *   lives in zustand, no server actions/routes), so it exports cleanly;
 *   cacheComponents is off in this mode because partial prerendering needs
 *   the Next server.
 */
const sharedTurbopack = {
  rules: {
    "*.css": {
      loaders: ["@tailwindcss/turbopack"],
      as: "*.css",
    },
  },
};

const nextConfig: NextConfig =
  process.env.NEXT_EXPORT === "1"
    ? {
        output: "export",
        images: { unoptimized: true },
        turbopack: sharedTurbopack,
      }
    : {
        cacheComponents: true,
        partialPrefetching: true,
        turbopack: sharedTurbopack,
        // The desktop shell and a plain browser both reach the dev server over
        // loopback; Next otherwise refuses the 127.0.0.1 spelling of the same
        // origin and floods the log with a host warning on every load.
        allowedDevOrigins: ["127.0.0.1", "localhost"],
        // The deck is a product surface, not a docs page: the floating dev
        // badge sits on top of the status rail and is mistaken for app chrome.
        // Errors still reach the terminal and the browser console.
        devIndicators: false,
      };

export default nextConfig;
