/**
 * Resume-snapshot budget tests.
 *
 * A compaction summary is supposed to shrink the context. Measured on
 * 2026-10-30, one session's `errors` section reached 185,993 chars (35 raw tool
 * outputs) inside a 187,232-char summary — 99.3% of a ~47k-token resume block.
 * That summary sat above the compaction ceiling, so every turn compacted again
 * (70 compactions in 64 minutes). These tests pin the caps that stop it.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import {
  buildResumeSnapshot,
  ERROR_MAX_CHARS,
  MAX_ERRORS,
  SNAPSHOT_MAX_CHARS,
  type StoredEvent,
} from "../../src/session/snapshot.js";

function errorEvent(data: string): StoredEvent {
  return { type: "error", category: "error", data, priority: 2 };
}

function event(category: string, data: string): StoredEvent {
  return { type: category, category, data, priority: 1 };
}

describe("resume snapshot budget", () => {
  test("a flood of raw errors stays inside the block budget", () => {
    const dump = "Traceback (most recent call last):\n" + "x".repeat(5_000);
    const events = Array.from({ length: 35 }, () => errorEvent(dump));

    const xml = buildResumeSnapshot(events);

    assert.ok(
      xml.length <= SNAPSHOT_MAX_CHARS + 600,
      `snapshot should stay near ${SNAPSHOT_MAX_CHARS} chars, got ${xml.length}`,
    );
    assert.ok(xml.includes(`count="35"`), "the real error count is still reported");

    const longestRun = (xml.match(/x+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
    assert.ok(
      longestRun <= ERROR_MAX_CHARS + 20,
      `a 5k-char dump must be truncated near ${ERROR_MAX_CHARS} chars, got ${longestRun}`,
    );
    assert.ok(
      !xml.includes("x".repeat(1_000)),
      "no single raw tool output may survive at full length",
    );
  });

  test("an over-budget snapshot drops the lowest-priority sections and says so", () => {
    const fat = (i: number) => `${i}:${"y".repeat(4_000)}`;
    const events: StoredEvent[] = [
      event("goal", "ship the thing"),
      ...Array.from({ length: 40 }, (_, i) => event("file", fat(i))),
      ...Array.from({ length: 40 }, (_, i) => event("decision", `d${fat(i)}`)),
      ...Array.from({ length: 40 }, (_, i) => event("task", `t${fat(i)}`)),
      event("user-prompt", "what is left?"),
    ];

    const xml = buildResumeSnapshot(events);

    assert.ok(
      xml.length <= SNAPSHOT_MAX_CHARS + 600,
      `snapshot should stay near ${SNAPSHOT_MAX_CHARS} chars, got ${xml.length}`,
    );
    assert.ok(xml.includes("<omitted sections="), "dropped sections are named");
    assert.ok(xml.includes("<recent_user_messages"), "the prompt safety net survives");
    assert.ok(xml.includes("</session_resume>"), "the block still closes");
  });

  test("an explicit maxBytes is honoured", () => {
    const events: StoredEvent[] = [
      ...Array.from({ length: 30 }, () => errorEvent("e".repeat(2_000))),
      event("user-prompt", "carry on"),
    ];

    const xml = buildResumeSnapshot(events, { maxBytes: 2_000 });

    assert.ok(xml.length <= 2_600, `expected a 2k budget, got ${xml.length}`);
  });

  test("an ordinary snapshot keeps every section and marks nothing omitted", () => {
    const xml = buildResumeSnapshot([
      event("goal", "investigate the loop"),
      event("file", "/home/opc/everything/kyros/vibes/AGENTS.md"),
      event("decision", "lower the buffer instead of the ceiling"),
      event("user-prompt", "why does it keep compacting?"),
    ]);

    assert.ok(!xml.includes("<omitted"), "nothing was dropped");
    assert.ok(xml.includes("<how_to_search>"));
    assert.ok(xml.includes("<decisions"));
    assert.ok(xml.includes("<recent_user_messages"));
  });
});
