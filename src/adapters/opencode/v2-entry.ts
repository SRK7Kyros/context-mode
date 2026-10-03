/**
 * OpenCode v2 plugin module for context-mode.
 *
 * The v2 host validates a plugin's default export as either `{ id, effect }` or
 * `{ id, setup }` (opencode-fork-v2: packages/core/src/plugin/module.ts) and
 * resolves the loadable entry from the package's `./server` export. This file
 * is that entrypoint: it re-exports the adapter's `setup` under the required
 * default shape while keeping the v1 `server` factory available for v1 hosts.
 *
 * Keeping both keys on one object mirrors the oh-my-opencode plugin
 * (packages/omo-opencode/src/index.ts): v1 loaders read `server` and ignore
 * `setup`; the v2 loader strips `server` and calls `setup`.
 */

import { ContextModePlugin } from "./plugin.js";
import { setup } from "./v2.js";

// `ContextModePlugin` is the v1 factory; keep it as the `server` key for v1 hosts.
const createContextModePlugin = ContextModePlugin;

export { setup };
export { ContextModePlugin };

export default {
  id: "context-mode",
  setup,
  server: createContextModePlugin,
};
