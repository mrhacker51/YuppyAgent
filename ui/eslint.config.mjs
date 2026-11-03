import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored MediaPipe runtime assets are served verbatim from public/.
    "public/mediapipe/**",
    // Compiled test harness output (tsc → .tmp-tests), regenerated per run.
    ".tmp-tests/**",
    "tsconfig.tmp.json",
    // Vendored pixelfx effects (MIT): third-party JS, not our lint surface.
    "src/lib/pixelfx/core/**",
    "src/lib/pixelfx/fx/**",
  ]),
]);

export default eslintConfig;
