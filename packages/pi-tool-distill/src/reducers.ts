import { normalizeFingerprintText } from "./artifacts.js";
import type { ObservationArtifact } from "./types.js";

export type SafeReducerId = "normalized-duplicate" | "append-only";

export interface ReducerCandidate {
  artifact: ObservationArtifact;
  rawText: string;
}

export interface ReducerRequest {
  current: ObservationArtifact;
  rawText: string;
  candidates: ReducerCandidate[];
}

export interface ReducerHit {
  reducerId: SafeReducerId;
  summary: string;
  previousArtifactId: string;
  omittedBytes: number;
  outputBytes: number;
}

const MIN_PRIOR_BYTES = 1_000;
const MIN_SAVED_BYTES = 1_000;
const MAX_REDUCTION_RATIO = 0.6;
const MAX_APPEND_SUFFIX_BYTES = 4_000;
const MAX_SNIPPET_CHARS = MAX_APPEND_SUFFIX_BYTES;

export function reduceToolResult(request: ReducerRequest): ReducerHit | undefined {
  if (request.rawText.length === 0 || request.candidates.length === 0) {
    return undefined;
  }

  const candidates = request.candidates
    .filter((candidate) => candidate.artifact.id !== request.current.id && candidate.artifact.toolName === request.current.toolName)
    .sort((left, right) => right.artifact.createdAt - left.artifact.createdAt);

  const duplicate = findNormalizedDuplicate(request, candidates);
  if (duplicate) {
    return duplicate;
  }

  return findAppendOnlyRepeat(request, candidates);
}

function findNormalizedDuplicate(request: ReducerRequest, candidates: ReducerCandidate[]): ReducerHit | undefined {
  const currentNormalized = normalizeFingerprintText(request.rawText);
  if (Buffer.byteLength(currentNormalized, "utf-8") < MIN_PRIOR_BYTES) {
    return undefined;
  }
  for (const candidate of candidates) {
    const previousNormalized = normalizeFingerprintText(candidate.rawText);
    const previousBytes = Buffer.byteLength(previousNormalized, "utf-8");
    if (previousBytes < MIN_PRIOR_BYTES) {
      continue;
    }
    if (currentNormalized !== previousNormalized) {
      continue;
    }
    const summary = duplicateSummary(request.current, candidate.artifact, previousBytes);
    return usefulHit(request.current, {
      reducerId: "normalized-duplicate",
      summary,
      previousArtifactId: candidate.artifact.id,
      omittedBytes: previousBytes,
      outputBytes: Buffer.byteLength(summary, "utf-8"),
    });
  }
  return undefined;
}

function findAppendOnlyRepeat(request: ReducerRequest, candidates: ReducerCandidate[]): ReducerHit | undefined {
  const currentNormalized = normalizeFingerprintText(request.rawText);
  for (const candidate of candidates) {
    const previousNormalized = normalizeFingerprintText(candidate.rawText);
    const previousBytes = Buffer.byteLength(previousNormalized, "utf-8");
    if (previousBytes < MIN_PRIOR_BYTES || previousNormalized.length === 0) {
      continue;
    }

    const previousStart = currentNormalized.startsWith(previousNormalized) ? 0 : currentNormalized.indexOf(previousNormalized);
    if (previousStart === -1) {
      continue;
    }

    const prefix = currentNormalized.slice(0, previousStart).trim();
    const suffix = currentNormalized.slice(previousStart + previousNormalized.length).trim();
    const newText = [prefix, suffix].filter((part) => part.length > 0).join("\n");
    const newBytes = Buffer.byteLength(newText, "utf-8");
    if (newBytes === 0 || newBytes > MAX_APPEND_SUFFIX_BYTES) {
      continue;
    }

    const omittedBytes = Buffer.byteLength(previousNormalized, "utf-8");
    const summary = appendOnlySummary(request.current, candidate.artifact, omittedBytes, newText);
    return usefulHit(request.current, {
      reducerId: "append-only",
      summary,
      previousArtifactId: candidate.artifact.id,
      omittedBytes,
      outputBytes: Buffer.byteLength(summary, "utf-8"),
    });
  }
  return undefined;
}

function usefulHit(current: ObservationArtifact, hit: ReducerHit): ReducerHit | undefined {
  const savedBytes = current.rawBytes - hit.outputBytes;
  const ratio = current.rawBytes === 0 ? 1 : hit.outputBytes / current.rawBytes;
  if (savedBytes >= MIN_SAVED_BYTES || ratio <= MAX_REDUCTION_RATIO) {
    return hit;
  }
  return undefined;
}

function duplicateSummary(current: ObservationArtifact, previous: ObservationArtifact, omittedBytes: number): string {
  return [
    "## Outcome",
    `This ${current.toolName} result is mechanically equivalent to previous raw artifact ${previous.id} after ANSI/CRLF/trailing-whitespace normalization.`,
    "## Verbatim evidence",
    `- Current raw artifact: ${current.id}`,
    `- Previous raw artifact: ${previous.id}`,
    `- Reducer: normalized-duplicate`,
    "## Omitted",
    `Omitted ${omittedBytes} normalized bytes already present in previous raw artifact ${previous.id}.`,
    "## Uncertainty",
    "No semantic interpretation was performed; this is a code-only normalized duplicate check.",
  ].join("\n");
}

function appendOnlySummary(current: ObservationArtifact, previous: ObservationArtifact, omittedBytes: number, newText: string): string {
  return [
    "## Outcome",
    `This ${current.toolName} result repeats previous raw artifact ${previous.id} and adds a bounded new suffix/prefix.`,
    "## Verbatim evidence",
    `- Current raw artifact: ${current.id}`,
    `- Previous raw artifact: ${previous.id}`,
    `- Reducer: append-only`,
    "- New text outside the repeated block:",
    "```text",
    clipSnippet(newText),
    "```",
    "## Omitted",
    `Omitted ${omittedBytes} normalized bytes already present in previous raw artifact ${previous.id}.`,
    "## Uncertainty",
    "No semantic interpretation was performed; if the bounded suffix is insufficient, expand the current raw artifact.",
  ].join("\n");
}

function clipSnippet(text: string): string {
  if (text.length <= MAX_SNIPPET_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SNIPPET_CHARS)}\n[tool-distill reducer: snippet truncated at ${MAX_SNIPPET_CHARS} chars]`;
}
