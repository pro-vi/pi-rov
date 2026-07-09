import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { sha256 } from "../artifacts.js";
import type { EvalFact, EvalFactType, TranscriptCandidate } from "./types.js";

export interface FactMiningOptions {
  laterWindowLines?: number;
}

interface RawFactCandidate {
  type: EvalFactType;
  value: string;
  source: "raw" | "metadata";
}

export async function mineFactsForCandidate(candidate: TranscriptCandidate, options: FactMiningOptions = {}): Promise<EvalFact[]> {
  const laterText = await collectLaterConversationText(candidate, options.laterWindowLines ?? 80);
  return mineFacts(candidate, laterText);
}

export function mineFacts(candidate: TranscriptCandidate, laterText: string): EvalFact[] {
  const rawFacts = collectRawFactCandidates(candidate);
  const deduped = new Map<string, EvalFact>();

  for (const rawFact of rawFacts) {
    const normalizedValue = normalizeFactValue(rawFact.value);
    if (!normalizedValue) {
      continue;
    }
    const laterOccurrences = countNormalizedOccurrences(laterText, rawFact.value);
    if (laterOccurrences === 0) {
      continue;
    }
    const rawOccurrences = rawFact.source === "metadata" ? 1 : countNormalizedOccurrences(candidate.rawText, rawFact.value);
    const key = `${rawFact.type}:${normalizedValue}`;
    const existing = deduped.get(key);
    const next: EvalFact = {
      id: sha256(key).slice(0, 16),
      type: rawFact.type,
      value: rawFact.value,
      normalizedValue,
      confidence: rawFact.source === "metadata" ? 0.8 : 0.9,
      rawOccurrences: Math.max(1, rawOccurrences),
      laterOccurrences,
      source: rawFact.source === "metadata" ? "metadata-reused-later" : "raw-reused-later",
    };
    if (!existing || next.laterOccurrences > existing.laterOccurrences) {
      deduped.set(key, next);
    }
  }

  return [...deduped.values()].sort(compareFacts);
}

export async function collectLaterConversationText(candidate: TranscriptCandidate, laterWindowLines: number): Promise<string> {
  const textParts: string[] = [];
  let lineNumber = 0;
  let linesAfterCandidate = 0;

  const lineReader = createInterface({ input: createReadStream(candidate.sessionPath, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of lineReader) {
    lineNumber += 1;
    if (lineNumber <= candidate.lineNumber) {
      continue;
    }
    if (linesAfterCandidate >= laterWindowLines) {
      break;
    }
    linesAfterCandidate += 1;
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseJsonLine(line);
    if (!isRecord(parsed)) {
      continue;
    }
    const text = conversationEntryText(parsed);
    if (text.length > 0) {
      textParts.push(text);
    }
  }

  return textParts.join("\n");
}

export function normalizeFactValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function factAppearsInText(fact: EvalFact, text: string): boolean {
  return normalizeFactValue(text).includes(fact.normalizedValue);
}

function collectRawFactCandidates(candidate: TranscriptCandidate): RawFactCandidate[] {
  const facts: RawFactCandidate[] = [];
  collectPatternFacts(candidate.rawText, /\b(?:\.{1,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+\.[A-Za-z0-9_+-]+:\d+(?::\d+)?\b/g, "line-ref", facts);
  collectPatternFacts(candidate.rawText, /https?:\/\/[^\s)'"<>]+/g, "url", facts);
  collectPatternFacts(candidate.rawText, /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Failure)\b/g, "error", facts);
  collectPatternFacts(candidate.rawText, /\b(?:FAIL|PASS|SKIP|not ok|ok)\s+[^\n]{3,180}/gi, "test", facts);
  collectPathFacts(candidate.rawText, facts);
  collectQuotedFacts(candidate.rawText, facts);

  const command = readString(candidate.input, "command");
  if (command && command.length <= 300) {
    facts.push({ type: "command", value: command, source: "metadata" });
  }
  const exitCode = typeof candidate.exitCode === "number" ? candidate.exitCode : readNumber(candidate.input, "exitCode");
  if (exitCode !== undefined) {
    facts.push({ type: "exit-fact", value: `exit code ${exitCode}`, source: "metadata" });
  }

  return facts;
}

function collectPatternFacts(text: string, pattern: RegExp, type: EvalFactType, facts: RawFactCandidate[]): void {
  for (const match of text.matchAll(pattern)) {
    const value = trimFactValue(match[0]);
    if (isUsefulFactValue(value)) {
      facts.push({ type, value, source: "raw" });
    }
  }
}

function collectPathFacts(text: string, facts: RawFactCandidate[]): void {
  const pattern = /\b(?:\.{1,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+\.[A-Za-z0-9_+-]+\b/g;
  for (const match of text.matchAll(pattern)) {
    const value = trimFactValue(match[0]);
    if (isUsefulFactValue(value) && !value.includes("://")) {
      facts.push({ type: "path", value, source: "raw" });
    }
  }
}

function collectQuotedFacts(text: string, facts: RawFactCandidate[]): void {
  const pattern = /["'`]([^"'`\n]{8,120})["'`]/g;
  for (const match of text.matchAll(pattern)) {
    const value = trimFactValue(match[1] ?? "");
    if (isUsefulFactValue(value) && /[A-Za-z0-9]/.test(value)) {
      facts.push({ type: "quote", value, source: "raw" });
    }
  }
}

function trimFactValue(value: string): string {
  return value.trim().replace(/[),.;]+$/g, "");
}

function isUsefulFactValue(value: string): boolean {
  return value.length >= 3 && value.length <= 300;
}

function countNormalizedOccurrences(text: string, value: string): number {
  const normalizedText = normalizeFactValue(text);
  const normalizedValue = normalizeFactValue(value);
  if (!normalizedText || !normalizedValue) {
    return 0;
  }
  let count = 0;
  let index = normalizedText.indexOf(normalizedValue);
  while (index !== -1) {
    count += 1;
    index = normalizedText.indexOf(normalizedValue, index + normalizedValue.length);
  }
  return count;
}

function conversationEntryText(entry: Record<string, unknown>): string {
  if (entry.type === "message" && isRecord(entry.message)) {
    return messageText(entry.message);
  }
  if (entry.type === "custom_message") {
    return contentText(entry.content);
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const summary = readString(entry, "summary");
    return summary ?? "";
  }
  return "";
}

function messageText(message: Record<string, unknown>): string {
  const role = readString(message, "role");
  if (role === "user" || role === "custom") {
    return contentText(message.content);
  }
  if (role === "assistant") {
    return assistantContentText(message.content);
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function assistantContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    } else if (block.type === "toolCall") {
      const name = readString(block, "name");
      if (name) {
        parts.push(`[toolCall] ${name}`);
      }
    }
  }
  return parts.join("\n");
}

function compareFacts(left: EvalFact, right: EvalFact): number {
  const typeOrder = left.type.localeCompare(right.type);
  if (typeOrder !== 0) return typeOrder;
  return left.normalizedValue.localeCompare(right.normalizedValue);
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed;
  } catch {
    return undefined;
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
