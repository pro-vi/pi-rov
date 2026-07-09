import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_KEY } from "../src/constants.js";
import { feedbackFromDistillPatch, formatDistillFeedback, setDistillFeedbackStatus, type DistillStatusContext } from "../src/ui-status.js";

void test("formatDistillFeedback uses compact icon and token delta", () => {
  const ctx = createStatusContext();

  assert.equal(formatDistillFeedback(ctx, { kind: "model", rawBytes: 40_000, visibleBytes: 2_400 }), "distill ◆ −9.4k");
  assert.equal(formatDistillFeedback(ctx, { kind: "code", rawBytes: 10_000, visibleBytes: 2_000 }), "distill ◇ −2k");
  assert.equal(formatDistillFeedback(ctx, { kind: "cache", rawBytes: 20_000, visibleBytes: 4_000 }), "distill ↻ −4k");
  assert.equal(formatDistillFeedback(ctx, { kind: "fallback" }), "distill ! raw");
  assert.equal(formatDistillFeedback(ctx, { kind: "expand" }), "distill ↗ raw");
});

void test("feedbackFromDistillPatch differentiates model, cache, reducer, and fallback paths", () => {
  assert.equal(feedbackFromDistillPatch(patch("distilled", "semantic"))?.kind, "model");
  assert.equal(feedbackFromDistillPatch(patch("distilled", "semantic-cache"))?.kind, "cache");
  assert.equal(feedbackFromDistillPatch(patch("reduced", "reducer"))?.kind, "code");
  assert.equal(feedbackFromDistillPatch(patch("fallback"))?.kind, "fallback");
});

void test("setDistillFeedbackStatus writes footer status under the distill key", () => {
  const ctx = createStatusContext();

  setDistillFeedbackStatus(ctx, { kind: "model", rawBytes: 8_000, visibleBytes: 1_600 });

  assert.deepEqual(ctx.statuses.at(-1), { key: STATUS_KEY, text: "distill ◆ −1.6k" });
});

function patch(status: "distilled" | "reduced" | "fallback", method?: "semantic" | "semantic-cache" | "reducer") {
  return {
    content: [{ type: "text" as const, text: "x".repeat(1_000) }],
    details: {
      distill: {
        status,
        method,
        rawBytes: 9_000,
      },
    },
  };
}

function createStatusContext(): DistillStatusContext & { statuses: Array<{ key: string; text: string | undefined }> } {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  return {
    statuses,
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      theme: {
        fg: (_color: "success" | "accent" | "muted" | "dim" | "warning", text: string) => text,
      },
    },
  } satisfies DistillStatusContext & { statuses: Array<{ key: string; text: string | undefined }> };
}
