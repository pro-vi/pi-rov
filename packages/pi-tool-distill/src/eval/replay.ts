import { factAppearsInText } from "./facts.js";
import type { EvalFixtureManifest, EvalReplayInvoker, EvalReplayResult, EvalVariantResult } from "./types.js";

export interface EvalReplayOptions {
  live?: boolean;
  invoke?: EvalReplayInvoker;
}

export async function replayFixtureVariant(
  fixture: EvalFixtureManifest,
  variant: EvalVariantResult,
  options: EvalReplayOptions = {},
): Promise<EvalReplayResult> {
  if (variant.status === "skipped" || variant.status === "failed") {
    return {
      fixtureId: fixture.id,
      variant: variant.variant,
      status: "skipped",
      success: false,
      reason: `variant ${variant.status}`,
    };
  }
  if (!options.live || !options.invoke) {
    return {
      fixtureId: fixture.id,
      variant: variant.variant,
      status: "skipped",
      success: false,
      reason: "downstream replay requires --live and a replay invoker",
    };
  }

  const prompt = buildReplayPrompt(fixture, variant);
  try {
    const answer = await options.invoke({ fixture, variant, prompt });
    const score = scoreReplayAnswer(answer, fixture, variant);
    return {
      fixtureId: fixture.id,
      variant: variant.variant,
      status: "ok",
      success: score.success,
      reason: score.reason,
      answer,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "replay model failed";
    return {
      fixtureId: fixture.id,
      variant: variant.variant,
      status: "failed",
      success: false,
      reason,
    };
  }
}

export function buildReplayPrompt(fixture: EvalFixtureManifest, variant: EvalVariantResult): string {
  return [
    "You are evaluating a reduced tool result from a coding-agent session.",
    "Answer the next-step question using only the tool result below.",
    "If important exact evidence is missing, say that distill_expand should be called and name the missing evidence category.",
    "",
    `Tool: ${fixture.toolName}`,
    `Fixture: ${fixture.id}`,
    "Question: What failed, what exact file/path/error should be inspected, and is expansion needed?",
    "",
    "Tool result variant:",
    "<tool-result>",
    variant.outputText ?? "",
    "</tool-result>",
  ].join("\n");
}

export function scoreReplayAnswer(answer: string, fixture: EvalFixtureManifest, variant: EvalVariantResult): { success: boolean; reason: string } {
  if (!fixture.scoreable) {
    return { success: true, reason: "fixture has no required facts" };
  }
  const factsInAnswer = fixture.facts.filter((fact) => factAppearsInText(fact, answer));
  if (factsInAnswer.length === fixture.facts.length) {
    return { success: true, reason: "answer retained all required facts" };
  }
  const missingFromVariant = fixture.facts.filter((fact) => !factAppearsInText(fact, variant.outputText ?? ""));
  if (missingFromVariant.length > 0 && /distill_expand/i.test(answer)) {
    return { success: true, reason: "answer requested expansion for hidden evidence" };
  }
  return {
    success: false,
    reason: `answer retained ${factsInAnswer.length}/${fixture.facts.length} required facts and did not request expansion`,
  };
}
