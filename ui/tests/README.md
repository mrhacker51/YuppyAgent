# HUD tests

Behaviour tests for the 3D command centre's state layer (`src/lib/*`): the bridge
reducer, the department carousel, the floating panel layout and the terminal cell
repaint. Run them with:

```bash
cd ui
npm test
```

No test dependency is installed on purpose. The runner is `node --test` with
Node 22 type stripping, plus two small pieces of plumbing:

- `register.mjs` / `ts-resolver.mjs` let the runner import Next-style sources
  (extensionless `./store`, the `@/` alias) without a bundler.
- `helpers/dom-env.ts` installs a fake `window`, `localStorage` and
  `WebSocket`, then imports the store, so the real reducer, reconnect backoff
  and layout persistence run unmodified instead of being mocked.

## Conventions

- `beforeEach(resetHud)` restores the store's initial state; `connectBridge()`
  performs the handshake and applies the bridge's `connected` frame.
- Assertions quote the exact user-visible string. These strings are the HUD's
  contract with the operator, so renaming one should fail loudly here.
- Payload literals in these files mirror the Rust bridge
  (`crates/yuppycode-cli/src/bridge`, `crates/yuppycode-protocol`). If a field is
  renamed on one side, the relevant test here is the thing that should go red.
- `components/*` are deliberately not rendered here: they are the part of the UI
  under the most churn, and the state they read is covered by these tests.
