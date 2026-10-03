/**
 * OpenCode v2 plugin adapter for context-mode.
 *
 * The existing OpenCode integration (./plugin.ts) targets the v1 plugin
 * contract: a default export shaped `{ id, server: (input) => Promise<Hooks> }`.
 * The v2 host accepts ONLY `{ id, effect }` or `{ id, setup }`
 * (opencode-fork-v2: packages/core/src/plugin/module.ts), so a v1 `server`
 * factory is rejected with "Plugin must export a default definition with an id
 * and an effect or setup function."
 *
 * This module adapts the UNCHANGED v1 hooks onto the v2 domain surface. No hook
 * body is re-implemented; the adapter only translates payload shapes and the
 * registration call, exactly as the oh-my-opencode plugin does for its own v1
 * hooks (packages/omo-opencode/src/plugin/v2/register.ts).
 *
 * Key runtime facts this relies on (verified against the live v2 host):
 *   - `tool.hook("execute.before", cb)` hands `event.input` to the callback; the
 *     object is live, so writing `event.input = output.args` feeds mutated args
 *     back to the host. This is how v1 `output.args` mutation keeps working.
 *   - `tool.hook("execute.after", cb)` exposes `event.result`; assigning
 *     `event.result.content` feeds the mutated output back.
 *   - `session.hook("context", cb)` carries mutable `system[]` and `messages[]`,
 *     replacing v1 `experimental.chat.system.transform` and
 *     `experimental.chat.messages.transform`.
 *   - `session.hook("prompt", cb)` replaces v1 `chat.message`.
 *   - `session.hook("compaction", cb)` replaces v1
 *     `experimental.session.compacting`.
 *   - `event.subscribe()` replaces the v1 `event` hook.
 */

import { ContextModePlugin } from "./plugin.js";

const createContextModePlugin = ContextModePlugin;

// ── v2 structural types ────────────────────────────────────
// Deliberately local so the built bundle needs no runtime dependency on the v2
// package (which is not installed in this repo).

type V2Registration = { dispose: () => Promise<void> };
type V2Cleanup = () => Promise<void>;

type V2SystemPart = { type?: string; text?: string } & Record<string, unknown>;

type V2SessionContextEvent = {
  sessionID: string;
  model: { id: string; providerID: string };
  agent: string;
  system: V2SystemPart[];
  messages: Array<Record<string, unknown>>;
  options: Record<string, unknown>;
};

type V2SessionPromptEvent = {
  sessionID: string;
  messageID: string;
  prompt: { text: string } & Record<string, unknown>;
};

type V2CompactionEvent = V2SessionContextEvent & { result?: unknown };

type V2ToolBeforeEvent = {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
};

type V2ToolAfterEvent = {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
} & (
  | { status: "completed"; result: Record<string, unknown> }
  | { status: "error"; error: unknown }
);

type V2ToolEditor = {
  add(tool: {
    id?: string;
    name?: string;
    description: string;
    input: unknown;
    inputSchema?: unknown;
    execute: (...args: never[]) => unknown;
  }): void;
  list(): Array<{ id: string; description: string; input: unknown }>;
  update(id: string, update: (tool: { description: string; input: unknown }) => void): void;
};

type V2SetupContext = {
  location: { directory: string; worktree?: string };
  options?: Record<string, unknown>;
  session: {
    hook(name: string, cb: (event: never) => unknown): Promise<V2Registration>;
  };
  tool: {
    hook(name: string, cb: (event: never) => unknown): Promise<V2Registration>;
    transform(cb: (editor: V2ToolEditor) => unknown): Promise<V2Registration>;
  };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
};

// ── v1 hook shapes (structural views) ──────────────────────

type V1Hooks = Awaited<ReturnType<typeof createContextModePlugin>>;

type ToolBeforeOut = { args: Record<string, unknown> };
type ToolAfterOut = { title: string; output: string; metadata: Record<string, unknown> };
type SystemTransformOut = { system: string[] };
type CompactingOut = { context: string[] };
type ChatMessageOut = { parts: Array<{ type?: string; text?: string } & Record<string, unknown>> };
type CompactingIn = { sessionID?: string };
type SystemTransformIn = { sessionID?: string; model?: unknown };
type ChatMessageIn = { sessionID?: string; agent?: string; messageID?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the model-facing text from a v2 tool result the same way OMO's tool
 * adapter does: prefer `content` parts, fall back to `output`.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

// ── adapters: v2 event -> v1 hook call -> write back ───────

/** v1 `tool.execute.before`: deny by throwing, mutate args in place. */
function createToolBeforeAdapter(hooks: V1Hooks) {
  return async (event: V2ToolBeforeEvent): Promise<void> => {
    const handler = hooks["tool.execute.before"];
    if (!handler) return;
    const output: ToolBeforeOut = { args: isRecord(event.input) ? event.input : {} };
    await handler({ tool: event.tool, sessionID: event.sessionID, callID: event.id }, output);
    event.input = output.args;
  };
}

/** v1 `tool.execute.after`: session/usage capture; may rewrite the output text. */
function createToolAfterAdapter(hooks: V1Hooks) {
  return async (event: V2ToolAfterEvent): Promise<void> => {
    if (event.status !== "completed") return;
    const handler = hooks["tool.execute.after"];
    if (!handler) return;
    const result = isRecord(event.result) ? event.result : {};
    const fromContent = contentText(result.content);
    const initial = fromContent !== "" ? fromContent : typeof result.output === "string" ? result.output : "";
    const output: ToolAfterOut = {
      title: typeof result.title === "string" ? result.title : "",
      output: initial,
      metadata: isRecord(result.metadata) ? result.metadata : {},
    };
    await handler(
      { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input },
      output,
    );
    result.title = output.title;
    result.metadata = output.metadata;
    if (output.output !== initial) {
      result.content = output.output === "" ? [] : [{ type: "text", text: output.output }];
    }
    event.result = result;
  };
}

/** v1 `tool` record -> v2 editor.add (id/name both required by the host). */
function createToolTransformAdapter(hooks: V1Hooks) {
  return (editor: V2ToolEditor): void => {
    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      const def = definition as {
        description: string;
        args?: unknown;
        execute: (...args: never[]) => unknown;
      };
      const input = argsToJsonSchema(def.args);
      editor.add({
        id: name,
        name,
        description: def.description,
        input,
        inputSchema: input,
        execute: def.execute,
      });
    }
  };
}

