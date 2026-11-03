import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Next resolves with bundler semantics (`./store`, `@/lib/protocol`), which
 * plain Node ESM rejects. These hooks add the two twists the test runner needs
 * so the exact source files the browser loads can be imported by `node --test`
 * without adding a bundler to the repo:
 *  - extensionless relative specifiers resolve to `.ts`/`.tsx`/index files
 *  - the `@/` path alias from tsconfig.json maps to `src/`
 *
 * Only `resolve` is implemented, so Node's own load hook keeps applying
 * `--experimental-strip-types`.
 */
const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const INDEX_FILES = ["/index.ts", "/index.tsx", "/index.js"];

function isFile(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function firstExisting(base) {
  for (const suffix of [...EXTENSIONS, ...INDEX_FILES]) {
    const candidate = base + suffix;
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const isAlias = specifier.startsWith("@/");
  if (!specifier.startsWith(".") && !isAlias) {
    return nextResolve(specifier, context);
  }
  const base = isAlias
    ? path.resolve(UI_ROOT, "src", specifier.slice(2))
    : path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  const alreadyDiscrete = EXTENSIONS.includes(path.extname(specifier)) && isFile(base);
  const found = alreadyDiscrete ? base : firstExisting(base);
  if (!found) return nextResolve(specifier, context);
  return { url: pathToFileURL(found).href, shortCircuit: true };
}
