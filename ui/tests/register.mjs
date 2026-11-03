import { register } from "node:module";

// Loaded through `node --import ./tests/register.mjs`; installs the resolver
// that lets the test runner import Next-style TypeScript sources.
register("./ts-resolver.mjs", import.meta.url);