/**
 * v1 `experimental.chat.system.transform` -> v2 `session.hook("context")`.
 * v2 hands `system` as `SystemPart[]`; the v1 hook reads/writes `string[]`.
 * Splice positions are preserved by mapping indices one-to-one.
 */
function createSystemTransformAdapter(hooks: V1Hooks) {
  return async (event: V2SessionContextEvent): Promise<void> => {
    const handler = hooks["experimental.chat.system.transform"];
    if (!handler) return;
    const strings = event.system.map((part) => (typeof part.text === "string" ? part.text : ""));
    const output: SystemTransformOut = { system: strings };
    await handler({ sessionID: event.sessionID, model: event.model } as SystemTransformIn, output);
    if (output.system !== strings) {
      event.system.length = 0;
      for (const text of output.system) event.system.push({ type: "text", text });
    }
  };
}

/** v1 `chat.message` -> v2 `session.hook("prompt")`. */
function createChatMessageAdapter(hooks: V1Hooks) {
  return async (event: V2SessionPromptEvent): Promise<void> => {
    const handler = hooks["chat.message"];
    if (!handler) return;
    const text = event.prompt?.text ?? "";
    const output: ChatMessageOut = { parts: [{ type: "text", text }] };
    await handler(
      { sessionID: event.sessionID, messageID: event.messageID } as ChatMessageIn,
      output,
    );
  };
}

/** v1 `experimental.session.compacting` -> v2 `session.hook("compaction")`. */
function createCompactingAdapter(hooks: V1Hooks) {
  return async (event: V2CompactionEvent): Promise<void> => {
    const handler = hooks["experimental.session.compacting"];
    if (!handler) return;
    const output: CompactingOut = { context: [] };
    const snapshot = await handler({ sessionID: event.sessionID } as CompactingIn, output);
    const injected = output.context.filter((entry) => typeof entry === "string" && entry.length > 0);
    // v1 pushed every string onto output.context and also returned the snapshot; deliver all of it
    // so neither the resume snapshot nor the auto-injection block is dropped.
    const parts = [
      ...(typeof snapshot === "string" && snapshot ? [snapshot] : []),
      ...injected,
    ];
    if (parts.length > 0) {
      event.result = { summary: parts.join("\n\n") };
    }
  };
}

/** v1 `event` hook -> v2 `event.subscribe()` stream. */
function startEventSubscription(hooks: V1Hooks, ctx: V2SetupContext): { abort: () => void } {
  const controller = new AbortController();
  const handler = hooks.event;
  if (!handler) return { abort: () => controller.abort() };
  const stream = ctx.event.subscribe({ signal: controller.signal });
  void (async () => {
    try {
      for await (const event of stream) {
        await handler({ event } as never);
      }
    } catch {
      // Stream torn down by abort during cleanup or host shutdown.
    }
  })();
  return { abort: () => controller.abort() };
}

// ── json-schema bridge ─────────────────────────────────────
// context-mode declares tool args as zod v3 shapes (converted to v4 by the
// existing adapter). The v2 editor wants a JSON schema. Reuse the same
// converter the v1 adapter exports when present, otherwise pass through.
function argsToJsonSchema(args: unknown): Record<string, unknown> {
  try {
    const maybe = args as { _def?: unknown; toJSONSchema?: () => unknown };
    if (maybe && typeof maybe.toJSONSchema === "function") {
      const schema = maybe.toJSONSchema();
      if (isRecord(schema)) return schema;
    }
  } catch {
    // fall through to a permissive object schema
  }
  return { type: "object", additionalProperties: true };
}

// ── setup ──────────────────────────────────────────────────

/**
 * v2 entrypoint. Runs the untouched v1 hook factory and registers every hook on
 * the v2 domain surface, returning the cleanup that disposes them all.
 */
export async function setup(ctx: V2SetupContext): Promise<V2Cleanup> {
  const hooks = await createContextModePlugin({ directory: ctx.location.directory } as never);
  const registrations: V2Registration[] = [];

  const record = async (registration: Promise<V2Registration>): Promise<void> => {
    registrations.push(await registration);
  };

  await record(ctx.tool.hook("execute.before", createToolBeforeAdapter(hooks) as never));
  await record(ctx.tool.hook("execute.after", createToolAfterAdapter(hooks) as never));
  await record(ctx.tool.transform(createToolTransformAdapter(hooks) as never));
  await record(ctx.session.hook("context", createSystemTransformAdapter(hooks) as never));
  await record(ctx.session.hook("prompt", createChatMessageAdapter(hooks) as never));
  await record(ctx.session.hook("compaction", createCompactingAdapter(hooks) as never));
  const subscription = startEventSubscription(hooks, ctx);

  return async () => {
    subscription.abort();
    for (const registration of registrations) await registration.dispose();
  };
}
