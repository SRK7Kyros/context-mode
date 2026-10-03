// Direct contract test: decode the ported context-mode plugin module with the
// exact Schema the v2 host uses (opencode-fork-v2 packages/core/src/plugin/
// module.ts). A successful decode is the authoritative proof that the host
// accepts the module shape; a failure reproduces the host's LoadError text.
//
// Run: bun test/contract/v2-module-contract.test.ts
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

const Module = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<(...args: never[]) => unknown>(
        (input): input is (...args: never[]) => unknown => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<(...args: never[]) => unknown>(
        (input): input is (...args: never[]) => unknown => typeof input === "function",
      ),
    }),
  ]),
});

describe("context-mode v2 module contract", () => {
  test("default export satisfies the host Module schema", async () => {
    const loaded = await import("../../build/adapters/opencode/v2.js");

    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(Module)(loaded).pipe(Effect.result),
    );

    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success.default.id).toBe("context-mode");
    }
  });

  test("module exposes setup as the v2 entrypoint", async () => {
    const loaded = await import("../../build/adapters/opencode/v2.js");
    expect(typeof loaded.default.setup).toBe("function");
    expect(loaded.default.setup.length).toBe(1);
  });
});
