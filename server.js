// Local-directory entrypoint for OpenCode v2.
//
// `Host.resolve({ directory })` sits next to the package root (no package name
// in that code path) and probes the literals `server` then `index`, so a
// configured local directory is only discovered through a physical `server.js`
// at the root. The built adapter lives under build/adapters/opencode; this file
// re-exports it so the directory is loadable without relying on exports maps.
import plugin, { setup, ContextModePlugin } from "./build/adapters/opencode/v2.js";

export { setup, ContextModePlugin };
export { plugin as server };
export default plugin;
